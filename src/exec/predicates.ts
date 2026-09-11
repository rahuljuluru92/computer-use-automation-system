/**
 * Evaluating predicates against a live surface.
 *
 * One algebra, five uses: step preconditions, waits, checkpoints,
 * business-outcome detectors, and recovery triggers. Keeping it to one type is
 * what lets the executor have a single evaluation path, and it means a reviewer
 * only has to understand this once.
 *
 * Every predicate answers a question about *observed state*. None of them
 * measures time, and there is no `sleep` predicate, because "wait 2 seconds" is
 * not a statement about the application - it is a guess about the application
 * that is simultaneously too slow when things are fine and too fast when they
 * are not.
 */

import type { Predicate, LocatorBundle } from '../core/schema.ts';
import type { Surface } from '../surface/surface.ts';
import type { UiSnapshot } from '../surface/uinode.ts';
import { resolveBundle } from '../surface/locator/resolve.ts';

export interface PredicateContext {
  snapshot: UiSnapshot;
  params: Record<string, unknown>;
  surface: Surface;
  /** Previous snapshot, for `stable`. */
  previous?: UiSnapshot | undefined;
}

export interface PredicateResult {
  held: boolean;
  /** Human-readable account of what was checked and what was seen. Goes
   *  straight into a failure's `expected` / `observed` fields. */
  detail: string;
}

export async function evaluate(p: Predicate, ctx: PredicateContext): Promise<PredicateResult> {
  switch (p.kind) {
    case 'node_present': {
      const r = resolveBundle(p.locator, ctx.snapshot, ctx.params);
      return r.ok
        ? { held: true, detail: `"${p.locator.description}" is present` }
        : { held: false, detail: `"${p.locator.description}" not found: ${r.error.detail}` };
    }

    case 'node_absent': {
      const r = resolveBundle(p.locator, ctx.snapshot, ctx.params);
      // An *ambiguous* match still means the thing is there, several times
      // over. Only a genuine miss counts as absent.
      const present = r.ok || r.error.reason === 'ambiguous';
      return present
        ? { held: false, detail: `"${p.locator.description}" is still present` }
        : { held: true, detail: `"${p.locator.description}" is gone` };
    }

    case 'text_matches': {
      const r = resolveBundle(p.locator, ctx.snapshot, ctx.params);
      if (!r.ok) return { held: false, detail: `"${p.locator.description}" not found` };
      const text = `${r.value.node.name} ${r.value.node.value ?? ''}`.trim();
      const held = new RegExp(p.pattern).test(text);
      return { held, detail: `"${p.locator.description}" reads "${text}" (wanted /${p.pattern}/)` };
    }

    case 'value_equals': {
      const r = resolveBundle(p.locator, ctx.snapshot, ctx.params);
      if (!r.ok) return { held: false, detail: `"${p.locator.description}" not found` };
      const actual = r.value.node.value ?? r.value.node.name;
      return { held: actual === p.value, detail: `"${p.locator.description}" = "${actual}" (wanted "${p.value}")` };
    }

    case 'url_matches': {
      const url = ctx.snapshot.url;
      const held = new RegExp(p.pattern).test(url);
      return { held, detail: `url is ${url} (wanted /${p.pattern}/)` };
    }

    case 'aria_subtree': {
      const r = resolveBundle(p.root, ctx.snapshot, ctx.params);
      if (!r.ok) return { held: false, detail: `"${p.root.description}" not found` };
      const actual = await ctx.surface.ariaSubtree(r.value.node);
      const held = normaliseShape(actual) === normaliseShape(p.snapshot);
      return {
        held,
        detail: held
          ? `the accessible structure of "${p.root.description}" matches the recorded shape`
          : `the accessible structure of "${p.root.description}" differs from the recorded shape`,
      };
    }

    case 'stable': {
      // Structure hashes ignore values, so this asks "has the page finished
      // rearranging", not "has anything at all changed" - which is what
      // callers actually mean by settled.
      const held = ctx.previous !== undefined
        && ctx.previous.structureHash === ctx.snapshot.structureHash;
      return { held, detail: held ? 'the page has settled' : 'the page is still changing' };
    }

    case 'all': {
      const results = await Promise.all(p.of.map((q) => evaluate(q, ctx)));
      const failed = results.filter((r) => !r.held);
      return failed.length === 0
        ? { held: true, detail: results.map((r) => r.detail).join('; ') }
        : { held: false, detail: failed.map((r) => r.detail).join('; ') };
    }

    case 'any': {
      const results = await Promise.all(p.of.map((q) => evaluate(q, ctx)));
      const ok = results.find((r) => r.held);
      return ok
        ? { held: true, detail: ok.detail }
        : { held: false, detail: `none held: ${results.map((r) => r.detail).join('; ')}` };
    }

    case 'not': {
      const r = await evaluate(p.of, ctx);
      return { held: !r.held, detail: `not (${r.detail})` };
    }
  }
}

export async function evaluateAll(
  predicates: Predicate[],
  ctx: PredicateContext,
): Promise<PredicateResult> {
  if (predicates.length === 0) return { held: true, detail: '(nothing asserted)' };
  return evaluate({ kind: 'all', of: predicates }, ctx);
}

/** Describes a predicate without evaluating it, for artifact explanations. */
export function describe(p: Predicate): string {
  switch (p.kind) {
    case 'node_present': return `"${p.locator.description}" is present`;
    case 'node_absent':  return `"${p.locator.description}" is gone`;
    case 'text_matches': return `"${p.locator.description}" matches /${p.pattern}/`;
    case 'value_equals': return `"${p.locator.description}" equals "${p.value}"`;
    case 'url_matches':  return `the url matches /${p.pattern}/`;
    case 'aria_subtree': return `"${p.root.description}" has the recorded accessible structure`;
    case 'stable':       return `the page has settled`;
    case 'all':          return `all of (${p.of.map(describe).join(', ')})`;
    case 'any':          return `any of (${p.of.map(describe).join(', ')})`;
    case 'not':          return `not (${describe(p.of)})`;
  }
}

/** Ignore indentation and trailing whitespace when comparing aria shapes. */
function normaliseShape(s: string): string {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Convenience for predicates that need a bundle's node. */
export function resolveIn(
  bundle: LocatorBundle,
  ctx: PredicateContext,
): ReturnType<typeof resolveBundle> {
  return resolveBundle(bundle, ctx.snapshot, ctx.params);
}
