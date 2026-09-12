# ADR-0001: The model never writes a selector

**Status:** Accepted

## Context

A discovery run has to tell the system which control it means. The obvious
design lets the model emit a locator directly - a CSS selector, an XPath, a
role/name pair - as an argument to a `click` or `type` tool. That is also the
design that cannot be trusted: a model can hallucinate a selector that happens
to match something, and there is no way to distinguish "this selector is
robust" from "this selector matched once, coincidentally, on this render."

## Decision

Every tool that touches a control takes a `ref` - an opaque handle minted by
the accessibility snapshot the model just observed - never a selector string.
There is no tool parameter anywhere in `src/discovery/tools.ts` that accepts
CSS, XPath, a locator bundle, or coordinates. Refs are stamped with the
observation that produced them (`o3#f2e14`), so a ref from an earlier screen
is rejected by its own name rather than by luck (decision #34: a node captured
on member 12345's page, then a navigate, then a click that *succeeded* on the
identically-named control belonging to a different customer - a silent rescue
that services the wrong person).

The system, not the model, synthesizes a ranked `LocatorBundle` for the node
the ref resolves to, and acts *through that bundle* - never through the ref
directly in the shipped artifact (ADR text continued in decision #89: acting
by ref turned out to be unreliable for a different reason - it fires DOM
events without triggering default browser actions - so the structural bundle
is also what production replay uses to act, with ref as a fallback only).

Because there is no `aria-ref` locator syntax a human could hand-author,
discovery is forced to act through the same synthesized bundle that replay
uses. That is not a constraint we accepted; it is a consequence we designed
for, and it is why invariant #3 holds: every locator bundle in a shipped
artifact was actually executed at record time. A bundle that never worked
could not have clicked anything.

## Consequences

- Selector quality is bounded by the resolver's own strategy tiers
  (`src/surface/locator/strategies.ts`), not by whatever string a model
  happened to produce - so it is auditable and testable independent of any
  particular model.
- The model's job shrinks to "which node" rather than "how do I find this
  node reliably," which is exactly the split between what an LLM is good at
  (semantic judgment about a screen) and what it is unreliable at (predicting
  selector stability months later).
- Errors are legible: a hallucinated ref comes back from the tool listing the
  refs that actually exist (decision #54), so the next turn is a correction,
  not another guess.
