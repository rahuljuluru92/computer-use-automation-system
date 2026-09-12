/**
 * The M2 gate, as a test: a real browser against a second, re-skinned tenant
 * of Meridian Core (`summitcu`), proving Section 3.7's generalization claim
 * live rather than only in the write-up.
 *
 * Two things have to be true at once for the overlay story to mean anything:
 *
 *  1. The base capability, run unmodified against the re-skinned tenant,
 *     genuinely degrades - it is not that summitcu happens to work anyway.
 *  2. The same capability, with the summitcu overlay applied, replays end to
 *     end with the identical typed output the canonical tenant returns.
 *
 * Both are asserted here rather than just one, because a passing "with
 * overlay" test alone would not distinguish "the overlay fixed something
 * real" from "nothing needed fixing in the first place".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { rmSync } from 'node:fs';
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

const EVIDENCE_ROOT = 'evidence/_test-tenant-overlay';

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
  // Fresh, unconsented summitcu session for every test - arming the tenant
  // also clears `consented`, the same way arming a chaos mode clears `fired`.
  await surface.navigate(`${base}/_tenant?name=summitcu`);
});

async function run(tenant?: string) {
  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({ runId: newRunId('replay'), root: EVIDENCE_ROOT, redactor });
  const result = await replay({
    artifact: seedArtifact(),
    inputs: { memberId: '12345' },
    surface,
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: base,
    tenant,
  });
  return result;
}

describe('tenant overlays: a second, re-skinned tenant of the same app', () => {
  it('degrades the unmodified base capability against the re-skinned tenant', async () => {
    // No `tenant` option: the base artifact runs as if summitcu were the
    // canonical Meridian. It cannot be, because summitcu shows a consent
    // notice sign-in never produced before, and the base recovery rules
    // (maintenance dialog, reauth) do not know what "I Agree" means.
    //
    // What actually fails is worth naming precisely, because it is not a
    // clean timeout. The sign-in click's own `waitFor` (the Member Search
    // panel) never appears - the consent notice is in its place - and
    // nothing declared recognises that, so the step retries. A retry
    // blindly repeats the step's action, which is a second click on a Sign
    // In button that no longer exists once you are past sign-in: the
    // control itself fails to resolve. That is `locator_unresolved`, not
    // `wait_timeout` - found by running this, not by predicting it.
    const result = await run();
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('locator_unresolved');
    expect(result.failure.stepId).toBe('s3');
    expect(result.metrics.llmCalls).toBe(0);
  }, 30_000);

  it('replays end to end once the summitcu overlay is applied', async () => {
    const result = await run('summitcu');
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs.savingsBalance).toBe(4210.55);
    expect(result.metrics.llmCalls).toBe(0);
    // The consent notice was a real obstacle this run had to clear, not a
    // no-op - counted the same way any other declared recovery is counted.
    expect(result.metrics.recoveries).toBeGreaterThan(0);
  }, 30_000);

  it('still returns the canonical Member ID output for the default tenant', async () => {
    // Same browser, same server - proof this is a per-tenant overlay and not
    // an accidental change to the base flow's own behaviour.
    await surface.navigate(`${base}/_tenant?name=meridian`);
    const result = await run();
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs.savingsBalance).toBe(4210.55);
    expect(result.metrics.recoveries).toBe(0);
  }, 30_000);
});
