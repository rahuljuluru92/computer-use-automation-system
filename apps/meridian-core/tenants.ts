/**
 * Tenant skins.
 *
 * Meridian Core is a stand-in for a vendor product that many institutions run
 * under their own branding and copy. `meridian` is the canonical skin every
 * other phase was built and gated against; `summitcu` is a second one, applied
 * to the same server and the same seeded data, to give the locator engine's
 * generalization story (Section 3.7) a live second render to resolve against
 * rather than only a description of one.
 *
 * The skin is chosen once, sticky per session - same reasoning as chaos mode
 * (decision #21): a capability navigates and clicks its way through several
 * pages, and a query parameter would be lost on the first link.
 */

export interface TenantSkin {
  id: string;
  brandName: string;
  productLine: string;
  /** What this tenant calls the field a caller knows as "memberId". */
  memberIdLabel: string;
  /** Whether this tenant requires an extra consent click before servicing tools open. */
  requiresConsent: boolean;
}

export const TENANTS = {
  meridian: {
    id: 'meridian',
    brandName: 'MERIDIAN CORE',
    productLine: 'Servicing Console v7.2.14',
    memberIdLabel: 'Member ID',
    requiresConsent: false,
  },
  summitcu: {
    id: 'summitcu',
    brandName: 'SUMMIT CREDIT UNION',
    productLine: 'Member Portal v3.0.1',
    memberIdLabel: 'Customer Number',
    requiresConsent: true,
  },
} as const satisfies Record<string, TenantSkin>;

export type TenantName = keyof typeof TENANTS;

export const DEFAULT_TENANT: TenantName = 'meridian';

export function isTenantName(v: string): v is TenantName {
  return Object.prototype.hasOwnProperty.call(TENANTS, v);
}
