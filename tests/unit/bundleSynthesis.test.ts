/**
 * Locator synthesis, against real captured snapshots of the real target app.
 *
 * These tests guard the claim the whole discovery story rests on: the model
 * points at a node, and the *system* works out how to find it again - well
 * enough that the result survives a render in which every control id changed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAriaSnapshot } from '../../src/surface/web/ariaYaml.ts';
import { flattenToSnapshot } from '../../src/surface/web/toUiNodes.ts';
import { synthesizeBundle } from '../../src/surface/locator/bundle.ts';
import { resolveBundle } from '../../src/surface/locator/resolve.ts';
import { runStrategy } from '../../src/surface/locator/strategies.ts';
import { LocatorBundle } from '../../src/core/schema.ts';
import type { UiNode, UiSnapshot } from '../../src/surface/uinode.ts';

const snap = (name: string): UiSnapshot =>
  flattenToSnapshot(
    parseAriaSnapshot(readFileSync(new URL(`../fixtures/aria/${name}.yaml`, import.meta.url), 'utf8')),
    { url: 'http://localhost:4400/x', title: name, frameNames: ['contentFrame'] },
  );

const nodeByRef = (s: UiSnapshot, ref: string): UiNode => {
  const n = s.nodes.find((x) => x.ref === ref);
  if (!n) throw new Error(`fixture drift: no node ${ref}`);
  return n;
};

/** The View link on the Savings row - three links share this accessible name. */
const SAVINGS_VIEW = 'f3e44';
const SAVINGS_VIEW_RERENDERED = 'f12e44';
const MONEY_MARKET_VIEW_RERENDERED = 'f12e58';

describe('synthesis: the ambiguous grid', () => {
  it('produces a bundle for a control that role and name cannot identify', () => {
    const s = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(s, SAVINGS_VIEW), s, {
      description: 'View link on the Savings row',
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Tier 1 is the thing that *should* work and here cannot: three identical
    // links. The bundle must be led by the row-relative strategy instead.
    expect(out.bundle.strategies[0]!.tier).toBe(2);
    expect(out.bundle.strategies[0]!.strategy.kind).toBe('table_cell_relative');
  });

  it('records why the strategies it discarded were discarded', () => {
    const s = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(s, SAVINGS_VIEW), s, { description: 'View link' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const roleName = out.rejected.find((r) => r.strategy.kind === 'role_name');
    expect(roleName?.reason).toBe('ambiguous: matched 3 nodes');
  });

  it('rejects geometry on this grid, because the row pitch equals the tolerance', () => {
    // Rows are 24px tall and byAnchorOffset accepts anything within 24px, so an
    // anchor cannot separate a row from its neighbour. Discovering that is the
    // point of verifying: a hand-written bundle would have shipped it.
    const s = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(s, SAVINGS_VIEW), s, { description: 'View link' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.bundle.strategies.some((st) => st.strategy.kind === 'anchor_offset')).toBe(false);
    expect(out.rejected.some((r) => r.strategy.kind === 'anchor_offset')).toBe(true);
  });
});

describe('synthesis: what it produces is valid and honest', () => {
  it('emits a bundle the contract accepts', () => {
    const s = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(s, SAVINGS_VIEW), s, { description: 'View link' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(() => LocatorBundle.parse(out.bundle)).not.toThrow();
  });

  it('never asks for agreement from more strategies than it kept', () => {
    const s = snap('member-detail');
    for (const ref of [SAVINGS_VIEW, 'f3e64', 'f3e12']) {
      const out = synthesizeBundle(nodeByRef(s, ref), s, { description: ref });
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.bundle.minAgreement).toBeLessThanOrEqual(out.bundle.strategies.length);
    }
  });

  it('never fabricates a css selector it cannot derive', () => {
    const s = snap('member-detail');
    for (const node of s.nodes) {
      const out = synthesizeBundle(node, s, { description: node.ref });
      if (!out.ok) continue;
      expect(out.bundle.strategies.some((st) => st.strategy.kind === 'css')).toBe(false);
    }
  });

  it('keeps only strategies that uniquely resolved to the node in their own snapshot', () => {
    // The rule the file's trustworthiness rests on, asserted over every node of
    // a real screen rather than over one hand-picked example.
    const s = snap('member-detail');
    let checked = 0;
    for (const node of s.nodes) {
      const out = synthesizeBundle(node, s, { description: node.ref });
      if (!out.ok) continue;
      for (const st of out.bundle.strategies) {
        const r = runStrategy(st.strategy, s, {});
        expect(r.inapplicable).toBeUndefined();
        expect(r.candidates).toHaveLength(1);
        expect(r.candidates[0]).toBe(node);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('discounts a strategy that keys on a value rather than on wording', () => {
    // The only label beside the View link is the account balance. It verifies
    // today and breaks whenever the balance moves, so it is kept but marked
    // down - silence here would be the trap.
    const s = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(s, SAVINGS_VIEW), s, { description: 'View link' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const label = out.bundle.strategies.find((st) => st.strategy.kind === 'label_anchored');
    expect(label).toBeDefined();
    expect(label!.confidence).toBeLessThan(0.4);
    expect(label!.rationale).toMatch(/Discounted/);
  });

  it('never keys an extraction target on its own text, only on context around it', () => {
    // decision #126, found live: a freshly-generated reference number verified
    // at tier 1 (role_name, its own text) during discovery, then could not
    // resolve on a cold replay where a *different* fresh value was generated -
    // and worse, the doomed tier-1 and tier-4 candidates (both keyed on that
    // same self-text) counted as quorum witnesses against the tier-3
    // label-anchored strategy that still worked correctly on its own.
    // "Current Balance" is static test data here, so it is not itself the
    // scenario that broke - the point is the *mechanism* must not depend on
    // that: it has to hold for a value that changes on every render too.
    const s = snap('member-detail');
    const node = nodeByRef(s, 'f3e42'); // the "$4,210.55" cell

    const withoutFlag = synthesizeBundle(node, s, { description: 'value of savingsBalance' });
    expect(withoutFlag.ok).toBe(true);
    if (withoutFlag.ok) {
      // Confirms the flag actually changes something, rather than asserting a
      // property that would hold either way.
      expect(withoutFlag.bundle.strategies.some((st) => st.strategy.kind === 'role_name')).toBe(true);
    }

    const forExtraction = synthesizeBundle(node, s, {
      description: 'value of savingsBalance', forExtraction: true,
    });
    expect(forExtraction.ok).toBe(true);
    if (!forExtraction.ok) return;

    expect(forExtraction.bundle.strategies.some((st) => st.strategy.kind === 'role_name')).toBe(false);
    expect(forExtraction.bundle.strategies.some((st) => st.strategy.kind === 'text')).toBe(false);
    // Context-based tiers are unaffected - there is still something to ship.
    expect(forExtraction.bundle.strategies.length).toBeGreaterThan(0);
  });

  it('refuses, rather than guessing, when nothing identifies the node', () => {
    const bare: UiNode = {
      ref: 'x1', role: 'generic', name: '', state: {}, frameChain: [],
      ancestry: [], nearestLabels: [], depth: 0,
    };
    const snapshot: UiSnapshot = {
      url: 'about:blank', title: '', nodes: [bare], structureHash: 'h',
      capturedAt: new Date(0).toISOString(), truncatedNodes: 0,
    };
    const out = synthesizeBundle(bare, snapshot, { description: 'an anonymous div' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/no strategy could uniquely identify/);
  });
});

describe('synthesis: the recording generalises', () => {
  it('finds the same control after a render in which every ref changed', () => {
    const recorded = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(recorded, SAVINGS_VIEW), recorded, {
      description: 'View link on the Savings row',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const r = resolveBundle(out.bundle, snap('member-detail-rerender'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.node.ref).toBe(SAVINGS_VIEW_RERENDERED);
    expect(r.value.trace.winningTier).toBe(2);
    expect(r.value.trace.degraded).toBe(false);
  });

  it('canonicalises a recorded literal into an input reference', () => {
    const recorded = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(recorded, SAVINGS_VIEW), recorded, {
      description: 'View link for the requested account',
      params: { accountNumber: '0001-4477' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const top = out.bundle.strategies[0]!.strategy;
    expect(top.kind).toBe('table_cell_relative');
    if (top.kind !== 'table_cell_relative') return;
    expect(top.matchValue).toBe('$input.accountNumber');
  });

  it('one recording drives a different row when the input changes', () => {
    // This is the whole argument for canonicalisation: the flow was recorded
    // against the Savings account and works for the Money Market one.
    const recorded = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(recorded, SAVINGS_VIEW), recorded, {
      description: 'View link for the requested account',
      params: { accountNumber: '0001-4477' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const rerendered = snap('member-detail-rerender');

    const same = resolveBundle(out.bundle, rerendered, { accountNumber: '0001-4477' });
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.value.node.ref).toBe(SAVINGS_VIEW_RERENDERED);

    const other = resolveBundle(out.bundle, rerendered, { accountNumber: '0003-2256' });
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value.node.ref).toBe(MONEY_MARKET_VIEW_RERENDERED);
  });

  it('carries the frame chain, so the bundle is usable inside the content iframe', () => {
    const s = snap('member-detail');
    const out = synthesizeBundle(nodeByRef(s, SAVINGS_VIEW), s, { description: 'View link' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bundle.frame.path).toEqual(['contentFrame']);
  });
});
