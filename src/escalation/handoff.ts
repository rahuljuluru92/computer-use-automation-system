/**
 * The round trip.
 *
 * This is the protocol the brief asks for - "pause, cede control, and resume on
 * the *same* session" - written out as one function, because the ordering is
 * the whole of the correctness argument and spreading it across three classes
 * would hide it:
 *
 *   cede          automation stops acting, generation++       (controller: none)
 *   publish       the console can now see it
 *   claim         a human takes it, generation++              (controller: operator)
 *   capture       everything they touch is recorded
 *   hand back     they decide, generation++                   (controller: automation)
 *   re-observe    the run looks at the page again before doing anything
 *
 * Two details carry most of the weight.
 *
 * **Cede before publish.** Publishing first would leave a window in which the
 * console shows a claimable intervention while automation still holds the
 * lease - and the operator's first click would land in a session that is still
 * being driven. Ceding first makes the window impossible rather than unlikely.
 *
 * **Cede to `none`, not to `operator`.** Between the run giving up and a human
 * arriving, nobody is driving, and the lease should say so. Handing control
 * straight to an operator who has not turned up yet would make the audit log
 * claim a person was in control of a session they had never seen.
 *
 * The run resumes only after `syncGeneration()` and a fresh observation, which
 * is enforced on the other side of this call in replay.ts. Actions planned
 * before the handoff carry the old generation and are rejected by the lease -
 * that is what the generation counter is for.
 */

import type { SessionLease } from '../exec/lease.ts';
import type { EvidenceWriter } from '../evidence/writer.ts';
import type { InterventionSink } from './bus.ts';
import type { HumanActionCapture } from './capture.ts';
import { type InterventionRecord, isTerminal } from './intervention.ts';

/** What the run tells the channel when it stops. */
export interface EscalationRequest {
  interventionId: string;
  reason: InterventionRecord['reason'];
  detail: string;
  stepId: string;
  stepIntent: string;
  actionKind: string;
  actionClass: string;
  url: string;
  title: string;
  screenshotPath?: string;
  /** How long to wait for a human before the run abandons. */
  timeoutMs?: number;
}

/** What the run gets back. */
export interface EscalationResolution {
  resolution: 'resolved' | 'aborted' | 'skipped' | 'timed_out';
  claimedBy?: string;
  humanActionCount: number;
  note?: string;
}

/**
 * A place a stuck run can ask for help.
 *
 * An interface rather than a callback because a handoff has a second half: the
 * run decides what to do when nobody comes, and the record of the intervention
 * is not complete until that decision is written down next to it.
 */
export interface EscalationChannel {
  raise(req: EscalationRequest): Promise<EscalationResolution>;
  /** Told what the run did after a timeout, so the record shows the whole story. */
  noteAbandon?(interventionId: string, abandon: { kind: string; performed: boolean; detail: string }): void;
}

export interface HandoffOptions {
  bus: InterventionSink;
  lease: SessionLease;
  evidence: EvidenceWriter;
  runId: string;
  capability: { id: string; version: string };
  tenant?: string | undefined;
  /** Absent for surfaces that cannot be driven by a human, e.g. a test double. */
  capture?: HumanActionCapture | undefined;
}

/**
 * Build the channel a run escalates into.
 *
 * Everything it needs is fixed for the life of the run, so this is a closure
 * over them rather than an object with six public fields.
 */
export function createHandoff(o: HandoffOptions): EscalationChannel {
  return {
    async raise(req: EscalationRequest): Promise<EscalationResolution> {
      // 1. Stop. Nobody is driving until somebody claims it.
      const ceded = o.lease.cede('none', `escalated: ${req.reason}`);
      o.evidence.event('lease.transfer',
        `Automation has stopped and given up the session at generation ${ceded}; `
        + `no one is driving until an operator claims it.`,
        { generation: ceded, controller: 'none', reason: req.reason }, req.stepId);

      // 2. Start watching. Armed before the intervention is visible, so the
      //    very first thing the operator does is already being recorded.
      await o.capture?.arm((action) => {
        o.bus.recordHumanAction(req.interventionId, action);
      });

      // 3. React to the claim. The console moves the record; the lease has to
      //    follow, or the audit and the enforcement disagree about who is
      //    holding a live banking session.
      const unsubscribe = o.bus.onChange((record) => {
        if (record.id !== req.interventionId) return;
        // Keyed on *who holds it*, not on catching the `claimed` state as it
        // goes past. A remote console is polled, so an operator who claims and
        // resolves inside one interval is only ever observed as resolved - and
        // keying on the transition meant the lease never recorded that a person
        // held the session at all, in precisely the cross-process case the
        // audit trail exists for. Found by the Phase 5 gate, whose lease
        // history came back two transfers long instead of three.
        if (record.claimedBy !== undefined && o.lease.controller !== 'operator') {
          const gen = o.lease.claim(record.claimedBy ?? 'operator');
          o.evidence.event('escalation.claimed',
            `${record.claimedBy ?? 'An operator'} took the session at generation ${gen}. `
            + `Automation will not act again until they hand it back.`,
            { interventionId: record.id, operator: record.claimedBy, generation: gen }, req.stepId);
        }
      });

      let record: InterventionRecord;
      try {
        record = await o.bus.raise({
          id: req.interventionId,
          runId: o.runId,
          capability: o.capability,
          ...(o.tenant !== undefined ? { tenant: o.tenant } : {}),
          reason: req.reason,
          detail: req.detail,
          stepId: req.stepId,
          stepIntent: req.stepIntent,
          actionKind: req.actionKind,
          actionClass: req.actionClass,
          url: req.url,
          title: req.title,
          evidenceDir: o.evidence.dir,
          ...(req.screenshotPath !== undefined ? { screenshotPath: req.screenshotPath } : {}),
        }, { ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}) });
      } finally {
        unsubscribe();
      }

      // 4. Stop watching, and take the session back.
      const humanActions = o.capture?.disarm() ?? [];
      const reclaimed = o.lease.reclaim(
        record.state === 'timed_out'
          ? 'nobody claimed the intervention; automation is taking the session back to abandon safely'
          : `operator ${record.resolution ?? 'finished'}`);

      const transfers = o.lease.history.map((t) => ({ ...t }));
      o.bus.recordLeaseTransfers(req.interventionId, transfers);

      if (record.state === 'timed_out') {
        o.evidence.event('escalation.timeout',
          `No one responded to ${req.interventionId}. ${record.note ?? ''} `
          + `Automation has the session back at generation ${reclaimed} only so it can `
          + `leave the screen safely; it will not continue the task.`,
          { interventionId: req.interventionId, generation: reclaimed,
            humanActions: humanActions.length }, req.stepId);
      } else {
        o.evidence.event('escalation.resumed',
          `${record.claimedBy ?? 'The operator'} ${describe(record.resolution)} after `
          + `${humanActions.length} action(s); control is back with automation at `
          + `generation ${reclaimed}.`,
          { interventionId: req.interventionId, resolution: record.resolution,
            operator: record.claimedBy, generation: reclaimed,
            humanActions: humanActions.length, note: record.note }, req.stepId);
      }

      // The actions themselves, as their own evidence file. They are an audit
      // record of a person touching a customer's session, so they get written
      // whether or not anybody reads the run log.
      if (humanActions.length > 0) {
        o.evidence.json(`interventions/${req.interventionId}.actions.json`, humanActions);
      }
      // Re-read for whatever the console knows, but write the lease history and
      // the captured actions from what we hold rather than from what came back.
      // A remote console is told about both over HTTP and echoes them on the
      // next poll, which is after this - so trusting the echo silently produced
      // an audit file with an empty lease history in exactly the cross-process
      // case the audit exists for. Found by the Phase 5 gate.
      const finalRecord = o.bus.get(req.interventionId) ?? record;
      o.evidence.json(`interventions/${req.interventionId}.json`,
        { ...finalRecord, leaseTransfers: transfers, humanActions });

      return {
        resolution: record.resolution ?? 'timed_out',
        ...(record.claimedBy !== undefined ? { claimedBy: record.claimedBy } : {}),
        humanActionCount: humanActions.length,
        ...(record.note !== undefined ? { note: record.note } : {}),
      };
    },

    noteAbandon(interventionId, abandon) {
      o.bus.recordAbandon(interventionId, abandon);
      const record = o.bus.get(interventionId);
      if (record) o.evidence.json(`interventions/${interventionId}.json`, record);
    },
  };
}

function describe(resolution: InterventionRecord['resolution']): string {
  switch (resolution) {
    case 'resolved': return 'resolved it';
    case 'skipped':  return 'asked to skip the step';
    case 'aborted':  return 'aborted the run';
    default:         return 'handed control back';
  }
}

/** True when the record is still waiting on somebody. Re-exported for the console. */
export { isTerminal };
