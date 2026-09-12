# ADR-0002: Perception via accessibility snapshot, not raw CDP

**Status:** Accepted

## Context

"Computer use" needs some representation of the screen to hand a model, and
some way to act on what it points at. The first draft of this design used raw
Chrome DevTools Protocol: `Accessibility.getFullAXTree` for perception,
cross-referenced against `DOM.getDocument` to recover DOM handles for action,
with frame-local coordinates converted into page coordinates by hand for
anything inside an iframe.

That cross-reference is genuinely hard, and Meridian Core (the target app,
ADR-0001's environment) is built specifically around a content iframe with
chrome at the top level (decision #17) - so the coordinate math was not an
edge case, it was the main case.

## Decision

Perception is Playwright's own `ariaSnapshot({ mode: 'ai', boxes: true, depth
})`, and action is `frameLocator(...).getByRole(...)` chains. `mode: 'ai'`
descends into iframes itself and reports boxes already in page coordinates -
which eliminates the AX-nodeId to DOM-backendNodeId cross-referencing and the
frame-local-to-page coordinate conversion entirely, rather than debugging it.
Verified against the installed Playwright types before committing to it, not
assumed from prior familiarity with the CDP approach.

A second property fell out of this choice rather than being designed for
separately: there is no `aria-ref` locator syntax a human (or a model) can
hand-write against this representation, which is the mechanism behind
ADR-0001 - discovery is forced through the same synthesized locator bundle
that replay uses, because there is no other path available.

The snapshot is parsed as YAML plus a descriptor regex (decision #23), not a
hand-rolled indentation walker - Playwright's output is valid YAML, and
counting whitespace in someone else's generated format breaks on their next
release. Childless nodes arrive as bare YAML strings rather than mappings
(decision #24), caught by fixtures captured from a real browser
(`scripts/capture-fixtures.mjs`) rather than assumed from the format's
documentation.

## Consequences

- No raw CDP dependency, and no coordinate math to get wrong across frame
  boundaries - the single largest time-sink identified in the first draft is
  simply not present in the shipped system.
- The representation degrades gracefully toward "what a human operator sees,"
  which is the brief's own fallback for surfaces with no clean DOM (Section
  3.1): an accessibility tree exists for native desktop apps too, so the same
  perception model has a credible extension path (see the Heterogeneity ADR
  in REPORT.md's "Heterogeneity & multi-tenant" section).
- The tradeoff: perception is bound to what Playwright's `ai` snapshot mode
  chooses to expose. Boxes are viewport-relative CSS pixels (decision #6), so
  only the *delta* between two nodes in one snapshot is scroll-invariant -
  Tier 6 (`anchor_offset`) is anchor-relative for exactly this reason.
