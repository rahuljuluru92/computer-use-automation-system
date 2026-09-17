/**
 * Adds a `summitcu` tenant overlay to the real, shipped
 * `cap.member.open_subaccount` artifact - decision #121's design (patch a
 * step's target, checkpoint and waitFor, never add/remove/reorder steps)
 * applied to a second capability, not a new mechanism.
 *
 * Same two re-skin effects as the existing `read_savings_balance` overlay
 * (in `tests/fixtures/seedArtifact.ts`, the hand-authored reference
 * artifact): "Customer Number" replaces "Member ID" on the search field, and
 * a one-time consent notice gates the console after sign-in. This
 * capability's own sign-in step (`s4`) proves it worked by finding the
 * search field present - exactly the checkpoint the rename invalidates,
 * same as decision #121 found - and its search step (`s5`) both types into
 * that field and checks the typed value stuck, so both its target and its
 * `value_equals` checkpoint need the same patch.
 *
 *   npx tsx scripts/add-open-subaccount-summitcu-overlay.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CapabilityArtifact } from '../src/core/schema.ts';
import { withIntegrity } from '../src/core/integrity.ts';

const PATH = 'artifacts/cap.member.open_subaccount@1.0.0.json';
const FRAME = { path: ['contentFrame'] };
const roleName = (role: string, name: string) => ({ kind: 'role_name' as const, role, name, exact: true });

/** The renamed search field itself - two witnesses, same as the base tenant's own target. */
function customerNumberTarget(description: string) {
  return {
    description,
    frame: FRAME,
    strategies: [
      { tier: 1, strategy: roleName('textbox', 'Customer Number'), confidence: 0.9,
        rationale: 'Same field as the base flow\'s Member ID box; this tenant labels it '
                 + 'Customer Number instead.' },
      { tier: 3, strategy: { kind: 'label_anchored' as const, label: 'Customer Number', controlRole: 'textbox' },
        confidence: 0.7, rationale: 'Fallback if the label association is lost.' },
    ],
  };
}

/** "Does the field exist" checks only need one witness, same as the seed's own checkpoint patch. */
function customerNumberPresence(description: string) {
  return {
    description, frame: FRAME,
    strategies: [{ tier: 1, strategy: roleName('textbox', 'Customer Number'), confidence: 0.9,
      rationale: 'Being able to search is the real postcondition of signing in, under whatever '
               + 'name this tenant gives the field.' }],
    minAgreement: 1,
  };
}

const raw = JSON.parse(readFileSync(PATH, 'utf8')) as Record<string, unknown>;
(raw.tenancy as { overlays: Record<string, unknown> }).overlays.summitcu = {
  targets: {
    s5: customerNumberTarget('the Customer Number search field'),
  },
  checkpoints: {
    // s4 proves sign-in worked by finding the search field present.
    s4: [{ kind: 'node_present', locator: customerNumberPresence('the Customer Number search field') }],
    // s5's own checkpoint proved the typed value stuck, against the base
    // tenant's field name - it needs the identical rename.
    s5: [{ kind: 'value_equals', locator: customerNumberTarget('the Customer Number search field'),
      value: '$input.memberId' }],
  },
  waitFors: {
    s4: [{ kind: 'node_present', locator: customerNumberPresence('the Customer Number search field') }],
  },
  recovery: [{
    id: 'accept-summitcu-consent',
    description: 'accept the Summit Credit Union servicing consent notice',
    kind: 'dismiss',
    when: {
      kind: 'node_present',
      locator: {
        description: 'the consent notice', frame: FRAME,
        strategies: [{ tier: 1, strategy: roleName('button', 'I Agree'), confidence: 0.9,
          rationale: 'Summit\'s consent screen offers exactly one way past it.' }],
        minAgreement: 1,
      },
    },
    do: [{
      action: { kind: 'click' },
      target: {
        description: 'the I Agree button', frame: FRAME,
        strategies: [{ tier: 1, strategy: roleName('button', 'I Agree'), confidence: 0.9,
          rationale: 'Same control the when predicate detected.' }],
        minAgreement: 1,
      },
    }],
    maxAttempts: 1,
    thenRetryStep: true,
  }],
  waitBudgetMultiplier: 1,
  notes: 'Summit Credit Union re-brand, the same fix as read_savings_balance (decision #121) applied '
       + 'to a second, real, model-discovered capability: "Customer Number" replaces "Member ID" on '
       + 'the search field and on the sign-in checkpoint that proves it is there, plus the consent-'
       + 'notice recovery rule. Same flow, same steps, same outputs.',
};

const parsed = CapabilityArtifact.parse(raw);
const signed = withIntegrity(parsed);
writeFileSync(PATH, `${JSON.stringify(signed, null, 2)}\n`);
console.log(`summitcu overlay added to ${PATH}`);
console.log(`  hash: ${signed.integrity?.hash}`);
