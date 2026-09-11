/**
 * Resolving a LocatorBundle against a snapshot.
 *
 * The interesting decision here is *when* to demand agreement between
 * strategies.
 *
 * A naive quorum rule - "always require two strategies to agree" - is worse
 * than no quorum at all. It fails perfectly good resolutions whenever the
 * lower-tier strategies were recorded against a slightly different render, so
 * it trades a rare wrong-node bug for a frequent cannot-find-node bug. That is
 * not robustness, it is just brittleness pointed the other way.
 *
 * So quorum is demanded *exactly when confidence has dropped*:
 *
 *   - The top tier resolves uniquely -> accept it. Role plus accessible name
 *     matching one node is strong evidence on its own. Agreement is still
 *     computed, but only as telemetry.
 *
 *   - The top tier misses and a lower tier wins -> now we are guessing, so
 *     require `minAgreement` independent strategies to point at the same node
 *     before proceeding. Mark the resolution DEGRADED and emit a drift record.
 *
 * That second branch is the whole multi-tenant drift story in miniature. A base
 * artifact run against a re-skinned variant will systematically degrade on
 * exactly the steps that variant changed, and the drift records say which ones
 * without anyone having to file a bug.
 *
 * Strategies that cannot be evaluated at all (a CSS selector against an
 * accessibility snapshot) are *inapplicable*, not *disagreeing*. Scoring them
 * as dissent would punish a bundle for carrying forensic information.
 */

import type { UiNode, UiSnapshot } from '../uinode.ts';
import type { LocatorBundle } from '../../core/schema.ts';
import type { DriftRecord, ResolutionTrace } from '../../core/result.ts';
import { runStrategy } from './strategies.ts';

export interface ResolvedNode {
  node: UiNode;
  trace: ResolutionTrace;
  drift?: DriftRecord;
}

export type ResolveFailure =
  | { reason: 'unresolved'; detail: string; triedTiers: number[] }
  | { reason: 'ambiguous'; detail: string; tier: number; count: number }
  | { reason: 'no_quorum'; detail: string; tier: number; agreement: number; required: number };

export type ResolveOutcome =
  | { ok: true; value: ResolvedNode }
  | { ok: false; error: ResolveFailure };

interface TierRun {
  tier: number;
  candidates: UiNode[];
  inapplicable: boolean;
}

export function resolveBundle(
  bundle: LocatorBundle,
  snapshot: UiSnapshot,
  params: Record<string, unknown> = {},
  opts: { stepId?: string } = {},
): ResolveOutcome {
  const started = Date.now();

  const ordered = [...bundle.strategies].sort((a, b) => a.tier - b.tier);
  const runs: TierRun[] = ordered.map((s) => {
    const r = runStrategy(s.strategy, snapshot, params);
    return { tier: s.tier, candidates: r.candidates, inapplicable: r.inapplicable !== undefined };
  });

  const applicable = runs.filter((r) => !r.inapplicable);
  const uniqueRuns = applicable.filter((r) => r.candidates.length === 1);

  // The best tier that produced exactly one node.
  const winner = uniqueRuns[0];

  if (!winner) {
    const ambiguous = applicable.find((r) => r.candidates.length > 1);
    if (ambiguous && bundle.requireUnique) {
      return { ok: false, error: {
        reason: 'ambiguous',
        tier: ambiguous.tier,
        count: ambiguous.candidates.length,
        detail: `tier ${ambiguous.tier} matched ${ambiguous.candidates.length} nodes for `
              + `"${bundle.description}"; uniqueness was required`,
      }};
    }
    return { ok: false, error: {
      reason: 'unresolved',
      triedTiers: applicable.map((r) => r.tier),
      detail: `no strategy resolved "${bundle.description}" `
            + `(tried tiers ${applicable.map((r) => r.tier).join(', ') || 'none'})`,
    }};
  }

  const node = winner.candidates[0]!;
  const agreement = countAgreement(applicable, node);
  const topTier = Math.min(...ordered.map((s) => s.tier));
  const degraded = winner.tier > topTier;
  const missedTiers = applicable
    .filter((r) => r.tier < winner.tier && r.candidates.length !== 1)
    .map((r) => r.tier);

  if (degraded && agreement < bundle.minAgreement) {
    if (!bundle.allowDegraded) {
      return { ok: false, error: {
        reason: 'no_quorum', tier: winner.tier, agreement, required: bundle.minAgreement,
        detail: `"${bundle.description}" fell back to tier ${winner.tier} and degraded `
              + `resolution is disabled for this target`,
      }};
    }
    return { ok: false, error: {
      reason: 'no_quorum', tier: winner.tier, agreement, required: bundle.minAgreement,
      detail: `"${bundle.description}" fell back to tier ${winner.tier}, where only `
            + `${agreement} of ${bundle.minAgreement} required strategies agree. `
            + `Refusing to guess which node was meant.`,
    }};
  }

  const trace: ResolutionTrace = {
    locatorDescription: bundle.description,
    winningTier: winner.tier,
    agreement,
    degraded,
    missedTiers,
    candidateCount: winner.candidates.length,
    durationMs: Date.now() - started,
  };

  const value: ResolvedNode = { node, trace };
  if (degraded) {
    value.drift = {
      stepId: opts.stepId ?? '(unknown)',
      locatorDescription: bundle.description,
      expectedTier: topTier,
      actualTier: winner.tier,
      agreement,
      observedName: node.name,
      note: `top tier ${topTier} did not resolve uniquely; tier ${winner.tier} won with `
          + `${agreement} strategies in agreement. The surface has probably changed here.`,
    };
  }
  return { ok: true, value };
}

/**
 * How many independent strategies point at this exact node?
 *
 * Strict on purpose: a strategy agrees only if it resolved to a single node and
 * that node is the winner. Counting "the winner is somewhere in my candidate
 * list" would let a strategy matching forty nodes vote, which is not agreement,
 * it is a coincidence.
 */
function countAgreement(runs: TierRun[], node: UiNode): number {
  return runs.filter((r) => r.candidates.length === 1 && r.candidates[0] === node).length;
}

/** Formats a failure for a human, for evidence and error messages. */
export function describeFailure(e: ResolveFailure): string {
  return e.detail;
}
