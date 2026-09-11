/**
 * Tenant overlays.
 *
 * Hundreds of institutions run the same vendor product, configured, branded
 * and versioned differently. Re-recording one capability per tenant does not
 * scale and, worse, it means a fix to a flow has to be applied hundreds of
 * times by hand.
 *
 * So a capability is a *base* artifact plus small, declarative per-tenant
 * patches. An overlay may replace the locator bundle for a named step, add
 * recovery rules that only one tenant needs (a consent interstitial, say), and
 * stretch wait budgets for a tenant on slower infrastructure. It may not add,
 * remove or reorder steps - an overlay that can change the shape of a flow is
 * not a variation on that flow, it is a different capability wearing the same
 * name, and it should be reviewed as one.
 *
 * That restriction is the whole design: it keeps "what this capability does"
 * reviewable once, while "how this tenant's screens are laid out" stays local.
 *
 * The drift records the resolver already emits are what tell you an overlay is
 * needed. A base artifact run against a re-skinned tenant degrades on exactly
 * the steps that tenant changed, and says which ones - so writing the overlay
 * is a response to evidence rather than to a support ticket.
 */

import type { CapabilityArtifact } from '../core/schema.ts';

export class UnknownTenantError extends Error {
  constructor(tenant: string, known: string[]) {
    super(
      `no overlay for tenant "${tenant}". Known: ${known.join(', ') || '(none)'}. `
      + `Run without --tenant to use the base capability.`,
    );
    this.name = 'UnknownTenantError';
  }
}

/**
 * Produces the effective artifact for a tenant. Pure: the base is never
 * mutated, so one loaded artifact can serve many tenants concurrently.
 */
export function applyOverlay(base: CapabilityArtifact, tenant: string): CapabilityArtifact {
  const overlay = base.tenancy.overlays[tenant];
  if (!overlay) throw new UnknownTenantError(tenant, Object.keys(base.tenancy.overlays));

  const steps = base.steps.map((step) => {
    const replacement = overlay.targets[step.id];
    const budget = overlay.waitBudgetMultiplier === 1
      ? step.budget
      : { ...step.budget, timeoutMs: Math.round(step.budget.timeoutMs * overlay.waitBudgetMultiplier) };
    return {
      ...step,
      ...(replacement ? { target: replacement } : {}),
      budget,
    };
  });

  return {
    ...base,
    steps,
    // Tenant rules come first: a tenant-specific answer to a condition should
    // win over the generic one.
    recovery: [...overlay.recovery, ...base.recovery],
  };
}

/** Which steps a tenant overrides. Used by the explainer and drift reports. */
export function overriddenSteps(base: CapabilityArtifact, tenant: string): string[] {
  return Object.keys(base.tenancy.overlays[tenant]?.targets ?? {});
}
