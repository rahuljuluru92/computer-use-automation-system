# Computer-Use Automation System

> **Status: in development.** This README is a placeholder; the full setup guide,
> demo path, and requirement map land in Phase 7.

An LLM discovers how to complete a task inside a legacy back-office application once.
That run is compiled into a typed, versioned, replayable **capability**. From then on,
production invokes the capability deterministically — with no model in the decision loop.

```bash
npm install
npm run check                 # typecheck + lint + tests
npm run explain -- --schema   # the capability contract, as JSON Schema
```
