# Evidence index

Every run below is real: a real browser, a real (local) target app, and — for the one directory
marked as such — a real, unscripted Claude Sonnet 5 call. Nothing here is a transcript written
by hand to look like a run. Open any `report.html` for per-step screenshots and the full event
log; `run.jsonl` is the same data as structured, greppable JSON Lines.

## The one required discovery run

| Directory | What it proves |
|---|---|
| [`20260912T042321Z-discovery-170125b7/`](20260912T042321Z-discovery-170125b7/) | The mandated real LLM-driven run (Section 4: "the discovery run has to be real"). Claude Sonnet 5 drives Meridian Core cold: 9 turns, 11 tool calls, 1121 tokens, 0 hallucinated refs that survived to the artifact. Ends by compiling `artifacts/cap.member.read_savings_balance@1.0.0.json`. |
| [`20260912T042337Z-verify-a1229d0e/`](20260912T042337Z-verify-a1229d0e/) | The compiler's own self-verification of that artifact, in a **cold, second browser session** (decision #87 - already being signed in proves nothing). This is what invariant #4 ("no artifact ships unverified") looks like as a file: the artifact on disk did not exist until this run passed. |

## A second discovery run, against a real public site

Not required by the brief (Section 4 asks for *at least one* real run, and Meridian above already
satisfies it), but included to demonstrate generalization with evidence instead of only argument.
Target: [saucedemo.com](https://www.saucedemo.com), a site Sauce Labs built and publishes
specifically for automation practice (open `robots.txt`; no real payment or PII involved).

| Directory | What it proves |
|---|---|
| [`20260912T153547Z-discovery-67e14020/`](20260912T153547Z-discovery-67e14020/) | A second genuine Claude Sonnet 5 run, cold, against a site never seen during this project's development: log in, add an item to the cart, fill in checkout information, and read the final total off the confirmation page. 17 turns, 12 steps, 1947 tokens. Compiles `artifacts/cap.store.checkout_review@1.0.0.json` — typed output `{ totalPrice: number }`. |
| `20260912T153617Z-verify-*/` | The compiler's cold-browser self-verification of that artifact, same as the Meridian run above. |

This run earned its evidence the hard way, and the four earlier failed attempts (not kept, but
recorded in this session's history) found three real, previously-unknown bugs, each fixed with a
regression test before this run succeeded:

- **A credential-loading bug** (decision #118): an empty, pre-exported `ANTHROPIC_API_KEY` was
  silently shadowing the real key in `.env`, rejected by the live API with no clear cause.
- **A tool-error-handling gap** (decision #119): `extract`'s direct surface read bypassed the
  try/catch every other tool gets from `Executor.act()`, so a stale ref crashed the whole
  discovery process instead of returning a correctable tool result.
- **A real perception-layer gap** (decision #120, the significant one): `generic`-role nodes were
  excluded from the model's view *by role alone*, which is right for pure layout wrappers but
  wrong for the ordinary case of a plain, non-semantic `<div>` that *is* the content. Saucedemo's
  entire price breakdown - the exact value this run needed to read - never reached the model at
  all, on any attempt, regardless of how much turn or time budget it was given. Confirmed by
  diffing Playwright's raw accessibility snapshot (which has the text) against this project's own
  parsed output (which didn't) before touching a line of code. This is precisely the class of gap
  Section 3.7 asks whether a design has a credible answer for on surfaces it wasn't built against
  - found live, not theorized about.

## The five terminal states (`npm run demo`)

One command (`scripts/demo.sh` → `scripts/gate-p5.ts`) reproduces all five, using the
hand-authored reference artifact rather than the one above — see the header comment in
`gate-p5.ts` and [REPORT.md §7](../REPORT.md#7-cuts) for exactly why the discovered artifact
can't produce four of these five outcomes.

| Directory | Status | What it proves |
|---|---|---|
| [`gate-1-success/`](gate-1-success/) | `success` | The happy path: typed outputs (`savingsBalance: 4210.55`), zero model calls. |
| [`gate-2-business-outcome/`](gate-2-business-outcome/) | `business_outcome` | "No member record found" arrives as ordinary page content, HTTP 200 — and is reported as an answer, exit code 0, not a failure. **This is the "one replay that hits an exceptional state" the brief asks for.** |
| [`gate-3-recovered/`](gate-3-recovered/) | `success` | A maintenance interstitial the recorded flow never saw. A declared, bounded recovery rule dismisses it; the run finishes and the recovery is counted, not surfaced as a different status. |
| [`gate-4-hard-failure/`](gate-4-hard-failure/) | `failed` | An injected fault nothing declared covers. Bounded retries are spent; the failure is typed (`locator_unresolved`), with what was expected and what was observed. |
| [`gate-5-escalation/`](gate-5-escalation/) | `escalated` | Recovery is exhausted → the run raises an intervention → a human takes the **same live browser session** → clears it by hand → hands control back → the run re-observes and finishes. The operator is `scripted-operator (gate demo)`, labelled as such on purpose (decision #78's rule extended to escalation) — nothing here should read as a person who wasn't there. |

Every one of the five carries `metrics.llmCalls: 0`; `gate-p5.ts` asserts this across all five
runs at once and throws if it's ever violated, so this claim is enforced by the script that
produces the evidence, not just stated next to it.

## A second tenant skin, generalizing live (`npx tsx scripts/gate-m2.ts`)

Section 3.7 asks whether a design generalizes to more than one instance of the same vendor
product. `summitcu` is a second skin of Meridian Core - different branding, "Customer Number"
in place of "Member ID", and a one-time consent notice the canonical tenant never shows - and
`tenancy.overlays.summitcu` on the reference artifact resolves all three re-skins.

| Directory | Status | What it proves |
|---|---|---|
| [`gate-m2-canonical/`](gate-m2-canonical/) | `success` | The control: the base capability, unmodified, against the canonical Meridian skin. |
| [`gate-m2-summitcu-degraded/`](gate-m2-summitcu-degraded/) | `failed` | The **same** unmodified capability, no `--tenant` flag, against `summitcu`. Genuinely degrades - `locator_unresolved` at the sign-in step, not a clean timeout: its `waitFor` misses the renamed search panel (the consent notice is there instead), nothing declared recognises the notice, the step retries, and the retry blindly re-clicks a Sign In button that is no longer on the page. This is the evidence an overlay responds to, not a contrived failure. |
| [`gate-m2-summitcu-overlaid/`](gate-m2-summitcu-overlaid/) | `success` | The same capability run with `--tenant summitcu`: the renamed field resolves, the renamed sign-in checkpoint resolves, the consent notice is cleared by a declared recovery rule, and the run reaches the identical typed output the canonical tenant returns. |

All three: `metrics.llmCalls: 0`; `gate-m2.ts` asserts the control succeeds, the un-overlaid run
degrades, and the overlaid run succeeds, and throws if any of the three doesn't hold.

## Replay with no model configured at all

| Directory | What it proves |
|---|---|
| [`demo-replay-no-key/`](demo-replay-no-key/) | `npm run replay` succeeding with **no `ANTHROPIC_API_KEY` set in the environment at all**. This is the thesis in one directory: production invocation needs no model, full stop. |

## The MCP stretch demo (`bash scripts/demo-stretch.sh`)

| Directory | Status | What it proves |
|---|---|---|
| `20260912T144522Z-mcp-*/` | `success` | An approved capability invoked by a **real MCP client** over real JSON-RPC (`memberId: 12345`), with `via: "mcp"` in the manifest distinguishing it from a CLI-driven replay. |
| `20260912T144525Z-mcp-*/` | `failed` | The same capability called with a bad member id. Confirms decision #114 live: the **model-discovered** artifact never learned "no such member" exists (it only ever walked the happy path once), so this surfaces as a typed `failed: wait_timeout` — a clean, structured MCP error, not a business outcome and not a thrown exception. Compare against `gate-2-business-outcome/` above, which uses the richer hand-authored reference artifact and does produce a proper business outcome for the same input. |

## Everything here is safe to read

Every byte in every directory above has passed through `Redactor` (`src/core/redact.ts`) before
being written — `tests/safety/redaction.test.ts` proves this with planted canary values (a fake
password, SSN, and card number) rather than asserting it. If you `grep` for the operator
password in `apps/meridian-core/data/seed.ts` across this entire directory, you will find zero
matches.
