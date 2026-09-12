/**
 * The Phase 3 gate: a saved artifact replays end to end against the real app,
 * with no model anywhere, and the four possible answers stay distinct.
 *
 * This runs before the discovery loop exists on purpose. Proving the execution
 * path works on a hand-authored artifact means that when discovery starts
 * producing artifacts, any failure is in the compiler and not in replay.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR } from '../../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../../src/policy/policyEngine.ts';
import { SecretResolver } from '../../src/policy/secrets.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { buildRedactor } from '../../src/core/redact.ts';
import { replay } from '../../src/replay/replay.ts';
import { seedArtifact } from '../fixtures/seedArtifact.ts';
import { newRunId } from '../../src/core/ids.ts';

const EVIDENCE_ROOT = 'evidence/_test';

let server: Server;
let base: string;
let surface: WebSurface;

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
}, 60_000);

afterAll(async () => {
  await surface?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await surface.navigate(`${base}/_chaos/reset`);
});

async function run(inputs: Record<string, unknown>, opts: { chaos?: string } = {}) {
  if (opts.chaos) await surface.navigate(`${base}/_chaos?mode=${opts.chaos}`);
  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({ runId: newRunId('replay'), root: EVIDENCE_ROOT, redactor });
  const result = await replay({
    artifact: seedArtifact(),
    inputs,
    surface,
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: base,
  });
  return { result, evidence };
}

describe('replay: an environment that cannot run the capability', () => {
  it('says so as a typed failure, before the browser opens', async () => {
    // A capability that needs a credential this environment cannot supply is
    // unrunnable. Finding that out six steps in - as an uncaught throw from
    // inside the secret resolver, which is what used to happen - turns a
    // configuration mistake into a stack trace.
    const redactor = buildRedactor({ secrets: {} });
    const evidence = new EvidenceWriter({
      runId: newRunId('replay'), root: EVIDENCE_ROOT, redactor,
    });
    const result = await replay({
      artifact: seedArtifact(),
      inputs: { memberId: '12345' },
      surface,
      policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
      evidence,
      baseUrl: base,
      // no `secrets` resolver at all
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('artifact_invalid');
    expect(result.failure.message).toMatch(/MERIDIAN_PASSWORD/);
    // Nothing was executed - it refused before touching the application.
    expect(result.metrics.stepsExecuted).toBe(0);
    expect(result.metrics.llmCalls).toBe(0);
  });
});

describe('replay: success', () => {
  it('reads the savings balance and returns typed outputs', async () => {
    const { result } = await run({ memberId: '12345' });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.outputs.savingsBalance).toBe(4210.55);
      expect(result.outputs.accountNumber).toBe('0001-4477');
    }
  }, 60_000);

  it('never consults a model', async () => {
    const { result } = await run({ memberId: '67890' });
    // The runtime half of the claim that eslint enforces statically.
    expect(result.metrics.llmCalls).toBe(0);
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.outputs.savingsBalance).toBe(927.40);
  }, 60_000);

  it('resolves every locator at its preferred tier on an unchanged surface', async () => {
    const { result } = await run({ memberId: '12345' });
    expect(result.metrics.degradedResolutions).toBe(0);
    expect(result.drift).toEqual([]);
  }, 60_000);
});

describe('replay: business outcomes are answers, not failures', () => {
  it('reports no_such_member without failing', async () => {
    const { result } = await run({ memberId: '99999' });
    expect(result.status).toBe('business_outcome');
    if (result.status === 'business_outcome') {
      expect(result.outcome.code).toBe('no_such_member');
      expect(result.outcome.data.memberId).toBe('99999');
    }
  }, 60_000);

  it('distinguishes a restricted member from a missing one', async () => {
    const { result } = await run({ memberId: '55555' });
    expect(result.status).toBe('business_outcome');
    if (result.status === 'business_outcome') {
      // Two different answers. A system that models only success and failure
      // has nowhere to put either of them.
      expect(result.outcome.code).toBe('member_restricted');
      expect(result.outcome.severity).toBe('warn');
    }
  }, 60_000);

  it('rejects inputs that do not satisfy the published contract', async () => {
    const { result } = await run({ memberId: 'not-a-member-id' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.failure.code).toBe('artifact_invalid');
  }, 60_000);
});

describe('replay: recoverable conditions', () => {
  it('dismisses an interstitial it has never seen and carries on', async () => {
    const { result } = await run({ memberId: '12345' }, { chaos: 'surprise_modal' });
    expect(result.status).toBe('success');
    expect(result.metrics.recoveries).toBeGreaterThan(0);
    const recovered = result.steps.filter((s) => s.status === 'recovered');
    expect(recovered.length).toBeGreaterThan(0);
  }, 60_000);

  it('signs in again when the session expires part-way through', async () => {
    const { result } = await run({ memberId: '12345' }, { chaos: 'session_timeout' });
    expect(result.status).toBe('success');
    const reauth = result.steps.flatMap((s) => s.recoveries)
      .filter((r) => r.ruleId === 'reauth-after-session-expiry');
    expect(reauth.length).toBeGreaterThan(0);
    // Bounded: once. A reauth loop against a dead session locks the account.
    expect(reauth.length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('outwaits a slow page without a sleep anywhere', async () => {
    const { result } = await run({ memberId: '12345' }, { chaos: 'slow_load' });
    expect(result.status).toBe('success');
  }, 90_000);
});

describe('replay: hard failures are debuggable', () => {
  it('reports what it expected and what it saw', async () => {
    const { result } = await run({ memberId: '12345' }, { chaos: 'http_500' });
    // Either it recovered within budget or it failed - both are acceptable;
    // what is not acceptable is failing without saying why.
    if (result.status === 'failed') {
      expect(result.failure.expected).toBeTruthy();
      expect(result.failure.observed).toBeTruthy();
      expect(result.failure.stepId).toBeTruthy();
    } else {
      expect(result.status).toBe('success');
    }
  }, 90_000);
});

describe('evidence', () => {
  it('writes a structured log carrying both data and an explanation', async () => {
    const { result, evidence } = await run({ memberId: '12345' });
    const lines = readFileSync(join(evidence.dir, 'run.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(10);
    // "what the agent did AND why" - both halves, on every event.
    expect(lines.every((e) => typeof e.message === 'string' && (e.message as string).length > 0)).toBe(true);
    expect(lines.some((e) => e.kind === 'locator.resolve')).toBe(true);
    expect(lines.some((e) => e.kind === 'policy.check')).toBe(true);
    expect(lines.some((e) => e.kind === 'checkpoint')).toBe(true);
    expect(result.status).toBe('success');
  }, 60_000);

  it('captures per-step screenshots as proof the run happened', async () => {
    const { evidence } = await run({ memberId: '12345' });
    const stepsDir = join(evidence.dir, 'steps');
    expect(existsSync(stepsDir)).toBe(true);
    const shots = readdirSync(stepsDir, { recursive: true }) as string[];
    expect(shots.filter((f) => f.endsWith('.png')).length).toBeGreaterThan(3);
  }, 60_000);

  it('writes a manifest that says what was redacted, not just that redaction ran', async () => {
    const { evidence } = await run({ memberId: '12345' });
    const manifest = JSON.parse(readFileSync(join(evidence.dir, 'manifest.json'), 'utf8'));
    expect(manifest.redaction).toBeDefined();
    // "nothing was redacted" and "redaction never ran" must not look identical.
    expect(manifest.redaction.registeredValues).toBeGreaterThan(0);
  }, 60_000);
});

// The canary-value safety tests (operator password, SSN, card number never
// reaching disk) live in tests/safety/redaction.test.ts, not here.
