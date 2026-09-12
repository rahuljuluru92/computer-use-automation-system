/**
 * The compiler.
 *
 * The verifier is injected, so these tests drive the whole pipeline - prune,
 * canonicalise, infer, assemble, verify - without a browser. What they are
 * really about is invariant #4: the compiler must be unable to hand back a
 * usable capability it has not replayed.
 */

import { describe, it, expect } from 'vitest';
import { compile, type CompileOptions, type Verifier } from '../../src/discovery/compiler.ts';
import type { DiscoveryRun } from '../../src/discovery/loop.ts';
import type { RecordedStep } from '../../src/discovery/tools.ts';
import { verifyIntegrity } from '../../src/core/integrity.ts';
import type { CapabilityArtifact, LocatorBundle } from '../../src/core/schema.ts';
import type { ReplayResult } from '../../src/core/result.ts';

function bundle(name: string): LocatorBundle {
  return {
    description: name,
    frame: { path: ['contentFrame'] },
    strategies: [{
      tier: 1,
      strategy: { kind: 'role_name', role: 'link', name, exact: true },
      confidence: 0.95,
      rationale: 'unique in the recorded snapshot',
    }],
    requireUnique: true,
    minAgreement: 1,
    allowDegraded: true,
  };
}

function step(over: Partial<RecordedStep> = {}): RecordedStep {
  return {
    index: 0,
    intent: 'a step',
    action: { kind: 'click' },
    actionClass: 'read',
    target: bundle('somewhere'),
    extract: [],
    checkpoint: [],
    beforeHash: 'A',
    afterHash: 'B',
    beforeUrl: 'http://localhost:4400/x',
    afterUrl: 'http://localhost:4400/y',
    rejected: [],
    ...over,
  };
}

/** Three steps: search, open the account, read the balance. */
const HAPPY_PATH: RecordedStep[] = [
  step({
    intent: 'go to member search',
    action: { kind: 'navigate', urlTemplate: 'http://localhost:4400/members/12345' },
    beforeHash: 'start', afterHash: 'member',
  }),
  step({
    intent: 'open the savings account',
    target: bundle('View'),
    beforeHash: 'member', afterHash: 'account',
  }),
  step({
    intent: 'read the savings balance',
    action: { kind: 'extract' },
    target: bundle('Current Balance'),
    beforeHash: 'account', afterHash: 'account',
    extract: [{
      name: 'savingsBalance',
      from: bundle('Current Balance'),
      parse: { kind: 'currency', locale: 'en-US' },
      sensitivity: 'none',
    }],
  }),
];

const run = (over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
  steps: HAPPY_PATH,
  terminal: { kind: 'finish', outputs: { savingsBalance: 4210.55 } },
  stop: { kind: 'terminal', terminal: { kind: 'finish', outputs: {} } },
  metrics: {
    turns: 5, toolCalls: 6, llmCalls: 5, inputTokens: 100, outputTokens: 20,
    durationMs: 1000, policyDenials: 0, oscillationWarnings: 0,
  },
  transcript: [],
  ...over,
});

const succeeds: Verifier = async () => ({
  status: 'success',
  runId: 'verify-1',
  capability: { id: 'cap.x', version: '1.0.0', hash: 'h', status: 'draft' },
  startedAt: new Date(0).toISOString(),
  endedAt: new Date(1000).toISOString(),
  durationMs: 1000,
  steps: [], drift: [],
  outputs: { savingsBalance: 4210.55 },
  metrics: { stepsExecuted: 3, retries: 0, recoveries: 0, degradedResolutions: 0, llmCalls: 0, interventions: 0 },
  evidenceDir: 'evidence/verify-1',
} as ReplayResult);

const fails: Verifier = async () => ({
  status: 'failed',
  runId: 'verify-2',
  capability: { id: 'cap.x', version: '1.0.0', hash: 'h', status: 'draft' },
  startedAt: new Date(0).toISOString(),
  endedAt: new Date(1000).toISOString(),
  durationMs: 1000,
  steps: [], drift: [],
  failure: {
    code: 'locator_unresolved', stepId: 's2',
    message: 'could not find the View link',
    expected: 'the View link', observed: 'nothing matched', retryable: false,
    evidence: [],
  },
  metrics: { stepsExecuted: 1, retries: 0, recoveries: 0, degradedResolutions: 0, llmCalls: 0, interventions: 0 },
  evidenceDir: 'evidence/verify-2',
} as ReplayResult);

const options = (over: Partial<CompileOptions> = {}): CompileOptions => ({
  run: run(),
  task: {
    id: 'cap.member.read_savings_balance',
    version: '1.0.0',
    title: 'Read a savings balance',
    description: 'Look up a member and return their current savings balance.',
    inputs: [
      { name: 'memberId', description: 'the member to look up' },
      { name: 'unused', description: 'never referenced' },
    ],
    entryUrlTemplate: 'http://localhost:4400/members/search',
    product: { vendor: 'Meridian', app: 'Core Servicing Console' },
  },
  provenance: {
    model: 'claude-opus-5',
    promptVersion: 'discovery.v1+sha256:abcd1234',
    discoveryRunId: 'disco-1',
  },
  params: { memberId: '12345' },
  verify: succeeds,
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

describe('no artifact ships unverified', () => {
  it('replays what it produced before handing it back', async () => {
    let replayed: CapabilityArtifact | undefined;
    const r = await compile(options({
      verify: async (a) => { replayed = a; return succeeds(a); },
    }));

    expect(r.ok).toBe(true);
    expect(replayed).toBeDefined();
    // What was verified is the artifact, not a sketch of it.
    expect(replayed!.steps).toHaveLength(3);
  });

  it('returns a diagnostic, not a capability, when the replay fails', async () => {
    const r = await compile(options({ verify: fails }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/did not replay/);
    expect(r.reason).toMatch(/locator_unresolved/);
    // The thing it produced is still returned - for debugging - but it is
    // typed differently and carries an unverified stamp.
    expect(r.diagnostic?.provenance.selfVerified.passed).toBe(false);
  });

  it('stamps selfVerified only after the replay passed', async () => {
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.artifact.provenance.selfVerified).toEqual({
      passed: true, at: '2026-01-01T00:00:00.000Z', runId: 'verify-1',
    });
  });

  it('never compiles a run the model abandoned', async () => {
    const r = await compile(options({
      run: run({ terminal: { kind: 'give_up', reason: 'the grid defeated me' } }),
    }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/give_up/);
  });

  it('never compiles a run that ran out of budget mid-flow', async () => {
    const abandoned = run({ stop: { kind: 'max_turns', limit: 40 } });
    delete (abandoned as { terminal?: unknown }).terminal;
    const r = await compile(options({ run: abandoned }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/max_turns/);
  });
});

describe('what the artifact says about itself', () => {
  it('is always a draft, never approved', async () => {
    // Compiling successfully is not the same as being cleared to run
    // unattended. That is earned through review.
    const r = await compile(options());
    expect(r.ok && r.artifact.status).toBe('draft');
  });

  it('records what actually drove the run', async () => {
    const r = await compile(options({
      provenance: {
        model: 'scripted:fixture',
        promptVersion: 'n/a',
        discoveryRunId: 'test',
      },
    }));
    expect(r.ok && r.artifact.provenance.model).toBe('scripted:fixture');
  });

  it('carries an integrity hash that verifies', async () => {
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.integrity?.hash).toBeTruthy();
    expect(verifyIntegrity(r.artifact)).toBe(true);
  });
});

describe('the contract it publishes', () => {
  it('requires only the inputs the flow actually reads', async () => {
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(Object.keys(r.artifact.inputs.properties)).toEqual(['memberId']);
    expect(r.artifact.inputs.required).toEqual(['memberId']);
  });

  it('types a currency output as a number, not as the text on the screen', async () => {
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.artifact.outputs.properties.savingsBalance).toMatchObject({ type: 'number' });
  });

  it('does not grant the flow an action class it never used', async () => {
    const r = await compile(options());
    expect(r.ok && r.artifact.policy.allowedActionClasses).toEqual(['read']);
  });
});

describe('the inferences', () => {
  it('waits on a state predicate, never on a duration', async () => {
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const wait = r.artifact.steps[0]!.waitFor[0]!;
    expect(wait.kind).toBe('node_present');
  });

  it('gives every step a checkpoint, so none of them assume the click worked', async () => {
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const s of r.artifact.steps) expect(s.checkpoint.length).toBeGreaterThan(0);
    expect(r.report.uncheckedSteps).toEqual([]);
  });

  it('prefers what the model asserted over what it can infer', async () => {
    const asserted = {
      kind: 'text_matches' as const, locator: bundle('Account Detail'), pattern: 'Savings',
    };
    const r = await compile(options({
      run: run({
        steps: [
          { ...HAPPY_PATH[0]!, checkpoint: [asserted] },
          ...HAPPY_PATH.slice(1),
        ],
      }),
    }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.steps[0]!.checkpoint).toEqual([asserted]);
  });

  it('proves a typed value landed, since typing moves no structure', async () => {
    // The first real discovery run compiled three type steps with no
    // checkpoint at all - the "assumes the click worked" step the contract
    // warns about. Typing changes no roles, names or nesting, so nothing
    // structural can speak for it; the field holding the value can.
    const withType = run({
      steps: [
        step({
          intent: 'enter the member id',
          action: { kind: 'type', clearFirst: true },
          actionClass: 'write_reversible',
          target: bundle('Member ID'),
          data: { value: '$input.memberId', sensitivity: 'none' },
          beforeHash: 'same', afterHash: 'same',
        }),
        ...HAPPY_PATH.slice(1),
      ],
    });
    const r = await compile(options({ run: withType }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const check = r.artifact.steps[0]!.checkpoint[0]!;
    expect(check.kind).toBe('value_equals');
    if (check.kind !== 'value_equals') return;
    expect(check.value).toBe('$input.memberId');
    expect(r.report.uncheckedSteps).toEqual([]);
  });

  it('never asserts a credential value, only that its field is there', async () => {
    const withSecret = run({
      steps: [
        step({
          intent: 'enter the operator password',
          action: { kind: 'type', clearFirst: true },
          actionClass: 'write_reversible',
          target: bundle('Password'),
          // sensitivity "none" on purpose: the operator *id* is recorded this
          // way, and keying on the flag rather than the value missed it.
          data: { value: '$secret.MERIDIAN_USERNAME', sensitivity: 'none' },
          beforeHash: 'same', afterHash: 'same',
        }),
        ...HAPPY_PATH.slice(1),
      ],
    });
    const r = await compile(options({ run: withSecret }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // A failing value_equals quotes what it found; a password must not end up
    // in evidence that way.
    expect(r.artifact.steps[0]!.checkpoint[0]!.kind).toBe('node_present');
    expect(JSON.stringify(r.artifact.steps[0]!.checkpoint)).not.toContain('value_equals');
  });

  it('does not wait for a transition that never happened', async () => {
    // The third step read a value without moving; there was nothing to wait for.
    const r = await compile(options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.steps[2]!.waitFor).toEqual([]);
  });
});

describe('the compile report', () => {
  it('accounts for the steps the recording had and the artifact kept', async () => {
    const detour = [
      HAPPY_PATH[0]!,
      step({ intent: 'wrong account', beforeHash: 'member', afterHash: 'wrong' }),
      step({ intent: 'back', beforeHash: 'wrong', afterHash: 'member' }),
      ...HAPPY_PATH.slice(1),
    ];
    const r = await compile(options({ run: run({ steps: detour }) }));

    expect(r.report.recordedSteps).toBe(5);
    expect(r.report.compiledSteps).toBe(3);
    expect(r.report.pruned).toHaveLength(2);
  });

  it('lists the literals it turned into references', async () => {
    const r = await compile(options());
    expect(r.report.rewrites.some((w) => w.field === 'action.urlTemplate')).toBe(true);
  });
});
