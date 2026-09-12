/**
 * Invariant #8: nothing sensitive reaches disk. Every byte written to
 * evidence/ goes through the Redactor (ADR-0006); this pushes real canary
 * values - the operator password, plus `CANARY_SSN`/`CANARY_CARD` from the
 * seed, deliberately shaped so a leak is unambiguous - through a full
 * recorded run and then greps every file that run produced.
 *
 * Its own file, not a describe block inside tests/integration/replay.test.ts,
 * so the layout matches what `.env.example` already promises a reader: "the
 * password is deliberately shaped as a canary so tests/safety/ can prove it
 * never reaches disk."
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR, CANARY_SSN, CANARY_CARD } from '../../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../../src/policy/policyEngine.ts';
import { SecretResolver } from '../../src/policy/secrets.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { buildRedactor } from '../../src/core/redact.ts';
import { replay } from '../../src/replay/replay.ts';
import { seedArtifact } from '../fixtures/seedArtifact.ts';
import { newRunId } from '../../src/core/ids.ts';

const EVIDENCE_ROOT = 'evidence/_test_safety';

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

async function run(inputs: Record<string, unknown>) {
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

function textFilesIn(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => join(dir, f))
    .filter((f) => /\.(json|jsonl|txt|html)$/.test(f));
}

describe('safety: nothing sensitive reaches disk', () => {
  it('keeps the operator password out of every byte of evidence', async () => {
    const { evidence } = await run({ memberId: '12345' });
    const files = textFilesIn(evidence.dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      expect(content, `${f} leaked the operator password`).not.toContain(OPERATOR.password);
    }
  }, 60_000);

  it('keeps regulated member data out of the text evidence', async () => {
    const { evidence } = await run({ memberId: '12345' });
    const files = textFilesIn(evidence.dir);
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      expect(content, `${f} leaked an SSN`).not.toContain(CANARY_SSN);
      expect(content, `${f} leaked a card number`).not.toContain(CANARY_CARD);
    }
  }, 60_000);
});
