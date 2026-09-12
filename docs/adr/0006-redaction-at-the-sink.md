# ADR-0006: Redaction happens at the sink, never after

**Status:** Accepted

## Context

This system drives real login forms and reads real account data in a
regulated-financial-data context (Section 3.4). "Redact sensitive data before
logging" is easy to state and easy to violate by omission: any new call site
that writes to disk is a new opportunity to forget the redaction step, and a
grep-after-the-fact check only proves a redactor exists, not that it ran on
every byte.

## Decision

Redaction is a property of the writer, not a step call sites remember to
perform. `EvidenceWriter` (`src/evidence/writer.ts`) is the *only* path from
the running system to disk - `event()`, `json()`, and `text()` all pass their
payload through the registered `Redactor` before a single byte is written, so
there is no way to write text that skipped it. `tests/safety/` pushes planted
canary values (a fake password, a fake SSN, a fake card number, all clearly
marked as canaries in `apps/meridian-core/data/seed.ts`) through a full
recorded run and then inspects every file the run produced.

Two decisions follow from where redaction physically happens:

- **Screenshots are the exception that proves the rule** (decision #42).
  Masking happens at *capture* time in `WebSurface.screenshot({ mask })`,
  before the image bytes exist - a PNG cannot be redacted by a text filter
  after the fact, so by the time an image reaches `EvidenceWriter` it is
  already safe, and the writer cannot make it so if it isn't.
- **Registered values are matched longest-first** (decision #13), so a
  registered username that happens to be a substring of a registered password
  does not leave the remainder of the password in the clear. Card-shaped
  digit runs are Luhn-checked before being treated as sensitive (decision
  #14) - a greedy digit regex would also destroy reference numbers and
  timestamps, and destroying evidence is its own failure mode. Values shorter
  than three characters are never registered (decision #13/#81) - masking
  `"1"` would rewrite every `1` in every URL and column header in the report.

The manifest records **what** was redacted, not just that redaction ran
(decision #43) - `{ registeredValues, hits: [{ kind, label, count }] }` -
because "nothing was redacted" and "redaction never ran" must not look
identical to a reviewer.

## Consequences

- A new evidence-writing call site inherits redaction automatically; there is
  no separate checklist item to remember.
- The safety guarantee is falsifiable by test, not merely asserted in
  documentation - `tests/safety/` (canary values from the seed, pushed
  through a full run) is what makes invariant #8 a checked property of the
  system rather than a claim about it.
- The limit: redaction only catches values it was told about, plus the small
  set of shapes it recognizes structurally (SSN-shaped, Luhn-valid card
  numbers, API-key-shaped tokens). A secret the system never resolves - one
  a human typed directly into a form during an escalation handoff, for
  instance - cannot be redacted by value. That is why `HumanActionCapture`
  records *what was touched, never what was typed* (decision #100): a
  servicing console is mostly fields whose contents must never reach disk at
  all, redacted or not.
