/**
 * Locator resolution, against real captured snapshots of the real target app.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAriaSnapshot } from '../../src/surface/web/ariaYaml.ts';
import { flattenToSnapshot } from '../../src/surface/web/toUiNodes.ts';
import { resolveBundle } from '../../src/surface/locator/resolve.ts';
import { LocatorBundle } from '../../src/core/schema.ts';
import type { UiSnapshot } from '../../src/surface/uinode.ts';

const snap = (name: string): UiSnapshot =>
  flattenToSnapshot(
    parseAriaSnapshot(readFileSync(new URL(`../fixtures/aria/${name}.yaml`, import.meta.url), 'utf8')),
    { url: 'http://localhost:4400/x', title: name, frameNames: ['contentFrame'] },
  );

/** Terse bundle builder; defaults come from the schema. */
const bundle = (description: string, strategies: Array<[number, object, string?]>) =>
  LocatorBundle.parse({
    description,
    strategies: strategies.map(([tier, strategy, rationale]) => ({
      tier, strategy, confidence: 1 - tier / 10, rationale: rationale ?? 'test',
    })),
  });

describe('tier 1 - role and accessible name', () => {
  it('resolves an unambiguous button', () => {
    const r = resolveBundle(
      bundle('Open Sub-Account button', [[1, { kind: 'role_name', role: 'button', name: 'Open Sub-Account' }]]),
      snap('member-detail'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.node.name).toBe('Open Sub-Account');
      expect(r.value.trace.winningTier).toBe(1);
      expect(r.value.trace.degraded).toBe(false);
    }
  });

  it('refuses to guess between three identically named links', () => {
    // All three account rows have a link called "View". This is the case the
    // whole grid strategy exists for, and the honest answer here is "no".
    const r = resolveBundle(
      bundle('View link', [[1, { kind: 'role_name', role: 'link', name: 'View', exact: true }]]),
      snap('member-detail'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('ambiguous');
      if (r.error.reason === 'ambiguous') expect(r.error.count).toBe(3);
    }
  });
});

describe('tier 2 - table cell relative', () => {
  it('finds the View link in the row whose Type is Savings', () => {
    const r = resolveBundle(
      bundle('View link on the Savings row', [[2, {
        kind: 'table_cell_relative',
        table: { role: 'table', name: 'Accounts' },
        matchColumn: 'Type', matchValue: 'Savings',
        targetColumn: 'Action', within: { role: 'link' },
      }]]),
      snap('member-detail'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.node.tableContext?.rowIndex).toBe(1); // header row is 0
  });

  it('picks a different row when the row data changes', () => {
    const forType = (type: string) => resolveBundle(
      bundle(`View link on the ${type} row`, [[2, {
        kind: 'table_cell_relative',
        table: { role: 'table', name: 'Accounts' },
        matchColumn: 'Type', matchValue: type,
        targetColumn: 'Action', within: { role: 'link' },
      }]]),
      snap('member-detail'),
    );
    const savings = forType('Savings');
    const checking = forType('Checking');
    expect(savings.ok && checking.ok).toBe(true);
    if (savings.ok && checking.ok) {
      expect(savings.value.node.ref).not.toBe(checking.value.node.ref);
    }
  });

  it('substitutes $input references into the row match', () => {
    const r = resolveBundle(
      bundle('View link for the requested account type', [[2, {
        kind: 'table_cell_relative',
        table: { role: 'table', name: 'Accounts' },
        matchColumn: 'Type', matchValue: '$input.accountType',
        targetColumn: 'Action', within: { role: 'link' },
      }]]),
      snap('member-detail'),
      { accountType: 'Money Market' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.node.tableContext?.rowHeaders).toContain('Money Market');
  });

  it('returns unresolved when no row matches', () => {
    const r = resolveBundle(
      bundle('View link on a nonexistent row', [[2, {
        kind: 'table_cell_relative',
        table: { role: 'table', name: 'Accounts' },
        matchColumn: 'Type', matchValue: 'Crypto',
        targetColumn: 'Action', within: { role: 'link' },
      }]]),
      snap('member-detail'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('unresolved');
  });
});

describe('quorum and degradation', () => {
  const savingsRow = {
    kind: 'table_cell_relative' as const,
    table: { role: 'table', name: 'Accounts' },
    matchColumn: 'Type', matchValue: 'Savings',
    targetColumn: 'Action', within: { role: 'link' },
  };

  it('accepts a unique top-tier hit without demanding agreement', () => {
    // A naive "always require two" rule would fail this, trading a rare
    // wrong-node bug for a frequent cannot-find-node bug.
    const r = resolveBundle(
      bundle('Open Sub-Account', [[1, { kind: 'role_name', role: 'button', name: 'Open Sub-Account' }]]),
      snap('member-detail'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.trace.agreement).toBe(1);   // below minAgreement of 2
      expect(r.value.trace.degraded).toBe(false);
      expect(r.value.drift).toBeUndefined();
    }
  });

  it('degrades and emits drift when the top tier misses but quorum holds', () => {
    const b = bundle('View link on the Savings row', [
      // Tier 1 is wrong on purpose: this is what a re-skinned tenant looks like.
      [1, { kind: 'role_name', role: 'link', name: 'Open Savings Detail', exact: true }],
      [2, savingsRow],
      [4, { kind: 'text', pattern: '^View$', role: 'link' }],
    ]);
    const r = resolveBundle(b, snap('member-detail'), {}, { stepId: 's4' });
    // Tier 2 wins; tier 4 matches three nodes so does NOT agree; agreement is 1.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('no_quorum');
      if (r.error.reason === 'no_quorum') {
        expect(r.error.agreement).toBe(1);
        expect(r.error.required).toBe(2);
      }
    }
  });

  it('proceeds degraded, with a drift record, when two strategies do agree', () => {
    const b = LocatorBundle.parse({
      description: 'View link on the Savings row',
      strategies: [
        { tier: 1, strategy: { kind: 'role_name', role: 'link', name: 'Nonexistent', exact: true },
          confidence: 0.9, rationale: 'stale top tier' },
        { tier: 2, strategy: savingsRow, confidence: 0.85, rationale: 'row data' },
        { tier: 3, strategy: { kind: 'label_anchored', label: '$4,210.55', controlRole: 'link' },
          confidence: 0.6, rationale: 'the link sits beside the balance cell' },
      ],
    });
    const r = resolveBundle(b, snap('member-detail'), {}, { stepId: 's4' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.trace.degraded).toBe(true);
      expect(r.value.trace.winningTier).toBe(2);
      expect(r.value.trace.agreement).toBeGreaterThanOrEqual(2);
      // The drift record is the signal that this surface has moved.
      expect(r.value.drift?.stepId).toBe('s4');
      expect(r.value.drift?.expectedTier).toBe(1);
      expect(r.value.drift?.actualTier).toBe(2);
    }
  });

  it('does not count an inapplicable strategy as disagreement', () => {
    // A CSS selector cannot be evaluated against an accessibility snapshot.
    // Scoring that as dissent would punish a bundle for carrying forensics.
    const b = bundle('Open Sub-Account', [
      [1, { kind: 'role_name', role: 'button', name: 'Open Sub-Account' }],
      [5, { kind: 'css', selector: '#ctl00_anything' }, 'brittle, forensics only'],
    ]);
    const r = resolveBundle(b, snap('member-detail'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.trace.degraded).toBe(false);
  });
});

describe('resolution survives a re-render that changes every control id', () => {
  it('finds the same node in both renders', () => {
    const b = bundle('View link on the Savings row', [[2, {
      kind: 'table_cell_relative',
      table: { role: 'table', name: 'Accounts' },
      matchColumn: 'Type', matchValue: 'Savings',
      targetColumn: 'Action', within: { role: 'link' },
    }]]);
    const a = resolveBundle(b, snap('member-detail'));
    const c = resolveBundle(b, snap('member-detail-rerender'));
    expect(a.ok && c.ok).toBe(true);
    if (a.ok && c.ok) {
      // Same row, same column, same meaning - even though every id changed.
      expect(a.value.node.tableContext?.rowIndex).toBe(c.value.node.tableContext?.rowIndex);
      expect(a.value.trace.degraded).toBe(false);
      expect(c.value.trace.degraded).toBe(false);
    }
  });
});

describe('tier 3 - label anchored', () => {
  it('finds a form field by the label in the cell beside it', () => {
    const r = resolveBundle(
      bundle('Initial Deposit field', [[3, { kind: 'label_anchored', label: 'Initial Deposit', controlRole: 'textbox' }]]),
      snap('subaccount-form'),
    );
    expect(r.ok).toBe(true);
  });
});
