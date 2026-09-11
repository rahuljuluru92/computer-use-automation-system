/**
 * Canonicalisation: the difference between a capability and a capability for
 * reading one specific customer's balance.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/discovery/canonicalize.ts';
import type { RecordedStep } from '../../src/discovery/tools.ts';
import type { LocatorBundle, LocatorStrategy } from '../../src/core/schema.ts';

function bundle(...strategies: LocatorStrategy[]): LocatorBundle {
  return {
    description: 'a control',
    frame: { path: [] },
    strategies: strategies.map((strategy, i) => ({
      tier: i + 1, strategy, confidence: 0.9, rationale: 'test',
    })),
    requireUnique: true,
    minAgreement: 1,
    allowDegraded: true,
  };
}

function step(over: Partial<RecordedStep> = {}): RecordedStep {
  return {
    index: 0,
    intent: 'a step',
    action: { kind: 'click' },
    actionClass: 'read',
    extract: [],
    checkpoint: [],
    beforeHash: 'A',
    afterHash: 'B',
    beforeUrl: 'http://localhost:4400/x',
    afterUrl: 'http://localhost:4400/y',
    rejected: [],
    ...over,
  };
}

const PARAMS = { memberId: '12345', accountNumber: '0001-4477' };

describe('the two interpolation syntaxes', () => {
  it('rewrites a URL with braces, because that is what interpolateUrl reads', () => {
    const r = canonicalize([step({
      action: { kind: 'navigate', urlTemplate: 'http://localhost:4400/members/12345' },
    })], PARAMS);

    const action = r.steps[0]!.action;
    expect(action.kind).toBe('navigate');
    if (action.kind !== 'navigate') return;
    expect(action.urlTemplate).toBe('http://localhost:4400/members/{memberId}');
  });

  it('rewrites typed text with $input, because that is what interpolate reads', () => {
    const r = canonicalize([step({
      action: { kind: 'type', clearFirst: true },
      data: { value: '12345', sensitivity: 'none' },
    })], PARAMS);

    expect(r.steps[0]!.data).toEqual({ value: '$input.memberId', sensitivity: 'none' });
  });
});

describe('which locator fields may carry a reference', () => {
  it('rewrites the two fields the resolver interpolates', () => {
    const r = canonicalize([step({
      target: bundle(
        { kind: 'role_name', role: 'link', name: 'View 12345', exact: true },
        {
          kind: 'table_cell_relative',
          table: { role: 'table' },
          matchColumn: 'Account Number',
          matchValue: '0001-4477',
          targetColumn: 'Action',
        },
      ),
    })], PARAMS);

    const [one, two] = r.steps[0]!.target!.strategies;
    expect(one!.strategy).toMatchObject({ name: 'View $input.memberId' });
    expect(two!.strategy).toMatchObject({ matchValue: '$input.accountNumber' });
  });

  it('leaves the fields the resolver matches literally alone', () => {
    // byLabel and byText build their matcher straight from the recorded string.
    // A reference in either would be searched for as the text "$input.memberId".
    const r = canonicalize([step({
      target: bundle(
        { kind: 'label_anchored', label: '12345', controlRole: 'textbox' },
        { kind: 'text', pattern: '^12345$', role: 'cell' },
      ),
    })], PARAMS);

    const [label, text] = r.steps[0]!.target!.strategies;
    expect(label!.strategy).toMatchObject({ label: '12345' });
    expect(text!.strategy).toMatchObject({ pattern: '^12345$' });
  });

  it('reaches into extracts and checkpoints too', () => {
    const r = canonicalize([step({
      extract: [{
        name: 'balance',
        from: bundle({ kind: 'role_name', role: 'cell', name: '0001-4477', exact: true }),
        parse: { kind: 'currency', locale: 'en-US' },
        sensitivity: 'none',
      }],
      checkpoint: [{
        kind: 'node_present',
        locator: bundle({ kind: 'role_name', role: 'cell', name: '12345', exact: true }),
      }],
    })], PARAMS);

    expect(r.steps[0]!.extract[0]!.from.strategies[0]!.strategy)
      .toMatchObject({ name: '$input.accountNumber' });
    const check = r.steps[0]!.checkpoint[0]!;
    expect(check.kind).toBe('node_present');
    if (check.kind !== 'node_present') return;
    expect(check.locator.strategies[0]!.strategy).toMatchObject({ name: '$input.memberId' });
  });
});

describe('what it refuses to substitute', () => {
  it('leaves very short values alone', () => {
    // A parameter whose value is "1" would otherwise rewrite every "1" in every
    // URL and column header in the flow.
    const r = canonicalize([step({
      action: { kind: 'navigate', urlTemplate: 'http://localhost:4400/page/1/members/1' },
    })], { page: '1' });

    const action = r.steps[0]!.action;
    if (action.kind !== 'navigate') return;
    expect(action.urlTemplate).toBe('http://localhost:4400/page/1/members/1');
    expect(r.rewrites).toHaveLength(0);
  });

  it('substitutes the longest value first', () => {
    // "12345" sits inside "12345-6789". Shortest-first would leave "-6789"
    // stranded next to a reference.
    const r = canonicalize([step({
      action: { kind: 'navigate', urlTemplate: 'http://h/a/12345-6789' },
    })], { memberId: '12345', accountId: '12345-6789' });

    const action = r.steps[0]!.action;
    if (action.kind !== 'navigate') return;
    expect(action.urlTemplate).toBe('http://h/a/{accountId}');
  });
});

describe('which inputs the flow actually uses', () => {
  it('reports only the ones referenced', () => {
    const r = canonicalize([step({
      action: { kind: 'navigate', urlTemplate: 'http://h/members/12345' },
    })], { memberId: '12345', unusedThing: 'never-appears-anywhere' });

    expect(r.used).toEqual(['memberId']);
  });

  it('counts references that record time already put there', () => {
    // tools.ts canonicalises as it records, so most values arrive referenced.
    // Those still count as used or the artifact would not require them.
    const r = canonicalize([step({
      action: { kind: 'type', clearFirst: true },
      data: { value: '$input.password', sensitivity: 'secret' },
    })], {});

    expect(r.used).toEqual(['password']);
  });

  it('is safe to run twice', () => {
    const once = canonicalize([step({
      action: { kind: 'navigate', urlTemplate: 'http://h/members/12345' },
    })], PARAMS);
    const twice = canonicalize(once.steps, PARAMS);

    expect(twice.steps[0]!.action).toEqual(once.steps[0]!.action);
    expect(twice.rewrites).toHaveLength(0);
  });
});
