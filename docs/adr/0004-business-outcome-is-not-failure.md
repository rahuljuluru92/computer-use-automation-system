# ADR-0004: `ReplayResult` is a discriminated union - business outcome is not failure

**Status:** Accepted

## Context

The brief's own glossary names this directly: *"'no such member' is a
legitimate answer the caller needs, not a crash. Conflating the two is the
most common design mistake here."* A result shape like `{ success: boolean,
data?, error? }` makes that mistake easy to write and easy to miss in review -
nothing stops a caller from reading `data` without checking `error`, and
nothing stops an implementer from routing "no such member" through the same
`error` field a real crash would use.

## Decision

`ReplayResult` (`src/core/result.ts`) is a Zod discriminated union on
`status`, with five terminal variants: `success`, `business_outcome`,
`failed`, `escalated`, `blocked_by_policy`. A caller cannot read `outputs`
without first narrowing on `status`, and narrowing on `status` forces the
caller to notice that `business_outcome` exists as its own case, distinct
from `failed`. The type system enforces the distinction the brief calls out,
rather than relying on a reviewer to catch a conflation in a PR.

`business_outcome` and `success` both exit the CLI with code `0` (decision
#46) and both come back `isError: false` over MCP (extending the same
reasoning to the Phase 6 transport, ADR-0003's `src/mcp`) - a caller shelling
out or calling as an agent gets the same distinction a caller importing the
type gets. `recoverable` is deliberately **not** a sixth terminal status
(decision #10): a recoverable condition that was handled surfaces as
`success` with the recovery counted in `metrics.recoveries`; one that
exhausted its budget becomes `failed` or `escalated`. Recovery is something
that happens *during* a run, not something a run ends as.

The failure taxonomy itself is a closed enum (`FailureCode`) rather than a
free-text message, each code answering "what would I look at first?" -
`locator_unresolved`, `precondition_failed`, `checkpoint_failed`,
`wait_timeout`, `artifact_invalid`, and so on - because a failure that cannot
be triaged without reading the automation's source is not a taxonomy, it is a
stack trace with extra steps.

## Consequences

- Every consumer of a `ReplayResult` - the CLI printer, the MCP server, the
  test suite - is forced by the compiler to handle all five cases or
  explicitly ignore one, which is a compile error in this codebase's strict
  TypeScript configuration rather than a runtime surprise.
- Declaring outcomes is part of the published contract (`CapabilityArtifact
  .outcomes`), not something a caller discovers by accident when a run
  behaves unexpectedly - Section 3.2's "clear contract, not just a step list."
- The known gap: a model that only ever walks a happy path during discovery
  declares no business outcomes and no recovery rules (decision #114,
  documented in REPORT.md's Cuts section) - the taxonomy is only as rich as
  what discovery actually met.
