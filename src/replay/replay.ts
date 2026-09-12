/**
 * Deterministic replay - the production execution path.
 *
 * No model is consulted here. Not as a matter of discipline: this module is
 * forbidden by eslint from importing the planner or any model SDK, a source
 * scan in tests/determinism re-checks it, and every result it returns carries
 * `metrics.llmCalls`, which is asserted to be zero. Three guards, because this
 * is the property the whole design rests on. If replay can consult a model then
 * it is not replay, it is a cheaper discovery run wearing a costume.
 *
 * Each step runs the same cycle, and the cycle is the error taxonomy:
 *
 *   observe -> outcomes? -> preconditions -> act -> wait -> checkpoint -> extract
 *
 * At every stage there are four possible answers, and keeping them distinct is
 * the single most important thing this file does:
 *
 *   the goal was reached                 -> success, with typed outputs
 *   the app gave a legitimate answer     -> business_outcome  (NOT a failure)
 *   something known went wrong           -> recover, bounded, and carry on
 *   something unknown went wrong         -> fail, with enough detail to debug
 *
 * Business outcomes are checked *before* preconditions on every step, because
 * "no such member" arrives as ordinary page content with HTTP 200 and would
 * otherwise surface as a precondition failure - a crash where the caller asked
 * a question and got a perfectly good answer.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import type {
  CapabilityArtifact, Step, RecoveryRule, BusinessOutcome, ExtractSpec, ActionClass,
} from '../core/schema.ts';
import type {
  ReplayResult, StepTrace, DriftRecord, RecoveryTrace, FailureCode, FailureDetail,
  EscalationDetail,
} from '../core/result.ts';
import type { Surface } from '../surface/surface.ts';
import type { UiSnapshot } from '../surface/uinode.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { EvidenceWriter } from '../evidence/writer.ts';
import { Executor, interpolateUrl, type ActRequest } from '../exec/executor.ts';
import { SessionLease } from '../exec/lease.ts';
import { evaluate, evaluateAll } from '../exec/predicates.ts';
import { waitFor, waitForQuiescence } from '../exec/waits.ts';
import { resolveBundle } from '../surface/locator/resolve.ts';
import { artifactHash } from '../core/integrity.ts';
import { applyOverlay } from './overlay.ts';
import type { SecretResolver } from '../policy/secrets.ts';
import { renderReport } from '../evidence/reportHtml.ts';

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, unknown>;
  surface: Surface;
  policy: PolicyEngine;
  evidence: EvidenceWriter;
  lease?: SessionLease;
  baseUrl: string;
  tenant?: string | undefined;
  approvalGranted?: boolean;
  /** Resolves `$secret.NAME` references in step data. Without one, a step that
   *  needs a credential fails cleanly rather than typing the literal text. */
  secrets?: SecretResolver | undefined;
  /** Raised when the run cannot safely continue on its own. Phase 5 wires a
   *  real operator to this; without one, escalation fails cleanly. */
  onEscalate?: ((req: EscalationRequest) => Promise<EscalationResolution>) | undefined;
}

export interface EscalationRequest {
  interventionId: string;
  reason: 'locator_unresolved' | 'unknown_dialog' | 'recovery_exhausted'
        | 'irreversible_action_needs_approval' | 'policy_requires_approval' | 'not_safely_abandonable';
  detail: string;
  stepId: string;
  stepIntent: string;
  snapshot: UiSnapshot;
  screenshotPath?: string;
}

export interface EscalationResolution {
  resolution: 'resolved' | 'aborted' | 'skipped' | 'timed_out';
  claimedBy?: string;
  humanActionCount?: number;
}

/**
 * Runs the artifact and writes the run's report.
 *
 * The report is written for every outcome, including - especially - the ones
 * that went wrong. Evidence you only produce on success is marketing.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const result = await runReplay(opts);
  try {
    opts.evidence.text('report.html', renderReport({
      runId: opts.evidence.runId,
      events: [...opts.evidence.events],
      manifest: {
        capability: opts.artifact.title, version: opts.artifact.version,
        tenant: opts.tenant, status: result.status,
      },
      result,
    }));
  } catch {
    // A report that fails to render must not turn a good run into a bad one.
  }
  return result;
}

async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const { evidence, surface } = opts;

  const artifact = opts.tenant
    ? applyOverlay(opts.artifact, opts.tenant)
    : opts.artifact;

  const lease = opts.lease ?? new SessionLease(evidence.runId);
  const executor = new Executor({
    surface, policy: opts.policy, lease, evidence,
    approvalGranted: opts.approvalGranted ?? false,
  });

  const steps: StepTrace[] = [];
  const drift: DriftRecord[] = [];
  const outputs: Record<string, unknown> = {};
  let retries = 0;
  let recoveries = 0;
  let degradedResolutions = 0;

  const envelope = () => ({
    runId: evidence.runId,
    capability: {
      id: artifact.id, version: artifact.version,
      hash: artifactHash(artifact), status: artifact.status,
    },
    ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    steps, drift,
    metrics: {
      stepsExecuted: steps.length, retries, recoveries, degradedResolutions,
      // Not a hopeful comment: asserted in tests/determinism.
      llmCalls: 0,
    },
    evidenceDir: evidence.dir,
  });

  evidence.event('run.start',
    `Replaying ${artifact.id} v${artifact.version} (${artifact.status})`
    + `${opts.tenant ? ` for tenant ${opts.tenant}` : ''}, with no model in the loop.`,
    { capability: artifact.id, version: artifact.version, tenant: opts.tenant,
      inputs: Object.keys(opts.inputs) });

  // ---- Inputs must satisfy the published contract -------------------------
  const badInput = validateInputs(artifact, opts.inputs);
  if (badInput) {
    evidence.event('run.end', `Refusing to start: ${badInput}`, { reason: 'artifact_invalid' });
    const result: ReplayResult = {
      ...envelope(), status: 'failed',
      failure: { code: 'artifact_invalid', message: badInput,
        expected: 'inputs matching the capability contract', observed: badInput, evidence: [] },
    };
    evidence.close({ status: result.status, failure: badInput });
    return result;
  }

  // Same idea as the input check above, and for the same reason: a capability
  // that asks for a credential this environment cannot supply is unrunnable,
  // and finding that out six steps in - as an uncaught throw from inside the
  // secret resolver, which is what used to happen - turns a configuration
  // mistake into a stack trace. It is a typed failure, and it happens before
  // the browser opens.
  const missing = missingSecrets(artifact, opts.secrets);
  if (missing.length > 0) {
    const detail = `this capability needs ${missing.map((n) => `$secret.${n}`).join(', ')} `
      + `and the environment does not supply ${missing.length === 1 ? 'it' : 'them'}`;
    evidence.event('run.end', `Refusing to start: ${detail}`, { reason: 'artifact_invalid', missing });
    const result: ReplayResult = {
      ...envelope(), status: 'failed',
      failure: { code: 'artifact_invalid', message: detail,
        expected: `${missing.join(', ')} set in the environment`,
        observed: 'not set - copy .env.example to .env and fill it in', evidence: [] },
    };
    evidence.close({ status: result.status, failure: detail });
    return result;
  }

  const params = { ...opts.inputs, baseUrl: opts.baseUrl };

  // ---- Entry --------------------------------------------------------------
  await surface.navigate(interpolateUrl(artifact.target.entry.template, params));
  let snapshot = await surface.observe();
  evidence.event('observe', `Entered at ${snapshot.url}.`,
    { url: snapshot.url, nodes: snapshot.nodes.length, structureHash: snapshot.structureHash });

  // ---- Steps --------------------------------------------------------------
  for (const [index, step] of artifact.steps.entries()) {
    evidence.event('step.begin', `Step ${index + 1}: ${step.intent}`,
      { index: index + 1, actionKind: step.action.kind, actionClass: step.actionClass }, step.id);

    // A declared business outcome anywhere on the page ends the run with an
    // answer. Checked first, because it is an answer and not an obstacle.
    const outcome = await detectOutcome(artifact.outcomes, snapshot, params, surface);
    if (outcome) {
      return finishWithOutcome(outcome.outcome, outcome.detail);
    }

    const stepResult = await runStep(step, index);
    steps.push(stepResult.trace);

    if (stepResult.kind === 'outcome') {
      return finishWithOutcome(stepResult.outcome, stepResult.detail);
    }
    if (stepResult.kind === 'failed') {
      evidence.event('run.end', `Run failed at ${step.id}: ${stepResult.failure.message}`,
        { code: stepResult.failure.code }, step.id);
      const result: ReplayResult = { ...envelope(), status: 'failed', failure: stepResult.failure };
      evidence.close({ status: result.status, failedAt: step.id, code: stepResult.failure.code });
      return result;
    }
    if (stepResult.kind === 'blocked') {
      const result: ReplayResult = {
        ...envelope(), status: 'blocked_by_policy',
        policy: { rule: stepResult.rule, stepId: step.id,
          attemptedAction: step.action.kind, reason: stepResult.reason },
      };
      evidence.event('run.end', `Run blocked by policy at ${step.id}: ${stepResult.reason}`,
        { rule: stepResult.rule }, step.id);
      evidence.close({ status: result.status, rule: stepResult.rule });
      return result;
    }
    if (stepResult.kind === 'escalated') {
      const result: ReplayResult = {
        ...envelope(), status: 'escalated', escalation: stepResult.escalation,
      };
      evidence.close({ status: result.status, intervention: stepResult.escalation.interventionId });
      return result;
    }

    snapshot = stepResult.snapshot;
  }

  // ---- Done ---------------------------------------------------------------
  evidence.event('run.end',
    `Completed ${artifact.steps.length} steps and extracted `
    + `${Object.keys(outputs).length} output(s).`, { outputs: Object.keys(outputs) });
  const result: ReplayResult = { ...envelope(), status: 'success', outputs };
  evidence.close({ status: result.status, outputs: Object.keys(outputs) });
  return result;

  // =========================================================================

  function finishWithOutcome(o: BusinessOutcome, detail: string): ReplayResult {
    evidence.event('outcome.detected',
      `The application answered "${o.code}": ${o.description} `
      + `This is a legitimate result, not a failure.`, { code: o.code, detail });
    const data: Record<string, unknown> = {};
    for (const [k, ref] of Object.entries(o.returns)) {
      data[k] = ref.startsWith('$input.') ? opts.inputs[ref.slice('$input.'.length)] : outputs[ref] ?? ref;
    }
    const result: ReplayResult = {
      ...envelope(), status: 'business_outcome',
      outcome: { code: o.code, description: o.description, severity: o.severity, data },
    };
    evidence.event('run.end', `Run ended with business outcome "${o.code}".`, { code: o.code });
    evidence.close({ status: result.status, outcome: o.code });
    return result;
  }

  type StepResult =
    | { kind: 'ok'; trace: StepTrace; snapshot: UiSnapshot }
    | { kind: 'outcome'; trace: StepTrace; outcome: BusinessOutcome; detail: string }
    | { kind: 'failed'; trace: StepTrace; failure: FailureDetail }
    | { kind: 'blocked'; trace: StepTrace; rule: string; reason: string }
    | { kind: 'escalated'; trace: StepTrace; escalation: EscalationDetail };

  async function runStep(step: Step, index: number): Promise<StepResult> {
    const stepStarted = new Date().toISOString();
    const st0 = Date.now();
    const recoveryTraces: RecoveryTrace[] = [];
    let stepRetries = 0;
    let resolution: StepTrace['resolution'];
    let preconditionsHeld: boolean | undefined;
    let checkpointHeld: boolean | undefined;
    const evidenceRefs: string[] = [];

    const trace = (status: StepTrace['status']): StepTrace => ({
      stepId: step.id, intent: step.intent,
      actionKind: step.action.kind, actionClass: step.actionClass,
      status,
      ...(resolution ? { resolution } : {}),
      ...(preconditionsHeld !== undefined ? { preconditionsHeld } : {}),
      ...(checkpointHeld !== undefined ? { checkpointHeld } : {}),
      retries: stepRetries, recoveries: recoveryTraces,
      startedAt: stepStarted, durationMs: Date.now() - st0,
      evidence: evidenceRefs,
    });

    const maxAttempts = step.budget.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) { stepRetries += 1; retries += 1; }

      // --- has a recovery already done this step's job? ---
      //
      // This is a correctness guard, not an optimisation. A recovery rule can
      // leave the world exactly where the step was trying to get it: the
      // reauth rule signs in, which is precisely what the sign-in step wanted.
      // Blindly re-running the action then does one of two things, and both
      // are bad. Usually it fails, because the control it needs is gone -
      // there is no Sign In button once you are signed in. Occasionally it
      // succeeds, and in a servicing console that means submitting the same
      // form twice: two sub-accounts, two transfers, two of whatever the step
      // committed.
      //
      // So before repeating an action, ask whether the step's own
      // postconditions already hold. If they do, the step is done, and the
      // honest thing is to move on rather than to insist on having been the
      // one to do it.
      let skipAction = false;
      if (attempt > 1 && (step.waitFor.length > 0 || step.checkpoint.length > 0)) {
        snapshot = await surface.observe();
        const already = await evaluateAll([...step.waitFor, ...step.checkpoint], {
          snapshot, params, surface,
        });
        if (already.held) {
          skipAction = true;
          evidence.event('checkpoint',
            `Recovery already reached the state this step wanted, so the action is not `
            + `being repeated. Re-submitting here would risk doing the work twice.`,
            { detail: already.detail }, step.id);
        }
      }

      if (!skipAction) {
        // --- preconditions ---
        const pre = await evaluateAll(step.preconditions, {
          snapshot, params, surface,
        });
        preconditionsHeld = pre.held;
        if (!pre.held) {
          evidence.event('precondition', `Preconditions do not hold: ${pre.detail}`, {}, step.id);
          const rec = await tryRecover(step, `precondition: ${pre.detail}`);
          if (rec === 'recovered') continue;
          if (rec === 'escalated') return escalate(step, 'recovery_exhausted', pre.detail, trace);
          if (attempt < maxAttempts) continue;
          return { kind: 'failed', trace: trace('failed'), failure: {
            code: 'precondition_failed', stepId: step.id,
            message: `the step's preconditions did not hold`,
            expected: step.preconditions.map((p) => JSON.stringify(p)).join('; ') || '(none)',
            observed: pre.detail, evidence: evidenceRefs,
          }};
        }

        // --- act ---
        const before = await captureShot(index, 'before');
        if (before) evidenceRefs.push(before);

        const req: ActRequest = {
          stepId: step.id, action: step.action, params, snapshot,
          ...(step.target ? { target: step.target } : {}),
          ...(step.data ? { text: materialise(step.data.value, params, opts.secrets) } : {}),
          declaredClass: step.actionClass as ActionClass,
        };
        const acted = await executor.act(req);

        if (!acted.ok) {
          if (acted.code === 'policy_denied') {
            return { kind: 'blocked', trace: trace('blocked'),
              rule: acted.decision.verdict === 'deny' ? acted.decision.rule : 'policy',
              reason: acted.observed };
          }
          if (acted.code === 'needs_approval') {
            return escalate(step, 'irreversible_action_needs_approval', acted.observed, trace);
          }
          const rec = await tryRecover(step, `${acted.code}: ${acted.observed}`);
          if (rec === 'recovered') continue;
          if (rec === 'escalated') return escalate(step, 'recovery_exhausted', acted.observed, trace);
          if (acted.retryable && attempt < maxAttempts) continue;

          // Before calling it a failure: did the app answer the question?
          const late = await detectOutcome(artifact.outcomes, snapshot, params, surface);
          if (late) return { kind: 'outcome', trace: trace('ok'), outcome: late.outcome, detail: late.detail };

          return { kind: 'failed', trace: trace('failed'), failure: {
            code: acted.code as FailureCode, stepId: step.id,
            message: `${step.intent} could not be completed`,
            expected: acted.expected, observed: acted.observed, evidence: evidenceRefs,
          }};
        }

        if (acted.resolution) {
          resolution = acted.resolution;
          if (acted.resolution.degraded) degradedResolutions += 1;
        }
        if (acted.drift) drift.push(acted.drift);
        snapshot = acted.snapshot;
      }

      // --- wait for the declared transition ---
      if (step.waitFor.length > 0) {
        const w = await waitFor(step.waitFor, {
          surface, params, timeoutMs: step.budget.timeoutMs, initial: snapshot,
        });
        snapshot = w.snapshot;
        evidence.event('wait',
          w.held ? `The expected change happened after ${w.elapsedMs}ms.`
                 : `The expected change never happened (${w.detail}).`,
          { held: w.held, elapsedMs: w.elapsedMs, attempts: w.attempts }, step.id);
        if (!w.held) {
          const outcomeNow = await detectOutcome(artifact.outcomes, snapshot, params, surface);
          if (outcomeNow) {
            return { kind: 'outcome', trace: trace('ok'), outcome: outcomeNow.outcome, detail: outcomeNow.detail };
          }
          const rec = await tryRecover(step, `wait: ${w.detail}`);
          if (rec === 'recovered') continue;
          if (rec === 'escalated') return escalate(step, 'recovery_exhausted', w.detail, trace);
          if (attempt < maxAttempts) continue;
          const shot = await captureShot(index, 'failure');
          if (shot) evidenceRefs.push(shot);
          return { kind: 'failed', trace: trace('failed'), failure: {
            code: 'wait_timeout', stepId: step.id,
            message: `the state change this step expected never happened`,
            expected: step.waitFor.map((p) => JSON.stringify(p)).join('; '),
            observed: w.detail, evidence: evidenceRefs,
          }};
        }
      } else {
        const q = await waitForQuiescence(surface, { timeoutMs: step.budget.timeoutMs });
        snapshot = q.snapshot;
      }

      // --- an outcome may have appeared as a result of this step ---
      const outcomeAfter = await detectOutcome(artifact.outcomes, snapshot, params, surface);
      if (outcomeAfter) {
        return { kind: 'outcome', trace: trace('ok'), outcome: outcomeAfter.outcome, detail: outcomeAfter.detail };
      }

      // --- checkpoint ---
      const cp = await evaluateAll(step.checkpoint, { snapshot, params, surface });
      checkpointHeld = cp.held;
      evidence.event('checkpoint',
        cp.held ? `Checkpoint held: ${cp.detail}`
                : `Checkpoint failed: ${cp.detail}`,
        { held: cp.held }, step.id);
      if (!cp.held) {
        const rec = await tryRecover(step, `checkpoint: ${cp.detail}`);
        if (rec === 'recovered') continue;
        if (rec === 'escalated') return escalate(step, 'recovery_exhausted', cp.detail, trace);
        if (attempt < maxAttempts) continue;
        const shot = await captureShot(index, 'failure');
        if (shot) evidenceRefs.push(shot);
        return { kind: 'failed', trace: trace('failed'), failure: {
          code: 'checkpoint_failed', stepId: step.id,
          message: `${step.intent} did not reach the state it should have`,
          expected: step.checkpoint.map((p) => JSON.stringify(p)).join('; '),
          observed: cp.detail, evidence: evidenceRefs,
        }};
      }

      // --- extract ---
      for (const spec of step.extract) {
        const got = await extractValue(spec, snapshot, params, surface);
        if (got === undefined) {
          return { kind: 'failed', trace: trace('failed'), failure: {
            code: 'extract_failed', stepId: step.id,
            message: `could not read "${spec.name}"`,
            expected: spec.from.description, observed: 'no value, or it did not parse',
            evidence: evidenceRefs,
          }};
        }
        outputs[spec.name] = got;
        evidence.event('extract', `Read ${spec.name}.`,
          { name: spec.name, sensitivity: spec.sensitivity }, step.id);
      }

      const after = await captureShot(index, 'after');
      if (after) evidenceRefs.push(after);

      const status: StepTrace['status'] = recoveryTraces.length > 0 ? 'recovered' : 'ok';
      evidence.event('step.end', `Step ${index + 1} ${status}.`,
        { status, durationMs: Date.now() - st0 }, step.id);
      return { kind: 'ok', trace: trace(status), snapshot };
    }

    return { kind: 'failed', trace: trace('failed'), failure: {
      code: 'budget_exceeded', stepId: step.id,
      message: `step exhausted its ${maxAttempts} attempts`,
      expected: `success within ${maxAttempts} attempts`, observed: 'still failing',
      evidence: evidenceRefs,
    }};

    // -----------------------------------------------------------------------

    /**
     * Bounded recovery. Every rule has a cap, every attempt is counted, and
     * nothing loops. "Recoverable" means a declared rule fired and worked -
     * not that we kept trying until something happened.
     */
    async function tryRecover(s: Step, why: string): Promise<'recovered' | 'none' | 'escalated'> {
      const rules: RecoveryRule[] = [...s.recovery, ...artifact.recovery];
      for (const rule of rules) {
        const applies = await evaluate(rule.when, { snapshot, params, surface });
        if (!applies.held) continue;

        const used = recoveryTraces.filter((r) => r.ruleId === rule.id).length;
        if (used >= rule.maxAttempts) {
          evidence.event('recovery',
            `"${rule.description}" already ran ${used} time(s) and is capped. Not retrying.`,
            { ruleId: rule.id, capped: true }, s.id);
          continue;
        }

        const r0 = Date.now();
        evidence.event('recovery',
          `Recovering from ${why} using "${rule.description}".`,
          { ruleId: rule.id, kind: rule.kind, attempt: used + 1 }, s.id);

        let ok = true;
        for (const act of rule.do) {
          const res = await executor.act({
            stepId: s.id, action: act.action, params, snapshot,
            ...(act.target ? { target: act.target } : {}),
            ...(act.data ? { text: materialise(act.data.value, params, opts.secrets) } : {}),
          });
          if (!res.ok) { ok = false; break; }
          snapshot = res.snapshot;
        }
        if (ok && rule.kind === 'wait_longer') {
          const q = await waitForQuiescence(surface, { timeoutMs: rule.budgetMs });
          snapshot = q.snapshot;
        }
        if (ok && rule.do.length === 0 && rule.kind === 'retry_with_backoff') {
          snapshot = await surface.observe();
        }

        recoveryTraces.push({
          ruleId: rule.id, kind: rule.kind, attempt: used + 1,
          succeeded: ok, durationMs: Date.now() - r0,
        });
        recoveries += 1;
        if (ok && rule.thenRetryStep) return 'recovered';
        if (ok) return 'recovered';
      }
      return 'none';
    }

    async function escalate(
      s: Step,
      reason: EscalationRequest['reason'],
      detail: string,
      mkTrace: (status: StepTrace['status']) => StepTrace,
    ): Promise<StepResult> {
      const interventionId = `int-${evidence.runId}-${s.id}`;
      const shot = await captureShot(index, 'escalation');
      if (shot) evidenceRefs.push(shot);

      evidence.event('escalation.raised',
        `Stopping and asking for a human: ${detail}`,
        { interventionId, reason, stepId: s.id }, s.id);

      if (!opts.onEscalate) {
        // No operator wired in. Failing cleanly and saying so is the honest
        // behaviour; pretending to escalate into the void is not.
        evidence.event('escalation.timeout',
          `No operator channel is configured, so the run cannot be handed over.`,
          { interventionId }, s.id);
        return { kind: 'escalated', trace: mkTrace('escalated'), escalation: {
          interventionId, reason, detail, raisedAtStepId: s.id,
          claimed: false, humanActionCount: 0, resolution: 'timed_out',
          evidence: evidenceRefs,
        }};
      }

      const res = await opts.onEscalate({
        interventionId, reason, detail, stepId: s.id, stepIntent: s.intent, snapshot,
        ...(shot ? { screenshotPath: shot } : {}),
      });
      executor.syncGeneration();
      snapshot = await surface.observe();

      evidence.event('escalation.resumed',
        `Control returned to automation; the operator ${res.resolution} the intervention.`,
        { interventionId, ...res }, s.id);

      return { kind: 'escalated', trace: mkTrace('escalated'), escalation: {
        interventionId, reason, detail, raisedAtStepId: s.id,
        claimed: res.resolution !== 'timed_out',
        ...(res.claimedBy !== undefined ? { claimedBy: res.claimedBy } : {}),
        humanActionCount: res.humanActionCount ?? 0,
        resolution: res.resolution,
        resumedAt: new Date().toISOString(),
        evidence: evidenceRefs,
      }};
    }
  }

  async function captureShot(index: number, label: string): Promise<string | null> {
    try {
      const mask = snapshot.nodes.filter(isSensitiveNode);
      const bytes = await surface.screenshot({ mask });
      return evidence.image(evidence.stepPath(index + 1, `${label}.png`), bytes);
    } catch {
      return null;   // evidence capture must never break a run
    }
  }
}

/**
 * Nodes masked out of every screenshot.
 *
 * Deliberately shape-based rather than a list of field names: an unknown
 * servicing screen will show regulated data in a field nobody told us about,
 * and guessing wrong there is the expensive direction.
 */
function isSensitiveNode(n: { name: string; value?: string }): boolean {
  const text = `${n.name} ${n.value ?? ''}`;
  return /\b\d{3}-\d{2}-\d{4}\b/.test(text) || /\b(?:\d[ -]?){13,19}\b/.test(text);
}

async function detectOutcome(
  outcomes: BusinessOutcome[],
  snapshot: UiSnapshot,
  params: Record<string, unknown>,
  surface: Surface,
): Promise<{ outcome: BusinessOutcome; detail: string } | null> {
  for (const o of outcomes) {
    const r = await evaluate(o.detect, { snapshot, params, surface });
    if (r.held) return { outcome: o, detail: r.detail };
  }
  return null;
}

async function extractValue(
  spec: ExtractSpec,
  snapshot: UiSnapshot,
  params: Record<string, unknown>,
  surface: Surface,
): Promise<unknown> {
  const r = resolveBundle(spec.from, snapshot, params);
  if (!r.ok) return undefined;
  const raw = (await surface.readText(r.value.node)) || r.value.node.name;
  switch (spec.parse.kind) {
    case 'text':   return spec.parse.trim ? raw.trim() : raw;
    case 'number': { const n = Number(raw.replace(/[^0-9.-]/g, '')); return Number.isNaN(n) ? undefined : n; }
    case 'currency': {
      const n = Number(raw.replace(/[^0-9.-]/g, ''));
      return Number.isNaN(n) ? undefined : n;
    }
    case 'date':   return raw.trim();
    case 'regex': {
      const m = new RegExp(spec.parse.pattern).exec(raw);
      return m ? m[spec.parse.group] : undefined;
    }
  }
}

/**
 * Turns a recorded value into the text to type.
 *
 * `$input.x` comes from the caller. `$secret.NAME` is resolved from the
 * environment and registered with the redactor at the moment it is resolved,
 * so the value is already unprintable before anything can print it. An
 * artifact therefore never contains a credential - only a reference to one,
 * which is what makes artifacts safe to review in a pull request.
 */
/**
 * Every `$secret.NAME` the artifact mentions that this environment cannot
 * supply. Read off the whole artifact rather than only the step data, because
 * a recovery rule or a tenant overlay can reference one too.
 */
function missingSecrets(artifact: CapabilityArtifact, secrets?: SecretResolver): string[] {
  const names = new Set<string>();
  for (const m of JSON.stringify(artifact).matchAll(/\$secret\.([A-Za-z0-9_]+)/g)) {
    names.add(m[1]!);
  }
  const missing: string[] = [];
  for (const name of names) {
    if (!secrets) { missing.push(name); continue; }
    try {
      secrets.resolve({ $secret: `env:${name}` });
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

function materialise(
  value: string,
  params: Record<string, unknown>,
  secrets?: SecretResolver,
): string {
  return value
    .replace(/\$secret\.([A-Za-z0-9_]+)/g, (whole, name: string) => {
      if (!secrets) return whole;
      return secrets.resolve({ $secret: `env:${name}` });
    })
    .replace(/\$input\.([A-Za-z0-9_]+)/g, (whole, key: string) => {
      const v = params[key];
      return v === undefined ? whole : String(v);
    });
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap<object, ValidateFunction>();

/** Returns an error string, or null when the inputs satisfy the contract. */
function validateInputs(artifact: CapabilityArtifact, inputs: Record<string, unknown>): string | null {
  let validate = validators.get(artifact.inputs);
  if (!validate) {
    validate = ajv.compile(artifact.inputs);
    validators.set(artifact.inputs, validate);
  }
  if (validate(inputs)) return null;
  return (validate.errors ?? [])
    .map((e) => `inputs${e.instancePath} ${e.message}`)
    .join('; ') || 'inputs do not satisfy the capability contract';
}
