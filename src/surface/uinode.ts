/**
 * What we perceive, normalised.
 *
 * This shape is the seam between "how we look at a surface" and "what the
 * recorded flow says". It is deliberately describable in terms a screen reader
 * would use - role, name, value, state - because that vocabulary is the one
 * thing shared by a modern web app, a 1998 frameset, and a native desktop
 * window. A DOM-shaped type here would have quietly welded the whole system to
 * browsers.
 *
 * Everything richer than role+name (table context, nearest labels, geometry) is
 * present because legacy grids need it to be findable, not because it is nice
 * to have. See docs/adr/0001-accessibility-first-perception.md.
 */

export interface BoundingBox {
  /** Viewport-relative CSS pixels, per getBoundingClientRect. Only deltas
   *  between nodes in the same snapshot are scroll-invariant. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiNodeState {
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  focused?: boolean;
  readonly?: boolean;
}

export interface TableContext {
  /** Accessible name of the enclosing table, when it has one. */
  table?: string;
  /** Header cells for this node's row, left to right. */
  rowHeaders: string[];
  /** Header for this node's column. */
  colHeader?: string;
  rowIndex?: number;
  colIndex?: number;
}

export interface UiNode {
  /**
   * Snapshot-scoped handle. This is what the model is given and what it points
   * at; it is meaningless outside the snapshot it came from, which is the point
   * - it cannot be persisted into an artifact by accident.
   */
  ref: string;
  role: string;
  name: string;
  value?: string;
  state: UiNodeState;
  /** Frame chain by name or url fragment, outermost first. Never by index. */
  frameChain: string[];
  box?: BoundingBox;
  /** Roles and names of ancestors, outermost first. Used for scoping. */
  ancestry: Array<{ role: string; name?: string }>;
  tableContext?: TableContext;
  /** Structurally or visually adjacent text, for label-anchored location. */
  nearestLabels: string[];
  /** Depth in the accessibility tree, for stable ordering and truncation. */
  depth: number;
}

export interface UiSnapshot {
  url: string;
  title: string;
  nodes: UiNode[];
  /**
   * Hash over the structural shape of the snapshot (roles, names, order) but
   * NOT over volatile values. Two renders of the same screen with the same data
   * hash the same, which is what makes oscillation detection and backtrack
   * pruning possible.
   */
  structureHash: string;
  capturedAt: string;
  /** True when a blocking dialog is present - checked before every action. */
  blockingDialog?: { ref: string; name: string };
  /** Nodes dropped by the depth cap, so truncation is never silent. */
  truncatedNodes: number;
}

export function findNode(snapshot: UiSnapshot, ref: string): UiNode | undefined {
  return snapshot.nodes.find((n) => n.ref === ref);
}
