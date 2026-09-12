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
import type { EscalationChannel, EscalationRequest } from '../escalation/handoff.ts';

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
  /**
   * Where a stuck run goes to ask for a human.
   *
   * Optional, and the absence is designed behaviour rather than a gap: with no
   * channel wired, an escalation fails cleanly and says there was nobody to
   * ask. Escalating into a void nobody is watching would look like working and
   * be worse than failing honestly.
   *
   * The import is type-only on purpose. Replay depends on the *shape* of a
   * channel and on none of its machinery - no bus, no console, no browser
   * hooks - so the deterministic path carries none of that weight.
   */
  escalation?: EscalationChannel | undefined;
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
  let interventions = 0;
  /**
   * Set when a human actually held this session and the run carried on
   * afterwards.
   *
   * It changes the terminal status, and that is the point. The same reasoning
   * that keeps `business_outcome` out of `failed` applies here: a run a person
   * had to take over is not the same event as a run that completed on its own,
   * and a caller who cannot tell them apart will treat them the same. Recovery
   * stays invisible in the status because recovery is the machine working
   * within declared bounds (#10); a human taking control of a customer's
   * session is the thing the audit trail exists for.
   */
  // A holder rather than a bare `let`: the assignments happen inside nested
  // closures, which TypeScript's flow analysis does not look into, so a plain
  // variable narrows to `null` at the check below and the whole branch becomes
  // unreachable in the type system while being perfectly reachable at runtime.
  const humanHeld: { detail: EscalationDetail | null } = { detail: null };

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
      interventions,
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
    // The artifact's own run budget, enforced before the step rather than
    // reported after it. A budget that is only checked on the way out is a
    // description of what happened, not a limit on it.
    const overBudget = await checkRunBudget(step, index);
    if (overBudget) return overBudget;

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
  if (humanHeld.detail) {
    evidence.event('run.end',
      `Completed all ${artifact.steps.length} steps, but only because `
      + `${humanHeld.detail.claimedBy ?? 'an operator'} took the session at `
      + `${humanHeld.detail.raisedAtStepId}. Reporting this as escalated rather than a `
      + `clean success: the outputs are good, and a caller still needs to know a person `
      + `was required to get them.`,
      { outputs: Object.keys(outputs), intervention: humanHeld.detail.interventionId });
    const escalatedResult: ReplayResult = {
      ...envelope(), status: 'escalated', escalation: humanHeld.detail, outputs,
    };
    evidence.close({
      status: escalatedResult.status, outputs: Object.keys(outputs),
      intervention: humanHeld.detail.interventionId,
    });
    return escalatedResult;
  }

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

    // `let`, because a human who resolves an intervention buys the step one
    // more attempt. Without that, a step declared with `retries: 0` would have
    // no attempt left to resume into and the handoff would be theatre: the
    // operator fixes the problem and the run fails anyway.
    let maxAttempts = step.budget.retries + 1;
    let humanResumes = 0;
    let justResumed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // A resumed attempt is not a retry. The step is not being re-tried
      // because it failed on its own; it is being re-checked because somebody
      // changed the world underneath it, and counting that as a retry would
      // make the reliability numbers quietly wrong.
      if (attempt > 1 && !justResumed) { stepRetries += 1; retries += 1; }
      justResumed = false;

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
          // The step's own retry budget comes first. A declared remedy being
          // spent does not mean the page was not simply slow, and escalating
          // over a retry the artifact already asked for would put a person in
          // the loop for something the machine was about to handle.
          if (attempt < maxAttempts) continue;
          if (rec === 'escalated') {
            const e = await escalateStep(step, 'recovery_exhausted', pre.detail, trace);
            if (e.kind === 'retry') { justResumed = true; maxAttempts += 1; continue; }
            return e.result;
          }
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
            const e = await escalateStep(step, 'irreversible_action_needs_approval', acted.observed, trace);
            if (e.kind === 'retry') { justResumed = true; maxAttempts += 1; continue; }
            return e.result;
          }
          const rec = await tryRecover(step, `${acted.code}: ${acted.observed}`);
          if (rec === 'recovered') continue;
          if (acted.retryable && attempt < maxAttempts) continue;
          if (rec === 'escalated') {
            const e = await escalateStep(step, 'recovery_exhausted', acted.observed, trace);
            if (e.kind === 'retry') { justResumed = true; maxAttempts += 1; continue; }
            return e.result;
          }

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
          if (attempt < maxAttempts) continue;
          if (rec === 'escalated') {
            const e = await escalateStep(step, 'recovery_exhausted', w.detail, trace);
            if (e.kind === 'retry') { justResumed = true; maxAttempts += 1; continue; }
            return e.result;
          }
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
        if (attempt < maxAttempts) continue;
        if (rec === 'escalated') {
          const e = await escalateStep(step, 'recovery_exhausted', cp.detail, trace);
          if (e.kind === 'retry') { justResumed = true; maxAttempts += 1; continue; }
          return e.result;
        }
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
     *
     * The three return values are three genuinely different situations, and the
     * difference between the last two is where escalation earns its place:
     *
     *   recovered  a declared rule matched and fixed it. Carry on.
     *   none       nothing matched. We have never seen this before, so there is
     *              no remedy to be out of - it is an unknown failure, and a
     *              plain `failed` with expected/observed is the honest answer.
     *   escalated  a rule matched and could not fix it, either because it
     *              failed or because it is out of attempts. That is different
     *              in kind: the condition was recognised, the declared remedy
     *              was applied, and it did not work. Retrying the raw action
     *              after that is just doing the same thing again more quietly.
     *              It is a person's problem now.
     *
     * Collapsing those last two is how "bounded recovery" quietly becomes
     * "gives up", and it is why this function returns a verdict rather than a
     * boolean.
     */
    async function tryRecover(s: Step, why: string): Promise<'recovered' | 'none' | 'escalated'> {
      const rules: RecoveryRule[] = [...s.recovery, ...artifact.recovery];
      /** Did anything declared claim this condition? */
      let recognised = false;
      for (const rule of rules) {
        const applies = await evaluate(rule.when, { snapshot, params, surface });
        if (!applies.held) continue;
        recognised = true;

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

      if (recognised) {
        evidence.event('recovery',
          `Every declared recovery for this condition has been tried or is capped, `
          + `and ${why} is still true. Asking for a human rather than retrying.`,
          { recognised: true, exhausted: true }, s.id);
        return 'escalated';
      }
      return 'none';
    }

    /**
     * Stop, ask for a human, and turn what they decided into what this step
     * does next.
     *
     * The translation is the interesting part, because "a human dealt with it"
     * is not one outcome, it is three, and collapsing them is how escalation
     * becomes a fancy way to fail:
     *
     *   resolved  they cleared the obstacle. The step re-checks itself and
     *             carries on - and critically, it re-checks *before* acting,
     *             because the thing they did may well be the thing the step
     *             was trying to do. That guard already exists at the top of
     *             the attempt loop and this reuses it rather than inventing a
     *             second, subtly different one.
     *   skipped   they handled it outside the flow, or it does not apply. The
     *             step is marked skipped and the run moves on.
     *   aborted   stop. Ends the run as `escalated`, with the record attached.
     *   timed_out nobody came. The run leaves the screen safely and stops.
     *
     * Resumes are bounded by the artifact. An unbounded resume loop is an
     * operator and an automation taking turns failing at the same step, which
     * costs a person's afternoon and produces nothing.
     */
    async function escalateStep(
      s: Step,
      reason: EscalationRequest['reason'],
      detail: string,
      mkTrace: (status: StepTrace['status']) => StepTrace,
    ): Promise<{ kind: 'retry' } | { kind: 'stop'; result: StepResult }> {
      const interventionId = `int-${evidence.runId}-${s.id}`;
      const shot = await captureShot(index, 'escalation');
      if (shot) evidenceRefs.push(shot);

      interventions += 1;
      evidence.event('escalation.raised',
        `Stopping and asking for a human: ${detail}`,
        { interventionId, reason, stepId: s.id, intent: s.intent }, s.id);

      const terminal = (
        res: { resolution: EscalationDetail['resolution']; claimedBy?: string; humanActionCount: number },
      ): { kind: 'stop'; result: StepResult } => ({
        kind: 'stop',
        result: { kind: 'escalated', trace: mkTrace('escalated'), escalation: {
          interventionId, reason, detail, raisedAtStepId: s.id,
          claimed: res.resolution !== 'timed_out',
          ...(res.claimedBy !== undefined ? { claimedBy: res.claimedBy } : {}),
          humanActionCount: res.humanActionCount,
          ...(res.resolution !== undefined ? { resolution: res.resolution } : {}),
          resumedAt: new Date().toISOString(),
          evidence: evidenceRefs,
        }},
      });

      /** One shape for "a human was here", used by both continuing outcomes. */
      const detailFor = (
        resolution: 'resolved' | 'skipped',
        r: { claimedBy?: string; humanActionCount: number; note?: string },
        id: string, why: EscalationRequest['reason'], what: string, stepId: string,
      ): EscalationDetail => ({
        interventionId: id, reason: why, detail: what, raisedAtStepId: stepId,
        claimed: true,
        ...(r.claimedBy !== undefined ? { claimedBy: r.claimedBy } : {}),
        humanActionCount: r.humanActionCount,
        resolution,
        resumedAt: new Date().toISOString(),
        evidence: evidenceRefs,
      });

      if (!opts.escalation) {
        // Nobody is wired in. Failing cleanly and saying so is the honest
        // behaviour; pretending to hand over to an empty room is not.
        evidence.event('escalation.timeout',
          `No operator channel is configured, so this run cannot be handed over. `
          + `Start one with "cua operator" and pass --operator to route to it.`,
          { interventionId }, s.id);
        await abandonSafely(interventionId, s);
        return terminal({ resolution: 'timed_out', humanActionCount: 0 });
      }

      const res = await opts.escalation.raise({
        interventionId, reason, detail,
        stepId: s.id, stepIntent: s.intent,
        actionKind: s.action.kind, actionClass: s.actionClass,
        url: snapshot.url, title: snapshot.title,
        timeoutMs: artifact.escalation.timeoutMs,
        ...(shot ? { screenshotPath: shot } : {}),
      });

      // Whatever they did, the run's picture of the page is now stale, and the
      // generation it planned under is two transfers old. Both are refreshed
      // before anything else happens - re-observing is not a nicety here, it
      // is the difference between resuming and acting on a screen that is no
      // longer there.
      executor.syncGeneration();
      snapshot = await surface.observe();
      evidence.event('observe',
        `Re-observed after the handoff: ${snapshot.url}.`,
        { url: snapshot.url, structureHash: snapshot.structureHash }, s.id);

      const humanActionCount = res.humanActionCount;

      switch (res.resolution) {
        case 'resolved': {
          if (humanResumes >= artifact.escalation.maxResumes) {
            evidence.event('escalation.timeout',
              `This step has already been resumed ${humanResumes} time(s), which is its `
              + `limit. Stopping rather than handing the same problem back again.`,
              { interventionId, maxResumes: artifact.escalation.maxResumes }, s.id);
            return terminal({ resolution: 'aborted', humanActionCount,
              ...(res.claimedBy !== undefined ? { claimedBy: res.claimedBy } : {}) });
          }
          humanResumes += 1;
          humanHeld.detail = detailFor('resolved', res, interventionId, reason, detail, s.id);
          evidence.event('escalation.resumed',
            `Resuming ${s.id}. The step re-checks its own postconditions before acting, `
            + `because the operator may already have done what it was about to do.`,
            { interventionId, resume: humanResumes }, s.id);
          return { kind: 'retry' };
        }

        case 'skipped': {
          humanHeld.detail = detailFor('skipped', res, interventionId, reason, detail, s.id);
          evidence.event('step.end',
            `Skipping ${s.id} at the operator's instruction.`,
            { status: 'skipped', interventionId }, s.id);
          return { kind: 'stop', result: { kind: 'ok', trace: mkTrace('skipped'), snapshot } };
        }

        case 'timed_out':
          await abandonSafely(interventionId, s);
          return terminal({ resolution: 'timed_out', humanActionCount,
            ...(res.claimedBy !== undefined ? { claimedBy: res.claimedBy } : {}) });

        case 'aborted':
        default:
          return terminal({ resolution: 'aborted', humanActionCount,
            ...(res.claimedBy !== undefined ? { claimedBy: res.claimedBy } : {}) });
      }
    }
  }

  /**
   * Leaving the screen, when nobody came.
   *
   * The half of escalation that is easy to skip and expensive to omit. A run
   * that raises an intervention and then simply stops has left a half-filled
   * servicing form open in a live session - which is not "safe by default", it
   * is an unattended browser sitting on a page that commits money if anything
   * touches it.
   *
   * So the artifact declares where to go, and the run goes there. Returning to
   * the entry screen is safe by construction: it is where the flow begins, so
   * nothing is in flight there, and getting to it discards an in-progress form
   * without submitting it - the same thing a person does when they give up on
   * a form.
   *
   * Note it goes through the executor. The abandon path is an action like any
   * other, so it is policy-checked against its destination like any other. An
   * escape hatch that skipped policy would be the most attractive place in the
   * system to hide a navigation.
   */
  async function abandonSafely(interventionId: string, step: Step): Promise<void> {
    const spec = artifact.escalation.abandon;

    if (spec.kind === 'none') {
      const detail = 'this capability declares no safe abandon path, so the session has been '
        + 'left exactly as it is for whoever arrives';
      evidence.event('escalation.timeout',
        `Not touching anything: ${detail}.`, { interventionId, abandon: 'none' }, step.id);
      opts.escalation?.noteAbandon?.(interventionId, { kind: 'none', performed: false, detail });
      return;
    }

    const url = interpolateUrl(
      spec.kind === 'entry' ? artifact.target.entry.template : spec.urlTemplate, params);

    const res = await executor.act({
      stepId: step.id, action: { kind: 'navigate', urlTemplate: url }, params, snapshot,
      declaredClass: 'read',
    });

    if (res.ok) {
      snapshot = res.snapshot;
      const detail = `navigated to ${url}, leaving nothing in flight`;
      evidence.event('escalation.timeout',
        `Abandoned safely: ${detail}.`, { interventionId, abandon: spec.kind, url }, step.id);
      opts.escalation?.noteAbandon?.(interventionId, { kind: spec.kind, performed: true, detail });
      return;
    }

    // The abandon path itself failed. This is the state the taxonomy calls
    // `not_safely_abandonable`, and it is worth saying loudly rather than
    // quietly returning: the session is stuck on a screen the run could not
    // leave, and a person has to look at it.
    const detail = `could not reach ${url}: ${res.observed}`;
    evidence.event('escalation.timeout',
      `Could not abandon safely. ${detail}. The session has been left where it is.`,
      { interventionId, abandon: spec.kind, url, failed: true }, step.id);
    opts.escalation?.noteAbandon?.(interventionId, { kind: spec.kind, performed: false, detail });
  }

  /**
   * The run's own budget, checked before each step.
   *
   * Two limits with two different meanings. Exceeding `maxSteps` means the
   * artifact is longer than it says it is - a contract violation, and a plain
   * failure. Exceeding `maxWallClockMs` means the app went slow enough that the
   * run should stop, and whether that is safe depends entirely on where it
   * stopped: mid-flow on a capability with no declared abandon path, it is not,
   * and that is the one case the taxonomy has a dedicated escalation reason
   * for. Failing there would be the wrong answer - it would report a stuck
   * session as a closed matter.
   */
  async function checkRunBudget(step: Step, index: number): Promise<ReplayResult | null> {
    const elapsed = Date.now() - t0;
    const overSteps = index >= artifact.policy.maxSteps;
    const overClock = elapsed > artifact.policy.maxWallClockMs;
    if (!overSteps && !overClock) return null;

    const message = overSteps
      ? `the run reached its ${artifact.policy.maxSteps}-step limit`
      : `the run exceeded its ${artifact.policy.maxWallClockMs}ms wall-clock budget after ${elapsed}ms`;

    const strandedMidFlow = overClock
      && index > 0
      && artifact.escalation.abandon.kind === 'none';

    if (strandedMidFlow && opts.escalation) {
      interventions += 1;
      evidence.event('escalation.raised',
        `Out of time at ${step.id}, and this capability cannot be abandoned unattended. `
        + `Asking for a human rather than walking away from a live screen.`,
        { reason: 'not_safely_abandonable', elapsed }, step.id);
      const interventionId = `int-${evidence.runId}-budget`;
      const res = await opts.escalation.raise({
        interventionId, reason: 'not_safely_abandonable', detail: message,
        stepId: step.id, stepIntent: step.intent,
        actionKind: step.action.kind, actionClass: step.actionClass,
        url: snapshot.url, title: snapshot.title,
        timeoutMs: artifact.escalation.timeoutMs,
      });
      executor.syncGeneration();
      const result: ReplayResult = {
        ...envelope(), status: 'escalated',
        escalation: {
          interventionId, reason: 'not_safely_abandonable', detail: message,
          raisedAtStepId: step.id,
          claimed: res.resolution !== 'timed_out',
          ...(res.claimedBy !== undefined ? { claimedBy: res.claimedBy } : {}),
          humanActionCount: res.humanActionCount,
          resolution: res.resolution === 'skipped' ? 'resolved' : res.resolution,
          resumedAt: new Date().toISOString(),
          evidence: [],
        },
      };
      evidence.event('run.end', `Run stopped on its budget at ${step.id}.`, { elapsed });
      evidence.close({ status: result.status, intervention: interventionId });
      return result;
    }

    evidence.event('run.end', `Refusing to continue: ${message}.`,
      { code: 'budget_exceeded', elapsed, stepIndex: index }, step.id);
    const result: ReplayResult = {
      ...envelope(), status: 'failed',
      failure: {
        code: 'budget_exceeded', stepId: step.id, message,
        expected: overSteps
          ? `at most ${artifact.policy.maxSteps} steps`
          : `the run to finish within ${artifact.policy.maxWallClockMs}ms`,
        observed: overSteps ? `step ${index + 1}` : `${elapsed}ms`,
        evidence: [],
      },
    };
    evidence.close({ status: result.status, code: 'budget_exceeded' });
    return result;
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
