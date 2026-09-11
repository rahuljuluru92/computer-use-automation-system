/**
 * Parsing Playwright's AI-mode aria snapshot.
 *
 * `locator.ariaSnapshot({ mode: 'ai', boxes: true })` emits valid YAML whose
 * keys are descriptors, like:
 *
 *   - table "Accounts" [ref=f3e28] [box=16,151,760,122]:
 *     - row [ref=f3e38]:
 *       - cell "0001-4477" [ref=f3e39]
 *       - link "View" [ref=f3e44] [cursor=pointer]:
 *         - /url: /frame/members/12345/accounts/0001-4477
 *
 * So this is a YAML parse plus a regex over the descriptor strings, rather
 * than a hand-rolled indentation walker. Parsing a format someone else
 * generates by counting spaces is a standing invitation to break on their next
 * release; letting their YAML be YAML is not.
 *
 * Two properties of the format do real work downstream:
 *
 *  1. **Refs encode the frame.** `f2e17` is element 17 in frame 2; the iframe's
 *     children come back as `f3e*`. So the frame chain is recoverable from the
 *     tree itself - no separate frame enumeration, no guessing.
 *
 *  2. **Boxes inside a frame are frame-local.** The iframe sits at y=66 on the
 *     page while its first child reports y=0. Absolute coordinates are
 *     therefore meaningless across frames, which is why the only geometric
 *     strategy in this system is anchor-*relative* and compares two nodes from
 *     the same frame.
 */

import YAML from 'yaml';
import type { BoundingBox } from '../uinode.ts';

export interface ParsedAriaNode {
  role: string;
  name?: string;
  /** `[cursor=pointer]` -> cursor: 'pointer'; `[active]` -> active: true. */
  attrs: Record<string, string | true>;
  ref?: string;
  /** Frame ordinal parsed out of the ref (`f3e28` -> 3). */
  frameOrdinal?: number;
  box?: BoundingBox;
  /** Inline text content, when the node's YAML value is a scalar. */
  text?: string;
  /** From a `/url:` child, for links. */
  url?: string;
  children: ParsedAriaNode[];
}

/**
 * `role` then an optional quoted accessible name then any number of bracketed
 * attributes. Roles are ASCII words; names are double-quoted with backslash
 * escapes; attributes are `[flag]` or `[key=value]`.
 */
const DESCRIPTOR = /^(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*$/;
const ATTR = /\[([^\]=]+?)(?:=([^\]]*))?\]/g;
const REF = /^f(\d+)e\d+$/;

export function parseAriaSnapshot(yamlText: string): ParsedAriaNode[] {
  if (!yamlText.trim()) return [];
  const doc = YAML.parse(yamlText) as unknown;
  return toNodes(doc);
}

function toNodes(value: unknown): ParsedAriaNode[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedAriaNode[] = [];
  for (const entry of value) {
    const node = toNode(entry);
    if (node) out.push(node);
  }
  return out;
}

function toNode(entry: unknown): ParsedAriaNode | null {
  // A childless element is emitted as a bare string, because YAML only makes
  // it a mapping when there is something to map to:
  //
  //     - cell "0001-4477" [ref=f3e39] [box=...]          <- string
  //     - cell [ref=f3e43] [box=...]:                     <- mapping
  //         - link "View" [ref=f3e44]
  //
  // Treating bare strings as loose text silently drops every leaf in the tree,
  // which on this app means every column header and almost every table cell -
  // i.e. exactly the nodes the grid strategies depend on.
  if (typeof entry === 'string') {
    return fromDescriptor(entry, undefined);
  }
  if (!entry || typeof entry !== 'object') return null;

  const pairs = Object.entries(entry as Record<string, unknown>);
  const first = pairs[0];
  if (!first) return null;
  const [descriptor, value] = first;

  // `- text: Servicing Console v7.2.14`
  if (descriptor === 'text') {
    return { role: 'text', text: String(value ?? ''), attrs: {}, children: [] };
  }
  // `- /url: /logout` is metadata on the parent, handled by the caller.
  if (descriptor.startsWith('/')) {
    return { role: descriptor, text: String(value ?? ''), attrs: {}, children: [] };
  }

  return fromDescriptor(descriptor, value);
}

function fromDescriptor(descriptor: string, value: unknown): ParsedAriaNode {
  const m = DESCRIPTOR.exec(descriptor);
  if (!m) {
    // Unrecognised descriptor: keep it as an opaque node rather than dropping
    // it. Silently losing part of the tree would be worse than a strange role.
    return { role: descriptor, attrs: {}, children: [] };
  }

  const [, role = 'generic', rawName, rawAttrs = ''] = m;
  const attrs: Record<string, string | true> = {};
  for (const a of rawAttrs.matchAll(ATTR)) {
    attrs[a[1]!.trim()] = a[2] === undefined ? true : a[2].trim();
  }

  const node: ParsedAriaNode = {
    role,
    attrs,
    children: [],
    ...(rawName !== undefined ? { name: unescapeName(rawName) } : {}),
  };

  const ref = typeof attrs.ref === 'string' ? attrs.ref : undefined;
  if (ref) {
    node.ref = ref;
    const rm = REF.exec(ref);
    if (rm) node.frameOrdinal = Number(rm[1]);
  }

  const box = typeof attrs.box === 'string' ? parseBox(attrs.box) : undefined;
  if (box) node.box = box;

  if (typeof value === 'string') {
    node.text = value;
  } else if (Array.isArray(value)) {
    for (const child of toNodes(value)) {
      // Lift `/url` onto the parent instead of leaving it as a pseudo-child.
      if (child.role === '/url') { if (child.text !== undefined) node.url = child.text; }
      else node.children.push(child);
    }
  }

  return node;
}

function parseBox(raw: string): BoundingBox | undefined {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return undefined;
  return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
}

function unescapeName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** Depth-first walk, parents before children. */
export function walk(
  nodes: ParsedAriaNode[],
  visit: (node: ParsedAriaNode, ancestors: ParsedAriaNode[]) => void,
  ancestors: ParsedAriaNode[] = [],
): void {
  for (const node of nodes) {
    visit(node, ancestors);
    walk(node.children, visit, [...ancestors, node]);
  }
}
