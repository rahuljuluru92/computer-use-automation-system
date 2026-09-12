# ADR-0005: Escalation is a lease handoff, not a mutex

**Status:** Accepted

## Context

Section 3.6 asks for more than "notify someone": a human has to take control
of the *same live session* the automation was using, act in it, and hand it
back so the run can resume or finish. That implies a seam most designs
under-build - there must be a way to know, at any instant, whether automation
or a person is driving, and acting on a stale decision made before a handoff
has to be impossible, not just discouraged by a status flag.

A boolean "is a human in control?" flag looks sufficient and is not: it
cannot distinguish "a decision made before the handoff, executing after it"
from "a decision made after." That is a split-brain bug, not a hypothetical
one - two actors can each believe they hold control at once.

## Decision

Control is tracked by a `SessionLease` with a **generation counter**
(`src/exec/lease.ts`), not a mutex (decision #11). A mutex says "busy"; a
generation number lets `Executor.act()` reject any action that was decided
under an earlier generation than the one currently in force - so a plan made
right before a handoff, and executed right after, is refused rather than
raced. The lease follows *who holds it*, not the transition going past
(decision #110): a remote console is polled, so an operator who claims and
hands back inside one polling interval would otherwise never be observed
holding it at all - exactly the cross-process case the audit trail exists to
prove.

The handoff sequence is: raise an intervention with context (which
capability, current step, screenshot, why it stopped) -> cede control -> a
human claims the lease and acts in the *same* browser session -> the human
resolves, aborts, or lets it time out -> control is handed back -> the run
re-observes state and either resumes the step or verifies it already
happened (decision #37: a reauth rule signs in, which is exactly what a
stuck sign-in step wanted - repeating the action blindly would submit twice).
Cede happens *before* publishing the intervention, and to `none` rather than
to the operator (decision #101) - publishing first leaves a window where a
claim would land on a session automation is still driving, and between "the
run gave up" and "a human arrived" nobody is driving, so the audit must not
claim otherwise. The escalation deadline measures *silence*, not elapsed
time (decision #99): every captured human action resets it, so a human
mid-form is never swept out from under themselves by a wall-clock timeout.

The operator console itself is a deliberately minimal, mocked surface per the
brief's own scope note (Section 3.6) - loopback-only, and "resolved" is a
separate, explicit signal from "claimed," because a console that could assert
resolution without a human ever having held the session could lie to the run
about what happened to a customer's account (decision #115).

## Consequences

- A full real-time co-browsing UI was explicitly out of scope (per the
  brief) and is not what was cut to save time - the handoff *mechanism* and
  control-transfer *model* are real; only the operator's own UI is a bare
  console, which is where the brief specifically permitted mocking.
- The lease and the escalation model are useful independent of the console
  chosen - swapping the loopback HTTP console for a real co-browsing tool
  later changes only `src/escalation/remote.ts`, not the generation-counter
  model or `Executor.act()`'s chokepoint.
- Five of the bugs only a real handoff, in a real browser, across a real
  process boundary, ever surfaced (recorded in [DEVELOPMENT.md](../DEVELOPMENT.md)'s P5 section) -
  a mocked lease or a synchronous single-process test harness would not have
  found any of them.
