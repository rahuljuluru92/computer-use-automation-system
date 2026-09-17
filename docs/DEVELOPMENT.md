# Development History

Phase-by-phase build log for this project: what shipped at each gate, the test count
verified at that point, and the reasoning behind every non-obvious decision made along the
way. [../README.md](../README.md) is how to set up and run the system; [../REPORT.md](../REPORT.md)
is the design write-up graded against the brief; [adr/](adr/) gives deeper reasoning on the
six most load-bearing decisions. This document is the full record behind all three - the
complete decision log, and the story of how each phase gate was actually reached, bugs
included rather than smoothed over.

## What this is

interface.ai take-home, Assignment A. Build the layer that gives an AI agent *hands* inside
legacy bank back-office apps that have no API:

> A model discovers how to do a task once → that run compiles into a typed, versioned,
> replayable **capability** → production replays it deterministically with no model in the
> decision loop → with real error handling, real human escalation, and real guardrails.

Graded, in order: **system design → core-loop correctness → robustness/error handling →
human-in-the-loop escalation → generalization → safety → code quality → communication.**
Explicitly *not* rewarded: feature breadth, framework name-dropping, scaling infrastructure.

## Non-negotiable invariants

Nine rules the build held to throughout - each enforced in code or by test, not by
discipline alone:

1. **Replay never calls a model.** Enforced three ways: eslint `no-restricted-imports`
   (`eslint.config.js`), a source scan (`tests/determinism/`), and `metrics.llmCalls === 0`
   on every `ReplayResult`.
2. **The model never writes a selector.** It points at an opaque `nodeRef` from the snapshot
   it just observed; the *system* synthesizes the locator bundle. See ADR-0001.
3. **Discovery and replay share one resolution path.** So every locator bundle in a shipped
   artifact was actually executed at record time.
4. **No artifact ships unverified.** The compiler replays what it produced before writing it.
5. **No `sleep()` anywhere.** Waits are state predicates (`Predicate`), never durations.
6. **Business outcome ≠ failure.** `ReplayResult` is a discriminated union so a caller cannot
   read outputs without noticing `business_outcome` exists.
7. **Policy and lease are checked inside `Executor.act()`**, not in a prompt, not at call sites.
8. **Nothing sensitive reaches disk.** Every byte to `evidence/` and `artifacts/` goes through
   `Redactor`; `tests/safety/` proves it with canaries.
9. **Git authorship is Rahul only.** No Claude co-author trailers, ever.

---

## Phase summary

| Phase | What | Tests at this gate | State |
|---|---|---|---|
| P0 | Contracts and rails | 33 | **DONE** |
| P1 | Meridian Core target app (M0+M1+M2) | 19, +17 with M2 | **DONE** |
| P2 | Surface + locator engine | +35 new | **DONE** |
| P3 | Executor, policy, evidence | 124 | **DONE** |
| P4 | Discovery loop + compiler | 235 | **DONE** |
| P5 | Error taxonomy + escalation | 290 | **DONE** |
| P6 | MCP catalog (stretch goal) | 303 | **DONE** |
| P7 | README + REPORT + evidence | 311 | **DONE** - screen recording optional, not recorded |
| - | M2 second tenant skin (picked up from P7 slack) | 328 | **DONE** |
| P8 | Breadth pass: a second real capability, a value-ceiling safety check, a wider MCP demo, a read-only catalog | 362 | **DONE** |

**362 tests, verified via `npm run check` (typecheck + lint + full suite).** The one remaining
open item, the escalation screen recording, is explicitly optional per the brief's own text
and is logged, not hidden, in [REPORT.md §7](../REPORT.md#7-cuts).

---

## Phase-by-phase

### P0 - Contracts and rails

`npm run check` green (33 tests); `cua explain --schema` emits the 1875-line JSON Schema.

**Deliverables:** `src/core/{schema,result,redact,integrity,ids}.ts`,
`src/surface/{uinode,surface}.ts`, `src/exec/lease.ts`, `src/capability/explain.ts`,
`src/cli/index.ts`, the eslint determinism boundary, vitest, and `tsconfig` (strict +
`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`).

### P1 - Meridian Core target app (M0 + M1 + M2)

`npm run app` serves Meridian Core on `:4400`. Both flows work by hand and under test; all
eight chaos modes fire. 24 integration tests. Visually confirmed in a browser.

**Deliverables:** `apps/meridian-core/{server,chaos,session,ids}.ts`, `data/seed.ts`, 12 EJS
views, `tests/integration/meridian.test.ts`.

**M2, a second tenant skin, picked up from P7 slack.** `apps/meridian-core/tenants.ts` adds
`summitcu`: different branding, "Customer Number" replacing "Member ID" on the search field,
and a one-time consent interstitial no other tenant shows - armed through its own control
route (`/_tenant?name=`), sticky per session like chaos mode. The reference capability's
`tenancy.overlays.summitcu` resolves all three re-skins with one locator replacement, one
checkpoint replacement, and one recovery rule.

Building it live found a real limitation in the overlay mechanism: `TenantOverlay.targets`
could only patch a step's action target, not the checkpoint/waitFor predicates that carry
their own locator bundles - and the sign-in step's checkpoint (proving the search screen
loaded, by finding the very field this tenant renames) needed exactly that. Extended
`TenantOverlay` with `checkpoints`/`waitFors` maps rather than routing around it.

`npx tsx scripts/gate-m2.ts` proves it live: the unmodified base capability run against
`summitcu` with no `--tenant` flag genuinely degrades (`locator_unresolved`, not a clean
timeout - the sign-in step's `waitFor` misses the renamed panel, retries, and blindly
re-clicks a Sign In button no longer on the page), and the same capability with
`--tenant summitcu` replays end to end to the identical typed output. 0 model calls in every
run. Tests: `tests/unit/overlay.test.ts` (9, schema-level), `tests/integration/tenantOverlay
.test.ts` (3, real browser against both skins), 5 new cases in `meridian.test.ts`.

### P2 - Surface + locator engine

Aria snapshot parser, `UiNode` flattener, six locator strategies, a resolver with
conditional quorum + drift detection, and `WebSurface`. 35 new tests. Unit tests run against
fixtures captured from a real browser (`scripts/capture-fixtures.mjs`); integration tests
drive a real Chromium against a real Meridian instance.

The gate test: the View link on the Savings row resolves and clicks correctly across two
renders in which every control id changed - inside an iframe, with three identically-named
candidates.

### P3 - Executor, policy, evidence

The seed artifact replays end to end against the real app, with no model anywhere. 124
tests. `npm run replay` works from the CLI.

Proven by test: typed outputs (`savingsBalance: 4210.55`); `no_such_member` and
`member_restricted` as distinct **business outcomes** exiting 0; surprise-interstitial and
session-expiry recovery, both bounded; contract violation rejected before the browser opens;
per-step screenshots; redaction canaries (password, SSN, card) absent from every byte of
text evidence.

**Deliverables:** the predicate evaluator, state-predicate waits (no `sleep` anywhere), the
policy engine + action classifier + secret resolver, `Executor.act()`'s single chokepoint,
the evidence writer with redaction-at-the-sink, per-run `report.html`, `replay()`, tenant
overlays, and the CLI.

### P4 - Discovery loop + compiler

`npm run discover` produced a self-verified capability from a **real Sonnet 5 run**: 9
turns, 1121 tokens, 7 steps, 0 detours pruned, compiler-verified by replaying in a cold
browser before writing. 235 tests.

The claim, demonstrated with `ANTHROPIC_API_KEY` unset:

```
SUCCESS  cap.member.read_savings_balance v1.0.0
  savingsBalance: 4210.55
steps 7  retries 0  recoveries 0  degraded 0  model calls 0
```

`artifacts/cap.member.read_savings_balance@1.0.0.json` is model-discovered, not
hand-written - it replaced the Phase 3 seed. `memberId` is the only caller input;
credentials are `$secret` refs; the canary password is absent; the literal `12345` is absent
from steps; `savingsBalance` is typed as a number; every step is checkpointed; status is
`draft`. Evidence with per-step screenshots committed alongside.

**Deliverables:** `src/surface/locator/bundle.ts`,
`src/discovery/{tools,prompt,loop,planner,prune,canonicalize,compiler}.ts`,
`src/cli/discoverCommand.ts`, `prompts/discovery.v1.md`, `tests/integration/discover.test.ts`.

**Three bugs only a live run could find** - all fixed, all with regression tests:
1. Typing trips the oscillation detector (the structure hash excludes values). Killed the
   run after three keystrokes on a login form. (#94)
2. Every `type` step compiled with **no checkpoint** - the "assumes the click worked" step
   the contract warns against. (#95)
3. `.env` was documented but never read; `.env.example` had a password that did not match
   the seed.

**Two post-gate defects, also fixed:**
- E2E flakiness (~1 gate run in 3) - `requestSubmit()` goes through the same path a
  Playwright bug eats. A GET submission now navigates to the URL the browser would have
  built. 3/3 gate runs green after the fix. (#96)
- A clean clone could not run the demo path: both commands also needed `MERIDIAN_*`, and a
  missing secret surfaced as an uncaught throw six steps into a browser session. Now
  defaulted from the seed, and checked as a typed `artifact_invalid` before the browser
  opens. (#97, #98)

**Verified:** with no `ANTHROPIC_API_KEY`, no `MERIDIAN_USERNAME`, and no
`MERIDIAN_PASSWORD`, replay returns `savingsBalance: 4210.55` in 7 steps, 0 model calls.
Evidence at `evidence/demo-replay-no-key/`.

### P5 - Error taxonomy + escalation

Five recorded replays, one per terminal state, all from `npx tsx scripts/gate-p5.ts`:

```
gate-1-success             success            savingsBalance 4210.55
gate-2-business-outcome    business_outcome   no_such_member
gate-3-recovered           success            1 recovery
gate-4-hard-failure        failed             bounded retries spent
gate-5-escalation          escalated          resolved by an operator, 1 intervention
```

Every one: **0 model calls**. Evidence in `evidence/gate-*/report.html`. 290 tests.

Gate 5 is the phase: the interstitial appears, the declared remedy is applied and fails,
the run cedes the session, a human clears it by hand in the *same* browser, hands back, and
the run re-observes and finishes the task. Its audit trail reads `click Acknowledge · submit
form · navigate`, and its lease history reads `automation->none gen2 · none->operator gen3 ·
operator->automation gen4`.

**Deliverables:** `src/escalation/{intervention,bus,capture,handoff,remote}.ts`,
`src/escalation/operatorConsole/{server,ui}.ts`, `src/cli/operatorCommand.ts`, the artifact
`escalation` block (timeout + declared abandon path), run-level budget enforcement,
`metrics.interventions`, `scripts/{gate-p5,resign-artifacts}.ts`.

**Five bugs only a real browser and a real handoff could find** - all fixed, all with
regression tests:
1. **The audit trail was silently empty.** The in-page script is serialised by Playwright
   via `toString()`, but `tsx` compiles it first and esbuild's `keepNames` leaves a
   `__name(...)` call that does not exist in a browser. It died as `ReferenceError:
   __name is not defined` inside a catch that existed for navigating frames. The script is
   now an uncompiled string. (#107)
2. The "already installed" guard outlived its own listeners - `document.open()` rewrites a
   page in the *same* document object, so the flag survived while every listener was
   dropped. Installation is now idempotent by removal. (#108)
3. `tryRecover` could never return `'escalated'`: the whole recovery-exhaustion path into
   escalation was unreachable dead code. (#104)
4. The safe-abandon path was blocked by the very modal that caused the escalation, so a
   timed-out run reported an abandon it had not performed. (#106)
5. Cross-process, the lease never recorded that a person held the session - the poller
   misses the `claimed` state when claim and resolve land in one polling interval. (#110)

### P6 - MCP capability catalog (stretch goal)

The brief's stretch goal #1, verbatim: *"expose saved artifacts as a catalog of callable
capabilities... and show one being invoked."* Not a new execution path - every `tools/call`
is `replay()`, the exact path `cua replay` drives from a terminal, behind a different
transport. `src/mcp` was added to the determinism boundary's protected list alongside
`src/replay`/`src/exec`/`src/surface`/`src/policy`/`src/escalation` for exactly that reason.
303 tests, all green, all with zero model calls.

The gate, run for real against the live app with `scripts/demo-stretch.sh`:

```
tools/call  cap.member.read_savings_balance  { memberId: "12345" }
  isError: false   structuredContent: {"status":"success","outputs":{"savingsBalance":4210.55}}

tools/call  cap.nonexistent.made_up
  isError: true    blocked_by_policy: no approved capability named "cap.nonexistent.made_up".
```

**Deliverables:** `src/mcp/{catalog,server}.ts`, `src/cli/approveCommand.ts`, wired
`approve`/`mcp` in `src/cli/index.ts` (both were stubs since P0 - the CLI surface never had
to change shape). `scripts/demo-stretch.{ts,sh}`. Tests:
`tests/unit/approveCommand.test.ts`, `tests/integration/mcp.test.ts` (a real MCP
`Client`/`Server` pair over `InMemoryTransport`, not a mock of either side).

**One design bug, caught only by running the real demo against the real shipped artifact**
(the in-memory test used the richer hand-authored fixture and never saw it): the MCP tool's
`outputSchema` was set to the artifact's raw success-output schema. A business-outcome
response has a different shape than a success response by design (ADR-0004) - so the MCP
SDK's own client-side validation correctly rejected a business-outcome `structuredContent`
against a success-only schema. Fixed by advertising a small envelope schema
(`{status, outputs?, outcome?}`) instead of the raw success shape - the same
discriminated-union reasoning as `ReplayResult`, just one layer further out at the wire
boundary. Caught before it shipped because the demo was actually run, not just described.

**One finding, not a bug:** running the demo against the real `artifacts/` file (rather than
the hand-authored seed the tests use) reproduced decision #114 live - a bad member id
against the model-discovered artifact surfaces as a typed `failed: wait_timeout`, not a
`business_outcome`, because that artifact never learned "no such member" exists. The demo
script narrates this explicitly rather than hiding it or quietly swapping in a friendlier
artifact.

### P7 - README, REPORT, ADRs, and the evidence index

Produced the two required deliverables - [../README.md](../README.md) and
[../REPORT.md](../REPORT.md) (using the brief's exact seven required headings) - the six
ADRs in [adr/](adr/), and the evidence index at `evidence/README.md`. Also recorded a
second, independent real discovery run against a public site
([saucedemo.com](https://www.saucedemo.com)) to test the generalization claim in REPORT.md
§4 against evidence rather than only argument - see decision #120 below, the most
significant bug either discovery run found.

Independently re-verified in a full audit at this stage: 311/311 tests passing, typecheck
and lint clean, via a fresh run of `npm run check`.

### P8 - Breadth pass: a second real capability, a value-ceiling check, a wider MCP demo, a catalog

Picked up after P7 to grow the demo's surface area without touching any of the nine
invariants - six sub-phases, each landing as its own commit with `npm run check` green
before the next one started.

**A latent compiler bug, fixed first.** `outcomesFrom()` (`src/discovery/compiler.ts`) had
always built a declared outcome's detector as `{ kind: 'text_matches', pattern: ... }` with
no `locator` - the field the schema requires - forced through a type-cast. Never caught
because no discovered artifact had ever taken the `declare_outcome` path (decision #114).
Fixed by giving `declare_outcome` an optional `ref` directly (not a chained `assert` call,
which would be fragile against a model confused on a chaotic screen), and by teaching
`compile()` to accept `additionalOutcomeScenarios` - a second discovery run kept only for
its declared outcome, proven with its own scenario replay (an `armUrl` navigated on a fresh
session, an `expectedCode` checked after), never merged into the primary trajectory. A
`BusinessOutcome` is artifact-level and checked on every step regardless of which run
produced the steps, so this is an array push, not a step-alignment problem.

**`cap.member.open_subaccount`: the second real, model-discovered capability**, and the
first to ship with an actual, replay-checked business outcome
(`validation_error_funding_limit`) instead of none. Discovered live (Sonnet 5) in two runs -
a clean happy path, and a second run with `validation_error` chaos armed and a dedicated
`prompts/discovery-outcome.v1.md` prompt variant telling the model to declare the refusal
immediately rather than try to fix it. The anti-remediation prompt worked correctly on
every attempt that reached the review screen; the real obstacles were two ordinary
engineering bugs, not model behaviour (declared inputs missing the operator credentials on
the first attempt; the verifier's `inputs` leaking those same credentials into a schema
that correctly rejects them, since a credential is a `$secret.*` reference, never a caller
input).

Two more bugs, neither specific to this one capability, found compiling and verifying it:

- Policy already refuses an irreversible action during discovery by default ("you never let
  a discovery agent move money") - untested until now because the only prior capability was
  read-only. `--approve-irreversible` is the explicit, one-session human exception; the
  compiler's own self-verification of this capability's happy path uses the identical,
  previously-unused `approvalGranted` mechanism for one supervised proof-run, so it can
  reach the real "done" screen and prove the extract steps work.
- Locator synthesis for an extraction target could key its top two tiers on the node's own
  text - fine for a click target's stable label, wrong for a value certain to differ on
  every future run by construction. A generated reference number verified at record time
  and then could not resolve on a cold replay where a different value was generated, and the
  doomed strategy kept counting as a quorum witness against a label-anchored strategy that
  still worked on its own. `synthesizeBundle(..., { forExtraction: true })` now skips those
  two tiers for extraction targets entirely - a latent bug in the existing
  `read_savings_balance` artifact too, never triggered because that capability's test data
  never actually changes between a discovery run and a replay.

**A value-ceiling safety check**, `PolicyEngine`'s fourth inline rule alongside
`denyLabels`/`requireApprovalLabels`/`maxUnapprovedActionClass`: a numeric `$input` field
over a configured maximum needs a human decision, sourced from the caller-supplied input
value itself (never from rendered DOM text - an `$input` field is a plain string a caller
supplied, and the target app does the identical `Number()` conversion server-side).
`scripts/gate-value-ceiling.ts` and `tests/integration/valueCeiling.test.ts` both replay the
real, shipped `open_subaccount` artifact: a $500 deposit completes with zero escalation, an
$8000 one escalates specifically at the deposit step, not several steps later at commit.

**The `summitcu` tenant overlay, extended to the real artifact.** Checking first showed the
existing M2 story had only ever demonstrated the overlay mechanism on the hand-authored
seed capability - `read_savings_balance`'s own shipped artifact carries `tenancy.overlays:
{}`. `scripts/add-open-subaccount-summitcu-overlay.ts` applies the identical decision #121
fix (patch a step's target, checkpoint, and waitFor; never add/remove/reorder steps) to
`open_subaccount` directly, re-signed the same way `resign-artifacts.ts` does.
`tests/integration/tenantOverlayOpenSubaccount.test.ts` proves the same two things the
original M2 gate proves - against this second, real capability.

**The MCP demo, widened to three tools**, but not by forcing the chaos-gated business
outcome through it: `tools/call` launches a fresh, cookie-less browser per invocation, and
chaos is armed per session-cookie by design, so there is no side channel through which an
MCP caller could arm it on that session. The more honest, more valuable demonstration was
already sitting in the existing code - `open_subaccount`'s commit step needs approval
unconditionally, the MCP server wires no escalation channel into an unattended call, and the
existing `escalated` handling already returns a clean, typed refusal rather than a hang. A
legitimate, in-bounds deposit therefore still cannot complete over MCP, which is a stronger
safety point than the funding-limit outcome would have been.

**A read-only capability catalog**, at `/catalog` on the existing operator console and at
`cua catalog` on the CLI - not a new server, port, or dashboard framework. Both read
`loadApprovedCatalog()`, the identical loader `cua mcp`'s `tools/list` already uses, so the
console, the CLI, and MCP can never disagree about what is approved.

Independently re-verified at this stage: 362/362 tests passing, typecheck and lint clean.

---

## Decisions log

One line per non-obvious choice made during the build, with the reasoning behind it, so
nothing gets silently re-litigated or re-broken later.

| # | Decision | Why |
|---|---|---|
| 1 | TypeScript / Node 20+ | One language for target app, engine, operator console, MCP server. Playwright and MCP are both TS-first. |
| 2 | Hand-rolled Anthropic tool-use loop; no LangChain/LangGraph | Brief penalizes framework name-dropping; the loop is ~200 lines and the policy/lease chokepoints must be explicit. |
| 3 | Perception = Playwright `ariaSnapshot({mode:'ai', boxes:true, depth})`, **not raw CDP** | `mode:"ai"` gives `[ref=eN]` and descends into iframes itself; kills the AX-nodeId↔DOM-backendNodeId cross-referencing and frame-local coordinate math that would have been the worst time sink. Verified against installed 1.63 types. |
| 4 | Execution = `frameLocator(…).getByRole(…)` chains | Playwright re-resolves on every action and handles cross-origin frames. |
| 5 | There is **no** `aria-ref` locator syntax | So discovery must act through the synthesized bundle → invariant #3 falls out for free. |
| 6 | Boxes are **viewport**-relative CSS px | Only the *delta* between two nodes in one snapshot is scroll-invariant. Tier-6 `anchor_offset` is anchor-relative for exactly this reason. |
| 7 | `inputs`/`outputs` stored as JSON Schema, not Zod | The artifact is a portable contract an MCP server hands straight to a calling agent. |
| 8 | Zod 4 native `z.toJSONSchema()`; dropped `zod-to-json-schema` | Built in since Zod 4. One less dependency. |
| 9 | `ReplayResult` is a discriminated union on `status` | Makes conflating business outcome with failure a type error, not a code review note. |
| 10 | Recovery is **not** a terminal status | Recovery happens *during* a run; it surfaces as `success` + counted recoveries, or escalates. |
| 11 | Lease uses a **generation counter**, not a mutex | A mutex says "busy"; a generation rejects a stale action decided before a handoff and executed after it. That is the actual split-brain bug. |
| 12 | `eslint no-redeclare` off (both base and TS-aware) | The `const Foo` + `type Foo = z.infer<typeof Foo>` pattern is two declaration spaces; neither rule models it, and `tsc` already catches real duplicates. |
| 13 | Redactor: registered values matched **longest-first** | Otherwise a registered username inside a password leaves the rest of the password in the clear. |
| 14 | Card redaction is Luhn-checked | A greedy digit-run regex would destroy reference numbers and timestamps - useless evidence is its own failure. |
| 15 | Node's `util.parseArgs`, no CLI framework | Thirty lines vs three dependencies. |
| 16 | CLI surface fixed at P0, commands stubbed | So the README demo path never has to change as phases land. |
| 17 | Meridian uses a **content iframe**: chrome at top level, screens under `/frame` | Matches how this generation of app was actually built, and creates a property worth designing against - see #18. |
| 18 | **The top-level URL stops changing** as you navigate in-frame | So a `url_matches` checkpoint would pass forever without ever being true. Checkpoints must be written against the accessibility tree. This is a feature of the target, not an accident. |
| 19 | `session_timeout` clears the session and lets the request continue, rendering sign-in **inside the frame** | What the real thing does, and it makes a bounded `reauth` recovery subflow possible: fill the form in place and retry the step, rather than detecting that the whole window navigated. |
| 20 | All three account rows have a `View` link with the **same** accessible name | Deliberate. Role+name alone is ambiguous, which is exactly the case `table_cell_relative` exists for: identify the row by its data, the way a human does. |
| 21 | Chaos is sticky per session, not a query parameter | A replay navigates several pages; a query parameter is lost on the first link. |
| 22 | `createApp()` factory, listen only when run directly | Integration tests run it on an ephemeral port with no shell and no port race. |
| 23 | Aria snapshot parsed as **YAML** + a descriptor regex, not a hand-rolled indentation walker | Playwright's output is valid YAML. Counting spaces in someone else's generated format breaks on their next release. |
| 24 | Childless nodes arrive as **bare YAML strings**, not mappings | Caught by fixtures. Treating them as loose text dropped every leaf - every column header and nearly every cell. |
| 25 | Frame names never use Playwright's frame ordinal | Two renders of one screen came back `f2` and `f11`. That ordinal inside the structure hash would have silently broken oscillation detection and backtrack pruning. Caller supplies real names; fallback is document order, honestly labelled positional. |
| 26 | Structure hash covers roles/names/nesting, **never values** | Two renders of the same screen must agree despite every control id changing. Including values would make every hash unique and the feature useless. |
| 27 | **Quorum is required only when the top tier misses** | "Always require two strategies" fails good resolutions whenever lower tiers were recorded against a slightly different render - it trades a rare wrong-node bug for a frequent cannot-find-node bug. Demand agreement exactly when confidence has dropped. |
| 28 | Agreement is strict: a strategy votes only if it resolved to **exactly one** node and that node is the winner | "The winner is somewhere in my 40 candidates" is coincidence, not agreement. |
| 29 | Inapplicable ≠ disagreeing | A CSS selector can't be evaluated against an a11y snapshot. Scoring that as dissent would punish a bundle for carrying forensic info. |
| 30 | A control nested inside a grid cell inherits that cell's column | The View link is a child of the Action cell, not the cell itself. Without this every actionable control in a grid loses its column and tier 2 stops working. |
| 31 | **Resolution in our model, action by `aria-ref`** | `aria-ref=fNeM` works as a Playwright selector, is exact, and pierces frames with no frameLocator chain. Nothing synthesises a selector anywhere in the system. |
| 32 | Playwright's own `getByRole('row').filter({hasText})` is **unsound here** | It matched 2 rows and then 3 links: the outer *layout* table's row transitively contains every word on the page. Text filtering doesn't work on table-in-table legacy layouts. Our parsed tree knows real row/column, so it gets it right. This is the concrete argument for resolving in our own model. |
| 33 | A stale ref **times out** rather than matching something else | Verified empirically. Safe failure, and the trigger for `re_resolve_locator`. Ref action timeouts kept short (5s) so staleness is found fast. |
| 34 | **You may only act on a node from the most recent observation** | Caught by a test: a node captured on member 12345's page, then a navigate to 67890, then click - it *succeeded*, because the structural fallback found the identically-named button on the wrong member's page. A silent rescue that services the wrong customer. The fallback now only covers "aria-ref unavailable", never "page moved". |
| 35 | `label_anchored` prefers *labelled* over *named* | On `Current Balance \| $4,210.55` both cells match and the strategy is useless. "The thing labelled X" beats "the thing that says X". |
| 36 | Business outcomes are checked **before** preconditions, on every step | "No member record found" arrives as page content with HTTP 200. Checking preconditions first turns a legitimate answer into a precondition failure. |
| 37 | **After a recovery, verify the step's postconditions before repeating the action** | The reauth rule signs in - which is exactly what the sign-in step wanted. Repeating the action then either fails (no Sign In button once signed in) or, worse, succeeds: a second form submit means two sub-accounts. Caught by the session_timeout test. |
| 38 | Policy classifies actions **independently** of the artifact and takes the more cautious answer | The artifact's `actionClass` is a claim written by a compiler a model drove. Being wrong safely costs a prompt; being wrong the other way moves money. |
| 39 | `navigate` is policy-checked against its **destination**, not the current URL | Checking only the current URL lets one navigate walk the agent off the allowlist, after which every later check passes. |
| 40 | `press Enter` is classified by the target's label | A step list reading "press Enter" hides a commit from a human reviewer. |
| 41 | The executor refuses to act behind an **unclaimed** blocking dialog | Clicking something under a modal is how automation does the right thing to the wrong screen. |
| 42 | Screenshots are masked at **capture** time, not at the evidence writer | An image cannot be redacted by a text filter after the bytes exist. |
| 43 | The manifest reports **what** was redacted, not just that redaction ran | "Nothing was redacted" and "redaction never ran" must not look identical. |
| 44 | Report images are **relative paths**, not inlined base64 | Self-contained sounds nicer but fills the repo with megabytes of duplicated pixels; the report lives next to the images anyway. |
| 45 | Tenant overlays may replace locators, add recovery, stretch budgets - but **never add/remove/reorder steps** | An overlay that changes the shape of a flow is a different capability wearing the same name and should be reviewed as one. |
| 46 | Business outcome exits **0** from the CLI | A caller shelling out gets the same distinction the type system gives a caller importing. Verified: success 0, business_outcome 0, failed 1. |
| 47 | A synthesised strategy is kept only if it **uniquely resolved to its own node in its own snapshot** | Generation is cheap and speculative; verification is what ships. Means every strategy in a shipped bundle has actually run - invariant #3, enforced rather than asserted. |
| 48 | **At most one strategy per tier** | Three tier-2 strategies drawn from three columns of one row are not three independent witnesses, and quorum treats agreement as evidence. Inflating the bundle inflates confidence exactly where it is least deserved. |
| 49 | Tier 5 (`css`) is **never synthesised** | Not derivable from an a11y snapshot, and `byCss` reports itself inapplicable anyway. An empty slot is honest; a fabricated selector is a guess dressed as forensic evidence. |
| 50 | Volatile discriminators (currency, dates, times, %) are **kept but discounted**, with the reason written into `rationale` | Verification proves a strategy worked *once*, not that it will keep working. The only label beside the View link is the balance - it verifies today and breaks tomorrow. Silence there is the trap; bare digit runs are deliberately *not* volatile, since account numbers are exactly what you want to key on. |
| 51 | Canonicalisation touches only `role_name.name` and `table_cell_relative.matchValue` | The only two fields the resolver interpolates. A `$input.` reference anywhere else produces a locator that searches for the literal text `$input.memberId`. |
| 52 | Geometry is **rejected on the accounts grid**, and that is correct | Rows are 24px tall; `byAnchorOffset` tolerance is 24px. No anchor can separate a row from the one below it. Found by verification, not by inspection - a hand-written bundle would have shipped it. |
| 53 | Refs shown to the model are stamped with their observation (`o3#f2e14`) | Decision #34 says you may only act on a node from the most recent observation, but refs repeat across renders, so a stale one can silently match a *different* control. The stamp makes staleness detectable by construction instead of by luck. |
| 54 | Tool errors are **returned, never thrown** | A thrown error ends a run; a typed error ends a turn. A hallucinated ref comes back with the refs that exist, so the next turn is a correction rather than another guess. |
| 55 | A policy denial tells the model **not to seek another route** | Otherwise a capable agent treats a refusal as an obstacle and finds the unguarded path to the same effect. The refusal has to be legible as final. |
| 56 | `tools.ts` holds tool schemas as **inert JSON Schema** and imports no SDK | Keeps the tool surface unit-testable with no key and no network, and leaves the determinism boundary a one-line question: this file has no model dependency to leak. |
| 57 | URL templates use `{memberId}`; text fields use `$input.memberId` | Two syntaxes, because `Executor.interpolateUrl` and `strategies.interpolate` are separate and pre-date P4. The tool description states it explicitly - teaching the model one syntax would produce a capability that navigates to a literal. Worth unifying later; noted rather than silently patched. |
| 58 | Prompt text lives in `prompts/discovery.v1.md`; `promptVersion()` hashes its **bytes** | `provenance.promptVersion` is a contract field, so it must identify what drove the run. A hand-maintained version string records an intention to bump a number. An unbumped edit still stamps differently. |
| 59 | The loop takes a **`Planner` seam** and imports no model SDK | Budgets, oscillation, stalls and refusals are all testable with a scripted planner, no key, no network. Budget logic that needs a live model to exercise is budget logic that ships broken. |
| 60 | Budgets are checked **before** spending, not after | The point of a token budget is not to report that it was exceeded. |
| 61 | Oscillation gets **feedback before a verdict** | A detector ends a run; feedback rescues one. The model is told "you are back on the screen you were on at turn N" and only stopped once the state recurs past budget. |
| 62 | A single policy refusal does **not** end a run; a bounded number does | One refusal is information, and the model needs the chance to call `request_human`. Three is an agent circling a wall, costing tokens and producing nothing. |
| 63 | After a terminal tool call, remaining tool calls **in the same turn are dropped** | They were decided before the model knew the run had ended - the same stale-plan problem the lease generation counter solves for handoffs. |
| 64 | Each test file gets its **own** evidence scratch directory | Vitest runs files in parallel; a shared root had one suite's `afterAll` deleting a directory another was still writing into. Caught by the gate, not in review. |
| 65 | Assistant turns are replayed **verbatim** via an opaque `raw`, never rebuilt from `text` + `toolCalls` | Rebuilding silently drops reasoning blocks, which must be echoed back unaltered to the model that produced them. The loop carries `raw` without ever inspecting it. |
| 66 | **Every** `tool_use` gets a `tool_result`, including calls abandoned after a terminal | They come back marked "not executed". Dropping them was safe only by accident (the loop returns on a terminal); the transcript is evidence, and a malformed one is rejected by the API the moment anything replays it. |
| 67 | Written against installed SDK **0.71.2**: `thinking` and `output_config` **omitted**, not worked around | 0.71.2 predates adaptive thinking, `output_config`, top-level `cache_control` and `stop_details`. On Opus 5, omitting both *is* adaptive thinking at `high` effort - the configuration we wanted. Upgrading the SDK would allow explicit `effort`; not needed for correctness. `Model` is `(string & {})` so `claude-opus-5` type-checks on the old SDK. |
| 68 | Two **per-block** cache breakpoints: system prompt, and the end of the transcript | Render order is tools → system → messages. The system prompt never changes within a run; the transcript is append-only and grows by a whole screen per turn, so reading the previous turn's prefix back is by far the larger win. |
| 69 | A `refusal` is checked **before** reading content | It arrives as a successful 200. Reading content without checking would hand the loop a turn with no tool calls and no explanation, which it scores as a stall. |
| 70 | **Not** using server-side refusal `fallbacks` (a documented deviation from the `claude-api` default) | It needs the beta endpoint plus a beta header, adding a beta dependency to a codebase graded on clarity - and a beta the reviewer's org may not have enabled would fail at 400. Refusal is handled explicitly instead. Revisit if a real run ever hits one. |
| 71 | No retry layer in the planner | The SDK already retries 429/5xx twice. A second layer would multiply the backoff and hide the failure. |
| 72 | Pruning: a step whose `afterHash === beforeHash` is **never** a backtrack | The structure hash excludes values (#26), so typing hashes identically on both sides. Treating it as a state revisit deletes the form filling from every form-filling capability. A cycle must return to a state *strictly below* the stack top. |
| 73 | Pruning: a span containing an **extract** is always kept | "Open the account, read the balance, come back" is a round trip by shape and the whole task by intent. Pruning it silently deletes the capability's output. |
| 74 | Pruning: only `read`-class steps are ever pruned | A write that left the page looking the same still changed something behind it. Pruning is an optimisation; it does not get to decide that. |
| 75 | After a cycle is handled, the stack entry records it was re-reached at step `i` | Found by test. Without it the entry still claimed the state was reached at the start, so the next return swept a *retained* cycle back into its span and pruned nothing. |
| 76 | Every removal carries a **reason** | A compiler that silently drops steps is a compiler nobody can debug - and the removals are compile evidence. |
| 77 | The API key is a **runtime** requirement, never a repo one | The core thread runs on a clean clone with only `ANTHROPIC_API_KEY` set, and `npm run replay` must work with **no key at all**. That split is the thesis, so the README states it in the first screenful. `.env.example` only; no key committed, ever. |
| 78 | A scripted-planner run must **never** write a model id into `provenance.model` | It would be a lie in the artifact. Compiler records what actually drove the run (e.g. `scripted:fixture`), so a reviewer can tell a model-discovered capability from a machinery test at a glance. |
| 79 | **Checkpoints:** the model's `assert` wins; the compiler infers one otherwise; every step gets one | Settles the open question. The inference is not a guess - the next step demonstrably resolved its target on the screen this step produced, so requiring it again restates something already true at record time. A step with no checkpoint assumes the click worked. |
| 80 | `waitFor` = "the next step's target is present" | A state predicate, never a duration (#5), and derived from observation rather than invented. |
| 81 | Canonicalisation skips values shorter than 3 characters | A param whose value is `1` would rewrite every `1` in every URL and column header. Same reasoning as the Redactor's short-value guard (#13). |
| 82 | `compile()` returns a **discriminated union**; a failed verification yields a *diagnostic*, not a capability | Invariant #4 made unbypassable by the type, not by discipline. The schema already calls an unverified artifact "a diagnostic, not a capability". |
| 83 | Compiled artifacts are always `draft`, never `approved` | Compiling successfully is not being cleared for unattended use. That is earned through review. |
| 84 | The artifact requires only the inputs the flow reads, and is granted only the action classes it used | An input nothing reads is a question asked of every caller forever; a class it never used is standing authority it never needed. |
| 85 | `Surface.settle()` - optional, a question about in-flight network activity | Discovery observes the instant an action returns, and Meridian navigates its content *frame*, so a page-level load state is already satisfied and answers about the wrong document. Replay never noticed because `waitFor` predicates re-observe until they pass. Optional on the port because it is genuinely surface-specific; absence means "cannot tell", never "settled". |
| 86 | Two quick observations agreeing is **not** proof a page settled | Both samples land before the navigation starts, agree, and declare the old screen current. Kept as a second line of defence behind `settle()`, never as the only one. |
| 87 | Verification replays in a **fresh browser**, not the discovery session | Already signed in, already on the right screen, cookies already set - verifying there proves almost nothing. The capability must work from cold. |
| 88 | A credential is recorded as `$secret.ENV`, never `$input.x` | The model references it without seeing it, and replay reads it from the environment. Otherwise the compiled capability would demand an operator password from whoever invokes it. |
| 89 | Act through the **structural locator**; `aria-ref` is the fallback (reverses #31) | Measured: clicking a submit button via `aria-ref` fires click *and* submit events and performs **no navigation** - zero requests - while a role locator on the same element at the same moment issues the request. It dispatches events without default actions, and resolves unreliably. Replay never noticed because it acts on stale refs and had been falling through to structural all along - it worked by accident. |
| 90 | A click that triggers navigation can throw `TimeoutError` **while succeeding** | Verified: the click timed out and the navigation completed. `#act` converts that into a `SurfaceError`, so a working action is reported as failed. **Open** - see REPORT.md §7. |
| 91 | Clicks are backed by a `requestSubmit()` rescue | Playwright 1.63.0: after an iframe navigates via a form submission, synthesized clicks in it never submit again. Reproduced in 40 lines of static HTML, no project code. `requestSubmit()` is the DOM's faithful "as if the user clicked submit" - it fires the submit event and runs validation, unlike `submit()`. Gated on "nothing navigated" + still-attached submit control, because double-submitting is the one failure that would matter. |
| 92 | `extract` reads its value **before** the executor acts | `act` re-observes, retiring the node, and the surface refuses a node from an earlier observation (#34). Extraction is read-only, so reading first is safe. |
| 93 | Test **files** run one at a time (`fileParallelism: false`) | Four drive a real browser; in parallel they contend and miss timing windows - the E2E test passed 5/5 alone and ~50% alongside the others. ~51s → ~105s, and the suite stops depending on how busy the laptop is. A suite you learn to re-run is one you stop believing. |
| 94 | Oscillation counts only a **change** of state | The structure hash excludes values (#26), so typing leaves it identical; counting that as a revisit ends every form-filling run as a cycle. A live run died after three keystrokes. `prune.ts` already knew this (#72); the loop did not. |
| 95 | A `type` step checkpoints on `value_equals`, and that predicate interpolates | Both other inferences are structural, and typing moves no structure - so the first real run compiled three type steps with no checkpoint at all. Never for a `$secret.` value: the failure detail quotes what it found, and `$secret.` is resolved at action time rather than by predicate interpolation, so the check would compare against literal text. Keys on the **value**, not the sensitivity flag - the operator *id* is `sensitivity: none` and still a `$secret.` ref. |
| 96 | A **GET** submission is rescued by navigating to the URL the browser would have built; POST keeps `requestSubmit()` | `requestSubmit()` goes through the same submission path the Playwright bug (#91) eats - it worked ~2 runs in 3, which is worse than failing honestly. `location.href` worked in every probe. POST has no URL to navigate to, and a frame's *first* submission is unaffected anyway. Both routes check `checkValidity()` first, because both skip it - and that difference is what would let an artifact submit something a person could not. |
| 97 | Demo credentials default from the **seed**, lazily imported | The README promises the thread runs on a clean clone with only `ANTHROPIC_API_KEY`, and replay with none. Read from the one source of truth because this value has already drifted twice (`.env.example`, a doc comment) and both times it surfaced as "cannot sign in". |
| 98 | A missing `$secret` is a typed `artifact_invalid` **before the browser opens** | It used to be an uncaught throw from inside the resolver, six steps in - a stack trace, in the one path whose whole argument is that failures are typed. Scans the entire artifact, since recovery rules and tenant overlays can reference secrets too. |
| 99 | The escalation deadline measures **silence**, not elapsed time | "Abandon N seconds after raising" expires while a human is mid-form, so the run resumes underneath somebody still typing - the exact split-brain the lease exists to prevent. Claiming resets it, and so does every captured action. Nobody comes and it expires on schedule; somebody works and it never does; somebody claims and wanders off and it expires one window later - the case the naive rule turns into a hang. |
| 100 | Capture records **what was touched, never what was typed** | A servicing console is mostly fields whose contents must not reach disk, and the redactor only catches values it was told about - so a capture that recorded values would be a second, unredacted path to disk beside a carefully redacted one. "Typed 8 characters into Password" answers every question an audit asks. A submit button's `value` is exempt: it is a label the page authored, not something a person entered. |
| 101 | Cede **before** publishing, and cede to `none` rather than to the operator | Publishing first leaves a window where the console offers a claimable session automation is still driving, and the operator's first click lands in it. And between the run giving up and a human arriving nobody is driving - saying "operator" would make the audit claim a person controlled a session they had never seen. |
| 102 | A run a human unstuck reports **`escalated` with `outputs`**, not `success` | Same reasoning that keeps `business_outcome` out of `failed`: a run that needed a person is not the same event as one that did not, and a caller who cannot tell them apart will treat them the same. Recovery stays invisible in the status (#10) because that is the machine working within declared bounds; a human taking a customer's session is what the audit exists for. |
| 103 | `metrics.interventions`, on **every** status | A run can need a human and still end as something else - an operator unsticks it, the run carries on, the app gives a perfectly good business answer. Found by the gate: a skipped step produced `business_outcome`, a variant with nowhere to put an escalation record. One number on every outcome beats destructuring five. |
| 104 | Recovery that was **recognised and failed** escalates; recovery that never matched fails | Three situations, not two. Nothing matched means we have never seen this, so there is no remedy to be out of - an unknown failure, and `failed` with expected/observed is honest. A rule that matched and could not fix it means the condition was recognised, the declared remedy was applied, and it did not work; retrying the raw action after that is doing the same thing again more quietly. Collapsing them is how "bounded recovery" quietly becomes "gives up". |
| 105 | The step's **retry budget is spent before** the escalation verdict | A declared remedy being exhausted does not mean the page was not simply slow. Escalating the moment a rule is capped put a person in the loop for `slow_load`, which the step's own retries were about to absorb. Retries first, verdict after. |
| 106 | `navigate` is **exempt** from the blocking-dialog guard | #41 is about hitting the wrong *element*; a navigate has no element and leaves the page entirely, which is what a person does to get out of a modal. Without the exemption the declared abandon path cannot run in the one case it most needs to - stuck behind an unrecognised interstitial - and the run reports an abandon it did not perform. |
| 107 | The in-page script is an **uncompiled string**, never a function | Playwright serialises a function with `toString()`, but tsx compiles this file first and esbuild's `keepNames` leaves a `__name(...)` call that exists only in the module scope it compiled. In the page it is `ReferenceError: __name is not defined`, thrown inside a catch that existed for navigating frames - so every click went unrecorded and nothing said so. An audit trail that fails silently is worse than none: it looks exactly like a person who did nothing. |
| 108 | Listener installation is idempotent **by removal**, not by a flag | A "have I run?" marker must live somewhere that survives exactly as long as the listeners, and in a browser there is no such place. A window flag outlives a replaced document; a document flag is no better, because `document.open()` rewrites a page in the *same* document object and drops every listener while the property survives. Keep the handlers, unregister, register again. |
| 109 | Clicks are recorded on **`pointerdown`** | The interesting clicks in a servicing console are the ones that navigate, and `click` fires with the navigation already committed - the message out of the frame does not survive the teardown. The gate recorded the navigation an operator caused and not the action that caused it. `pointerdown` fires before the default action. Keyboard activation does not emit it, which is what the Enter branch is for. |
| 110 | The lease follows **who holds it**, not the transition going past | A remote console is polled, so an operator who claims and hands back inside one interval is only ever *observed* as resolved. Keying on the `claimed` state meant the lease never recorded that a person held the session at all - in precisely the cross-process case the audit exists for. |
| 111 | Lease history is written **from the lease**, not from the sink's echo | A remote console is told about it over HTTP and echoes it on the next poll, which is after the evidence file is written. Trusting the echo produced an audit file with an empty lease history. |
| 112 | `src/escalation` is **inside** the determinism boundary | Handing control to a human happens *during* a replay, so a model consulted there is a model consulted on the replay path. "Ask a model what the operator probably meant" is exactly the helpful idea this boundary refuses. |
| 113 | Growing the schema **invalidates every shipped artifact's hash**, and that is correct | `integrity.hash` covers the whole artifact, so a new field with a default changes it the moment it is parsed. The check refusing to run is the check working - "this file is not what was signed" is exactly true. The answer is `scripts/resign-artifacts.ts` and a deliberate diff, not a softer hash. The CLI message names both causes, because an edited artifact and a grown schema look identical and only one of them is anybody's fault. |
| 114 | The gate runs the **reference** artifact, not the discovered one | The discovered capability *cannot* produce four of the five outcomes: a model that walked a happy path once has never met "no member record found" or a maintenance notice, so it declares no business outcomes and no recovery rules. The engine handles all five; the discovered artifact knows one path. That gap is real, belongs in the write-up, and is not papered over by picking a friendlier artifact quietly. |
| 115 | The console binds to **loopback**, and claiming is separate from resolving | It is a remote control for a signed-in banking session; listening on 0.0.0.0 buys only convenience. And "resolved" is a claim about what a human did in the browser - a console that could assert it with nobody having held the session can lie to the run about what happened to a customer's account. |
| 116 | The MCP tool's `outputSchema` is a small **envelope** (`{status, outputs?, outcome?}`), not the artifact's raw success-output schema | A capability answers more than one way (success or a declared business outcome), and those are different shapes on purpose (ADR-0004). Advertising the success-only shape made the SDK's own client-side validation reject a legitimate business-outcome response - caught by actually running the demo, not by the in-memory test, which happened to only exercise the success path against that assertion. |
| 117 | `cua mcp` refuses at call time, not just at listing time | `tools/list` already excludes anything not `approved`, but a caller can still name an unlisted capability directly - a demoted artifact, a guess, a stale cached tool name. `tools/call` re-checks approval and re-verifies the hash before running anything, so the guarantee holds even when a client ignores what `tools/list` just told it. |
| 118 | `loadDotEnv` clears **empty** exported env vars before loading `.env`, not just missing ones | Decision #77 says a real env var wins over `.env`, but found live: a sandboxed shell can pre-export a variable name with an empty string, and `process.loadEnvFile`'s own overwrite-avoidance honors that as "already set" - silently shadowing a real key sitting in `.env`, surfacing many steps later as a rejected credential with no clear cause. An empty string is not a value anyone set on purpose. Same lineage as #97/#98: a credential problem should be typed and immediate, not an SDK exception several layers down. |
| 119 | `extract`'s direct `surface.readText()` call is wrapped in the same try/catch every other tool gets for free from `executor.act()` | Found live on the second (public-site) discovery run: `extract` reads before acting on purpose (decision #92 - the executor's own re-observe would retire the node), which means it calls the surface directly instead of through `Executor.act()`'s chokepoint. A stale ref reused across two tool calls in one turn threw a raw `SurfaceError` that escaped the tool runner and crashed the whole discovery process, instead of coming back as the same kind of correctable tool result a stale click or type already gets. Reuses `#explainFailure` for the conversion, so the model sees the identical "observe again and reconsider" guidance it would for any other stale-ref action. |
| 120 | A structural-role node is excluded only when it is **empty** - no name, no text of its own - never by role alone | The most significant bug the saucedemo.com run found. `toUiNodes.ts`'s `STRUCTURAL` set (`generic`, `rowgroup`, `text`, `none`, `presentation`) exists to drop pure layout wrappers, but `generic` is *also* what Playwright's AI-mode snapshot reports for any plain, non-semantic element that carries its own text - which on a real site built without table/cell roles throughout (as opposed to Meridian, purpose-built with them) is an ordinary way to render a label or a value. The old check excluded every `generic` node unconditionally, so saucedemo's entire price breakdown ("Item total: $29.99", "Tax: $2.40", "Total: $32.39") never reached the model at all - not a locator failure, not a model mistake, a perception gap: no amount of exploring finds text that was never shown. Confirmed by diffing the raw Playwright YAML (which has the content) against our own parsed output (which didn't) before touching any code. Fix is additive - 308/311 tests still pass, including every real-browser Meridian test, because Meridian's own semantic roles were never affected by the old blanket exclusion in the first place. This is exactly the kind of gap Section 3.7 (generalization to real, non-purpose-built surfaces) is asking whether a design has a credible answer for - found, not theorized. |
| 121 | `TenantOverlay` also patches a step's **checkpoint and waitFor**, not only its `target` | Found building the M2 `summitcu` skin: the field a re-skin renames is checked in more than one place. The search step's target types into it, but the sign-in step's checkpoint proves sign-in worked by finding it too - a rename invalidates both, and the original overlay (decision #87) could only fix the first. Extending to `checkpoints`/`waitFors` per step id is the same design applied completely, not a new mechanism: still keyed by step id, still additive, still cannot add/remove/reorder steps. |
| 122 | `declare_outcome` takes an optional `ref` (and `expect_text`) directly, resolved into a `detectTarget` the same way every other tool's target is resolved - not a chained `assert` call the compiler steals a locator from | `outcomesFrom()` (`src/discovery/compiler.ts`) has always built its `detect` predicate as `{ kind: 'text_matches', pattern: ... } as unknown as Predicate` - no `locator`, the field the schema requires, forced through with a type-cast. Never caught because no discovered artifact had ever taken the `declare_outcome` path (decision #114) - this is *why*, not a fundamental limitation. The first fix considered was requiring the model to call `assert` immediately before `declare_outcome` and lifting that locator; rejected before being built, because models are unreliable at strict multi-tool sequencing and a run confused by a chaotic screen would call `declare_outcome` bare, silently reverting to the broken path. Putting `ref` on the tool itself removes the ordering requirement entirely. A `ref` that fails to resolve does not fail the tool call - the model is ending the run either way - it is dropped and named in `CompileReport.droppedOutcomes` instead of shipping an undetectable outcome. |
| 123 | `compile()`'s verify stage takes a list of `(armUrl, expectedCode)` scenarios, not one implicit "replay it clean" - and a second discovery run kept for its outcome is never merged into the primary trajectory | A `BusinessOutcome` is artifact-level (`outcomes[]` beside `steps[]`), evaluated on every step regardless of which run produced them (decision #36) - so compiling a second, outcome-only run adds exactly one thing, an entry in `outcomes[]`, never a step-alignment problem. What a bare second `DiscoveryRun` cannot supply is *how to reproduce* the condition that made it end that way: a verifier replaying the assembled artifact against a clean target would never see the refusal, the detector would never fire, and verification would fail for a reason unrelated to whether the outcome is real. `OutcomeScenario.armUrl` is that precondition, supplied as data and navigated on a fresh session before the scenario replay - never guessed from the run. `Verifier` grew an optional second argument for exactly this; the plain success verify is unaffected because the added outcome detectors are dormant on a happy path that never says the matching text. |
| 124 | Discovery refuses an irreversible action by default, same as replay - `--approve-irreversible` (`approvalGranted: true` on the discovery `Executor`) is the explicit, one-session human exception, never a default | Found trying to record `cap.member.open_subaccount`'s happy path: `PolicyEngine.check()` already says, verbatim, "you never let a discovery agent move money" - `requireApprovalLabels` and `maxUnapprovedActionClass` apply during discovery exactly as they apply during replay, and neither `discoverCommand.ts` nor any test ever exercised this because the one capability that existed so far (`read_savings_balance`) is read-only. Without the flag, the model correctly hits `needs_approval` at the commit step, calls `request_human`, and `compile()` - which refuses a `request_human`/`give_up` terminal outright - has nothing to compile. The flag is scoped to exactly one discovery session, watched by whoever passed it; it has zero effect on how the *shipped* artifact behaves at replay time, which stays gated by the same policy regardless. `ReplayOptions.approvalGranted` already existed with no caller ever setting it true (`cua replay` and the MCP server both leave it `false`, correctly) - the compiler's own self-verification of this capability's happy path is the first thing in this codebase to use it, for the same reason: a single, human-supervised proof-run, immediately discarded as evidence, that has to reach the real "done" screen to prove the extract steps work, never reachable by an external caller. |
| 125 | The outcome-scenario discovery run gets its own prompt file, `prompts/discovery-outcome.v1.md` - not the default prompt with an instruction appended at runtime | Decision #58's reasoning extended to a second file: `provenance.promptVersion` has to identify what actually drove a run, and a runtime-appended string would drive the run just as much as the file's own bytes do while leaving nothing in the hash. `prompt.ts` grew a `PromptVariant` parameter (`'default' \| 'outcome'`), cached and hashed per variant; the default variant's bytes, and therefore `promptVersion()`'s existing return value with no argument, are untouched. Live result recording `cap.member.open_subaccount`'s `validation_error_funding_limit` outcome: the model declared the outcome cleanly on **every** attempt that reached the review screen - the anticipated failure mode (an LLM trying to fix the validation error and retry rather than declaring it) never actually occurred. The real failures on the way to a working run were two ordinary engineering bugs, not model behaviour: the operator credentials were available to `taskParams()` for interpolation but never listed in the prompt's declared inputs, so the model correctly reported it had no way to sign in; and the verifier's `inputs` argument included those same credentials, which the compiled artifact's own `inputs` schema correctly rejects as unlisted (`additionalProperties: false`) since a credential is a `$secret.*` reference, never a caller input (decision #88). Worth recording plainly rather than quietly fixing and moving on: the caution about prompt compliance was reasonable to raise, and turned out not to be where the actual risk was. |
| 126 | An extraction target's locator synthesis never keys tier 1 (`role_name`) or tier 4 (`text`) on the node's *own* name or value - only on context around it | Found live compiling `open_subaccount`: the "done" screen's reference number is generated fresh per request, so it verified at tier 1 during discovery (its own text was the node's only accessible name) and then, on a cold verify replay where a *different* fresh value was generated, tier 1 missed entirely. Decision #50's volatile-value discount does not save this case, and is a different problem than it looks like: that decision discounts a *nearby* value used to identify some *other* control (the balance labelling the View link) and rightly still ships it, discounted, because it usually keeps working. Here the volatile text *is* the extraction target itself, which is certain to differ on every future run by construction - extracting it is the entire reason the step exists - and discounting confidence does not stop a doomed strategy from being counted as a quorum witness: tier 4 (`text`, also keyed on the same self-text) missed for the same reason, leaving only 1 of the 2 strategies quorum needed to agree with the tier-3 label-anchored strategy that resolved correctly on its own. Fix: `synthesizeBundle(..., { forExtraction: true })`, set only by `tools.ts`'s `#extract`, skips generating tier 1/4 candidates entirely rather than generating and discounting them; table/label/geometry tiers, which key on context rather than the node's own text, are unaffected. The existing `read_savings_balance` artifact has the identical latent shape (tier 1 and tier 4 both keyed on the balance text, tier 2 the only context-based witness) and was never caught because that capability's test data never actually changes between a discovery run and a replay - this fix does not rewrite that already-shipped artifact, but the next capability compiled against a value that truly varies would have hit the exact same wall. |
| 127 | A value-ceiling check lives inside `PolicyEngine.check()` as one more inline rule, not as a separate `valuePolicy.ts` module - and the field/value pair it judges is supplied as a raw fact by the caller, never pre-computed into a verdict | `denyLabels`, `requireApprovalLabels` and `maxUnapprovedActionClass` are all inline checks in the same function; pulling this one into its own file would be inconsistent with the only precedent in this codebase for a separate policy module (`actionClass.ts`, which exists because `classifyAction` is substantial and reused elsewhere - this check is five lines and reused nowhere). `PolicyRequest.valueRef: { field, value }` mirrors `declaredClass` exactly: the caller (`replay.ts`, the only place that can materialise a step's `$input.*` reference against `params`) states what it observed, and `PolicyEngine` alone decides whether a limit applies and whether it is exceeded - inside the one chokepoint, per invariant #7, not at the call site. Sourced from the caller-supplied input value itself (`Number(params.deposit)`), never from rendered DOM text: unlike a balance the page formats for display, an `$input` field is a plain string a caller supplied for a form control, and the target app itself does the identical `Number(values.deposit)` conversion server-side - this is not the locale-formatted-currency parsing problem it could have been. |
| 128 | The value-ceiling gate (and its integration test) needed two fixes only a real replay of the real capability surfaced: `maxUnapprovedActionClass` defaults to `write_reversible`, and a session left mid-flow by a prior escalation must be signed out before the next run | The first version of both the test and `scripts/gate-value-ceiling.ts` used a policy with empty `requireApprovalLabels` and expected a $500 deposit to reach `success` outright - it escalated instead, because `write_irreversible` steps are *already* gated by `maxUnapprovedActionClass`'s default, entirely independent of labels. Demonstrating the ceiling's own effect in isolation needs *both* of the capability's other gates turned off, not just the label list. Separately: the very first attempt escalated on the $500 run for that reason, left the shared browser mid-flow, and the *next* run then failed at an early step because it was still signed in and the artifact's sign-in steps found no form to fill - a `beforeEach`/per-run sign-out fixes it, the same shape of bug as decision #37 (verify postconditions, don't just re-run) one layer up: the fix isn't in the artifact, it's in the harness reusing a session the artifact never expected to still be live. |
| 129 | The `summitcu` overlay is now applied to the real, shipped `open_subaccount` artifact directly (`scripts/add-open-subaccount-summitcu-overlay.ts`), not only to the hand-authored seed the M2 gate has always used | Checked first, and it was false: `read_savings_balance`'s *shipped* artifact carries `tenancy.overlays: {}` - the existing M2 story (`tests/fixtures/seedArtifact.ts`, `scripts/gate-m2.ts`) has only ever demonstrated the overlay mechanism on the hand-authored reference capability, never on a real, model-discovered one. `open_subaccount`'s own sign-in step's checkpoint and its search step (both the search field's target and its `value_equals` checkpoint) all name "Member ID", exactly the pattern decision #121 found and fixed - so the same overlay shape applies verbatim, patched onto the real artifact's real step ids via `CapabilityArtifact.parse()` + `withIntegrity()`, the identical re-signing path `resign-artifacts.ts` uses. `tests/integration/tenantOverlayOpenSubaccount.test.ts` proves the same two things the original gate proves (the unmodified capability genuinely degrades; the overlaid one replays end to end with real outputs) against this second capability specifically. |
| 130 | The MCP demo cannot reproduce `open_subaccount`'s chaos-gated business outcome, and does not try to - it demonstrates the escalation path instead | `tools/call` launches a fresh, cookie-less browser per invocation (`src/mcp/server.ts`'s `invokeCapability`), and chaos is armed per session-cookie (decision #21) with no global or default-on mode by design - there is no side channel through which an MCP caller could arm `validation_error` on the session `replay()` is about to create, and inventing one would mean giving a real production capability a hidden test lever. The honest, more valuable demonstration was already sitting in the existing code: `open_subaccount`'s commit step matches `requireApprovalLabels` unconditionally, `invokeCapability` wires no escalation channel into an unattended call, and `toCallToolResult`'s `escalated` branch already returns a clean, typed refusal - "No operator console was reachable from this MCP call" - rather than a hang. A legitimate, in-bounds deposit therefore still cannot complete over MCP, which is a stronger safety point than forcing the funding-limit outcome would have been: it shows the irreversible-action gate holding even for an agent calling a fully approved capability, not just a value check. |
| 131 | The capability catalog is a route on the *existing* operator console (`/catalog`), plus a `cua catalog` CLI companion - not a new server, a new port, or a dashboard framework | A web dashboard was the more obvious way to make what is approved visible at a glance, but that would mean a second surface to keep secure and consistent for something the existing infrastructure already answers. `catalog.ts` is a sibling to `ui.ts`, not an addition to it - deliberately: `ui.ts` is about one live, mutable intervention and polls a JSON API every second; `/catalog` is static metadata about what is approved to run at all, rebuilt fresh per request, with nothing to poll. Both read `loadApprovedCatalog()` (`src/mcp/catalog.ts`) - the identical function `cua mcp`'s `tools/list` already used, so the console, the CLI and the MCP server can never disagree about what is approved. `startOperatorConsole` still binds to loopback only (decision #115's reasoning holds: no reason to widen the bind surface for capability metadata just because it's less sensitive than a live session). |

---

For the deliberate cuts (the screen recording, the stability harness, the golden-fixture test,
and the two open loose ends #57 and #90), see [REPORT.md §7](../REPORT.md#7-cuts) - kept there
rather than duplicated here, since that is the version graded against the brief's own "say what
you cut and why."
