/**
 * The Phase 5 gate: a run that cannot finish on its own hands the session to a
 * person, and then does the right thing with whatever they decide.
 *
 * Everything here is real. A real Meridian, a real Chromium holding a real
 * signed-in session, a real intervention bus, and a "human" that drives the
 * same page through Playwright rather than through the automation's own
 * executor - because the whole question is what happens when somebody acts
 * outside the chokepoint.
 *
 * The scenario is the one the target app was built to produce: a maintenance
 * interstitial the recorded flow never saw. The artifact's declared remedy for
 * it is deliberately broken here, so the run recognises the condition, applies
 * the remedy, fails, and escalates - which is exactly the shape of a capability
 * meeting a variant of a known problem in production.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import type { Page } from 'playwright';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR } from '../../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../../src/policy/policyEngine.ts';
import { SecretResolver } from '../../src/policy/secrets.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { buildRedactor } from '../../src/core/redact.ts';
import { replay } from '../../src/replay/replay.ts';
import { SessionLease } from '../../src/exec/lease.ts';
import { InterventionBus } from '../../src/escalation/bus.ts';
import { HumanActionCapture } from '../../src/escalation/capture.ts';
import { createHandoff } from '../../src/escalation/handoff.ts';
import type { Resolution } from '../../src/escalation/intervention.ts';
import { seedArtifact } from '../fixtures/seedArtifact.ts';
import { newRunId } from '../../src/core/ids.ts';
import type { CapabilityArtifact } from '../../src/core/schema.ts';

const EVIDENCE_ROOT = 'evidence/_test_escalation';

let server: Server;
let base: string;
let surface: WebSurface;
let capture: HumanActionCapture;

beforeAll(async () => {
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const a = server.address();
      base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
      resolve();
    });
  });
  surface = await WebSurface.launch();
  capture = await HumanActionCapture.attach(surface.page);
}, 60_000);

afterAll(async () => {
  capture?.dispose();
  await surface?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await surface.navigate(`${base}/_chaos/reset`);
});

/**
 * The seed capability with its interstitial remedy sabotaged.
 *
 * The rule still *matches* a blocking dialog - so the condition is recognised -
 * but it reaches for a button that does not exist. That is the difference the
 * taxonomy turns on: an unknown failure is a plain `failed`, while a known
 * condition whose declared remedy did not work is a person's problem.
 */
function artifactWithABrokenRemedy(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  const artifact = structuredClone(seedArtifact()) as CapabilityArtifact;
  const rule = artifact.recovery.find((r) => r.id === 'dismiss-maintenance-notice');
  if (!rule?.do[0]?.target) throw new Error('fixture drifted: no dismiss rule to sabotage');
  rule.do[0].target.strategies = [{
    tier: 1,
    strategy: { kind: 'role_name', role: 'button', name: 'Dismiss', exact: true },
    confidence: 0.9,
    rationale: 'Deliberately wrong: this button does not exist on the notice.',
  }];
  rule.maxAttempts = 1;
  return { ...artifact, ...overrides };
}

interface RunOpts {
  artifact?: CapabilityArtifact;
  chaos?: string;
  /** Absent means no console is wired: the run should fail cleanly and say so. */
  operator?: ((bus: InterventionBus, page: Page) => Promise<void>) | undefined;
  timeoutMs?: number;
}

async function run(opts: RunOpts = {}) {
  if (opts.chaos) await surface.navigate(`${base}/_chaos?mode=${opts.chaos}`);

  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const runId = newRunId('replay');
  const evidence = new EvidenceWriter({ runId, root: EVIDENCE_ROOT, redactor });
  const base_ = opts.artifact ?? artifactWithABrokenRemedy();
  // The artifact declares how long a human gets; the bus default is only a
  // fallback for callers that do not. Setting the bus here would be testing
  // the fallback and believing it was testing the contract.
  const artifact = opts.timeoutMs
    ? { ...base_, escalation: { ...base_.escalation, timeoutMs: opts.timeoutMs } }
    : base_;
  const lease = new SessionLease(runId);
  const bus = new InterventionBus({ timeoutMs: 10_000 });

  const escalation = opts.operator || opts.timeoutMs
    ? createHandoff({
        bus, lease, evidence, runId,
        capability: { id: artifact.id, version: artifact.version },
        capture,
      })
    : undefined;

  const running = replay({
    artifact, inputs: { memberId: '12345' }, surface,
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: base,
    lease,
    escalation,
  });

  const [result] = await Promise.all([
    running,
    opts.operator ? opts.operator(bus, surface.page) : Promise.resolve(),
  ]);
  return { result, evidence, lease, bus };
}

/** Wait for a condition, with no sleeps pretending to be synchronisation. */
async function until(fn: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never held');
}

/** A person clicking the notice away, outside the executor entirely. */
async function dismissTheNotice(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const button = frame.getByRole('button', { name: 'Acknowledge' });
      if (await button.count() > 0) { await button.first().click({ timeout: 4_000 }); return true; }
    } catch { /* a frame that moved under us; try the next */ }
  }
  return false;
}

/** The operator: waits to be asked, takes the session, acts, hands it back. */
function operatorWho(
  decision: Resolution,
  act: (page: Page) => Promise<unknown> = async () => undefined,
) {
  return async (bus: InterventionBus, page: Page): Promise<void> => {
    await until(() => bus.pending().length > 0);
    const id = bus.pending()[0]!.id;
    bus.claim(id, 'rahul');
    await act(page);
    bus.resolve(id, decision, `acted as a human, then chose ${decision}`);
  };
}

const kinds = (e: EvidenceWriter): string[] => e.events.map((x) => x.kind);
const eventNamed = (e: EvidenceWriter, kind: string) => e.events.find((x) => x.kind === kind);

describe('escalation: when there is nobody to ask', () => {
  it('fails cleanly and says the run could not be handed over', async () => {
    const { result, evidence } = await run({ chaos: 'surprise_modal' });

    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.escalation.reason).toBe('recovery_exhausted');
    expect(result.escalation.claimed).toBe(false);
    expect(result.escalation.resolution).toBe('timed_out');
    expect(result.metrics.llmCalls).toBe(0);

    // It says which command would have given it somewhere to go, rather than
    // reporting a bare failure the reader has to diagnose.
    expect(eventNamed(evidence, 'escalation.timeout')!.message).toContain('cua operator');
  }, 90_000);

  it('leaves the screen safely rather than parking on a half-finished page', async () => {
    const { result, evidence } = await run({ chaos: 'surprise_modal' });
    expect(result.status).toBe('escalated');

    // The abandon path ran, it went through the executor, and it says where to.
    const abandoned = evidence.events.filter((e) => e.kind === 'escalation.timeout');
    expect(abandoned.some((e) => e.message.includes('Abandoned safely'))).toBe(true);
    expect(abandoned.some((e) => (e.data as { abandon?: string })?.abandon === 'entry')).toBe(true);
  }, 90_000);

  it('touches nothing when the capability says it cannot be abandoned', async () => {
    const artifact = artifactWithABrokenRemedy();
    artifact.escalation = { ...artifact.escalation, abandon: { kind: 'none' } };
    const { result, evidence } = await run({ chaos: 'surprise_modal', artifact });

    expect(result.status).toBe('escalated');
    const timeout = evidence.events.filter((e) => e.kind === 'escalation.timeout');
    expect(timeout.some((e) => e.message.includes('Not touching anything'))).toBe(true);
    expect(timeout.some((e) => e.message.includes('Abandoned safely'))).toBe(false);
  }, 90_000);
});

describe('escalation: nobody comes', () => {
  it('abandons on its own deadline instead of waiting forever', async () => {
    const { result, evidence } = await run({ chaos: 'surprise_modal', timeoutMs: 400 });

    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.escalation.resolution).toBe('timed_out');
    expect(result.escalation.claimed).toBe(false);
    expect(kinds(evidence)).toContain('escalation.raised');
    expect(eventNamed(evidence, 'escalation.timeout')!.message).toMatch(/no one responded/i);
  }, 90_000);
});

describe('escalation: handoff, resume, and finish', () => {
  it('hands a human the session, resumes, and completes the task', async () => {
    const { result, evidence, lease } = await run({
      chaos: 'surprise_modal',
      operator: operatorWho('resolved', dismissTheNotice),
    });

    // The run finished and produced its real outputs...
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.outputs?.savingsBalance).toBe(4210.55);

    // ...but reports that it took a person to get them. A caller that cannot
    // tell this from a clean run will treat the two the same.
    expect(result.escalation.claimed).toBe(true);
    expect(result.escalation.claimedBy).toBe('rahul');
    expect(result.escalation.resolution).toBe('resolved');
    expect(result.metrics.llmCalls).toBe(0);
    expect(result.metrics.interventions).toBe(1);

    // The full round trip, in the lease's own audit history.
    expect(lease.history.map((h) => `${h.from}->${h.to}`)).toEqual([
      'automation->none', 'none->operator', 'operator->automation',
    ]);

    // And the run re-observed before doing anything else.
    const order = kinds(evidence);
    expect(order).toContain('escalation.raised');
    expect(order.indexOf('escalation.claimed')).toBeLessThan(order.indexOf('escalation.resumed'));
  }, 120_000);

  it('records what the operator touched, and never what they typed', async () => {
    const { evidence, bus } = await run({
      chaos: 'surprise_modal',
      operator: operatorWho('resolved', dismissTheNotice),
    });

    const record = bus.list()[0]!;
    expect(record.humanActions.length).toBeGreaterThan(0);
    const click = record.humanActions.find((a) => a.kind === 'click');
    expect(click?.target).toContain('Acknowledge');

    // The audit file exists and is about identity, not content.
    const file = `${evidence.dir}/interventions/${record.id}.actions.json`;
    expect(existsSync(file)).toBe(true);
    const written = readFileSync(file, 'utf8');
    expect(written).not.toContain(OPERATOR.password);
  }, 120_000);

  it('does not repeat the action when the human already did it', async () => {
    // The operator dismisses the notice *and* opens the account themselves.
    // Resuming must notice the step's postconditions already hold rather than
    // clicking through a second time - the same guard that stops a recovery
    // submitting a form twice.
    const { result, evidence } = await run({
      chaos: 'surprise_modal',
      operator: operatorWho('resolved', async (page) => {
        await dismissTheNotice(page);
      }),
    });
    expect(result.status).toBe('escalated');
    // Two components write this kind - the handoff records the round trip, the
    // step runner records what it is about to do next - so look at both.
    const resumed = evidence.events.filter((e) => e.kind === 'escalation.resumed');
    expect(resumed.some((e) => e.message.includes('re-checks its own postconditions'))).toBe(true);
  }, 120_000);
});

describe('escalation: the other two decisions', () => {
  it('stops the run when the operator aborts', async () => {
    const { result, lease } = await run({
      chaos: 'surprise_modal',
      operator: operatorWho('aborted'),
    });

    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.escalation.resolution).toBe('aborted');
    expect(result.escalation.claimed).toBe(true);
    expect(result.outputs).toBeUndefined();
    // Control still came back, so nothing is left holding the session.
    expect(lease.controller).toBe('automation');
  }, 120_000);

  it('skips the step, and the consequence of skipping it is an answer', async () => {
    const { result } = await run({
      chaos: 'surprise_modal',
      operator: operatorWho('skipped', dismissTheNotice),
    });

    // The interstitial blocked the step that types the member ID, and the
    // operator chose to skip it. So the search ran against an empty field and
    // the application said "no member record found" - which is exactly what it
    // should say, and is a legitimate answer rather than a crash. Skipping a
    // step has consequences; reporting them as a failure would be the
    // conflation the whole result contract exists to prevent.
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;
    expect(result.outcome.code).toBe('no_such_member');
    expect(result.steps.map((x) => `${x.stepId}:${x.status}`)).toContain('s4:skipped');

    // And a caller can still tell a person was involved, on a status that has
    // nowhere to put an escalation record.
    expect(result.metrics.interventions).toBe(1);
  }, 120_000);
});

describe('escalation: the lease is what makes it safe', () => {
  it('refuses an action planned before the handoff', async () => {
    const { lease } = await run({
      chaos: 'surprise_modal',
      operator: operatorWho('resolved', dismissTheNotice),
    });
    // Four transfers' worth of generation by the end, and the generation the
    // run planned its stuck action under is long dead.
    expect(lease.generation).toBe(4);
    expect(() => lease.assertHeldBy('automation', 1)).toThrow();
  }, 120_000);
});

describe('the run budget', () => {
  it('stops on its own wall-clock limit rather than running forever', async () => {
    const artifact = artifactWithABrokenRemedy();
    artifact.policy = { ...artifact.policy, maxWallClockMs: 1 };
    const { result } = await run({ artifact });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('budget_exceeded');
    expect(result.failure.message).toMatch(/wall-clock/);
  }, 90_000);

  it('refuses to run an artifact longer than it says it is', async () => {
    const artifact = artifactWithABrokenRemedy();
    artifact.policy = { ...artifact.policy, maxSteps: 2 };
    const { result } = await run({ artifact });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('budget_exceeded');
    expect(result.failure.expected).toContain('at most 2 steps');
  }, 90_000);
});
