/**
 * Backtrack pruning.
 *
 * Pure function over a trajectory, so these are plain table-driven tests. The
 * interesting cases are all the ones where pruning must *not* happen - a
 * pruner that is too eager deletes the capability's outputs or its form
 * filling, and both failures are silent.
 */

import { describe, it, expect } from 'vitest';
import { pruneBacktracks } from '../../src/discovery/prune.ts';
import type { RecordedStep } from '../../src/discovery/tools.ts';
import type { ActionClass, ExtractSpec } from '../../src/core/schema.ts';

let seq = 0;

/** A step from state `a` to state `b`. */
function step(a: string, b: string, over: Partial<RecordedStep> = {}): RecordedStep {
  seq += 1;
  return {
    index: 0,
    intent: `step ${seq}: ${a} -> ${b}`,
    action: { kind: 'click' },
    actionClass: 'read' as ActionClass,
    extract: [],
    checkpoint: [],
    beforeHash: a,
    afterHash: b,
    beforeUrl: 'http://localhost:4400/x',
    afterUrl: 'http://localhost:4400/x',
    rejected: [],
    ...over,
  };
}

const extract: ExtractSpec = {
  name: 'savingsBalance',
  from: { description: 'balance', frame: { path: [] }, strategies: [], requireUnique: true, minAgreement: 1, allowDegraded: true },
  parse: { kind: 'currency', locale: 'en-US' },
  sensitivity: 'none',
};

const intents = (r: { steps: RecordedStep[] }) => r.steps.map((s) => s.intent);

describe('the straight path', () => {
  it('leaves a walk that never revisits anything alone', () => {
    const r = pruneBacktracks([step('A', 'B'), step('B', 'C'), step('C', 'D')]);
    expect(r.steps).toHaveLength(3);
    expect(r.removed).toHaveLength(0);
  });

  it('handles an empty trajectory', () => {
    expect(pruneBacktracks([])).toEqual({ steps: [], removed: [], retained: [] });
  });

  it('re-indexes what survives, so the compiled steps are numbered without gaps', () => {
    const r = pruneBacktracks([step('A', 'B'), step('B', 'A'), step('A', 'C')]);
    expect(r.steps.map((s) => s.index)).toEqual([0]);
  });
});

describe('removing a detour', () => {
  it('drops a there-and-back round trip', () => {
    // A -> B -> A: the run opened something, looked, and came back.
    const r = pruneBacktracks([
      step('A', 'B', { intent: 'open the wrong account' }),
      step('B', 'A', { intent: 'go back' }),
      step('A', 'C', { intent: 'open the right account' }),
    ]);

    expect(intents(r)).toEqual(['open the right account']);
    expect(r.removed).toHaveLength(2);
  });

  it('drops a longer wander in one pass', () => {
    const r = pruneBacktracks([
      step('A', 'B'), step('B', 'C'), step('C', 'D'), step('D', 'A'),
      step('A', 'Z', { intent: 'the real step' }),
    ]);
    expect(intents(r)).toEqual(['the real step']);
  });

  it('says why each step went', () => {
    const r = pruneBacktracks([step('A', 'B'), step('B', 'A'), step('A', 'C')]);
    expect(r.removed[0]!.reason).toMatch(/returned to the screen/);
    expect(r.removed[0]!.reason).toMatch(/read-only step/);
  });

  it('prunes a detour taken part-way along a path, keeping what came before', () => {
    const r = pruneBacktracks([
      step('A', 'B', { intent: 'first real step' }),
      step('B', 'X', { intent: 'detour out' }),
      step('X', 'B', { intent: 'detour back' }),
      step('B', 'C', { intent: 'second real step' }),
    ]);
    expect(intents(r)).toEqual(['first real step', 'second real step']);
  });
});

describe('what must survive pruning', () => {
  it('keeps a step that leaves the structure unchanged', () => {
    // Typing does not change roles, names or nesting, so both sides of the
    // step hash identically. Reading that as a return-to-previous-state would
    // delete the form filling from every form-filling capability.
    const r = pruneBacktracks([
      step('A', 'A', { intent: 'type the member id', action: { kind: 'type', clearFirst: true } }),
      step('A', 'B', { intent: 'submit' }),
    ]);
    expect(intents(r)).toEqual(['type the member id', 'submit']);
    expect(r.removed).toHaveLength(0);
  });

  it('keeps a round trip that read something', () => {
    // "Go to the account, read the balance, come back" is the task, not a
    // wrong turn. Pruning it would delete the capability's only output.
    const r = pruneBacktracks([
      step('A', 'B', { intent: 'open the savings account' }),
      step('B', 'B', { intent: 'read the balance', extract: [extract], action: { kind: 'extract' } }),
      step('B', 'A', { intent: 'back to the member' }),
    ]);

    expect(r.steps).toHaveLength(3);
    expect(r.removed).toHaveLength(0);
    expect(r.retained[0]!.reason).toMatch(/savingsBalance/);
    expect(r.retained[0]!.reason).toMatch(/is the task, not a wrong turn/);
  });

  it('keeps a round trip that changed something, even if the screen looks the same', () => {
    const r = pruneBacktracks([
      step('A', 'B', { intent: 'open the form' }),
      step('B', 'B', { intent: 'submit it', actionClass: 'write_irreversible' }),
      step('B', 'A', { intent: 'back' }),
    ]);

    expect(r.steps).toHaveLength(3);
    expect(r.retained[0]!.reason).toMatch(/write_irreversible/);
    expect(r.retained[0]!.reason).toMatch(/does not show/);
  });

  it('still tracks position correctly after keeping a cycle', () => {
    // The walk is physically back at A whether or not the steps were removed.
    // If the stack did not pop, a later cycle would be measured from the wrong
    // place and would prune the wrong span.
    const r = pruneBacktracks([
      step('A', 'B', { intent: 'open' }),
      step('B', 'B', { intent: 'read', extract: [extract], action: { kind: 'extract' } }),
      step('B', 'A', { intent: 'back' }),
      step('A', 'C', { intent: 'detour' }),
      step('C', 'A', { intent: 'return' }),
      step('A', 'D', { intent: 'the last real step' }),
    ]);

    expect(intents(r)).toEqual(['open', 'read', 'back', 'the last real step']);
  });
});

describe('repeated visits', () => {
  it('does not confuse a state revisited after it was already popped', () => {
    const r = pruneBacktracks([
      step('A', 'B'), step('B', 'A'),          // first cycle, pruned
      step('A', 'B', { intent: 'deliberate second visit' }),
      step('B', 'C', { intent: 'onwards' }),
    ]);
    expect(intents(r)).toEqual(['deliberate second visit', 'onwards']);
  });

  it('never removes a step twice', () => {
    const r = pruneBacktracks([
      step('A', 'B'), step('B', 'C'), step('C', 'B'), step('B', 'A'),
      step('A', 'Z', { intent: 'real' }),
    ]);
    const removedIntents = r.removed.map((x) => x.step.intent);
    expect(new Set(removedIntents).size).toBe(removedIntents.length);
    expect(intents(r)).toEqual(['real']);
  });
});
