/**
 * The capability contract.
 *
 * A CapabilityArtifact is what a successful discovery run compiles into: a typed,
 * versioned, reviewable description of a flow that an AI agent can invoke and a
 * human can audit. It is deliberately NOT a transcript of what the model did, and
 * NOT a list of selectors. It is a contract:
 *
 *   inputs  - what the caller must supply
 *   steps   - what will happen, and how each control is found
 *   outcomes- the legitimate business answers the caller must handle
 *   outputs - what comes back
 *
 * Design notes worth reading before changing anything here:
 *
 * 1. `inputs` and `outputs` are stored as JSON Schema, not as Zod. The artifact is
 *    a portable contract that an MCP server hands straight to a calling agent;
 *    JSON Schema is that wire format. Zod validates the envelope around it.
 *
 * 2. Business outcomes (`outcomes`) are first-class and declared up front. The
 *    brief's glossary calls conflating "no such member" with a crash the most
 *    common design mistake in this problem, so the schema refuses to let a caller
 *    discover outcomes by accident - they are part of the published contract.
 *
 * 3. Every target carries a *bundle* of ranked location strategies plus stored
 *    reasoning about why each is (or is not) robust. Section 3.2 asks for that
 *    reasoning, so it lives in the artifact where a reviewer will actually see it,
 *    not in a README paragraph.
 */

import * as z from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** How dangerous is this action if it happens when it shouldn't? */
export const ActionClass = z.enum([
  'read',               // observing only; always safe to retry
  'write_reversible',   // changes state, but undoable (fill a field, open a form)
  'write_irreversible', // submits, confirms, transfers, deletes - needs approval
]);
export type ActionClass = z.infer<typeof ActionClass>;

/** Drives redaction. `secret` never reaches disk; `pii` is masked in evidence. */
export const Sensitivity = z.enum(['none', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ArtifactStatus = z.enum([
  'draft',      // compiled, self-verified, but not cleared for unattended use
  'candidate',  // under review
  'approved',   // may be invoked unattended (e.g. over MCP)
  'deprecated',
]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

/**
 * A JSON Schema document, loosely validated. We check that it is object-shaped
 * and carries properties; we deliberately do not implement a metaschema
 * validator. Properties may carry `x-sensitivity` to drive redaction.
 */
export const JsonSchemaDoc = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), z.looseObject({
    type: z.string().optional(),
    description: z.string().optional(),
    'x-sensitivity': Sensitivity.optional(),
  })),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
});
export type JsonSchemaDoc = z.infer<typeof JsonSchemaDoc>;

// ---------------------------------------------------------------------------
// Locator strategies
// ---------------------------------------------------------------------------

/**
 * Tiers are ordered by expected survival, not by convenience.
 *
 * The ordering encodes the central bet of this system: on a legacy enterprise
 * surface, what a human operator perceives (a role, a label, a row identified by
 * its data) outlives what a developer wrote (an id, a class, a DOM path). The
 * target app regenerates its control ids on every render specifically so this
 * ordering is not a matter of taste.
 */
export const LocatorStrategy = z.discriminatedUnion('kind', [
  /** Tier 1. Accessible role + name. Ports unchanged to desktop AX. */
  z.object({
    kind: z.literal('role_name'),
    role: z.string(),
    name: z.string().optional(),
    nameMatches: z.string().optional(),   // regex source, when the name is not exact
    exact: z.boolean().default(false),
    scope: z.string().optional(),         // optional named scope, e.g. a row resolved earlier
  }),

  /**
   * Tier 2. The legacy-grid workhorse: find the row whose `matchColumn` reads
   * `matchValue`, then take the control in `targetColumn`. This is how a human
   * finds the link too, which is exactly why it survives re-skinning.
   */
  z.object({
    kind: z.literal('table_cell_relative'),
    table: z.object({ role: z.string().default('table'), name: z.string().optional() }),
    matchColumn: z.string(),
    matchValue: z.string(),               // may contain $input.* references
    targetColumn: z.string(),
    within: z.object({ role: z.string() }).optional(),
  }),

  /** Tier 3. The control associated with a visible label. */
  z.object({
    kind: z.literal('label_anchored'),
    label: z.string(),
    labelMatches: z.string().optional(),
    controlRole: z.string().optional(),
  }),

  /** Tier 4. Visible text. Cheap, and surprisingly durable for buttons. */
  z.object({
    kind: z.literal('text'),
    pattern: z.string(),
    role: z.string().optional(),
  }),

  /**
   * Tier 5. CSS/XPath. Recorded for forensics and drift diagnosis, never trusted
   * unattended. On the target app these ids are render-ordinal dependent and will
   * be wrong on the very next page load - which is the point.
   */
  z.object({
    kind: z.literal('css'),
    selector: z.string(),
  }),

  /**
   * Tier 6. Geometry relative to an anchor node. Exists to carry the desktop /
   * no-a11y-tree story. Note boxes are viewport-relative (CSS pixels, per
   * getBoundingClientRect), so only the *delta* between two nodes in the same
   * snapshot is meaningful - absolute coordinates are not stable across scroll.
   */
  z.object({
    kind: z.literal('anchor_offset'),
    anchor: z.object({ role: z.string(), name: z.string().optional() }),
    dx: z.number(),
    dy: z.number(),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const RankedStrategy = z.object({
  tier: z.number().int().min(1).max(6),
  strategy: LocatorStrategy,
  confidence: z.number().min(0).max(1),
  /**
   * Why this strategy is or isn't robust here. Section 3.2 asks for this
   * reasoning explicitly, so it is a stored field rather than prose elsewhere.
   */
  rationale: z.string().min(1),
});
export type RankedStrategy = z.infer<typeof RankedStrategy>;

/**
 * A bundle is how one control is found. Resolution walks the tiers in order and
 * requires (a) a unique match and (b) agreement from `minAgreement` independent
 * strategies. If a lower tier wins while quorum holds, the step proceeds in a
 * DEGRADED state and emits a drift record rather than failing - that telemetry is
 * what turns "the UI changed" from an outage into a signal.
 */
export const LocatorBundle = z.object({
  description: z.string().min(1),
  frame: z.object({
    /** Frame chain resolved by name or URL pattern - never by index. */
    path: z.array(z.string()).default([]),
  }).default({ path: [] }),
  strategies: z.array(RankedStrategy).min(1),
  requireUnique: z.boolean().default(true),
  minAgreement: z.number().int().min(1).max(6).default(2),
  allowDegraded: z.boolean().default(true),
});
export type LocatorBundle = z.infer<typeof LocatorBundle>;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * One small algebra, reused in five places: preconditions, waits, checkpoints,
 * business-outcome detectors, and recovery triggers. Keeping it to one type is
 * what lets the executor have a single evaluation path - and it means a reviewer
 * only has to understand this once.
 */
export type Predicate =
  | { kind: 'node_present'; locator: LocatorBundle }
  | { kind: 'node_absent'; locator: LocatorBundle }
  | { kind: 'text_matches'; locator: LocatorBundle; pattern: string }
  | { kind: 'value_equals'; locator: LocatorBundle; value: string }
  | { kind: 'url_matches'; pattern: string }
  | { kind: 'aria_subtree'; root: LocatorBundle; snapshot: string }
  | { kind: 'stable'; forMs: number }
  | { kind: 'all'; of: Predicate[] }
  | { kind: 'any'; of: Predicate[] }
  | { kind: 'not'; of: Predicate };

export const Predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('node_present'), locator: LocatorBundle }),
    z.object({ kind: z.literal('node_absent'), locator: LocatorBundle }),
    z.object({ kind: z.literal('text_matches'), locator: LocatorBundle, pattern: z.string() }),
    z.object({ kind: z.literal('value_equals'), locator: LocatorBundle, value: z.string() }),
    z.object({ kind: z.literal('url_matches'), pattern: z.string() }),
    /** Asserts accessible *structure*, via Playwright's aria snapshot matching. */
    z.object({ kind: z.literal('aria_subtree'), root: LocatorBundle, snapshot: z.string() }),
    /** The accessibility tree has stopped changing - our substitute for sleep(). */
    z.object({ kind: z.literal('stable'), forMs: z.number().int().positive() }),
    z.object({ kind: z.literal('all'), of: z.array(Predicate) }),
    z.object({ kind: z.literal('any'), of: z.array(Predicate) }),
    z.object({ kind: z.literal('not'), of: Predicate }),
  ]),
);

// ---------------------------------------------------------------------------
// Actions, recovery, extraction
// ---------------------------------------------------------------------------

export const ActionSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click') }),
  z.object({ kind: z.literal('type'), clearFirst: z.boolean().default(true) }),
  z.object({ kind: z.literal('select') }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  z.object({ kind: z.literal('navigate'), urlTemplate: z.string() }),
  z.object({ kind: z.literal('scroll'), direction: z.enum(['up', 'down']), amount: z.number().default(3) }),
  /** Read-only: pull a value out of the page. */
  z.object({ kind: z.literal('extract') }),
  /** Read-only: assert without acting. */
  z.object({ kind: z.literal('assert') }),
]);
export type ActionSpec = z.infer<typeof ActionSpec>;

/**
 * A bounded, declarative answer to a known runtime condition. Every recovery is
 * counted and logged; none of them loop. "Recoverable" in the result contract
 * means one of these fired and worked, not that we retried until something
 * happened.
 */
export const RecoveryRule = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  when: Predicate,
  kind: z.enum([
    'dismiss',            // click something away (interstitial, nag dialog)
    'retry_with_backoff', // transient load / 5xx
    're_resolve_locator', // node went stale under us
    'wait_longer',        // slow, not broken
    'reauth',             // session expired; run the declared re-auth subflow once
  ]),
  do: z.array(z.object({
    action: ActionSpec,
    target: LocatorBundle.optional(),
    data: z.object({ value: z.string(), sensitivity: Sensitivity.default('none') }).optional(),
  })).default([]),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  budgetMs: z.number().int().positive().default(5_000),
  thenRetryStep: z.boolean().default(true),
});
export type RecoveryRule = z.infer<typeof RecoveryRule>;

export const ExtractSpec = z.object({
  name: z.string().min(1),
  from: LocatorBundle,
  parse: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), trim: z.boolean().default(true) }),
    z.object({ kind: z.literal('currency'), locale: z.string().default('en-US') }),
    z.object({ kind: z.literal('number') }),
    z.object({ kind: z.literal('date'), format: z.string().optional() }),
    z.object({ kind: z.literal('regex'), pattern: z.string(), group: z.number().int().default(1) }),
  ]),
  sensitivity: Sensitivity.default('none'),
});
export type ExtractSpec = z.infer<typeof ExtractSpec>;

// ---------------------------------------------------------------------------
// Steps and outcomes
// ---------------------------------------------------------------------------

/**
 * Every step runs the same cycle: resolve -> precheck -> act -> wait -> verify.
 * `waitFor` is what proves the action landed; `checkpoint` is what proves we
 * arrived somewhere correct. Neither is optional in spirit - a step with no
 * checkpoint is a step that assumes the click worked, which is the failure mode
 * the brief names in its glossary.
 */
export const Step = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  action: ActionSpec,
  actionClass: ActionClass,
  target: LocatorBundle.optional(),
  data: z.object({
    /** May reference inputs as `$input.memberId`. */
    value: z.string(),
    sensitivity: Sensitivity.default('none'),
  }).optional(),
  preconditions: z.array(Predicate).default([]),
  waitFor: z.array(Predicate).default([]),
  checkpoint: z.array(Predicate).default([]),
  extract: z.array(ExtractSpec).default([]),
  /** Declared business outcomes that can legitimately surface at this step. */
  onOutcome: z.array(z.string()).default([]),
  recovery: z.array(RecoveryRule).default([]),
  budget: z.object({
    timeoutMs: z.number().int().positive().default(8_000),
    retries: z.number().int().min(0).max(5).default(2),
  }).default({ timeoutMs: 8_000, retries: 2 }),
});
export type Step = z.infer<typeof Step>;

/**
 * A legitimate answer, not a failure. "No such member" is information the caller
 * asked for. Detectors are declared here so replay recognises them deliberately
 * rather than inferring them from a failed checkpoint.
 */
export const BusinessOutcome = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['info', 'warn']).default('info'),
  terminal: z.boolean().default(true),
  detect: Predicate,
  /** Values to return with the outcome; may reference `$input.*` or extracted names. */
  returns: z.record(z.string(), z.string()).default({}),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcome>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const TenantOverlay = z.object({
  /** Per-step locator bundle replacements, keyed by step id. */
  targets: z.record(z.string(), LocatorBundle).default({}),
  /** Extra recovery rules this tenant needs (e.g. a consent interstitial). */
  recovery: z.array(RecoveryRule).default([]),
  waitBudgetMultiplier: z.number().positive().default(1),
  notes: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

export const CapabilityArtifact = z.object({
  schemaVersion: z.literal('1.0.0'),

  /** Stable capability identity. Survives version bumps. */
  id: z.string().regex(/^cap(\.[a-z0-9_]+)+$/, 'expected dotted lower_snake id, e.g. cap.member.read_savings_balance'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: ArtifactStatus.default('draft'),

  title: z.string().min(1),
  /** Agent-facing. This becomes the MCP tool description verbatim. */
  description: z.string().min(1),

  target: z.object({
    surface: z.enum(['web', 'desktop']),
    product: z.object({
      vendor: z.string(),
      app: z.string(),
      versionRange: z.string().optional(),
    }),
    entry: z.object({
      kind: z.literal('url'),
      template: z.string(),  // e.g. "{baseUrl}/members/search"
    }),
    /**
     * A hash over stable structural landmarks of the app, captured at record
     * time. A mismatch at replay time means "this app is not the one I learned"
     * - which is a warning worth surfacing, not a crash.
     */
    fingerprint: z.object({
      algo: z.literal('landmark-sha256'),
      value: z.string(),
      capturedAt: z.string(),
    }).optional(),
  }),

  inputs: JsonSchemaDoc,
  outputs: JsonSchemaDoc,

  outcomes: z.array(BusinessOutcome).default([]),
  steps: z.array(Step).min(1),
  /** Recovery rules that apply at any step. */
  recovery: z.array(RecoveryRule).default([]),

  policy: z.object({
    maxSteps: z.number().int().positive().default(40),
    maxWallClockMs: z.number().int().positive().default(90_000),
    allowedActionClasses: z.array(ActionClass).default(['read', 'write_reversible']),
  }).default({ maxSteps: 40, maxWallClockMs: 90_000, allowedActionClasses: ['read', 'write_reversible'] }),

  tenancy: z.object({
    canonical: z.boolean().default(true),
    overlays: z.record(z.string(), TenantOverlay).default({}),
  }).default({ canonical: true, overlays: {} }),

  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    recordedAt: z.string(),
    compilerVersion: z.string(),
    /**
     * No artifact is written unless the compiler replayed it successfully first.
     * If this says false, the artifact is a diagnostic, not a capability.
     */
    selfVerified: z.object({
      passed: z.boolean(),
      at: z.string(),
      runId: z.string(),
    }),
  }),

  /**
   * Populated by self-verification today. The N-run stability harness that would
   * fill this properly is a documented cut - the field stays because the schema
   * should anticipate it.
   */
  reliability: z.object({
    runs: z.number().int().min(0).default(0),
    passRate: z.number().min(0).max(1).default(0),
    p50DurationMs: z.number().int().min(0).default(0),
    p95DurationMs: z.number().int().min(0).default(0),
    degradedResolutions: z.number().int().min(0).default(0),
    lastVerifiedAt: z.string().optional(),
  }).default({ runs: 0, passRate: 0, p50DurationMs: 0, p95DurationMs: 0, degradedResolutions: 0 }),

  /** sha256 over the artifact with this field removed. See core/integrity.ts. */
  integrity: z.object({ hash: z.string() }).optional(),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/** Convenience: the artifact as written by an author, before defaults are applied. */
export type CapabilityArtifactInput = z.input<typeof CapabilityArtifact>;
