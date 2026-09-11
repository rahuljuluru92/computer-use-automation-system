/**
 * Waiting.
 *
 * There is no `sleep()` in this system, and that is a design position rather
 * than a style preference. A fixed delay is a guess about the application that
 * is wrong in both directions at once: too long when the page was ready
 * immediately, and too short on the day the database is slow. It converts a
 * determinism problem into a flakiness problem and then hides it behind a
 * number somebody picked.
 *
 * Instead: poll a predicate until it holds or the budget runs out. The budget
 * is a *failure* threshold, not an expected duration - normal operation never
 * reaches it. The polling interval is the only raw duration anywhere in the
 * executor, and it controls responsiveness, not correctness.
 */

import type { Predicate } from '../core/schema.ts';
import type { Surface } from '../surface/surface.ts';
import type { UiSnapshot } from '../surface/uinode.ts';
import { evaluateAll, type PredicateResult } from './predicates.ts';

const POLL_INTERVAL_MS = 100;

export interface WaitOutcome {
  held: boolean;
  /** Snapshot at the moment the wait finished; reused by the caller. */
  snapshot: UiSnapshot;
  elapsedMs: number;
  attempts: number;
  /** Why it did not hold, when it did not. */
  detail: string;
}

export async function waitFor(
  predicates: Predicate[],
  opts: {
    surface: Surface;
    params: Record<string, unknown>;
    timeoutMs: number;
    /** Snapshot to evaluate first, saving one round trip. */
    initial?: UiSnapshot;
  },
): Promise<WaitOutcome> {
  const started = Date.now();
  let attempts = 0;
  let previous: UiSnapshot | undefined;
  let snapshot = opts.initial ?? (await opts.surface.observe());
  let last: PredicateResult = { held: false, detail: '(not evaluated)' };

  for (;;) {
    attempts += 1;
    last = await evaluateAll(predicates, {
      snapshot, params: opts.params, surface: opts.surface, previous,
    });
    if (last.held) {
      return { held: true, snapshot, elapsedMs: Date.now() - started, attempts, detail: last.detail };
    }
    if (Date.now() - started >= opts.timeoutMs) {
      return { held: false, snapshot, elapsedMs: Date.now() - started, attempts, detail: last.detail };
    }
    await pause(POLL_INTERVAL_MS);
    previous = snapshot;
    snapshot = await opts.surface.observe();
  }
}

/**
 * Waits for the accessibility tree to stop changing.
 *
 * Used after an action when the artifact declares no explicit transition. It
 * is the weakest possible wait and is deliberately only a fallback: a step
 * that says what it expects to happen is always better than one that waits for
 * things to go quiet.
 */
export async function waitForQuiescence(
  surface: Surface,
  opts: { timeoutMs: number; stillForMs?: number },
): Promise<WaitOutcome> {
  const stillFor = opts.stillForMs ?? 250;
  const started = Date.now();
  let attempts = 0;
  let snapshot = await surface.observe();
  let lastHash = snapshot.structureHash;
  let unchangedSince = Date.now();

  for (;;) {
    attempts += 1;
    if (Date.now() - unchangedSince >= stillFor) {
      return { held: true, snapshot, elapsedMs: Date.now() - started, attempts, detail: 'the page settled' };
    }
    if (Date.now() - started >= opts.timeoutMs) {
      return {
        held: false, snapshot, elapsedMs: Date.now() - started, attempts,
        detail: `the page was still changing after ${opts.timeoutMs}ms`,
      };
    }
    await pause(POLL_INTERVAL_MS);
    snapshot = await surface.observe();
    if (snapshot.structureHash !== lastHash) {
      lastHash = snapshot.structureHash;
      unchangedSince = Date.now();
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
