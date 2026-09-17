/**
 * Synthesis: turning a node the model pointed at into a way to find it again.
 *
 * This is the other half of locator/resolve.ts, and it is where invariant #2 is
 * actually enforced. The model never writes a selector. It points at an opaque
 * `ref` from the snapshot it just observed, and this file works out - from the
 * same accessibility evidence a human operator would use - how that control
 * could be found on a later render of the same screen.
 *
 * One rule makes the output trustworthy:
 *
 *   A strategy is kept only if it was evaluated against the snapshot it was
 *   derived from and uniquely resolved to the node it claims to describe.
 *
 * Generation is cheap and speculative; verification is what ships. So every
 * strategy in a compiled bundle has actually run and actually worked at least
 * once - which is what invariant #3 asks for, and what stops the compiler from
 * emitting a plausible-looking bundle that never resolved anything.
 *
 * Two deliberate omissions, both documented rather than silently handled:
 *
 *   Tier 5 (css) is never synthesised. A CSS selector is not derivable from an
 *   accessibility snapshot, and `byCss` reports itself inapplicable anyway. An
 *   empty slot is the honest answer; a fabricated selector would be a guess
 *   wearing the costume of forensic evidence.
 *
 *   At most one strategy per tier. Three tier-2 strategies drawn from three
 *   columns of the same row are not three independent witnesses, and quorum
 *   (see resolve.ts) treats agreement as evidence. Inflating the bundle would
 *   inflate confidence in exactly the case where it is least deserved.
 */

import type { LocatorBundle, LocatorStrategy, RankedStrategy } from '../../core/schema.ts';
import type { UiNode, UiSnapshot } from '../uinode.ts';
import { runStrategy } from './strategies.ts';

export interface SynthesizeOptions {
  /** Becomes `bundle.description`: what this control is, in the flow's terms. */
  description: string;
  /**
   * Input values in play at record time, keyed by input name. A literal that
   * equals one of these is rewritten to `$input.<name>` and then re-verified
   * *with these same params*, so the template is proven to resolve back to the
   * node it came from rather than assumed to.
   *
   * Only `role_name.name` and `table_cell_relative.matchValue` are rewritten,
   * because those are the only two fields the resolver interpolates. Putting a
   * reference anywhere else would produce a bundle that silently searches for
   * the literal text "$input.memberId".
   */
  params?: Record<string, unknown>;
  /**
   * This node's own text is what `extract` is about to read as an output, not
   * wording the page merely happens to display next to it - so a strategy that
   * discriminates by that text (tier 1's own name, tier 4's own text) is not
   * volatile in the decision #50 sense of "eventually goes stale"; it is
   * certain to be wrong on the very next render, because a fresh value is the
   * entire reason the step exists. Found live: a reference number generated
   * per request verified at tier 1 during discovery (its own text was the
   * node's only name) and then could not resolve on a cold replay, and worse,
   * poisoned quorum for the tier-3 label-anchored strategy that *did* still
   * work, because decision #50's confidence discount does not stop a doomed
   * strategy from being counted as a quorum witness. Skips generating tier 1
   * and tier 4 candidates entirely for an extraction target, rather than
   * generating and merely discounting them - table/label/geometry tiers,
   * which key on context around the node rather than the node's own text, are
   * unaffected (decision #126).
   */
  forExtraction?: boolean;
}

export interface RejectedStrategy {
  strategy: LocatorStrategy;
  /** Why it did not survive - kept for the compiler's evidence, not discarded. */
  reason: string;
}

export type SynthesisOutcome =
  | { ok: true; bundle: LocatorBundle; rejected: RejectedStrategy[] }
  | { ok: false; reason: string; rejected: RejectedStrategy[] };

/**
 * Text that reads as a live value rather than as wording: currency, dates,
 * times, percentages. A locator keyed on one of these verifies perfectly at
 * record time and then breaks silently the next day, which is the worst
 * failure shape available - so it is detected here rather than discovered in
 * production.
 *
 * Deliberately narrow. Bare digit runs are *not* volatile: account numbers and
 * member ids are digits too, and they are exactly what a durable locator should
 * key on. Guessing wider would cost more than it saves.
 */
const VOLATILE = [
  /[$£€]\s?\d/,                       // $4,210.55
  /\d{4}-\d{2}-\d{2}/,                // 2014-03-08
  /\d{1,2}\/\d{1,2}\/\d{2,4}/,        // 03/08/2014
  /\d{1,2}:\d{2}/,                    // 14:05
  /\d\s?%/,                           // 3.25 %
];

function looksVolatile(text: string): boolean {
  return VOLATILE.some((re) => re.test(text));
}

/** How much of a tier's confidence survives keying on a volatile value. */
const VOLATILE_PENALTY = 0.4;

/**
 * The value a strategy discriminates *by* - the part that would go stale. Role,
 * column name and geometry are structural and are not at issue here.
 */
function discriminatorOf(s: LocatorStrategy): string | undefined {
  switch (s.kind) {
    case 'table_cell_relative': return s.matchValue;
    case 'label_anchored':      return s.label;
    case 'role_name':           return s.name;
    case 'text':                return s.pattern;
    default:                    return undefined;
  }
}

/** Baseline confidence by tier: how long this kind of evidence tends to survive. */
const TIER_CONFIDENCE: Record<number, number> = {
  1: 0.95,  // what the control is and is called
  2: 0.90,  // which row holds the data you asked about
  3: 0.75,  // what the text beside it says
  4: 0.55,  // what it says
  6: 0.30,  // where it sits
};

export function synthesizeBundle(
  node: UiNode,
  snapshot: UiSnapshot,
  opts: SynthesizeOptions,
): SynthesisOutcome {
  const params = opts.params ?? {};
  const rejected: RejectedStrategy[] = [];
  const kept: RankedStrategy[] = [];

  // Generation order is tier order, and the first candidate in each tier that
  // verifies wins that tier. Candidates within a tier are ordered by how well
  // they tend to generalise, not by how easy they were to produce.
  const byTier: Array<[number, LocatorStrategy[]]> = [
    [1, opts.forExtraction ? [] : roleNameCandidates(node, params)],
    [2, tableCellCandidates(node, snapshot, params)],
    [3, labelAnchoredCandidates(node)],
    [4, opts.forExtraction ? [] : textCandidates(node)],
    [6, anchorOffsetCandidates(node, snapshot)],
  ];

  for (const [tier, candidates] of byTier) {
    for (const strategy of candidates) {
      const verdict = verify(strategy, node, snapshot, params);
      if (verdict.ok) {
        // Verification proves the strategy worked *once*, against the snapshot
        // it came from. Whether it will keep working is a separate question, and
        // the answer belongs in confidence and rationale rather than in silence.
        const volatile = discriminatorOf(strategy);
        const decayed = volatile !== undefined && looksVolatile(volatile);
        kept.push({
          tier,
          strategy,
          // Two decimals: this lands in a JSON artifact a human reads, and
          // 0.30000000000000004 is not a confidence, it is a floating-point leak.
          confidence: Math.round((TIER_CONFIDENCE[tier] ?? 0.5) * (decayed ? VOLATILE_PENALTY : 1) * 100) / 100,
          rationale: rationaleFor(strategy, node)
            + (decayed ? ` Discounted: it keys on ${JSON.stringify(volatile)}, which reads as a `
              + `balance, date or rate - a value that changes without the screen changing.` : ''),
        });
        break;
      }
      rejected.push({ strategy, reason: verdict.reason });
    }
  }

  if (kept.length === 0) {
    return {
      ok: false,
      reason: `no strategy could uniquely identify ${describe(node)}: `
        + `${rejected.length} candidate(s) generated, none verified`,
      rejected,
    };
  }

  return {
    ok: true,
    bundle: {
      description: opts.description,
      frame: { path: [...node.frameChain] },
      strategies: kept,
      requireUnique: true,
      // Cannot demand agreement from more witnesses than exist. Quorum is only
      // consulted when the top tier misses (decision #27), so a single-strategy
      // bundle is honest about being all-or-nothing rather than quietly
      // unsatisfiable.
      minAgreement: Math.min(2, kept.length),
      allowDegraded: true,
    },
    rejected,
  };
}

// ---------------------------------------------------------------------------
// Verification - the step that makes the rest of this file trustworthy
// ---------------------------------------------------------------------------

function verify(
  strategy: LocatorStrategy,
  node: UiNode,
  snapshot: UiSnapshot,
  params: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const result = runStrategy(strategy, snapshot, params);
  if (result.inapplicable) return { ok: false, reason: `inapplicable: ${result.inapplicable}` };
  if (result.candidates.length === 0) {
    return { ok: false, reason: 'matched nothing in its own snapshot' };
  }
  if (result.candidates.length > 1) {
    return { ok: false, reason: `ambiguous: matched ${result.candidates.length} nodes` };
  }
  const only = result.candidates[0]!;
  if (only !== node) {
    return { ok: false, reason: `resolved to a different node (${describe(only)})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tier 1 - role + accessible name
// ---------------------------------------------------------------------------

function roleNameCandidates(node: UiNode, params: Record<string, unknown>): LocatorStrategy[] {
  if (node.name.trim() === '') return [];
  const canonical = canonicalise(node.name, params);
  const out: LocatorStrategy[] = [];
  // The canonicalised form first: it is the one that works for every member
  // rather than only for the member this happened to be recorded against.
  if (canonical !== node.name) {
    out.push({ kind: 'role_name', role: node.role, name: canonical, exact: true });
  }
  out.push({ kind: 'role_name', role: node.role, name: node.name, exact: true });
  return out;
}

// ---------------------------------------------------------------------------
// Tier 2 - the legacy-grid workhorse
// ---------------------------------------------------------------------------

/**
 * "The control in the Action column of the row whose Type is Savings."
 *
 * Built by looking along the target's own row for a cell that identifies it.
 * Candidate match columns are ordered: canonicalisable values first (those
 * generalise across inputs), then left to right, because the identifying
 * column of a servicing grid is almost always one of the first.
 */
function tableCellCandidates(
  node: UiNode,
  snapshot: UiSnapshot,
  params: Record<string, unknown>,
): LocatorStrategy[] {
  const tc = node.tableContext;
  if (!tc || tc.rowIndex === undefined || tc.colHeader === undefined) return [];
  const targetColumn = tc.colHeader;

  const siblings = snapshot.nodes.filter((n) => {
    const s = n.tableContext;
    return n !== node
      && s !== undefined
      && s.table === tc.table
      && s.rowIndex === tc.rowIndex
      && s.colHeader !== undefined
      && s.colHeader !== targetColumn
      && n.name.trim() !== '';
  });

  return siblings
    .map((n) => {
      const value = canonicalise(n.name, params);
      return {
        matchColumn: n.tableContext!.colHeader!,
        value,
        colIndex: n.tableContext?.colIndex ?? Number.MAX_SAFE_INTEGER,
        generalises: value !== n.name,
        volatile: looksVolatile(value),
      };
    })
    // Generalising values first, then stable ones, then left to right. Matching
    // a row by its balance would verify today and break tomorrow; matching it by
    // its account number is what an operator would do.
    .sort((a, b) =>
      rank(a.generalises) - rank(b.generalises)
      || rank(!a.volatile) - rank(!b.volatile)
      || a.colIndex - b.colIndex)
    .map((c): LocatorStrategy => ({
      kind: 'table_cell_relative',
      table: { role: 'table', ...(tc.table === undefined ? {} : { name: tc.table }) },
      matchColumn: c.matchColumn,
      matchValue: c.value,
      targetColumn,
      // Without this the cell itself is as good a match as the link inside it.
      // See decision #30: a control nested in a cell inherits the cell's column.
      within: { role: node.role },
    }));
}

// ---------------------------------------------------------------------------
// Tier 3 - label-anchored
// ---------------------------------------------------------------------------

function labelAnchoredCandidates(node: UiNode): LocatorStrategy[] {
  return node.nearestLabels
    .filter((l) => l.trim() !== '')
    // Wording before values. "The link labelled Account Number" outlives "the
    // link next to $4,210.55" by however long it takes the balance to change.
    .sort((a, b) => rank(!looksVolatile(a)) - rank(!looksVolatile(b)))
    .map((label): LocatorStrategy => ({ kind: 'label_anchored', label, controlRole: node.role }));
}

// ---------------------------------------------------------------------------
// Tier 4 - visible text
// ---------------------------------------------------------------------------

/**
 * Anchored and escaped, so "View" does not also match "View all". Not
 * canonicalised: `byText` compiles the pattern straight into a RegExp without
 * interpolating, so an `$input.` reference here would be searched for literally.
 */
function textCandidates(node: UiNode): LocatorStrategy[] {
  const out: LocatorStrategy[] = [];
  if (node.name.trim() !== '') {
    out.push({ kind: 'text', pattern: `^${escapeRegex(node.name)}$`, role: node.role });
  }
  if (node.value !== undefined && node.value.trim() !== '' && node.value !== node.name) {
    out.push({ kind: 'text', pattern: `^${escapeRegex(node.value)}$`, role: node.role });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 6 - geometry relative to an anchor
// ---------------------------------------------------------------------------

/**
 * Anchors must be unique by role+name in the snapshot, because `byAnchorOffset`
 * takes the *first* node matching the anchor description. An ambiguous anchor
 * would measure from whichever one happened to come first in document order,
 * which is a coin flip dressed up as geometry.
 *
 * Nearest anchor first: things close together are more likely to move together.
 */
function anchorOffsetCandidates(node: UiNode, snapshot: UiSnapshot): LocatorStrategy[] {
  const box = node.box;
  if (!box) return [];
  const frame = node.frameChain.join('>');

  const seen = new Map<string, number>();
  for (const n of snapshot.nodes) {
    const key = JSON.stringify([n.role, normalise(n.name)]);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  return snapshot.nodes
    .flatMap((n) => {
      if (n === node || !n.box || n.name.trim() === '') return [];
      if (n.frameChain.join('>') !== frame) return [];
      if (seen.get(JSON.stringify([n.role, normalise(n.name)])) !== 1) return [];
      const d = Math.hypot(cx - (n.box.x + n.box.w / 2), cy - (n.box.y + n.box.h / 2));
      return [{ anchor: n, box: n.box, d }];
    })
    .sort((a, b) => a.d - b.d)
    .map(({ anchor, box: ab }): LocatorStrategy => ({
      kind: 'anchor_offset',
      anchor: { role: anchor.role, name: anchor.name },
      // byAnchorOffset compares the *centre* of each candidate against the
      // anchor's box origin plus this delta, so it is measured the same way.
      dx: cx - ab.x,
      dy: cy - ab.y,
    }));
}

// ---------------------------------------------------------------------------
// Rationale - a stored field because Section 3.2 asks for the reasoning
// ---------------------------------------------------------------------------

function rationaleFor(s: LocatorStrategy, node: UiNode): string {
  switch (s.kind) {
    case 'role_name':
      return `role=${s.role} name=${JSON.stringify(s.name ?? '')} is unique in the recorded `
        + `snapshot. Survives re-skinning and id churn for as long as the control keeps its `
        + `accessible name.`;
    case 'table_cell_relative':
      return `Row identified by ${s.matchColumn}=${JSON.stringify(s.matchValue)}, then the `
        + `${s.targetColumn} column - the way an operator finds it. Survives id churn, row `
        + `re-ordering and re-skinning, because it depends on the data rather than the markup.`;
    case 'label_anchored':
      return `The ${node.role} labelled ${JSON.stringify(s.label)}. Durable while the form's `
        + `visible wording holds; breaks on copy changes rather than on markup changes.`;
    case 'text':
      return `Matches its own visible text exactly (${s.pattern}). Cheap and surprisingly durable `
        + `for buttons, but it cannot tell two identically-worded controls apart.`;
    case 'anchor_offset':
      return `Geometry only: ${Math.round(s.dx)},${Math.round(s.dy)} px from `
        + `${JSON.stringify(s.anchor.name ?? s.anchor.role)}. Carries the no-accessibility-tree `
        + `case; viewport-relative, so only this delta is meaningful, and it is never trusted alone.`;
    case 'css':
      return `Recorded for forensics only; never resolved from an accessibility snapshot.`;
  }
}

// ---------------------------------------------------------------------------

/**
 * Rewrites a literal that equals a recorded input into `$input.<name>`. Longest
 * value first, for the same reason the redactor matches longest-first: a short
 * input that happens to be a substring of a longer one must not win.
 */
function canonicalise(text: string, params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [key, value] of entries) {
    if (normalise(text) === normalise(String(value))) return `$input.${key}`;
  }
  return text;
}

function describe(node: UiNode): string {
  return `${node.role}${node.name ? ` "${node.name}"` : ''} (ref ${node.ref})`;
}

/** Sort helper: true sorts before false. */
function rank(b: boolean): number {
  return b ? 0 : 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
