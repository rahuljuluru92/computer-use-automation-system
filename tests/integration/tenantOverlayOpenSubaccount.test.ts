/**
 * The M2 gate extended to a second, real capability: `cap.member
 * .open_subaccount`'s own `summitcu` overlay (`scripts/add-open-subaccount-
 * summitcu-overlay.ts`, decision #121's design applied a second time), on
 * the actual shipped artifact rather than only the hand-authored reference
 * one `tests/integration/tenantOverlay.test.ts` already covers.
 *
 * Same two things have to be true at once, for the same reason: the
 * unmodified base capability has to genuinely degrade against summitcu, or a
 * passing "with overlay" run alone would not distinguish "the overlay fixed
 * something real" from "nothing needed fixing".
 *
 * Fixed at port 4400, not ephemeral: this artifact's own steps bake in the
 * absolute URL it was discovered against (`s1`'s navigate, and
 * `target.entry.template`), the same reason `valueCeiling.test.ts` runs on
 * this port rather than a random one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR } from '../../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../../src/policy/policyEngine.ts';
import { SecretResolver } from '../../src/policy/secrets.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { buildRedactor } from '../../src/core/redact.ts';
import { replay } from '../../src/replay/replay.ts';
import { newRunId } from '../../src/core/ids.ts';
import type { CapabilityArtifact } from '../../src/core/schema.ts';

const EVIDENCE_ROOT = 'evidence/_test-tenant-overlay-open-subaccount';
const BASE = 'http://localhost:4400';

let server: Server;
let surface: WebSurface;

function loadArtifact(): CapabilityArtifact {
  return JSON.parse(
    readFileSync('artifacts/cap.member.open_subaccount@1.0.0.json', 'utf8'),
  ) as CapabilityArtifact;
}

beforeAll(async () => {
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;
  await new Promise<void>((resolve) => {
    server = createApp().listen(4400, () => resolve());
  });
  surface = await WebSurface.launch();
}, 60_000);

afterAll(async () => {
  await surface?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await surface.navigate(`${BASE}/logout`);
  await surface.navigate(`${BASE}/_tenant?name=summitcu`);
});

async function run(tenant?: string) {
  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({ runId: newRunId('replay'), root: EVIDENCE_ROOT, redactor });
  return replay({
    artifact: loadArtifact(),
    inputs: {
      memberId: '12345', subType: 'Savings', nickname: 'Rainy Day Fund',
      deposit: '500', fundingAccount: '0001-4477',
    },
    surface,
    // Approval granted, matching the compiler's own self-verification
    // (decision #124): the point here is the locator/checkpoint/recovery
    // patch, not re-litigating the irreversible-action gate a third time.
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [BASE] }),
    approvalGranted: true,
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: BASE,
    tenant,
  });
}

describe('tenant overlays, extended to a second capability: open_subaccount under summitcu', () => {
  it('degrades the unmodified capability against the re-skinned tenant', async () => {
    // s4's own checkpoint (the search field, named "Member ID" in the base
    // recording) is what summitcu breaks first - the consent notice sits
    // where the search screen is expected, and nothing declared recognises
    // it because the *base* artifact's recovery rules don't know what
    // "I Agree" means.
    const result = await run();
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.metrics.llmCalls).toBe(0);
  }, 30_000);

  it('replays end to end once the summitcu overlay is applied', async () => {
    const result = await run('summitcu');
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(typeof result.outputs.referenceNumber).toBe('string');
    expect(typeof result.outputs.accountNumber).toBe('string');
    expect(result.metrics.llmCalls).toBe(0);
    // The consent notice was a real obstacle this run had to clear.
    expect(result.metrics.recoveries).toBeGreaterThan(0);
  }, 30_000);

  it('still replays against the canonical tenant with no overlay applied', async () => {
    await surface.navigate(`${BASE}/logout`);
    await surface.navigate(`${BASE}/_tenant?name=meridian`);
    const result = await run();
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.metrics.recoveries).toBe(0);
  }, 30_000);
});
