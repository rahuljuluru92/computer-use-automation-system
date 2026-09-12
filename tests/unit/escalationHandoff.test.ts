/**
 * The handoff protocol.
 *
 * Everything here is about *ordering*, because the ordering is the correctness
 * argument. Getting the steps right in a different order produces a system that
 * works on a good day and hands an operator a live, still-being-driven session
 * on a bad one - and the bad day is the one this feature exists for.
 *
 * The bus is a stub rather than the real one. This file is testing what the
 * handoff does around the bus, and driving the real bus's timers from here
 * would be testing bus.ts twice and handoff.ts once.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { SessionLease } from '../../src/exec/lease.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { buildRedactor } from '../../src/core/redact.ts';
import { createHandoff } from '../../src/escalation/handoff.ts';
import type { EscalationRequest } from '../../src/escalation/handoff.ts';
import type { InterventionSink, RaiseInput, BusListener } from '../../src/escalation/bus.ts';
import {
  InterventionRecord, type HumanAction, type Resolution,
} from '../../src/escalation/intervention.ts';

// Decision #64: its own scratch root, because vitest runs files in parallel
// and a shared one had one suite deleting a directory another was writing to.
const EVIDENCE_ROOT = 'evidence/_test_handoff';
afterAll(() => { rmSync(EVIDENCE_ROOT, { recursive: true, force: true }); });

/**
 * A bus that records the order things happened in, and lets the test decide
 * when the human answers.
 */
class StubBus implements InterventionSink {
  readonly log: string[] = [];
  readonly records = new Map<string, InterventionRecord>();
  readonly #listeners = new Set<BusListener>();
  #settle: ((r: InterventionRecord) => void) | null = null;
  /** What the lease said at the instant the intervention became visible. */
  controllerAtPublish: string | null = null;

  constructor(private readonly lease: SessionLease) {}

  raise(input: RaiseInput): Promise<InterventionRecord> {
    this.controllerAtPublish = this.lease.controller;
    this.log.push('raise');
    const record = InterventionRecord.parse({
      ...input, state: 'pending',
      raisedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    this.records.set(record.id, record);
    this.#emit(record);
    return new Promise((resolve) => { this.#settle = resolve; });
  }

  /** The console claiming it, from outside the run. */
  claim(id: string, operatorId: string): void {
    this.log.push('claim');
    this.#update(id, { state: 'claimed', claimedBy: operatorId, claimedAt: new Date().toISOString() });
  }

  finish(id: string, resolution: Resolution | 'timed_out', note?: string): void {
    this.log.push(`finish:${resolution}`);
    const state = resolution === 'timed_out' ? 'timed_out'
      : resolution === 'resolved' ? 'resolved'
      : resolution === 'skipped' ? 'skipped' : 'aborted';
    const record = this.#update(id, {
      state,
      ...(resolution !== 'timed_out' ? { resolution } : {}),
      ...(note !== undefined ? { note } : {}),
      resolvedAt: new Date().toISOString(),
    });
    this.#settle?.(record);
  }

  get(id: string): InterventionRecord | undefined { return this.records.get(id); }
  recordHumanAction(id: string, a: HumanAction): void {
    this.log.push(`action:${a.kind}`);
    const r = this.records.get(id);
    if (r) this.#update(id, { humanActions: [...r.humanActions, a] });
  }
  recordLeaseTransfers(id: string, transfers: InterventionRecord['leaseTransfers']): void {
    this.log.push('leaseTransfers');
    this.#update(id, { leaseTransfers: transfers });
  }
  recordAbandon(id: string, abandon: NonNullable<InterventionRecord['abandon']>): void {
    this.log.push('abandon');
    this.#update(id, { abandon });
  }
  onChange(fn: BusListener): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  #update(id: string, patch: Partial<InterventionRecord>): InterventionRecord {
    const next = { ...this.records.get(id)!, ...patch } as InterventionRecord;
    this.records.set(id, next);
    this.#emit(next);
    return next;
  }
  #emit(r: InterventionRecord): void { for (const fn of this.#listeners) fn(r); }
}

/** A capture stub: the handoff should arm it before anyone can touch anything. */
class StubCapture {
  armed = false;
  armedAt: number | null = null;
  readonly actions: HumanAction[] = [];
  #onAction: ((a: HumanAction) => void) | null = null;

  arm(onAction?: (a: HumanAction) => void): void {
    this.armed = true;
    this.armedAt = Date.now();
    this.#onAction = onAction ?? null;
  }
  disarm(): HumanAction[] { this.armed = false; return [...this.actions]; }
  /** Simulate the operator doing something in the browser. */
  human(a: HumanAction): void { this.actions.push(a); this.#onAction?.(a); }
}

function setup(runId: string) {
  const lease = new SessionLease(runId);
  const bus = new StubBus(lease);
  const capture = new StubCapture();
  const evidence = new EvidenceWriter({
    runId, root: EVIDENCE_ROOT, redactor: buildRedactor({ secrets: {} }),
  });
  const channel = createHandoff({
    bus, lease, evidence, runId,
    capability: { id: 'cap.member.read_savings_balance', version: '1.0.0' },
    capture: capture as unknown as Parameters<typeof createHandoff>[0]['capture'],
  });
  return { lease, bus, capture, evidence, channel };
}

const request = (): EscalationRequest => ({
  interventionId: 'int-1',
  reason: 'recovery_exhausted',
  detail: 'the account row never appeared',
  stepId: 's4',
  stepIntent: 'open the savings account',
  actionKind: 'click',
  actionClass: 'read',
  url: 'http://localhost:4400/frame/members/12345',
  title: 'Member 12345',
});

const kinds = (e: EvidenceWriter): string[] => e.events.map((x) => x.kind);

describe('the handoff protocol', () => {
  it('cedes before the intervention is visible to anybody', async () => {
    const { bus, channel, lease } = setup('run-order');
    const waiting = channel.raise(request());
    await Promise.resolve();

    // Publishing first would leave a window in which the console offers a
    // claimable session that automation is still driving, and the operator's
    // first click lands in it.
    expect(bus.controllerAtPublish).toBe('none');
    expect(lease.generation).toBe(2);

    bus.claim('int-1', 'rahul');
    bus.finish('int-1', 'resolved');
    await waiting;
  });

  it('cedes to nobody, not to an operator who has not arrived', async () => {
    const { bus, channel, lease } = setup('run-none');
    const waiting = channel.raise(request());
    await Promise.resolve();

    // Handing control straight to "operator" would make the audit log claim a
    // person was driving a session they had never seen.
    expect(lease.controller).toBe('none');
    expect(lease.history[0]).toMatchObject({ from: 'automation', to: 'none' });

    bus.claim('int-1', 'rahul');
    bus.finish('int-1', 'resolved');
    await waiting;
  });

  it('arms capture before the intervention is published', async () => {
    const { bus, channel, capture } = setup('run-capture');
    const waiting = channel.raise(request());
    await Promise.resolve();
    // The very first thing an operator does must already be recorded.
    expect(capture.armed).toBe(true);
    expect(bus.log[0]).toBe('raise');

    bus.claim('int-1', 'rahul');
    bus.finish('int-1', 'resolved');
    await waiting;
  });

  it('moves the lease to the operator when the console claims it', async () => {
    const { bus, channel, lease } = setup('run-claim');
    const waiting = channel.raise(request());
    await Promise.resolve();

    bus.claim('int-1', 'rahul');
    // The console moved the record; the lease has to follow, or enforcement
    // and audit disagree about who is holding a live banking session.
    expect(lease.controller).toBe('operator');
    expect(lease.state.holderId).toBe('rahul');
    expect(lease.generation).toBe(3);

    bus.finish('int-1', 'resolved');
    const res = await waiting;
    expect(res.claimedBy).toBe('rahul');
  });

  it('runs the full cycle and returns control at a new generation', async () => {
    const { bus, channel, lease, evidence } = setup('run-cycle');
    const waiting = channel.raise(request());
    await Promise.resolve();
    bus.claim('int-1', 'rahul');
    bus.finish('int-1', 'resolved', 'unlocked the account by hand');

    const res = await waiting;
    expect(res.resolution).toBe('resolved');
    expect(lease.controller).toBe('automation');
    expect(lease.generation).toBe(4);
    expect(lease.history.map((h) => `${h.from}->${h.to}`)).toEqual([
      'automation->none', 'none->operator', 'operator->automation',
    ]);
    expect(kinds(evidence)).toEqual([
      'lease.transfer', 'escalation.claimed', 'escalation.resumed',
    ]);
  });

  it('records what the operator touched, and hands the count back to the run', async () => {
    const { bus, channel, capture } = setup('run-actions');
    const waiting = channel.raise(request());
    await Promise.resolve();
    bus.claim('int-1', 'rahul');

    capture.human({ at: new Date().toISOString(), kind: 'input', target: 'Password', role: 'password', valueLength: 8 });
    capture.human({ at: new Date().toISOString(), kind: 'click', target: 'Sign In', role: 'button' });

    bus.finish('int-1', 'resolved');
    const res = await waiting;

    expect(res.humanActionCount).toBe(2);
    expect(capture.armed).toBe(false);       // disarmed on the way out
    expect(bus.get('int-1')?.humanActions).toHaveLength(2);
    // What was touched, never what was typed.
    const typed = bus.get('int-1')!.humanActions[0]!;
    expect(typed.valueLength).toBe(8);
    expect(JSON.stringify(typed)).not.toContain('hunter2');
  });

  it('takes the session back when nobody came, so the run can leave safely', async () => {
    const { bus, channel, lease, evidence } = setup('run-timeout');
    const waiting = channel.raise(request());
    await Promise.resolve();
    bus.finish('int-1', 'timed_out', 'nobody responded within 60s');

    const res = await waiting;
    expect(res.resolution).toBe('timed_out');
    // Reclaimed, but only in order to abandon: the run does not continue.
    expect(lease.controller).toBe('automation');
    expect(kinds(evidence)).toEqual(['lease.transfer', 'escalation.timeout']);
    expect(evidence.events.at(-1)!.message).toContain('leave the screen safely');
  });

  it('writes the intervention to evidence whatever the outcome', async () => {
    const { bus, channel, evidence } = setup('run-evidence');
    const waiting = channel.raise(request());
    await Promise.resolve();
    bus.claim('int-1', 'rahul');
    bus.finish('int-1', 'aborted', 'this member is disputed; not touching it');
    await waiting;

    const { readFileSync } = await import('node:fs');
    const written = JSON.parse(
      readFileSync(`${evidence.dir}/interventions/int-1.json`, 'utf8')) as Record<string, unknown>;
    expect(written.resolution).toBe('aborted');
    expect(written.note).toContain('disputed');
    expect(written.leaseTransfers).toHaveLength(3);
  });

  it('attaches the whole lease history to the record, for the audit', async () => {
    const { bus, channel } = setup('run-audit');
    const waiting = channel.raise(request());
    await Promise.resolve();
    bus.claim('int-1', 'rahul');
    bus.finish('int-1', 'skipped');
    await waiting;

    expect(bus.get('int-1')!.leaseTransfers.map((t) => t.to))
      .toEqual(['none', 'operator', 'automation']);
    expect(bus.log).toContain('leaseTransfers');
  });
});

describe('a console that is polled rather than local', () => {
  it('still records that a person held the session', async () => {
    // A remote console is polled, so an operator who claims and hands back
    // inside one poll interval is only ever *observed* as resolved. The lease
    // must still show they held it - otherwise the audit trail for a
    // cross-process handoff is missing the one fact it exists to record.
    const { bus, channel, lease } = setup('run-polled');
    const waiting = channel.raise(request());
    await Promise.resolve();

    // No separate claim event reaches us: the first thing we see is terminal.
    bus.records.set('int-1', {
      ...bus.records.get('int-1')!,
      state: 'resolved', resolution: 'resolved',
      claimedBy: 'rahul', claimedAt: new Date().toISOString(),
    });
    bus.finish('int-1', 'resolved');
    await waiting;

    expect(lease.history.map((h) => `${h.from}->${h.to}`)).toEqual([
      'automation->none', 'none->operator', 'operator->automation',
    ]);
  });
});
