/**
 * The compiler: one wandering recording in, one typed capability out.
 *
 * Everything upstream of this file produced raw material - a trajectory, some
 * synthesised locator bundles, a declared ending. This turns that into the
 * artifact that replay executes forever afterwards, and it is the last place
 * anything can be caught before a capability starts running unattended against
 * real customer records.
 *
 * The pipeline, in order, each stage a separate module where it is worth one:
 *
 *   prune         remove the detours (prune.ts)
 *   canonicalize  literals become input references (canonicalize.ts)
 *   waits         infer what proves each step landed
 *   checkpoints   infer what proves each step arrived somewhere correct
 *   assemble      steps, schemas, outcomes, provenance
 *   verify        replay what was just produced, against the real application
 *
 * ## Verification is not the last step, it is the point
 *
 * Invariant #4: no artifact ships unverified. `compile()` cannot return a
 * usable capability without having replayed it successfully first, and the
 * signature says so - a failed verification returns a *diagnostic*, typed
 * differently, with `selfVerified.passed` false and status left at draft. The
 * schema already describes that object as "a diagnostic, not a capability".
 *
 * This matters more here than in most compilers, because everything upstream
 * was decided by a model. Verification is the step where the system stops
 * taking the model's word for it.
 *
 * ## Two inferences, both derived from what was observed
 *
 * **waitFor** is "the control the next step needs is present". Not a duration
 * (invariant #5) and not a guess: the next step demonstrably did resolve on
 * the screen this step produced, so requiring that again is a restatement of
 * something already true at record time.
 *
 * **checkpoint** is the same fact used for a different purpose - proof the
 * step arrived somewhere correct rather than merely somewhere. The model's own
 * `assert` calls come first when it made any; the inference fills the gaps,
 * because a step with no checkpoint is a step that assumes the click worked.
 */

import {
  CapabilityArtifact, type ActionClass, type BusinessOutcome, type ExtractSpec,
  type JsonSchemaDoc, type Predicate, type Step,
} from '../core/schema.ts';
import { withIntegrity } from '../core/integrity.ts';
import type { ReplayResult } from '../core/result.ts';
import type { DiscoveryRun } from './loop.ts';
import type { RecordedStep } from './tools.ts';
import { pruneBacktracks, type PruneResult } from './prune.ts';
import { canonicalize, type CanonicalizeResult } from './canonicalize.ts';

export const COMPILER_VERSION = '1.0.0';

export interface CompileInput {
  name: string;
  description?: string;
  sensitivity?: 'none' | 'pii' | 'secret';
}

export interface CompileTask {
  /** Dotted lower_snake, e.g. cap.member.read_savings_balance. */
  id: string;
  version: string;
  title: string;
  /** Agent-facing: this becomes the MCP tool description verbatim. */
  description: string;
  inputs: CompileInput[];
  entryUrlTemplate: string;
  product: { vendor: string; app: string };
}

export interface CompileProvenance {
  /**
   * What actually drove the run. A scripted planner must never be recorded as
   * a model id - an artifact that claims to be model-discovered when it was
   * not is a lie in the one document a reviewer is meant to trust.
   */
  model: string;
  promptVersion: string;
  discoveryRunId: string;
}

/**
 * Replays a candidate artifact against the real application. `scenario`, when
 * given, is a precondition to arm on a fresh session *before* replaying -
 * e.g. arming a chaos mode - so the same function verifies both the plain
 * happy path and a declared business outcome that only appears once that
 * precondition holds.
 */
export type Verifier = (
  artifact: CapabilityArtifact,
  scenario?: { armUrl: string },
) => Promise<ReplayResult>;

/**
 * A second discovery run, kept only for the business outcome it declared, and
 * the data needed to prove that outcome rather than merely assert it.
 *
 * This is *not* a second trajectory to merge into the primary one - a
 * `BusinessOutcome` is artifact-level (`outcomes[]` sits beside `steps[]`,
 * decision #36), evaluated on every step regardless of which run produced the
 * steps. Compiling with one of these adds exactly one thing to the artifact:
 * an entry in `outcomes[]`. There is no step-alignment question to answer,
 * because outcomes are never anchored to a step index.
 *
 * What a bare extra `DiscoveryRun` could not supply is *how to reproduce* the
 * condition that made it end that way - a verifier replaying the assembled
 * artifact against a clean target will never see the refusal, the detector
 * will never fire, and verification would fail for a reason that has nothing
 * to do with whether the outcome is real. `armUrl` is that missing
 * precondition, supplied as data rather than inferred (decision #123).
 */
export interface OutcomeScenario {
  /** Must have ended in `declare_outcome`; anything else is a caller error. */
  run: DiscoveryRun;
  /** Navigated on a fresh session before replay, to arm the precondition. */
  armUrl: string;
  /** The code `outcomesFrom(run.terminal)` will produce, checked after replay. */
  expectedCode: string;
}

export interface CompileOptions {
  run: DiscoveryRun;
  task: CompileTask;
  provenance: CompileProvenance;
  /** The input values the run was recorded with, for canonicalisation. */
  params: Record<string, unknown>;
  verify: Verifier;
  /**
   * Extra runs kept only for a declared outcome, each proven by its own
   * scenario replay rather than merged into the primary trajectory.
   */
  additionalOutcomeScenarios?: OutcomeScenario[];
  now?: () => Date;
}

export interface CompileReport {
  recordedSteps: number;
  compiledSteps: number;
  pruned: PruneResult['removed'];
  retainedCycles: PruneResult['retained'];
  rewrites: CanonicalizeResult['rewrites'];
  inputsUsed: string[];
  /** Steps the compiler could not give a checkpoint. Worth a reviewer's eye. */
  uncheckedSteps: string[];
  /**
   * A declared outcome dropped for lack of a detector - the model ended the
   * run with `declare_outcome` but gave no `ref` (or it did not resolve), so
   * there is nothing replay could recognise later. Shipping a schema-invalid
   * detector instead of this list was decision #122's actual bug.
   */
  droppedOutcomes: string[];
}

export type CompileResult =
  | { ok: true; artifact: CapabilityArtifact; report: CompileReport; verification: ReplayResult }
  | { ok: false; reason: string; report: CompileReport; diagnostic?: CapabilityArtifact;
      verification?: ReplayResult };

// ---------------------------------------------------------------------------

export async function compile(opts: CompileOptions): Promise<CompileResult> {
  const now = opts.now ?? (() => new Date());
  const pruned = pruneBacktracks(opts.run.steps);
  const canonical = canonicalize(pruned.steps, opts.params);
  const steps = withInferredWaitsAndCheckpoints(canonical.steps);

  const reportBase = {
    recordedSteps: opts.run.steps.length,
    compiledSteps: steps.length,
    pruned: pruned.removed,
    retainedCycles: pruned.retained,
    rewrites: canonical.rewrites,
    inputsUsed: canonical.used,
  };

  if (steps.length === 0) {
    return {
      ok: false, reason: 'the run recorded no steps to compile',
      report: { ...reportBase, uncheckedSteps: [], droppedOutcomes: [] },
    };
  }

  // A run that never said it succeeded did not produce a capability. Compiling
  // one anyway would bake a half-finished flow into something callable.
  const terminal = opts.run.terminal;
  if (!terminal) {
    return {
      ok: false,
      reason: `the run ended on ${opts.run.stop.kind} without the model declaring an outcome, `
        + 'so there is nothing to claim the flow completed',
      report: { ...reportBase, uncheckedSteps: [], droppedOutcomes: [] },
    };
  }
  if (terminal.kind === 'give_up' || terminal.kind === 'request_human') {
    return {
      ok: false, reason: `the run ended in ${terminal.kind}: ${terminal.reason}`,
      report: { ...reportBase, uncheckedSteps: [], droppedOutcomes: [] },
    };
  }

  // Every additional scenario must itself have ended in a declared outcome -
  // there is nothing else it could be kept for. Checked before spending any
  // browser time on it.
  for (const scenario of opts.additionalOutcomeScenarios ?? []) {
    if (scenario.run.terminal?.kind !== 'declare_outcome') {
      return {
        ok: false,
        reason: `an outcome scenario's run ended in ${scenario.run.terminal?.kind
          ?? scenario.run.stop.kind}, not declare_outcome - nothing to add to outcomes[]`,
        report: { ...reportBase, uncheckedSteps: [], droppedOutcomes: [] },
      };
    }
  }

  const primaryOutcomes = outcomesFrom(terminal);
  const scenarioOutcomes = (opts.additionalOutcomeScenarios ?? [])
    .map((s) => outcomesFrom(s.run.terminal));
  const outcomes = [...primaryOutcomes.outcomes, ...scenarioOutcomes.flatMap((o) => o.outcomes)];
  const droppedOutcomes = [...primaryOutcomes.dropped, ...scenarioOutcomes.flatMap((o) => o.dropped)];

  const report: CompileReport = {
    ...reportBase,
    uncheckedSteps: steps.filter((s) => s.checkpoint.length === 0).map((s) => s.id),
    droppedOutcomes,
  };

  const draft = assemble(opts, steps, canonical.used, outcomes, now());

  // Contract first: a shape violation should surface here, not as a confusing
  // failure three steps into a browser session.
  const parsed = CapabilityArtifact.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `the compiled artifact does not satisfy the contract: ${parsed.error.message}`,
      report,
    };
  }

  // Invariant #4. Everything above was decided by a model; this is where the
  // system stops taking its word for it.
  const verification = await opts.verify(parsed.data);
  if (verification.status !== 'success') {
    return {
      ok: false,
      reason: `the compiled artifact did not replay: ${describe(verification)}`,
      report,
      diagnostic: parsed.data,
      verification,
    };
  }

  // Each additional outcome gets its own scenario replay, on the same
  // artifact, with its own precondition armed first. A happy-path pass
  // proves nothing about a branch that pass never took.
  for (const scenario of opts.additionalOutcomeScenarios ?? []) {
    const scenarioResult = await opts.verify(parsed.data, { armUrl: scenario.armUrl });
    if (scenarioResult.status !== 'business_outcome' || scenarioResult.outcome.code !== scenario.expectedCode) {
      return {
        ok: false,
        reason: `outcome scenario "${scenario.expectedCode}" did not verify: ${describe(scenarioResult)}`,
        report,
        diagnostic: parsed.data,
        verification: scenarioResult,
      };
    }
  }

  const verified: CapabilityArtifact = {
    ...parsed.data,
    provenance: {
      ...parsed.data.provenance,
      selfVerified: { passed: true, at: now().toISOString(), runId: verification.runId },
    },
    reliability: {
      ...parsed.data.reliability,
      runs: 1,
      passRate: 1,
      p50DurationMs: verification.durationMs,
      p95DurationMs: verification.durationMs,
      degradedResolutions: verification.metrics.degradedResolutions,
      lastVerifiedAt: now().toISOString(),
    },
  };

  return { ok: true, artifact: withIntegrity(verified), report, verification };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * `waitFor` and `checkpoint` both come from the same observed fact: the next
 * step resolved its target on the screen this step produced. Used as a wait it
 * says "the page has finished moving"; used as a checkpoint it says "and it
 * moved to the right place".
 *
 * A step that changed nothing structurally gets no inferred wait - there was
 * no transition to wait for, and asserting the screen you are already on
 * proves nothing.
 */
function withInferredWaitsAndCheckpoints(steps: readonly RecordedStep[]): Step[] {
  return steps.map((step, i) => {
    const moved = step.beforeHash !== step.afterHash;
    const next = steps[i + 1];
    const arrival: Predicate[] = moved && next?.target
      ? [{ kind: 'node_present', locator: next.target }]
      : [];

    // The model's own assertions are better evidence than anything inferred:
    // it saw the screen and said what mattered about it.
    const asserted = step.checkpoint;

    // On the last step there is no "next" to point at, so the thing it read is
    // the proof it arrived.
    const readProof: Predicate[] = step.extract.map((e) => ({
      kind: 'node_present', locator: e.from,
    }));

    // Typing changes no structure, so neither of the above can speak for it -
    // and the first real run compiled three type steps with no checkpoint at
    // all, which is exactly the "assumes the click worked" step the contract
    // warns about. What proves a type landed is the field holding the value.
    //
    // Never for anything a credential resolves into. Two reasons, and the
    // second is why this keys on the value rather than on the sensitivity
    // flag: the predicate's failure detail quotes what it found, so a password
    // would land in evidence - and `$secret.` is resolved by the secret
    // resolver at action time, not by predicate interpolation, so the
    // comparison would test against the literal text "$secret.NAME" and fail
    // every time. The operator *id* is marked sensitivity "none" and still
    // recorded as `$secret.MERIDIAN_USERNAME`, which is exactly the case that
    // caught this. Those prove the field is there instead.
    const usesSecret = step.data?.value.includes('$secret.') ?? false;
    const typed: Predicate[] = step.action.kind === 'type' && step.target && step.data
      ? usesSecret
        ? [{ kind: 'node_present', locator: step.target }]
        : [{ kind: 'value_equals', locator: step.target, value: step.data.value }]
      : [];

    const checkpoint = asserted.length > 0
      ? asserted
      : typed.length > 0 ? typed
      : arrival.length > 0 ? arrival : readProof;

    return {
      id: `s${i + 1}`,
      intent: step.intent,
      action: step.action,
      actionClass: step.actionClass,
      ...(step.target ? { target: step.target } : {}),
      ...(step.data ? { data: step.data } : {}),
      preconditions: [],
      waitFor: arrival,
      checkpoint,
      extract: step.extract,
      onOutcome: [],
      recovery: [],
      budget: { timeoutMs: 8_000, retries: 2 },
    };
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function assemble(
  opts: CompileOptions,
  steps: Step[],
  used: string[],
  outcomes: BusinessOutcome[],
  at: Date,
): unknown {
  const extracts = steps.flatMap((s) => s.extract);

  return {
    schemaVersion: '1.0.0',
    id: opts.task.id,
    version: opts.task.version,
    // Never `approved`. A capability earns unattended use through review, not
    // through having compiled successfully.
    status: 'draft',
    title: opts.task.title,
    description: opts.task.description,
    target: {
      surface: 'web',
      product: opts.task.product,
      entry: { kind: 'url', template: opts.task.entryUrlTemplate },
    },
    inputs: inputsSchema(opts.task.inputs, used),
    outputs: outputsSchema(extracts),
    outcomes,
    steps,
    recovery: [],
    policy: {
      maxSteps: Math.max(40, steps.length * 2),
      maxWallClockMs: 90_000,
      allowedActionClasses: allowedClasses(steps),
    },
    tenancy: { canonical: true, overlays: {} },
    provenance: {
      discoveryRunId: opts.provenance.discoveryRunId,
      model: opts.provenance.model,
      promptVersion: opts.provenance.promptVersion,
      recordedAt: at.toISOString(),
      compilerVersion: COMPILER_VERSION,
      // Rewritten by compile() once replay has actually passed. Shipping this
      // as `true` before verifying would make the field decorative.
      selfVerified: { passed: false, at: at.toISOString(), runId: '' },
    },
    reliability: {
      runs: 0, passRate: 0, p50DurationMs: 0, p95DurationMs: 0, degradedResolutions: 0,
    },
  };
}

/**
 * Exactly the inputs the flow references. An input nothing reads is a question
 * asked of every caller forever for no reason, and a required one is worse.
 */
function inputsSchema(declared: CompileInput[], used: string[]): JsonSchemaDoc {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const name of used) {
    const spec = declared.find((d) => d.name === name);
    properties[name] = {
      type: 'string',
      ...(spec?.description ? { description: spec.description } : {}),
      ...(spec?.sensitivity && spec.sensitivity !== 'none'
        ? { 'x-sensitivity': spec.sensitivity } : {}),
    };
  }
  return {
    type: 'object',
    properties,
    required: used,
    additionalProperties: false,
  } as JsonSchemaDoc;
}

function outputsSchema(extracts: ExtractSpec[]): JsonSchemaDoc {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const e of extracts) {
    properties[e.name] = {
      type: e.parse.kind === 'currency' || e.parse.kind === 'number' ? 'number' : 'string',
      ...(e.sensitivity !== 'none' ? { 'x-sensitivity': e.sensitivity } : {}),
    };
  }
  return {
    type: 'object',
    properties,
    required: extracts.map((e) => e.name),
    additionalProperties: false,
  } as JsonSchemaDoc;
}

/**
 * A declared business outcome becomes a detector replay can recognise
 * deliberately, rather than inferring one from a checkpoint that happened to
 * fail. The detector is built from the node the model itself pointed at
 * (`declare_outcome`'s `ref`, resolved by the tool runner into `detectTarget`)
 * - never synthesised from the description text, which is prose for a human
 * reviewer, not something guaranteed to appear verbatim on the page.
 *
 * Without a locator there is nothing to detect, and shipping one anyway used
 * to mean forcing a `text_matches` predicate through a type-cast with no
 * `locator` field - schema-invalid, caught by nothing because no discovered
 * artifact had ever taken this path (decision #114). Now it is dropped and
 * named in the compile report instead (decision #122).
 */
function outcomesFrom(
  terminal: DiscoveryRun['terminal'],
): { outcomes: BusinessOutcome[]; dropped: string[] } {
  if (!terminal || terminal.kind !== 'declare_outcome') return { outcomes: [], dropped: [] };
  if (!terminal.detectTarget) {
    return {
      outcomes: [],
      dropped: [`"${terminal.code}" - declared with no locatable node, so replay could never `
        + 'recognise it again; shipped without a detector would be worse than not shipping it'],
    };
  }
  const detect: Predicate = terminal.expectText !== undefined
    ? { kind: 'text_matches', locator: terminal.detectTarget, pattern: escapeRegex(terminal.expectText) }
    : { kind: 'node_present', locator: terminal.detectTarget };
  return {
    outcomes: [{
      code: terminal.code,
      description: terminal.description,
      severity: terminal.severity,
      terminal: true,
      detect,
      returns: {},
    }],
    dropped: [],
  };
}

/** Never grants the flow a class it never used. */
function allowedClasses(steps: Step[]): ActionClass[] {
  const used = new Set<ActionClass>(steps.map((s) => s.actionClass));
  used.add('read');
  const order: ActionClass[] = ['read', 'write_reversible', 'write_irreversible'];
  return order.filter((c) => used.has(c));
}

function describe(r: ReplayResult): string {
  switch (r.status) {
    case 'business_outcome':
      return `it reported the business outcome "${r.outcome.code}" instead of completing`;
    case 'failed':
      return `${r.failure.code} at ${r.failure.stepId} - expected ${r.failure.expected}, `
        + `observed ${r.failure.observed}`;
    case 'escalated':
      return `it escalated: ${r.escalation.reason}`;
    default:
      return r.status;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
