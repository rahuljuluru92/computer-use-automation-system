/**
 * The value-ceiling gate, against a real browser and the real committed
 * `cap.member.open_subaccount` artifact - not a fixture built to make the
 * point, the thing that actually ships.
 *
 * Two things have to be true at once, the same reasoning as the tenant
 * overlay gate: a small deposit has to complete with no escalation at all,
 * or "the ceiling blocks large deposits" would be indistinguishable from
 * "this step always escalates for some other reason" - and it does, twice
 * over, in the shipped production policy: `requireApprovalLabels` matches
 * "confirm and open" unconditionally, and `maxUnapprovedActionClass`
 * defaults to `write_reversible`, which alone gates every write_irreversible
 * step regardless of amount. The policy used here raises the ceiling on the
 * second and omits the first, so the value check's own effect is legible on
 * its own; production `config/policy.yaml` carries all three, deliberately,
 * as defense in depth.
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

const EVIDENCE_ROOT = 'evidence/_test-value-ceiling';

let server: Server;
let base: string;
let surface: WebSurface;

// Fixed at 4400, not ephemeral like the other integration tests' own throwaway
// servers: the shipped artifact records an explicit `navigate` step to the
// absolute URL it was discovered against (`s1`, `http://localhost:4400`),
// same as `target.entry.template` - retargeting one and not the other is
// exactly what broke the first version of this test (`blocked_by_policy` at
// s1, an origin that never made it onto the allowlist). Running the real,
// unmodified artifact means matching the port it actually bakes in.
beforeAll(async () => {
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;
  base = 'http://localhost:4400';
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

function loadArtifact(): CapabilityArtifact {
  return JSON.parse(
    readFileSync('artifacts/cap.member.open_subaccount@1.0.0.json', 'utf8'),
  ) as CapabilityArtifact;
}

// Each run needs to start signed out - a run left mid-flow by the previous
// test's escalation (a discovered bug on the first version of this test)
// otherwise carries into the next one's sign-in steps in a way the artifact
// never recorded.
beforeEach(async () => {
  await surface.navigate(`${base}/logout`);
});

async function run(deposit: string) {
  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({ runId: newRunId('replay'), root: EVIDENCE_ROOT, redactor });
  return replay({
    artifact: loadArtifact(),
    inputs: {
      memberId: '12345', subType: 'Savings', nickname: 'Rainy Day Fund',
      deposit, fundingAccount: '0001-4477',
    },
    surface,
    // Isolates the ceiling: requireApprovalLabels stays empty and
    // maxUnapprovedActionClass is raised past write_irreversible, so a run
    // that reaches "success" did so with zero escalation of any kind, and a
    // run that escalates did so only because of the value check.
    policy: new PolicyEngine({
      ...DEFAULT_POLICY, allowedOrigins: [base],
      maxUnapprovedActionClass: 'write_irreversible',
      valueLimits: [{ field: 'deposit', max: 5000 }],
    }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: base,
  });
}

describe('value ceiling: a real capability, a real over-limit deposit', () => {
  it('completes with no escalation when the deposit is under the ceiling', async () => {
    const result = await run('500');
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.metrics.interventions).toBe(0);
    expect(result.metrics.llmCalls).toBe(0);
    expect(typeof result.outputs.referenceNumber).toBe('string');
  }, 30_000);

  it('escalates specifically because the deposit exceeds the configured ceiling', async () => {
    const result = await run('8000');
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.escalation.reason).toBe('irreversible_action_needs_approval');
    expect(result.escalation.detail).toMatch(/8000/);
    expect(result.escalation.detail).toMatch(/5000/);
    // Raised at the step that typed the deposit, not several steps later at
    // commit - the whole point of checking the value where it is entered.
    expect(result.escalation.raisedAtStepId).toBe('s10');
    // Nobody is at an operator console for this test, so the escalation
    // times out - the point is *that* it escalated, and at the deposit step
    // rather than several steps later.
    expect(result.escalation.resolution).toBe('timed_out');
    expect(result.metrics.llmCalls).toBe(0);
  }, 30_000);
});
