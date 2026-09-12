# Computer-Use Automation System

An LLM discovers how to do a task inside a legacy back-office app once. That run compiles into a
typed, versioned, replayable **capability**. From then on, production invokes the capability
deterministically — **with no model in the decision loop.**

That split is the whole thesis, so it's the first thing to verify: the core thread below needs an
`ANTHROPIC_API_KEY` for exactly one step (`discover`). Every `replay` command — success, a bad
input, an injected fault, a human escalation — runs with **no key at all**.

Design write-up: [REPORT.md](REPORT.md) (architecture, schema, determinism, escalation, safety,
cuts). Deeper reasoning on the six load-bearing decisions: [docs/adr/](docs/adr/). Full decision
log and phase-by-phase build history: [CLAUDE.md](CLAUDE.md).

## Setup

```bash
npm install                        # installs Playwright's browser binaries too
cp .env.example .env               # fill in ANTHROPIC_API_KEY; everything else has a fallback
npm run check                      # typecheck + lint + 311 tests, ~2 min
```

Node 20+. Nothing else to install — the target app, the engine, and the operator console are all
part of this one repo.

## Demo path (the core thread)

One command replays the committed reference capability across every terminal state the result
contract distinguishes - success, a bad input, a recovered fault, a hard failure, and a full
human escalation - and writes evidence for each to `/evidence/gate-*/`. It starts its own
in-process copy of the target app, needs no `ANTHROPIC_API_KEY`, and calls no model:

```bash
npm run demo
```

That's `npx tsx scripts/gate-p5.ts` under the hood - see its own header comment for exactly what
each of the five runs demonstrates and why it uses the hand-authored reference artifact rather
than the model-discovered one (the discovered one can only prove the happy path - see
[REPORT.md §7](REPORT.md#7-cuts)).

**The one real LLM-driven run** is separate, because it costs an actual API call and produces a
new artifact each time - not something to fire automatically every time someone wants to "see the
demo work." Its output and evidence are already committed; re-run it yourself with:

```bash
npm run app &                      # Meridian Core, the target app, on :4400
npm run discover -- --goal "Look up member 12345 and read their current savings balance" \
                    --target http://localhost:4400        # needs ANTHROPIC_API_KEY, ~$0.05-0.20

# Then replay what it produced - no model, no key, from here on:
npm run replay -- --artifact artifacts/cap.member.read_savings_balance@1.0.0.json \
                   --input '{"memberId":"12345"}'                    # success, typed outputs
npm run replay -- --artifact artifacts/cap.member.read_savings_balance@1.0.0.json \
                   --input '{"memberId":"99999"}'                    # a bad input, handled
npm run replay -- --artifact artifacts/cap.member.read_savings_balance@1.0.0.json \
                   --input '{"memberId":"12345"}' --chaos session_timeout   # recovered, bounded
npm run replay -- --artifact artifacts/cap.member.read_savings_balance@1.0.0.json \
                   --input '{"memberId":"12345"}' --chaos http_500         # hard failure, typed
```

Escalation needs an operator console running first, in its own terminal, and `--operator` so the
run knows where to send an intervention:

```bash
npm run operator                                       # terminal 1 - loopback console
npm run replay -- --artifact artifacts/cap.member.read_savings_balance@1.0.0.json \
                   --input '{"memberId":"12345"}' --chaos permission_denied \
                   --operator http://localhost:4500     # terminal 2
```

The run pauses, prints an intervention URL, and hands the *same live browser session* to whoever
opens it. Resolve it there; the run resumes and finishes. `npx tsx scripts/gate-p5.ts` records all
five terminal states (success, business outcome, recovered, hard failure, escalated) into
`evidence/gate-*/` in one pass — that's the fastest way to see every outcome without driving it by
hand.

### Running with no live services

`npm run replay` needs no `ANTHROPIC_API_KEY` — that's asserted by test, not just claimed:
`evidence/demo-replay-no-key/` is a committed replay run recorded with the key unset. If Meridian
Core also isn't running, point `--artifact` at nothing and `explain` still works fully offline:

```bash
npm run explain -- --artifact artifacts/cap.member.read_savings_balance@1.0.0.json   # reviewable prose
npm run explain -- --schema                                                          # the contract, as JSON Schema
```

## What each requirement is, where it lives, and how to see it run

| Section 3 requirement | Where | Verify it |
|---|---|---|
| 3.1 Goal-driven agent loop | `src/discovery/{loop,planner,tools}.ts`, `src/cli/discoverCommand.ts` | `npm run discover -- --goal ... --target ...` |
| 3.2 Structured artifact | `src/core/schema.ts` (`CapabilityArtifact`) | `npm run explain -- --schema` |
| 3.3 Deterministic replay | `src/replay/replay.ts`, `src/core/result.ts` (`ReplayResult`) | `npm run replay -- ...` (any input above) |
| 3.4 Safety & policy guardrails | `src/policy/{policyEngine,actionClass,secrets}.ts`, `config/policy.yaml` | `tests/unit/policy.test.ts`, `tests/safety/redaction.test.ts` |
| 3.5 Evidence / observability | `src/evidence/{writer,reportHtml}.ts` | open any `evidence/<runId>/report.html` |
| 3.6 Human-in-the-loop escalation | `src/escalation/*`, `src/exec/lease.ts` | `evidence/gate-5-escalation/report.html` |
| 3.7 Heterogeneity & multi-tenant (design) | `src/replay/overlay.ts`; discussed in [REPORT.md §4](REPORT.md#4-heterogeneity--multi-tenant) | `tests/unit/policy.test.ts`'s tenant-overlay cases |

| Section 7 evaluation criterion | Primary evidence |
|---|---|
| System design | `src/core/schema.ts`, [REPORT.md §1-2](REPORT.md) |
| Correctness of the core loop | `evidence/gate-1-success/`, a real Sonnet 5 discovery run in `evidence/` |
| Robustness & error handling | `evidence/gate-2-business-outcome/`, `gate-3-recovered/`, `gate-4-hard-failure/` |
| Human-in-the-loop escalation | `evidence/gate-5-escalation/`, [REPORT.md §5](REPORT.md#5-escalation--handoff) |
| Generalization | [REPORT.md §4](REPORT.md#4-heterogeneity--multi-tenant), `src/replay/overlay.ts`, and a second real discovery run against [saucedemo.com](https://www.saucedemo.com) (`evidence/20260912T153547Z-discovery-67e14020/`) — which found and fixed a real perception-layer gap rather than only arguing the design generalizes |
| Safety & data handling | `config/policy.yaml`, `tests/safety/`, [REPORT.md §6](REPORT.md#6-safety) |
| Code quality | `npm run check` (typecheck + lint + 311 tests) |
| Communication | [REPORT.md](REPORT.md), [docs/adr/](docs/adr/), this table |

## Stretch goal: the MCP capability catalog

Quarantined from the core demo path on purpose — a stretch-goal slip must never break the
primary thread above. Exposes approved capabilities as MCP tools an AI agent can discover and
call by name:

```bash
bash scripts/demo-stretch.sh
```

This approves the reference capability (`draft → approved`, re-signed) and then runs a real MCP
`Client` against a real `cua mcp` server over stdio — `tools/list` shows the catalog,
`tools/call` invokes it and gets back typed `structuredContent`, and a made-up capability name is
refused rather than silently attempted. See [REPORT.md §7](README.md) and `CLAUDE.md`'s P6 gate
section for what this demo does and does not prove with the currently-shipped, model-discovered
artifact.

## Project layout

```
apps/meridian-core/   the target app - a purpose-built hostile legacy surface, 8 chaos modes
src/discovery/        the agent loop: observe -> decide -> act, then compile + self-verify
src/surface/          perception + locator resolution (accessibility snapshot, 6 tiers)
src/replay/           the production execution path - no model, ever
src/exec/             the one chokepoint that touches a Surface: policy + lease + predicates
src/policy/           the allowlist, action classification, secret resolution
src/escalation/       the human handoff: lease, capture, operator console
src/mcp/              the stretch goal: approved capabilities served as MCP tools
src/evidence/         the only path from a running system to disk - redaction happens here
tests/                unit, integration (real browser, real app), determinism, safety
docs/adr/             the six decisions worth defending on their own page
```
