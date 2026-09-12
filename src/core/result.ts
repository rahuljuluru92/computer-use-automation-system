/**
 * The replay result contract.
 *
 * This file exists to make one mistake impossible. The brief's glossary says:
 *
 *   "Business outcome vs failure - 'no such member' is a legitimate answer the
 *    caller needs, not a crash. Conflating the two is the most common design
 *    mistake here."
 *
 * So `ReplayResult` is a discriminated union rather than a bag with an optional
 * error field. A caller cannot read `outputs` without first narrowing on
 * `status`, and narrowing on `status` forces them to notice that
 * `business_outcome` exists and is not `failed`. The type system does the
 * teaching.
 *
 * Five terminal states, and the difference between them is the whole error
 * taxonomy:
 *
 *   success           - goal reached, checkpoints held, outputs extracted
 *   business_outcome  - the app gave a legitimate answer the caller must handle
 *   failed            - a hard failure, with enough detail to debug
 *   escalated         - a human was needed; what happened and what they did
 *   blocked_by_policy - we refused to act; not an error, a guardrail working
 *
 * "Recoverable" is deliberately NOT a terminal status. A recoverable condition
 * that was handled shows up as `success` with recovery counted in the step
 * traces; a recoverable condition that exhausted its budget becomes `failed` or
 * `escalated`. Recovery is something that happens *during* a run, not something
 * a run ends as.
 */

import * as z from 'zod';

// ---------------------------------------------------------------------------
// Telemetry recorded per step
// ---------------------------------------------------------------------------

/** Which tier actually won, and did the bundle reach quorum? */
export const ResolutionTrace = z.object({
  locatorDescription: z.string(),
  /** Tier of the strategy that produced the final match (1 is best). */
  winningTier: z.number().int().min(1).max(6),
  /** How many independent strategies resolved to the same node. */
  agreement: z.number().int().min(0),
  /** True when tier 1 did not win but quorum held and we proceeded anyway. */
  degraded: z.boolean(),
  /** Tiers that were tried and produced nothing, for diagnosis. */
  missedTiers: z.array(z.number().int()).default([]),
  candidateCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
});
export type ResolutionTrace = z.infer<typeof ResolutionTrace>;

/**
 * Emitted whenever a bundle resolved below its top tier. This is the raw signal
 * behind the multi-tenant drift story: the same base artifact run against a
 * re-skinned variant will systematically degrade on the steps that variant
 * changed, and that is detectable without anyone filing a bug.
 */
export const DriftRecord = z.object({
  stepId: z.string(),
  locatorDescription: z.string(),
  expectedTier: z.number().int(),
  actualTier: z.number().int(),
  agreement: z.number().int(),
  observedName: z.string().optional(),
  expectedName: z.string().optional(),
  note: z.string(),
});
export type DriftRecord = z.infer<typeof DriftRecord>;

export const RecoveryTrace = z.object({
  ruleId: z.string(),
  kind: z.string(),
  attempt: z.number().int().min(1),
  succeeded: z.boolean(),
  durationMs: z.number().int().min(0),
});
export type RecoveryTrace = z.infer<typeof RecoveryTrace>;

export const StepTrace = z.object({
  stepId: z.string(),
  intent: z.string(),
  actionKind: z.string(),
  actionClass: z.string(),
  status: z.enum(['ok', 'recovered', 'skipped', 'failed', 'escalated', 'blocked']),
  resolution: ResolutionTrace.optional(),
  preconditionsHeld: z.boolean().optional(),
  checkpointHeld: z.boolean().optional(),
  retries: z.number().int().min(0).default(0),
  recoveries: z.array(RecoveryTrace).default([]),
  startedAt: z.string(),
  durationMs: z.number().int().min(0),
  /** Paths under evidence/<runId>/, never inline blobs. */
  evidence: z.array(z.string()).default([]),
});
export type StepTrace = z.infer<typeof StepTrace>;

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/**
 * Hard-failure codes. Each one answers "what would I look at first?" - which is
 * the only useful test of a failure taxonomy.
 */
export const FailureCode = z.enum([
  'locator_unresolved',   // no tier matched, or quorum not reached
  'locator_ambiguous',    // matched more than one node and uniqueness was required
  'precondition_failed',  // we were not where the artifact expected to be
  'checkpoint_failed',    // the action did not produce the state it should have
  'wait_timeout',         // the declared state transition never happened
  'extract_failed',       // the value was not there, or did not parse
  'budget_exceeded',      // step or run budget spent
  'surface_error',        // the browser/app broke under us (crash, navigation error)
  'artifact_invalid',     // the artifact does not satisfy its own schema or inputs
  'app_fingerprint_mismatch', // this is not the app we learned; refuse rather than guess
]);
export type FailureCode = z.infer<typeof FailureCode>;

export const FailureDetail = z.object({
  code: FailureCode,
  stepId: z.string().optional(),
  message: z.string(),
  /** What the artifact said should be true. */
  expected: z.string(),
  /** What we actually saw. Populated from the live snapshot, redacted. */
  observed: z.string(),
  /** Paths under evidence/<runId>/ - screenshot, ax snapshot, trace, event tail. */
  evidence: z.array(z.string()).default([]),
});
export type FailureDetail = z.infer<typeof FailureDetail>;

export const EscalationDetail = z.object({
  interventionId: z.string(),
  reason: z.enum([
    'locator_unresolved',
    'unknown_dialog',
    'recovery_exhausted',
    'irreversible_action_needs_approval',
    'policy_requires_approval',
    'not_safely_abandonable',
  ]),
  detail: z.string(),
  raisedAtStepId: z.string().optional(),
  /** Did a human actually take the session, or did we time out waiting? */
  claimed: z.boolean(),
  claimedBy: z.string().optional(),
  humanActionCount: z.number().int().min(0).default(0),
  resolution: z.enum(['resolved', 'aborted', 'skipped', 'timed_out']).optional(),
  resumedAt: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});
export type EscalationDetail = z.infer<typeof EscalationDetail>;

export const PolicyBlockDetail = z.object({
  rule: z.string(),
  stepId: z.string().optional(),
  attemptedAction: z.string(),
  reason: z.string(),
});
export type PolicyBlockDetail = z.infer<typeof PolicyBlockDetail>;

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

const envelope = {
  runId: z.string(),
  capability: z.object({
    id: z.string(),
    version: z.string(),
    /** Hash of the exact artifact executed, overlay applied. */
    hash: z.string(),
    status: z.string(),
  }),
  tenant: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().int().min(0),
  steps: z.array(StepTrace).default([]),
  drift: z.array(DriftRecord).default([]),
  metrics: z.object({
    stepsExecuted: z.number().int().min(0),
    retries: z.number().int().min(0),
    recoveries: z.number().int().min(0),
    degradedResolutions: z.number().int().min(0),
    /**
     * Always 0 on the replay path, and asserted to be 0 in
     * tests/determinism/. This field is the runtime half of the claim that
     * eslint enforces statically: replay does not consult a model.
     */
    llmCalls: z.number().int().min(0),
    /**
     * How many times this run stopped and asked for a person.
     *
     * Here rather than only on the `escalated` variant because a run can need
     * a human and still end as something else - an operator unsticks it, the
     * run carries on, and the app then gives a perfectly good business answer.
     * The status tells you what the run *concluded*; this tells you what it
     * cost to get there, and an unattended caller watching for "did this need
     * hands?" can read one number on every outcome instead of destructuring
     * five.
     */
    interventions: z.number().int().min(0).default(0),
  }),
  evidenceDir: z.string(),
};

export const ReplayResult = z.discriminatedUnion('status', [
  z.object({
    ...envelope,
    status: z.literal('success'),
    outputs: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...envelope,
    status: z.literal('business_outcome'),
    outcome: z.object({
      code: z.string(),
      description: z.string(),
      severity: z.enum(['info', 'warn']),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
  z.object({
    ...envelope,
    status: z.literal('failed'),
    failure: FailureDetail,
  }),
  z.object({
    ...envelope,
    status: z.literal('escalated'),
    escalation: EscalationDetail,
    /** Present when the human finished the job and the run completed after handback. */
    outputs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...envelope,
    status: z.literal('blocked_by_policy'),
    policy: PolicyBlockDetail,
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResult>;

export type ReplayStatus = ReplayResult['status'];

/**
 * Process exit codes. A business outcome is NOT a failure, so it does not exit
 * non-zero - a caller shelling out to this CLI gets the same distinction the
 * type system gives a caller importing it.
 */
export const EXIT_CODES: Record<ReplayStatus, number> = {
  success: 0,
  business_outcome: 0,
  escalated: 3,
  blocked_by_policy: 4,
  failed: 1,
};

/** True when the run produced an answer, whether or not that answer was "yes". */
export function isAnswered(r: ReplayResult): boolean {
  return r.status === 'success' || r.status === 'business_outcome';
}
