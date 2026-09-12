/**
 * What a handoff leaves behind.
 *
 * An escalation is the one moment this system admits it cannot finish the job,
 * so it is also the moment that most needs a record. Not a log line - a record
 * with a shape, because three different readers need it and they want different
 * things from it:
 *
 *   the operator console  needs enough context to decide, right now, whether to
 *                         take the session: what was being attempted, what went
 *                         wrong, and a picture of the screen.
 *   the run               needs the resolution, so it knows whether to resume,
 *                         skip the step, or stop.
 *   whoever reads it later needs to know a human touched a customer's session,
 *                         who they were, when, and what they did while they
 *                         held it.
 *
 * The last one is why `humanActions` exists and why it records *what was
 * touched* rather than *what was typed*. See capture.ts: a servicing console is
 * full of fields whose contents are exactly what must never reach disk, and an
 * audit trail is not worth buying at that price. "Typed 8 characters into
 * Password" answers the audit question; the password itself only adds risk.
 */

import * as z from 'zod';

/**
 * One thing a human did while they held the session.
 *
 * Deliberately shallow. This is an audit trail, not a macro recorder - nothing
 * replays these, and anything precise enough to replay would be precise enough
 * to leak.
 */
export const HumanAction = z.object({
  at: z.string(),
  kind: z.enum(['click', 'input', 'submit', 'navigate', 'key']),
  /** Accessible name or label of the control, where the page offered one. */
  target: z.string().default(''),
  /** Role or tag, so "click on Save" and "click on the page" are distinguishable. */
  role: z.string().default(''),
  /** Which frame, for the iframe-heavy apps this system exists for. */
  frame: z.string().optional(),
  /**
   * How much was typed, never what. A length is enough to tell a filled field
   * from an untouched one, which is all an audit needs to know.
   */
  valueLength: z.number().int().min(0).optional(),
  url: z.string().optional(),
});
export type HumanAction = z.infer<typeof HumanAction>;

export const InterventionReason = z.enum([
  'locator_unresolved',
  'unknown_dialog',
  'recovery_exhausted',
  'irreversible_action_needs_approval',
  'policy_requires_approval',
  'not_safely_abandonable',
]);
export type InterventionReason = z.infer<typeof InterventionReason>;

/**
 * Where the intervention is in its life.
 *
 * `pending` and `claimed` are the two states a console renders differently, and
 * the three terminal states are the three things a human can decide. `timed_out`
 * is terminal too, and is the state that matters most: it is what happens when
 * the escalation mechanism is working and the human side of it is not.
 */
export const InterventionState = z.enum(['pending', 'claimed', 'resolved', 'aborted', 'skipped', 'timed_out']);
export type InterventionState = z.infer<typeof InterventionState>;

/** What the human decided. Maps onto what the run does next. */
export const Resolution = z.enum([
  /** They fixed it. The run re-checks the step and carries on. */
  'resolved',
  /** They did the step's job, or decided it does not apply. Move past it. */
  'skipped',
  /** Stop. The run ends escalated, with everything recorded. */
  'aborted',
]);
export type Resolution = z.infer<typeof Resolution>;

export const InterventionRecord = z.object({
  id: z.string(),
  runId: z.string(),
  capability: z.object({ id: z.string(), version: z.string() }),
  tenant: z.string().optional(),

  reason: InterventionReason,
  /** One sentence a human can act on without reading the run log. */
  detail: z.string(),
  stepId: z.string(),
  stepIntent: z.string(),
  /** What the run would have done next, so the operator knows where they are. */
  actionKind: z.string().default(''),
  actionClass: z.string().default(''),

  url: z.string().default(''),
  title: z.string().default(''),
  /** Relative to the run's evidence directory. */
  screenshotPath: z.string().optional(),
  /**
   * Where that evidence directory is.
   *
   * Carried on the record because the console may be a different process from
   * the run - it is how the screenshot of the stuck screen gets in front of
   * the operator deciding whether to take the session.
   */
  evidenceDir: z.string().optional(),

  state: InterventionState,
  raisedAt: z.string(),
  /** When the run will abandon if nobody has claimed it. */
  expiresAt: z.string(),
  claimedBy: z.string().optional(),
  claimedAt: z.string().optional(),
  resolution: Resolution.optional(),
  /** Free text from the operator: why they did what they did. */
  note: z.string().optional(),
  resolvedAt: z.string().optional(),

  humanActions: z.array(HumanAction).default([]),
  /** Every control transfer, so the audit shows the whole round trip. */
  leaseTransfers: z.array(z.object({
    generation: z.number().int(),
    at: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  })).default([]),
  /** What the run did when nobody came. Absent unless it timed out. */
  abandon: z.object({
    kind: z.string(),
    performed: z.boolean(),
    detail: z.string(),
  }).optional(),
});
export type InterventionRecord = z.infer<typeof InterventionRecord>;

/** True once the run is no longer waiting on a human. */
export function isTerminal(state: InterventionState): boolean {
  return state !== 'pending' && state !== 'claimed';
}

/**
 * A one-line summary for the console list and the run log.
 *
 * Kept here rather than in the console so the CLI, the report and the web UI
 * all describe an intervention the same way.
 */
export function describeIntervention(r: InterventionRecord): string {
  const who = r.claimedBy ? ` (held by ${r.claimedBy})` : '';
  return `${r.id} - ${r.reason} at ${r.stepId}: ${r.detail} [${r.state}]${who}`;
}
