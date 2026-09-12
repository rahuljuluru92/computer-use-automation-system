/**
 * The seed capability, authored in TypeScript rather than JSON.
 *
 * This is the artifact the replay engine is developed against, before the
 * discovery loop exists to produce one. Writing it as a builder over the Zod
 * types rather than as raw JSON is not a convenience: a valid artifact carries
 * nested predicates, six-tier locator bundles, rationales and embedded JSON
 * Schema, and hand-authoring that in JSON is hours of syntax errors and
 * schema-validation whack-a-mole. Here the compiler catches every mistake
 * before the browser starts.
 *
 * It is also not throwaway. Phase 4's compiler has to produce something that
 * looks exactly like this, so this doubles as the golden target for what a
 * recorded flow should compile into - and as a worked example of the schema
 * for anyone reading the repo.
 *
 * The flow: sign in, look up a member, open their Savings account, read the
 * balance. Chosen because it exercises every hard thing at once - a credential
 * that must never be persisted, an iframe, a grid whose three action links
 * share one accessible name, and a business outcome ("no such member") that
 * arrives as ordinary page content with HTTP 200.
 */

import { CapabilityArtifact, type CapabilityArtifactInput } from '../../src/core/schema.ts';
import { withIntegrity } from '../../src/core/integrity.ts';

/** role + accessible name. The strategy that survives longest. */
const roleName = (role: string, name: string, exact = true) => ({
  kind: 'role_name' as const, role, name, exact,
});

const RECORDED = '2026-09-11T13:00:00.000Z';

export function seedArtifactInput(): CapabilityArtifactInput {
  return {
    schemaVersion: '1.0.0',
    id: 'cap.member.read_savings_balance',
    version: '1.0.0',
    status: 'draft',
    title: "Read a member's current savings balance",
    description:
      'Signs in to the servicing console, looks up a member by their member ID, opens their '
      + 'Savings account and returns the current balance. Returns the business outcome '
      + '"no_such_member" when the member ID does not exist at this institution.',

    target: {
      surface: 'web',
      product: { vendor: 'meridian', app: 'core-servicing', versionRange: '^7.2' },
      entry: { kind: 'url', template: '{baseUrl}/frame/' },
    },

    inputs: {
      type: 'object',
      properties: {
        memberId: {
          type: 'string',
          pattern: '^[0-9]{5}$',
          description: 'The five-digit member number as printed on the member record.',
          'x-sensitivity': 'pii',
        },
      },
      required: ['memberId'],
      additionalProperties: false,
    },

    outputs: {
      type: 'object',
      properties: {
        savingsBalance: { type: 'number', description: 'Current balance in USD.' },
        accountNumber: { type: 'string', description: 'The savings account number.' },
        memberName: { type: 'string', description: 'Name on the member record.' },
      },
      required: ['savingsBalance'],
    },

    // Legitimate answers the caller has to handle. Declared here rather than
    // inferred at run time, because the caller needs to know these exist
    // before they ever happen.
    outcomes: [
      {
        code: 'no_such_member',
        description: 'No member with that ID exists at this institution.',
        severity: 'info',
        terminal: true,
        detect: {
          kind: 'node_present',
          locator: {
            description: 'the "no member record found" notice',
            strategies: [{
              tier: 1,
              strategy: { kind: 'role_name', role: 'alert', nameMatches: 'No member record found' },
              confidence: 0.95,
              rationale:
                'The app renders this as a role=alert with HTTP 200, which is what a real '
                + 'servicing console does. Detecting it by status code would miss it entirely.',
            }],
            minAgreement: 1,
          },
        },
        returns: { memberId: '$input.memberId' },
      },
      {
        code: 'member_restricted',
        description: 'The member exists but this operator may not service the record.',
        severity: 'warn',
        terminal: true,
        detect: {
          kind: 'node_present',
          locator: {
            description: 'the permission denial notice',
            strategies: [{
              tier: 1,
              strategy: { kind: 'role_name', role: 'alert', nameMatches: 'Permission denied' },
              confidence: 0.95,
              rationale:
                'A denial is information the caller needs, not a crash - and it is a different '
                + 'answer from "no such member", which is why it is a separate outcome.',
            }],
            minAgreement: 1,
          },
        },
        returns: { memberId: '$input.memberId' },
      },
    ],

    steps: [
      {
        id: 's1',
        intent: 'Enter the operator ID on the sign-in form',
        action: { kind: 'type', clearFirst: true },
        actionClass: 'write_reversible',
        // Never the literal value: a reference, resolved at run time and
        // registered with the redactor before it can reach a log.
        data: { value: '$secret.MERIDIAN_USERNAME', sensitivity: 'secret' },
        target: {
          description: 'the Operator ID field',
          strategies: [
            { tier: 1, strategy: roleName('textbox', 'Operator ID'), confidence: 0.9,
              rationale: 'The field has a proper <label for>, so its accessible name is the label.' },
            { tier: 3, strategy: { kind: 'label_anchored', label: 'Operator ID', controlRole: 'textbox' },
              confidence: 0.7,
              rationale: 'Survives the label association being lost, which legacy forms often do.' },
          ],
        },
        checkpoint: [],
      },
      {
        id: 's2',
        intent: 'Enter the operator password',
        action: { kind: 'type', clearFirst: true },
        actionClass: 'write_reversible',
        data: { value: '$secret.MERIDIAN_PASSWORD', sensitivity: 'secret' },
        target: {
          description: 'the Password field',
          strategies: [
            { tier: 1, strategy: roleName('textbox', 'Password'), confidence: 0.9,
              rationale: 'Labelled field; the accessible name is stable across renders.' },
            { tier: 3, strategy: { kind: 'label_anchored', label: 'Password', controlRole: 'textbox' },
              confidence: 0.7, rationale: 'Fallback if the label association is lost.' },
          ],
        },
        checkpoint: [],
      },
      {
        id: 's3',
        intent: 'Submit the sign-in form',
        action: { kind: 'click' },
        actionClass: 'write_reversible',
        target: {
          description: 'the Sign In button',
          strategies: [
            { tier: 1, strategy: roleName('button', 'Sign In'), confidence: 0.95,
              rationale: 'Submit buttons carry their visible label as the accessible name.' },
          ],
          minAgreement: 1,
        },
        // What proves it worked: the search screen exists. Not a URL - the app
        // navigates inside a content frame, so the top-level URL does not move.
        waitFor: [{
          kind: 'node_present',
          locator: {
            description: 'the Member Search panel',
            strategies: [{ tier: 1, strategy: roleName('columnheader', 'Member Search'), confidence: 0.9,
              rationale: 'The panel heading is the first thing that proves we are past sign-in.' }],
            minAgreement: 1,
          },
        }],
        checkpoint: [{
          kind: 'node_present',
          locator: {
            description: 'the Member ID search field',
            strategies: [{ tier: 1, strategy: roleName('textbox', 'Member ID'), confidence: 0.9,
              rationale: 'Being able to search is the real postcondition of signing in.' }],
            minAgreement: 1,
          },
        }],
      },
      {
        id: 's4',
        intent: 'Type the member ID into the search field',
        action: { kind: 'type', clearFirst: true },
        actionClass: 'write_reversible',
        data: { value: '$input.memberId', sensitivity: 'pii' },
        target: {
          description: 'the Member ID search field',
          strategies: [
            { tier: 1, strategy: roleName('textbox', 'Member ID'), confidence: 0.9,
              rationale: 'Labelled field on the search panel.' },
            { tier: 3, strategy: { kind: 'label_anchored', label: 'Member ID', controlRole: 'textbox' },
              confidence: 0.7, rationale: 'Fallback if the label association is lost.' },
          ],
        },
        checkpoint: [],
      },
      {
        id: 's5',
        intent: 'Run the member search',
        action: { kind: 'click' },
        actionClass: 'read',
        target: {
          description: 'the Search button',
          strategies: [
            { tier: 1, strategy: roleName('button', 'Search'), confidence: 0.95,
              rationale: 'Visible label; searching commits nothing, so this is a read.' },
          ],
          minAgreement: 1,
        },
        // Either the member opened, or the app told us there is no such member.
        // Both are legitimate; only the first continues the flow.
        waitFor: [{
          kind: 'any',
          of: [
            { kind: 'node_present', locator: {
                description: 'the Accounts grid',
                strategies: [{ tier: 1, strategy: roleName('table', 'Accounts'), confidence: 0.9,
                  rationale: 'The grid only exists once a member record has opened.' }],
                minAgreement: 1 } },
            { kind: 'node_present', locator: {
                description: 'a notice explaining why there is no member record',
                strategies: [{ tier: 1,
                  strategy: { kind: 'role_name', role: 'alert', nameMatches: '(No member record found|Permission denied)' },
                  confidence: 0.9,
                  rationale: 'Waiting only for success would turn a legitimate answer into a timeout.' }],
                minAgreement: 1 } },
          ],
        }],
        onOutcome: ['no_such_member', 'member_restricted'],
        checkpoint: [],
      },
      {
        id: 's6',
        intent: "Open the member's Savings account from the accounts grid",
        action: { kind: 'click' },
        actionClass: 'read',
        target: {
          description: 'the View link on the Savings row of the Accounts grid',
          strategies: [
            // Tier 2 leads here on purpose: all three rows have a link called
            // "View", so role+name cannot tell them apart. The row's data can,
            // which is also how a person finds it.
            { tier: 2,
              strategy: {
                kind: 'table_cell_relative',
                table: { role: 'table', name: 'Accounts' },
                matchColumn: 'Type', matchValue: 'Savings',
                targetColumn: 'Action', within: { role: 'link' },
              },
              confidence: 0.9,
              rationale:
                'Every row has a link named "View", so role+name is ambiguous by construction. '
                + 'The row is identified by the data it holds, which is what a human reads too, '
                + 'and it survives re-skinning and row reordering.' },
            { tier: 5, strategy: { kind: 'css', selector: '#ctl00_ContentPlaceHolder1_grdAccounts_ctl03_lnkView' },
              confidence: 0.05,
              rationale:
                'BRITTLE and recorded for forensics only. This app regenerates control ids on '
                + 'every render, so this selector is already wrong. If it ever matches again, '
                + 'that tells you the markup stopped changing - which is diagnostic information, '
                + 'not a way to find the link.' },
          ],
          minAgreement: 1,
        },
        waitFor: [{
          kind: 'node_present',
          locator: {
            description: 'the Account Detail panel',
            strategies: [{ tier: 1, strategy: roleName('columnheader', 'Account Detail'), confidence: 0.9,
              rationale: 'The panel heading proves the account screen opened.' }],
            minAgreement: 1,
          },
        }],
        checkpoint: [{
          kind: 'text_matches',
          locator: {
            description: 'the Account Type field',
            strategies: [{ tier: 3, strategy: { kind: 'label_anchored', label: 'Account Type', controlRole: 'cell' },
              confidence: 0.8,
              rationale: 'Confirms we opened the Savings account and not a neighbouring row - '
                       + 'the failure this whole step is designed to avoid.' }],
            minAgreement: 1,
          },
          pattern: 'Savings',
        }],
        extract: [
          { name: 'savingsBalance',
            from: {
              description: 'the Current Balance value',
              strategies: [{ tier: 3,
                strategy: { kind: 'label_anchored', label: 'Current Balance', controlRole: 'cell' },
                confidence: 0.85,
                rationale:
                  'The page shows the same figure twice, as Current Balance and as Available '
                  + 'Balance, so matching on the value is genuinely ambiguous. The label beside '
                  + 'it is what distinguishes them, which is how a person reads this screen.' }],
              minAgreement: 1,
            },
            parse: { kind: 'currency', locale: 'en-US' },
          },
          { name: 'accountNumber',
            from: {
              description: 'the Account Number value',
              strategies: [{ tier: 3,
                strategy: { kind: 'label_anchored', label: 'Account Number', controlRole: 'cell' },
                confidence: 0.85, rationale: 'Labelled row on the account detail panel.' }],
              minAgreement: 1,
            },
            parse: { kind: 'text', trim: true },
          },
        ],
      },
    ],

    // Conditions that can interrupt at any step. Each is bounded and counted;
    // none of them loops.
    recovery: [
      {
        id: 'dismiss-maintenance-notice',
        description: 'dismiss a maintenance interstitial the recorded flow never saw',
        kind: 'dismiss',
        when: {
          kind: 'node_present',
          locator: {
            description: 'a blocking dialog',
            strategies: [{ tier: 1, strategy: { kind: 'role_name', role: 'dialog' }, confidence: 0.9,
              rationale: 'Any role=dialog is blocking by definition; the specific one does not matter.' }],
            minAgreement: 1,
          },
        },
        do: [{
          action: { kind: 'click' },
          target: {
            description: 'the Acknowledge button on the dialog',
            strategies: [{ tier: 1, strategy: roleName('button', 'Acknowledge'), confidence: 0.9,
              rationale: 'The dialog offers exactly one way out.' }],
            minAgreement: 1,
          },
        }],
        maxAttempts: 2,
        thenRetryStep: true,
      },
      {
        id: 'reauth-after-session-expiry',
        description: 'sign in again when the session expires part-way through',
        kind: 'reauth',
        when: {
          kind: 'all',
          of: [
            { kind: 'node_present', locator: {
                description: 'the sign-in form, where member data should be',
                strategies: [{ tier: 1, strategy: roleName('textbox', 'Operator ID'), confidence: 0.9,
                  rationale: 'The app renders sign-in inside the content frame on expiry, so the '
                           + 'form appearing mid-flow is the signal.' }],
                minAgreement: 1 } },
          ],
        },
        do: [
          { action: { kind: 'type', clearFirst: true },
            data: { value: '$secret.MERIDIAN_USERNAME', sensitivity: 'secret' },
            target: { description: 'the Operator ID field',
              strategies: [{ tier: 1, strategy: roleName('textbox', 'Operator ID'), confidence: 0.9,
                rationale: 'Same field as the original sign-in step.' }], minAgreement: 1 } },
          { action: { kind: 'type', clearFirst: true },
            data: { value: '$secret.MERIDIAN_PASSWORD', sensitivity: 'secret' },
            target: { description: 'the Password field',
              strategies: [{ tier: 1, strategy: roleName('textbox', 'Password'), confidence: 0.9,
                rationale: 'Same field as the original sign-in step.' }], minAgreement: 1 } },
          { action: { kind: 'click' },
            target: { description: 'the Sign In button',
              strategies: [{ tier: 1, strategy: roleName('button', 'Sign In'), confidence: 0.95,
                rationale: 'Same button as the original sign-in step.' }], minAgreement: 1 } },
        ],
        // Once. A reauth loop against a genuinely dead session is how an
        // automation locks an operator account.
        maxAttempts: 1,
        thenRetryStep: true,
      },
    ],

    policy: {
      maxSteps: 20,
      maxWallClockMs: 60_000,
      allowedActionClasses: ['read', 'write_reversible'],
    },

    // A second tenant skin (Meridian's `summitcu` re-brand) proves the overlay
    // story live rather than only describing it (Section 3.7). Summit renames
    // the field a caller knows as "memberId" to "Customer Number" and adds a
    // consent interstitial no other tenant shows. Both are real re-skins of
    // the same underlying flow, not a different capability: the steps, their
    // order, and what they extract are unchanged.
    tenancy: {
      canonical: true,
      overlays: {
        summitcu: {
          // s4 types into the renamed field.
          targets: {
            s4: {
              description: 'the Customer Number search field',
              strategies: [
                { tier: 1, strategy: roleName('textbox', 'Customer Number'), confidence: 0.9,
                  rationale: 'Same field as the base flow\'s Member ID box; this tenant labels it '
                           + 'Customer Number instead.' },
                { tier: 3, strategy: { kind: 'label_anchored', label: 'Customer Number', controlRole: 'textbox' },
                  confidence: 0.7, rationale: 'Fallback if the label association is lost.' },
              ],
            },
          },
          // s3's own checkpoint (proving sign-in worked by finding the search
          // field) names the field the base tenant sees. A re-skin that
          // renames the field invalidates that checkpoint exactly as much as
          // it invalidates s4's target - so it needs the same kind of patch,
          // not just a locator swap on the step that types into it.
          checkpoints: {
            s3: [{
              kind: 'node_present',
              locator: {
                description: 'the Customer Number search field',
                strategies: [{ tier: 1, strategy: roleName('textbox', 'Customer Number'), confidence: 0.9,
                  rationale: 'Being able to search is the real postcondition of signing in, under '
                           + 'whatever name this tenant gives the field.' }],
                minAgreement: 1,
              },
            }],
          },
          waitFors: {},
          // Summit shows a one-time consent notice right after sign-in, before
          // the search screen the base flow expects. s3's own waitFor (the
          // Member Search panel) fails against it first, which is exactly
          // the signal a declared recovery rule exists to catch.
          recovery: [{
            id: 'accept-summitcu-consent',
            description: 'accept the Summit Credit Union servicing consent notice',
            kind: 'dismiss',
            when: {
              kind: 'node_present',
              locator: {
                description: 'the consent notice',
                strategies: [{ tier: 1, strategy: roleName('button', 'I Agree'), confidence: 0.9,
                  rationale: 'Summit\'s consent screen offers exactly one way past it.' }],
                minAgreement: 1,
              },
            },
            do: [{
              action: { kind: 'click' },
              target: {
                description: 'the I Agree button',
                strategies: [{ tier: 1, strategy: roleName('button', 'I Agree'), confidence: 0.9,
                  rationale: 'Same control the `when` predicate detected.' }],
                minAgreement: 1,
              },
            }],
            maxAttempts: 1,
            thenRetryStep: true,
          }],
          waitBudgetMultiplier: 1,
          notes:
            'Summit Credit Union re-brand: "Customer Number" replaces "Member ID" on the search '
            + 'field, and a one-time consent notice gates the console after sign-in. Same flow, '
            + 'same steps, same outputs - only the locator and one checkpoint the rename touches, '
            + 'plus the recovery rule the consent notice requires.',
        },
      },
    },

    provenance: {
      discoveryRunId: 'hand-authored-seed',
      model: 'none (hand-authored before the discovery loop existed)',
      promptVersion: 'n/a',
      recordedAt: RECORDED,
      compilerVersion: '0.1.0',
      selfVerified: { passed: true, at: RECORDED, runId: 'tests/integration/replay.test.ts' },
    },
  };
}

export function seedArtifact() {
  return withIntegrity(CapabilityArtifact.parse(seedArtifactInput()));
}
