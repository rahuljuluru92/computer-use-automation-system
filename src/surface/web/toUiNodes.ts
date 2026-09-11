/**
 * Flattening a parsed aria tree into the UiNode list the rest of the system
 * works with.
 *
 * Three things are computed here that the raw tree does not give you, and each
 * one exists because a legacy grid needs it to be findable:
 *
 *  - **frameChain** - derived from the ref's frame ordinal. When the ordinal
 *    changes between a node and its parent, we have crossed into an iframe, and
 *    the iframe's accessible name (or title, or a stable ordinal fallback) is
 *    pushed onto the chain. Chains are named, never indexed, because "the
 *    second iframe" stops being true the moment someone adds a banner.
 *
 *  - **tableContext** - the column header above a cell and the other cells in
 *    its row. This is what makes "the View link in the row whose Type is
 *    Savings" expressible. On the target app all three View links have the
 *    identical accessible name, so without row context there is no way to tell
 *    them apart that a human would recognise as reasonable.
 *
 *  - **nearestLabels** - text that labels a control, for label-anchored
 *    location. In a table-laid-out form the label is a sibling cell, not a
 *    <label for> - though this app has both, which is realistic: legacy
 *    markup is usually semantically salvageable, just not selector-friendly.
 */

import { createHash } from 'node:crypto';
import type { ParsedAriaNode } from './ariaYaml.ts';
import type { UiNode, UiSnapshot, TableContext } from '../uinode.ts';

/** Roles that carry no useful identity and only add noise for the model. */
const STRUCTURAL = new Set(['generic', 'rowgroup', 'text', 'none', 'presentation']);

interface Frame {
  name: string;
}

export interface FlattenOptions {
  url: string;
  title: string;
  /** Drop nodes deeper than this. Truncation is reported, never silent. */
  maxDepth?: number;
  /**
   * Frame names in document order, supplied by the caller.
   *
   * The aria snapshot does not expose an iframe's name or title, so the only
   * naming available from the tree alone is document order. WebSurface knows
   * better - it can read the real `name`/`id` off the element - and passing
   * them in keeps the parser pure while still producing chains that are named
   * rather than positional. Fixture-driven tests omit it and get the fallback.
   */
  frameNames?: string[];
}

export function flattenToSnapshot(
  roots: ParsedAriaNode[],
  opts: FlattenOptions,
): UiSnapshot {
  const nodes: UiNode[] = [];
  let truncated = 0;
  let frameSeq = 0;
  const maxDepth = opts.maxDepth ?? Infinity;

  const visit = (
    node: ParsedAriaNode,
    ancestors: ParsedAriaNode[],
    frames: Frame[],
    depth: number,
  ): void => {
    // Crossing into an iframe: everything below gets one more link in the chain.
    let childFrames = frames;
    if (node.role === 'iframe') {
      childFrames = [...frames, { name: frameName(node, frameSeq, opts.frameNames) }];
      frameSeq += 1;
    }

    if (depth > maxDepth) { truncated += 1; return; }

    if (node.ref && !STRUCTURAL.has(node.role)) {
      nodes.push(toUiNode(node, ancestors, frames, depth));
    }

    for (const child of node.children) {
      visit(child, [...ancestors, node], childFrames, depth + 1);
    }
  };

  for (const root of roots) visit(root, [], [], 0);

  return {
    url: opts.url,
    title: opts.title,
    nodes,
    structureHash: structureHash(nodes),
    capturedAt: new Date().toISOString(),
    truncatedNodes: truncated,
    ...(findBlockingDialog(nodes) ? { blockingDialog: findBlockingDialog(nodes)! } : {}),
  };
}

/**
 * A name for a frame that survives a page reload.
 *
 * Playwright's ref prefix carries a frame ordinal (`f3e28`), and it is tempting
 * to use it. It is not stable: two renders of the same screen came back as `f2`
 * and `f11`. Using it would have made the structure hash differ between
 * identical screens, quietly breaking oscillation detection and backtrack
 * pruning - the ordinal is every bit as volatile as the control ids this whole
 * design exists to avoid.
 *
 * So, in order of preference: a real name supplied by the caller from the DOM,
 * then whatever name the tree happens to carry, then document order among
 * frames - which is at least stable as long as the page is, and is honestly
 * labelled as positional when it is used.
 */
function frameName(iframe: ParsedAriaNode, seq: number, supplied?: string[]): string {
  const fromCaller = supplied?.[seq]?.trim();
  if (fromCaller) return fromCaller;
  const fromTree = iframe.name?.trim()
    || (typeof iframe.attrs.title === 'string' ? iframe.attrs.title.trim() : '')
    || (typeof iframe.attrs.name === 'string' ? iframe.attrs.name.trim() : '');
  return fromTree || `frame#${seq}`;
}

function toUiNode(
  node: ParsedAriaNode,
  ancestors: ParsedAriaNode[],
  frames: Frame[],
  depth: number,
): UiNode {
  const state: UiNode['state'] = {};
  if (node.attrs.disabled) state.disabled = true;
  if (node.attrs.checked) state.checked = true;
  if (node.attrs.expanded) state.expanded = true;
  if (node.attrs.active) state.focused = true;
  if (node.attrs.readonly) state.readonly = true;

  const ui: UiNode = {
    ref: node.ref!,
    role: node.role,
    name: node.name ?? inlineText(node),
    state,
    frameChain: frames.map((f) => f.name),
    ancestry: ancestors
      .filter((a) => !STRUCTURAL.has(a.role))
      .map((a) => ({ role: a.role, ...(a.name ? { name: a.name } : {}) })),
    nearestLabels: nearestLabels(node, ancestors),
    depth,
  };
  if (node.box) ui.box = node.box;
  const value = inlineText(node);
  if (value && value !== ui.name) ui.value = value;

  const table = tableContext(node, ancestors);
  if (table) ui.tableContext = table;

  return ui;
}

/** Text directly under a node, including one level of structural wrappers. */
function inlineText(node: ParsedAriaNode): string {
  if (node.text) return node.text.trim();
  const parts: string[] = [];
  for (const c of node.children) {
    if (c.role === 'text' && c.text) parts.push(c.text.trim());
    else if (STRUCTURAL.has(c.role) && c.text) parts.push(c.text.trim());
  }
  return parts.join(' ').trim();
}

/**
 * Column header and row contents for a cell. Header row is the first row in
 * the table that contains columnheaders - which is where it is in every
 * table-laid-out grid, including ones nested inside layout tables.
 */
function tableContext(node: ParsedAriaNode, ancestors: ParsedAriaNode[]): TableContext | undefined {
  const rowIdx = lastIndexOfRole(ancestors, 'row');
  if (rowIdx === -1) return undefined;
  const row = ancestors[rowIdx]!;
  const tableIdx = lastIndexOfRole(ancestors.slice(0, rowIdx), 'table');
  const table = tableIdx === -1 ? undefined : ancestors[tableIdx];

  const cells = row.children.filter((c) => c.role === 'cell' || c.role === 'columnheader');
  const colIndex = cells.indexOf(node);

  const headers = table ? headerRowOf(table) : [];
  const ctx: TableContext = {
    rowHeaders: cells.map((c) => c.name ?? inlineText(c)).filter(Boolean),
  };
  if (table?.name) ctx.table = table.name;
  if (colIndex >= 0) {
    ctx.colIndex = colIndex;
    const header = headers[colIndex];
    if (header) ctx.colHeader = header;
  }
  const rows = allRowsOf(table);
  const rowIndex = rows.indexOf(row);
  if (rowIndex >= 0) ctx.rowIndex = rowIndex;
  return ctx;
}

function headerRowOf(table: ParsedAriaNode): string[] {
  for (const row of allRowsOf(table)) {
    const hs = row.children.filter((c) => c.role === 'columnheader');
    if (hs.length > 1) return hs.map((h) => h.name ?? inlineText(h));
  }
  return [];
}

function allRowsOf(table: ParsedAriaNode | undefined): ParsedAriaNode[] {
  if (!table) return [];
  const rows: ParsedAriaNode[] = [];
  const rec = (n: ParsedAriaNode): void => {
    for (const c of n.children) {
      if (c.role === 'row') rows.push(c);
      // Do not descend into a nested table: its rows are not these rows.
      if (c.role !== 'table') rec(c);
    }
  };
  rec(table);
  return rows;
}

function lastIndexOfRole(nodes: ParsedAriaNode[], role: string): number {
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i]!.role === role) return i;
  return -1;
}

/**
 * Text that plausibly labels this control: the preceding sibling's text, and
 * the preceding cell in the same row. Both are how legacy forms label things.
 */
function nearestLabels(node: ParsedAriaNode, ancestors: ParsedAriaNode[]): string[] {
  const parent = ancestors[ancestors.length - 1];
  const labels: string[] = [];
  if (parent) {
    const idx = parent.children.indexOf(node);
    for (let i = idx - 1; i >= 0 && labels.length < 2; i--) {
      const t = parent.children[i]!.name ?? inlineText(parent.children[i]!);
      if (t) labels.push(t);
    }
  }
  const row = ancestors[lastIndexOfRole(ancestors, 'row')];
  if (row) {
    const cells = row.children.filter((c) => c.role === 'cell' || c.role === 'columnheader');
    const own = cells.findIndex((c) => c === node || contains(c, node));
    const prev = own > 0 ? cells[own - 1] : undefined;
    if (prev) {
      const t = prev.name ?? inlineText(prev);
      if (t && !labels.includes(t)) labels.push(t);
    }
  }
  return labels;
}

function contains(parent: ParsedAriaNode, target: ParsedAriaNode): boolean {
  for (const c of parent.children) {
    if (c === target || contains(c, target)) return true;
  }
  return false;
}

/**
 * Hash of the snapshot's *shape*: roles, names and nesting, but not values.
 *
 * Two renders of the same screen showing the same data hash identically even
 * though every control id changed - which is what makes oscillation detection
 * and backtrack pruning possible at all. Including values would make every
 * hash unique and both features useless.
 */
export function structureHash(nodes: UiNode[]): string {
  const shape = nodes
    .map((n) => `${n.frameChain.join('>')}|${n.role}|${n.name}`)
    .join('\n');
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}

function findBlockingDialog(nodes: UiNode[]): { ref: string; name: string } | undefined {
  const dialog = nodes.find((n) => n.role === 'dialog' || n.role === 'alertdialog');
  return dialog ? { ref: dialog.ref, name: dialog.name } : undefined;
}
