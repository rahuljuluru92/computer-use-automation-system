/**
 * Turning one recording into a capability that works for everyone.
 *
 * A run recorded against member 12345 is full of the number 12345 - in the URL
 * it navigated to, in the text it typed, in the row it identified to find the
 * View link. Left alone, that artifact is a capability for reading *Jordan
 * Avery's* savings balance, which is not a capability at all.
 *
 * So every literal that equals a task input is rewritten to a reference. Two
 * syntaxes, because the runtime has two interpolators and pretending otherwise
 * would produce a flow that navigates to a URL containing the text
 * "$input.memberId":
 *
 *   URLs          `{memberId}`        - Executor.interpolateUrl
 *   everything else `$input.memberId` - strategies.interpolate
 *
 * Only the fields the resolver actually interpolates are rewritten (decision
 * #51). A reference anywhere else is not a reference, it is a literal that
 * happens to contain a dollar sign.
 *
 * Most of this has already happened at record time: `tools.ts` canonicalises
 * as it records, so the values reach here referenced. This pass is the safety
 * net for what that missed - a model that typed `12345` instead of
 * `$input.memberId` despite being asked, or a control whose accessible name
 * carries the member id. Running it twice is harmless, which is the property
 * you want in a belt-and-braces pass.
 */

import type { LocatorBundle, LocatorStrategy, Predicate } from '../core/schema.ts';
import type { RecordedStep } from './tools.ts';

export interface Rewrite {
  stepIndex: number;
  field: string;
  from: string;
  to: string;
}

export interface CanonicalizeResult {
  steps: RecordedStep[];
  /**
   * Inputs the compiled flow actually references. The artifact should require
   * exactly these - an input nothing reads is a question asked of every caller
   * for no reason.
   */
  used: string[];
  rewrites: Rewrite[];
}

/**
 * Values shorter than this are left alone. A parameter whose value is "1"
 * would otherwise rewrite every "1" in every URL, label and column header in
 * the flow. The Redactor refuses short values for the same reason (#13): a
 * substitution that fires everywhere destroys the thing it was meant to
 * generalise.
 */
const MIN_LENGTH = 3;

export function canonicalize(
  steps: readonly RecordedStep[],
  params: Record<string, unknown>,
): CanonicalizeResult {
  // Longest first, so a short input that happens to sit inside a longer one
  // does not win the race and leave the rest of the longer value inline.
  const entries = Object.entries(params)
    .map(([name, value]) => ({ name, value: String(value ?? '') }))
    .filter((e) => e.value.trim().length >= MIN_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);

  const rewrites: Rewrite[] = [];
  const used = new Set<string>();

  const out = steps.map((step, stepIndex) => {
    const at = (field: string) => ({
      note: (from: string, to: string, name: string) => {
        rewrites.push({ stepIndex, field, from, to });
        used.add(name);
      },
    });

    const next: RecordedStep = { ...step };

    // Any reference already present counts as used, whether this pass put it
    // there or record time did.
    for (const name of referencedInputs(step)) used.add(name);

    if (next.action.kind === 'navigate') {
      const from = next.action.urlTemplate;
      const to = substitute(from, entries, braceRef, at('action.urlTemplate').note);
      if (to !== from) next.action = { ...next.action, urlTemplate: to };
    }

    if (next.data) {
      const from = next.data.value;
      const to = substitute(from, entries, inputRef, at('data.value').note);
      if (to !== from) next.data = { ...next.data, value: to };
    }

    if (next.target) {
      next.target = canonicalBundle(next.target, entries, at('target').note);
    }

    if (next.extract.length > 0) {
      next.extract = next.extract.map((e, n) => ({
        ...e,
        from: canonicalBundle(e.from, entries, at(`extract[${n}].from`).note),
      }));
    }

    if (next.checkpoint.length > 0) {
      next.checkpoint = next.checkpoint.map((p, n) =>
        canonicalPredicate(p, entries, at(`checkpoint[${n}]`).note));
    }

    return next;
  });

  return { steps: out, used: [...used].sort(), rewrites };
}

// ---------------------------------------------------------------------------

type Entry = { name: string; value: string };
type Note = (from: string, to: string, name: string) => void;
type Ref = (name: string) => string;

const inputRef: Ref = (name) => `$input.${name}`;
const braceRef: Ref = (name) => `{${name}}`;

function substitute(text: string, entries: Entry[], ref: Ref, note: Note): string {
  let out = text;
  for (const e of entries) {
    if (!out.includes(e.value)) continue;
    const replaced = out.split(e.value).join(ref(e.name));
    note(out, replaced, e.name);
    out = replaced;
  }
  return out;
}

/**
 * Only `role_name.name` and `table_cell_relative.matchValue` are rewritten.
 * `label_anchored`, `text` and `anchor_offset` are matched literally by the
 * resolver, so a reference in one of them would be searched for as text.
 */
function canonicalBundle(bundle: LocatorBundle, entries: Entry[], note: Note): LocatorBundle {
  return {
    ...bundle,
    strategies: bundle.strategies.map((ranked) => ({
      ...ranked,
      strategy: canonicalStrategy(ranked.strategy, entries, note),
    })),
  };
}

function canonicalStrategy(s: LocatorStrategy, entries: Entry[], note: Note): LocatorStrategy {
  if (s.kind === 'role_name' && s.name !== undefined) {
    const name = substitute(s.name, entries, inputRef, note);
    return name === s.name ? s : { ...s, name };
  }
  if (s.kind === 'table_cell_relative') {
    const matchValue = substitute(s.matchValue, entries, inputRef, note);
    return matchValue === s.matchValue ? s : { ...s, matchValue };
  }
  return s;
}

function canonicalPredicate(p: Predicate, entries: Entry[], note: Note): Predicate {
  switch (p.kind) {
    case 'node_present':
    case 'node_absent':
      return { ...p, locator: canonicalBundle(p.locator, entries, note) };
    case 'text_matches':
    case 'value_equals':
      return { ...p, locator: canonicalBundle(p.locator, entries, note) };
    case 'aria_subtree':
      return { ...p, root: canonicalBundle(p.root, entries, note) };
    default:
      return p;
  }
}

/** Every `$input.x` and `{x}` already present anywhere in a step. */
function referencedInputs(step: RecordedStep): string[] {
  const found = new Set<string>();
  const text = JSON.stringify(step);
  for (const m of text.matchAll(/\$input\.([A-Za-z0-9_]+)/g)) found.add(m[1]!);
  if (step.action.kind === 'navigate') {
    for (const m of step.action.urlTemplate.matchAll(/\{(\w+)\}/g)) found.add(m[1]!);
  }
  return [...found];
}
