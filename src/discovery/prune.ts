/**
 * Backtrack pruning: removing the detours from a recorded trajectory.
 *
 * A model exploring an unfamiliar screen wanders. It opens the wrong account,
 * looks around, comes back, tries the next one. All of that is in the
 * recording, and none of it belongs in a capability that will run unattended
 * ten thousand times.
 *
 * This is deliberately not a graph algorithm. The trajectory is a **walk, not
 * a graph** - one linear sequence of states the run actually passed through -
 * and removing cycles from a walk is a stack pop. Keep a stack of the states
 * on the current path; when a step lands on a state already further down the
 * stack, everything above it was a round trip. O(n) with a hash map.
 *
 * ## Three things it must not do, all of which cost more than a wasted step
 *
 * **A step that leaves the structure unchanged is not a backtrack.** The
 * structure hash covers roles, names and nesting but never values (decision
 * #26), so typing into a field produces an identical hash on both sides of the
 * step. Treating that as a return-to-previous-state would delete every single
 * data-entry step in the flow. So a cycle has to return to a state *strictly
 * below* the top of the stack; standing still is standing still.
 *
 * **A detour that read something is not a detour.** "Open the account, read
 * the balance, go back" is a round trip by shape and the entire point of the
 * capability by intent. Pruning it would silently delete the output the caller
 * asked for. Any span containing an extraction is kept.
 *
 * **Only read-only steps are ever pruned.** A write that happened to leave the
 * page looking the same still changed something behind it, and a capability
 * that skips it is a capability that does a different job. Pruning is an
 * optimisation; it does not get to make that call.
 *
 * Everything removed is returned with a reason. A compiler that silently drops
 * steps is a compiler nobody can debug.
 */

import type { RecordedStep } from './tools.ts';

export interface RemovedStep {
  step: RecordedStep;
  /** Why it went, in terms a human reviewing the artifact can check. */
  reason: string;
}

export interface RetainedCycle {
  /** Indices in the original trajectory, inclusive. */
  from: number;
  to: number;
  reason: string;
}

export interface PruneResult {
  /** The surviving walk, re-indexed from zero. */
  steps: RecordedStep[];
  removed: RemovedStep[];
  /** Round trips that were found and deliberately kept. */
  retained: RetainedCycle[];
}

interface StackEntry {
  hash: string;
  /** Index of the step that produced this state; -1 for the starting state. */
  producedBy: number;
}

export function pruneBacktracks(trajectory: readonly RecordedStep[]): PruneResult {
  if (trajectory.length === 0) return { steps: [], removed: [], retained: [] };

  const dropped = new Set<number>();
  const removed: RemovedStep[] = [];
  const retained: RetainedCycle[] = [];

  const stack: StackEntry[] = [{ hash: trajectory[0]!.beforeHash, producedBy: -1 }];
  const positionOf = new Map<string, number>([[trajectory[0]!.beforeHash, 0]]);

  for (let i = 0; i < trajectory.length; i += 1) {
    const step = trajectory[i]!;
    const landed = step.afterHash;
    const at = positionOf.get(landed);

    // Not somewhere we have been on this path: the walk moved forward.
    if (at === undefined) {
      stack.push({ hash: landed, producedBy: i });
      positionOf.set(landed, stack.length - 1);
      continue;
    }

    // Landed on the state we were already in. The step did something the
    // structure hash cannot see - typing a value, most often - or nothing at
    // all. Either way it is not a round trip, and deleting it would be how
    // every form-filling capability quietly loses its form filling.
    if (at === stack.length - 1) continue;

    // A genuine round trip: everything since the step that produced `at`.
    const from = stack[at]!.producedBy + 1;
    const span = range(from, i).filter((n) => !dropped.has(n));
    const verdict = mayPrune(span.map((n) => trajectory[n]!));

    if (verdict.ok) {
      for (const n of span) {
        dropped.add(n);
        removed.push({
          step: trajectory[n]!,
          reason: `returned to the screen the run was already on at step ${from - 1 < 0 ? 'start' : from - 1}`
            + ` without changing anything; ${verdict.note}`,
        });
      }
    } else {
      retained.push({ from, to: i, reason: verdict.reason });
    }

    // Either way the walk is physically back at `at`, so the stack has to
    // reflect that or every later cycle is measured from the wrong place.
    for (let p = stack.length - 1; p > at; p -= 1) positionOf.delete(stack[p]!.hash);
    stack.length = at + 1;

    // The run arrives back at this state *now*, at step i. Without this the
    // entry still claims it was reached at the start of the walk, and the next
    // return to it would sweep everything since the beginning into its span -
    // including a cycle that was deliberately retained.
    stack[at]!.producedBy = i;
  }

  const steps = trajectory
    .filter((_, i) => !dropped.has(i))
    .map((step, index) => ({ ...step, index }));

  return { steps, removed, retained };
}

// ---------------------------------------------------------------------------

type Verdict = { ok: true; note: string } | { ok: false; reason: string };

function mayPrune(span: readonly RecordedStep[]): Verdict {
  if (span.length === 0) return { ok: false, reason: 'nothing to remove' };

  const extracting = span.filter((s) => s.extract.length > 0);
  if (extracting.length > 0) {
    const names = extracting.flatMap((s) => s.extract.map((e) => e.name));
    return {
      ok: false,
      reason: `the detour produced ${names.map((n) => `"${n}"`).join(', ')} - `
        + `going somewhere to read something and coming back is the task, not a wrong turn`,
    };
  }

  const writes = span.filter((s) => s.actionClass !== 'read');
  if (writes.length > 0) {
    return {
      ok: false,
      reason: `it contains ${writes.length} action(s) that change state `
        + `(${[...new Set(writes.map((s) => s.actionClass))].join(', ')}), which may have `
        + `changed something the screen does not show`,
    };
  }

  return { ok: true, note: `${span.length} read-only step(s) removed` };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}
