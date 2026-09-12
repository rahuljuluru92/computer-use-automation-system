# Architecture Decision Records

Short-form records for the decisions REPORT.md points to instead of
re-arguing inline, so the write-up stays within its ~1-3 page budget. Each one
draws on the full reasoning already captured in [DEVELOPMENT.md](../DEVELOPMENT.md)'s decisions log;
these are the load-bearing subset, organized by question rather than by the
order they were made in.

| ADR | Decision |
|---|---|
| [0001](0001-model-never-writes-a-selector.md) | The model never writes a selector - it points at an opaque ref; the system synthesizes the locator. |
| [0002](0002-accessibility-snapshot-not-cdp.md) | Perception is Playwright's accessibility snapshot, not raw CDP. |
| [0003](0003-replay-never-calls-a-model.md) | Replay never calls a model - enforced three independent ways. |
| [0004](0004-business-outcome-is-not-failure.md) | `ReplayResult` is a discriminated union - a business outcome is not a failure. |
| [0005](0005-escalation-is-a-lease-handoff.md) | Escalation is a generation-counter lease handoff, not a mutex. |
| [0006](0006-redaction-at-the-sink.md) | Redaction happens at the sink (the evidence writer, or capture time for images), never after. |
