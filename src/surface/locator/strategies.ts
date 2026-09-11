/**
 * The six location strategies, resolved against a UiSnapshot.
 *
 * Every one of these answers the same question - "which node did the artifact
 * mean?" - from a different kind of evidence, and they are ordered by how long
 * that evidence tends to survive:
 *
 *   1 role_name            what the control *is* and what it is *called*
 *   2 table_cell_relative  which row holds the data you asked about
 *   3 label_anchored       what the text next to it says
 *   4 text                 what it says
 *   5 css                  what a developer happened to name it
 *   6 anchor_offset        where it sits relative to something else
 *
 * Tiers 1-4 are all things a human operator uses. Tier 5 is the only one that
 * depends on implementation detail, and it is deliberately near the bottom.
 *
 * Kept in one file rather than a directory of six modules: they share the
 * matcher helpers, they are read together, and six files of thirty lines would
 * be structure for its own sake.
 */

import type { UiNode, UiSnapshot } from '../uinode.ts';
import type { LocatorStrategy } from '../../core/schema.ts';

export interface StrategyResult {
  /** Nodes this strategy considers a match, in document order. */
  candidates: UiNode[];
  /**
   * True when this strategy cannot be evaluated against a snapshot at all, as
   * opposed to being evaluated and finding nothing. The difference matters:
   * "did not apply" must not be scored as "disagreed".
   */
  inapplicable?: string;
}

export function runStrategy(
  strategy: LocatorStrategy,
  snapshot: UiSnapshot,
  params: Record<string, unknown> = {},
): StrategyResult {
  switch (strategy.kind) {
    case 'role_name':           return byRoleName(strategy, snapshot, params);
    case 'table_cell_relative': return byTableCell(strategy, snapshot, params);
    case 'label_anchored':      return byLabel(strategy, snapshot);
    case 'text':                return byText(strategy, snapshot);
    case 'css':                 return byCss();
    case 'anchor_offset':       return byAnchorOffset(strategy, snapshot);
  }
}

// ---------------------------------------------------------------------------
// Tier 1 - role + accessible name
// ---------------------------------------------------------------------------

function byRoleName(
  s: Extract<LocatorStrategy, { kind: 'role_name' }>,
  snapshot: UiSnapshot,
  params: Record<string, unknown>,
): StrategyResult {
  const wantName = s.name === undefined ? undefined : interpolate(s.name, params);
  const re = s.nameMatches ? new RegExp(s.nameMatches) : undefined;

  const candidates = snapshot.nodes.filter((n) => {
    if (n.role !== s.role) return false;
    if (re) return re.test(n.name);
    if (wantName === undefined) return true;
    return s.exact
      ? n.name === wantName
      : n.name.trim().toLowerCase().includes(wantName.trim().toLowerCase());
  });
  return { candidates };
}

// ---------------------------------------------------------------------------
// Tier 2 - the legacy-grid workhorse
// ---------------------------------------------------------------------------

/**
 * "The control in the Action column of the row whose Type is Savings."
 *
 * This exists because on a real servicing grid every row's action link has the
 * identical accessible name. Role and name cannot tell them apart; the row's
 * data can, and that is how a human tells them apart too.
 */
function byTableCell(
  s: Extract<LocatorStrategy, { kind: 'table_cell_relative' }>,
  snapshot: UiSnapshot,
  params: Record<string, unknown>,
): StrategyResult {
  const wantValue = interpolate(s.matchValue, params);
  const inTable = snapshot.nodes.filter((n) =>
    n.tableContext !== undefined
    && (s.table.name === undefined || n.tableContext.table === s.table.name));

  // Which rows satisfy "matchColumn reads matchValue"?
  const matchingRows = new Set<number>();
  for (const n of inTable) {
    const tc = n.tableContext!;
    if (tc.rowIndex === undefined) continue;
    if (tc.colHeader !== s.matchColumn) continue;
    if (normalise(n.name) === normalise(wantValue)) matchingRows.add(tc.rowIndex);
  }

  const candidates = inTable.filter((n) => {
    const tc = n.tableContext!;
    if (tc.rowIndex === undefined || !matchingRows.has(tc.rowIndex)) return false;
    if (tc.colHeader !== s.targetColumn) return false;
    return s.within ? n.role === s.within.role : true;
  });

  return { candidates };
}

// ---------------------------------------------------------------------------
// Tier 3 - label-anchored
// ---------------------------------------------------------------------------

function byLabel(
  s: Extract<LocatorStrategy, { kind: 'label_anchored' }>,
  snapshot: UiSnapshot,
): StrategyResult {
  const re = s.labelMatches ? new RegExp(s.labelMatches) : undefined;
  const matches = (text: string): boolean =>
    re ? re.test(text) : normalise(text) === normalise(s.label);

  const pool = snapshot.nodes.filter((n) => !s.controlRole || n.role === s.controlRole);

  // Two ways a node can be associated with a label, and they are not equal:
  //
  //   labelled - the label sits next to it (the previous cell in its row).
  //              This is the value, which is what you almost always want.
  //   named    - the node's own accessible name IS the label. For a proper
  //              <label for> control that is correct; for a table this is the
  //              label cell itself, which is the thing you want least.
  //
  // On "Current Balance | $4,210.55" both cells match, and returning both makes
  // the strategy ambiguous and therefore useless. So: if anything is *labelled*
  // by this text, prefer those and discard the merely *named*. "The thing
  // labelled X" beats "the thing that says X".
  const labelled = pool.filter((n) => n.nearestLabels.some(matches));
  const named = pool.filter((n) => matches(n.name));

  return { candidates: labelled.length > 0 ? labelled : named };
}

// ---------------------------------------------------------------------------
// Tier 4 - visible text
// ---------------------------------------------------------------------------

function byText(
  s: Extract<LocatorStrategy, { kind: 'text' }>,
  snapshot: UiSnapshot,
): StrategyResult {
  const re = new RegExp(s.pattern);
  const candidates = snapshot.nodes.filter((n) =>
    (!s.role || n.role === s.role) && (re.test(n.name) || (n.value !== undefined && re.test(n.value))));
  return { candidates };
}

// ---------------------------------------------------------------------------
// Tier 5 - CSS
// ---------------------------------------------------------------------------

/**
 * Not resolvable from an accessibility snapshot, and that is the honest
 * answer rather than a limitation to apologise for.
 *
 * A CSS selector is recorded during discovery for forensics - if it *does*
 * still match later, that tells you the DOM did not change - but it plays no
 * part in choosing a node here, and it never contributes to quorum. On the
 * target app it is guaranteed stale by the next render anyway.
 */
function byCss(): StrategyResult {
  return { candidates: [], inapplicable: 'css selectors are not resolvable from an accessibility snapshot' };
}

// ---------------------------------------------------------------------------
// Tier 6 - geometry relative to an anchor
// ---------------------------------------------------------------------------

/**
 * Carries the no-accessibility-tree case (a desktop surface, a canvas-rendered
 * grid). Anchor-*relative* on purpose: boxes inside a frame are frame-local, so
 * absolute coordinates mean nothing across frames, but the delta between two
 * nodes in the same frame is sound.
 */
function byAnchorOffset(
  s: Extract<LocatorStrategy, { kind: 'anchor_offset' }>,
  snapshot: UiSnapshot,
): StrategyResult {
  const anchor = snapshot.nodes.find((n) =>
    n.role === s.anchor.role
    && (s.anchor.name === undefined || normalise(n.name) === normalise(s.anchor.name))
    && n.box);
  if (!anchor?.box) return { candidates: [], inapplicable: 'anchor node not found or has no geometry' };

  const targetX = anchor.box.x + s.dx;
  const targetY = anchor.box.y + s.dy;
  const TOLERANCE = 24;

  const scored = snapshot.nodes
    .filter((n) => n.box && sameFrame(n, anchor) && n !== anchor)
    .map((n) => ({ node: n, d: Math.hypot(centreX(n) - targetX, centreY(n) - targetY) }))
    .filter((c) => c.d <= TOLERANCE)
    .sort((a, b) => a.d - b.d);

  return { candidates: scored.map((c) => c.node) };
}

// ---------------------------------------------------------------------------

function sameFrame(a: UiNode, b: UiNode): boolean {
  return a.frameChain.join('>') === b.frameChain.join('>');
}
const centreX = (n: UiNode): number => (n.box ? n.box.x + n.box.w / 2 : NaN);
const centreY = (n: UiNode): number => (n.box ? n.box.y + n.box.h / 2 : NaN);

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Substitutes `$input.memberId` style references. Canonicalisation turns
 * literal values recorded during discovery into these, which is what makes one
 * recording work for every member rather than only for member 12345.
 */
export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\$input\.([A-Za-z0-9_]+)/g, (whole, key: string) => {
    const v = params[key];
    return v === undefined ? whole : String(v);
  });
}
