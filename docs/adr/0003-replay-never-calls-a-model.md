# ADR-0003: Replay never calls a model

**Status:** Accepted

## Context

The brief's whole premise is that a discovery run becomes deterministic,
replayable automation - the model discovers once, production replays without
it. That is easy to say and easy to violate quietly: a "helpful" recovery
rule that asks a model what an unrecognized dialog probably means, a fallback
that re-plans a step when a locator fails, an escalation handler that asks a
model to guess what a human meant - each one is individually defensible and
each one reopens the decision loop that replay exists to close.

## Decision

Nothing under `src/replay`, `src/exec`, `src/surface`, `src/policy`, `src/
escalation`, or `src/mcp` may import a model SDK or the discovery/planner
package. Enforced three independent ways, deliberately redundant:

1. **eslint**, `no-restricted-imports` in `eslint.config.js` - fails the lint
   the moment someone types the import. Catches it while writing the code.
2. **A source scan**, `tests/determinism/no-llm-on-replay-path.test.ts` -
   fails CI even if the lint rule is disabled inline for one file. Catches it
   at review time, independent of editor configuration.
3. **Runtime**, `ReplayResult.metrics.llmCalls` - asserted `0` by the
   integration tests against a real run, not just a static property of the
   source. Catches it in production, and catches the case a static scan
   cannot: a dependency that itself calls a model indirectly.

`src/escalation` is on the list for a reason that is easy to miss: handing
control to a human happens *during* a replay, so a model consulted there is a
model consulted on the replay path - "ask a model what the operator probably
meant" is exactly the kind of locally-helpful idea this boundary exists to
refuse. `src/mcp` joined the list in Phase 6 for the same reason: an MCP
`tools/call` is `replay()` behind a different transport, not a new decision
loop.

## Consequences

- A capability that "mostly" replays deterministically but occasionally
  consults a model for a hard case is not a weaker version of this system; it
  is a different system, and this boundary makes building that different
  system by accident impossible rather than merely discouraged.
- Recovery from runtime errors (validation errors, interstitials, session
  timeouts) has to be expressed as declared, bounded rules the compiler wrote
  down at discovery time (`RecoveryRule` in the schema), not as a live
  fallback - which is also why "recovery" is not a resource of unlimited
  cleverness, only of what was actually seen and encoded once.
- The cost is real: a replay that meets a genuinely novel failure mode has no
  recourse but to escalate to a human or fail cleanly. That is the correct
  cost, not a limitation to route around - the boundary is the point.
