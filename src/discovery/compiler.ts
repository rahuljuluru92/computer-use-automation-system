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

/** Replays a candidate artifact against the real application. */
export type Verifier = (artifact: CapabilityArtifact) => Promise<ReplayResult>;

export interface CompileOptions {
  run: DiscoveryRun;
  task: CompileTask;
  provenance: CompileProvenance;
  /** The input values the run was recorded with, for canonicalisation. */
  params: Record<string, unknown>;
  verify: Verifier;
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

  const report: CompileReport = {
    recordedSteps: opts.run.steps.length,
    compiledSteps: steps.length,
    pruned: pruned.removed,
    retainedCycles: pruned.retained,
    rewrites: canonical.rewrites,
    inputsUsed: canonical.used,
    uncheckedSteps: steps.filter((s) => s.checkpoint.length === 0).map((s) => s.id),
  };

  if (steps.length === 0) {
    return { ok: false, reason: 'the run recorded no steps to compile', report };
  }

  // A run that never said it succeeded did not produce a capability. Compiling
  // one anyway would bake a half-finished flow into something callable.
  const terminal = opts.run.terminal;
  if (!terminal) {
    return {
      ok: false,
      reason: `the run ended on ${opts.run.stop.kind} without the model declaring an outcome, `
        + 'so there is nothing to claim the flow completed',
      report,
    };
  }
  if (terminal.kind === 'give_up' || terminal.kind === 'request_human') {
    return { ok: false, reason: `the run ended in ${terminal.kind}: ${terminal.reason}`, report };
  }

  const draft = assemble(opts, steps, canonical.used, terminal, now());

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
  terminal: NonNullable<DiscoveryRun['terminal']>,
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
    outcomes: outcomesFrom(terminal),
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
 * fail. Without a locator the model pointed at there is nothing to detect, so
 * the outcome is recorded without a detector and flagged - see the report.
 */
function outcomesFrom(terminal: NonNullable<DiscoveryRun['terminal']>): BusinessOutcome[] {
  if (terminal.kind !== 'declare_outcome') return [];
  return [{
    code: terminal.code,
    description: terminal.description,
    severity: terminal.severity,
    terminal: true,
    detect: { kind: 'text_matches', pattern: escapeRegex(terminal.description) } as unknown as Predicate,
    returns: {},
  }];
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
