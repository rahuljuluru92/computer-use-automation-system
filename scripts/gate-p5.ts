/**
 * The Phase 5 gate, recorded.
 *
 * Five runs, one for each terminal state the result contract distinguishes,
 * each leaving an evidence directory a reviewer can open:
 *
 *   gate-1-success            the happy path
 *   gate-2-business-outcome   "no such member" - an answer, and it exits 0
 *   gate-3-recovered          a surprise interstitial, dismissed by a declared rule
 *   gate-4-hard-failure       a 500 that bounded retries could not get past
 *   gate-5-escalation         recovery exhausted -> a human -> resume -> finish
 *
 * ## Which artifact this uses, and why it is not the shipped one
 *
 * It runs `tests/fixtures/seedArtifact.ts`, the hand-authored reference
 * capability - not `artifacts/cap.member.read_savings_balance@1.0.0.json`,
 * which is the one the model discovered in Phase 4.
 *
 * That is not a convenience, and it is worth saying plainly: the discovered
 * artifact **cannot** produce four of these five outcomes, because a model that
 * found a happy path once has never seen "no member record found" and has never
 * met a maintenance notice. So it declares no business outcomes and no recovery
 * rules, and against chaos it produces a `wait_timeout` where the reference
 * artifact produces a typed business outcome. The execution engine handles all
 * five; the *discovered capability* only knows about the one path it walked.
 *
 * That gap is real and it belongs in the write-up rather than being papered
 * over here. This script demonstrates the taxonomy; it does not claim discovery
 * produces artifacts that exercise it.
 *
 *   npx tsx scripts/gate-p5.ts
 */

import type { Server } from 'node:http';
import { rmSync } from 'node:fs';
import { createApp } from '../apps/meridian-core/server.ts';
import { OPERATOR } from '../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../src/policy/policyEngine.ts';
import { SecretResolver } from '../src/policy/secrets.ts';
import { EvidenceWriter } from '../src/evidence/writer.ts';
import { buildRedactor } from '../src/core/redact.ts';
import { replay } from '../src/replay/replay.ts';
import { SessionLease } from '../src/exec/lease.ts';
import { InterventionBus } from '../src/escalation/bus.ts';
import { startOperatorConsole } from '../src/escalation/operatorConsole/server.ts';
import { RemoteBus } from '../src/escalation/remote.ts';
import { HumanActionCapture } from '../src/escalation/capture.ts';
import { createHandoff } from '../src/escalation/handoff.ts';
import { seedArtifact } from '../tests/fixtures/seedArtifact.ts';
import type { CapabilityArtifact } from '../src/core/schema.ts';
import type { ReplayResult } from '../src/core/result.ts';

/**
 * The operator is a script, and the evidence says so.
 *
 * Same rule as decision #78, which forbids a scripted planner from writing a
 * model id into an artifact's provenance: a run driven by machinery must not
 * leave a record that reads as if a person was there. A reviewer opening
 * gate-5 should be able to tell at a glance that this was a rehearsal.
 */
const OPERATOR_ID = 'scripted-operator (gate demo)';

async function main(): Promise<void> {
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;

  let server: Server | undefined;
  const base = await new Promise<string>((resolve) => {
    server = createApp().listen(0, () => {
      const a = server!.address();
      resolve(`http://localhost:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });

  const surface = await WebSurface.launch();
  const capture = await HumanActionCapture.attach(surface.page);

  // One console for the whole gate, exactly as an operator would leave running.
  const bus = new InterventionBus({ timeoutMs: 60_000 });
  const consoleServer = await startOperatorConsole({ bus, port: 0 });
  console.log(`operator console at ${consoleServer.url}\n`);

  const results: Array<[string, ReplayResult]> = [];

  try {
    results.push(['gate-1-success', await run({
      label: 'gate-1-success', base, surface,
      inputs: { memberId: '12345' },
      note: 'The happy path: sign in, find the member, open Savings, read the balance.',
    })]);

    results.push(['gate-2-business-outcome', await run({
      label: 'gate-2-business-outcome', base, surface,
      inputs: { memberId: '99999' },
      note: 'The application answers "no member record found". That is the answer the '
          + 'caller asked for, so it is a business outcome and it exits 0 - not a failure.',
    })]);

    results.push(['gate-3-recovered', await run({
      label: 'gate-3-recovered', base, surface, chaos: 'surprise_modal',
      inputs: { memberId: '12345' },
      note: 'A maintenance interstitial the recorded flow never saw. A declared, bounded '
          + 'recovery rule dismisses it and the run carries on: recovery is not a '
          + 'terminal status, so this ends as success with the recovery counted.',
    })]);

    results.push(['gate-4-hard-failure', await run({
      label: 'gate-4-hard-failure', base, surface, chaos: 'http_500',
      inputs: { memberId: '12345' },
      note: 'The application breaks in a way nothing declared covers. Bounded retries '
          + 'are spent and it stops, with expected/observed and a screenshot.',
    })]);

    results.push(['gate-5-escalation', await run({
      label: 'gate-5-escalation', base, surface, chaos: 'surprise_modal',
      inputs: { memberId: '12345' },
      artifact: withABrokenRemedy(),
      operatorConsoleUrl: consoleServer.url,
      capture,
      note: 'The interstitial appears, the declared remedy is applied and fails, and the '
          + 'run stops and asks for a human. The operator takes the session, clears it '
          + 'by hand in the same browser, and hands control back; the run re-observes, '
          + 'resumes, and finishes the task.',
    })]);
  } finally {
    bus.shutdown();
    await consoleServer.close();
    await surface.close();
    await new Promise<void>((done) => server!.close(() => { done(); }));
  }

  console.log('\n' + '='.repeat(72));
  for (const [label, result] of results) {
    const detail = result.status === 'success' ? JSON.stringify(result.outputs)
      : result.status === 'business_outcome' ? result.outcome.code
      : result.status === 'failed' ? result.failure.code
      : result.status === 'escalated' ? `${result.escalation.resolution} by ${result.escalation.claimedBy ?? 'nobody'}`
      : result.policy.rule;
    console.log(
      `${label.padEnd(26)} ${result.status.padEnd(18)} ${detail}\n`
      + `${' '.repeat(26)} steps ${result.metrics.stepsExecuted}  recoveries ${result.metrics.recoveries}`
      + `  interventions ${result.metrics.interventions}  model calls ${result.metrics.llmCalls}`);
  }
  console.log('='.repeat(72));
  console.log('evidence/gate-*/report.html');

  // The claim the whole design rests on, checked across every gate run at once.
  const cheated = results.filter(([, r]) => r.metrics.llmCalls !== 0);
  if (cheated.length > 0) throw new Error(`a model was consulted in: ${cheated.map(([l]) => l).join(', ')}`);
}

interface RunArgs {
  label: string;
  base: string;
  surface: WebSurface;
  inputs: Record<string, unknown>;
  note: string;
  chaos?: string;
  artifact?: CapabilityArtifact;
  operatorConsoleUrl?: string;
  capture?: HumanActionCapture;
}

async function run(a: RunArgs): Promise<ReplayResult> {
  rmSync(`evidence/${a.label}`, { recursive: true, force: true });
  await a.surface.navigate(`${a.base}/_chaos/reset`);
  if (a.chaos) await a.surface.navigate(`${a.base}/_chaos?mode=${a.chaos}`);

  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const artifact = a.artifact ?? seedArtifact();
  const evidence = new EvidenceWriter({
    runId: a.label, redactor,
    meta: {
      gate: a.label,
      demonstrates: a.note,
      artifact: 'tests/fixtures/seedArtifact.ts (hand-authored reference capability)',
      ...(a.chaos ? { chaos: a.chaos } : {}),
      ...(a.operatorConsoleUrl ? { operator: OPERATOR_ID } : {}),
    },
  });
  evidence.event('note', a.note, { gate: a.label });

  const lease = new SessionLease(a.label);
  const escalation = a.operatorConsoleUrl && a.capture
    ? createHandoff({
        bus: new RemoteBus({ url: a.operatorConsoleUrl, pollMs: 150 }),
        lease, evidence, runId: a.label,
        capability: { id: artifact.id, version: artifact.version },
        capture: a.capture,
      })
    : undefined;

  const running = replay({
    artifact, inputs: a.inputs, surface: a.surface,
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [a.base] }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: a.base,
    lease,
    escalation,
  });

  const [result] = await Promise.all([
    running,
    a.operatorConsoleUrl ? playTheOperator(a.operatorConsoleUrl, a.surface) : Promise.resolve(),
  ]);
  console.log(`${a.label}: ${result.status}`);
  return result;
}

/**
 * The operator side of gate 5, driven through the console's own HTTP API.
 *
 * It clicks through Playwright rather than through the executor, because the
 * entire question an escalation asks is what happens when somebody acts outside
 * the chokepoint.
 */
async function playTheOperator(consoleUrl: string, surface: WebSurface): Promise<void> {
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${consoleUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const id = await until(async () => {
    const res = await fetch(`${consoleUrl}/api/interventions`);
    const { interventions } = await res.json() as { interventions: Array<{ id: string; state: string }> };
    return interventions.find((r) => r.state === 'pending')?.id;
  });

  await post(`/api/interventions/${id}/claim`, { operatorId: OPERATOR_ID });

  for (const frame of surface.page.frames()) {
    try {
      const button = frame.getByRole('button', { name: 'Acknowledge' });
      if (await button.count() > 0) { await button.first().click({ timeout: 4_000 }); break; }
    } catch { /* a frame that moved under us */ }
  }

  await post(`/api/interventions/${id}/resolve`, {
    resolution: 'resolved',
    note: 'Acknowledged the maintenance notice by hand and handed the session back.',
  });
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the intervention never appeared on the console');
}

/** The reference artifact with its interstitial remedy pointed at a button that does not exist. */
function withABrokenRemedy(): CapabilityArtifact {
  const artifact = structuredClone(seedArtifact()) as CapabilityArtifact;
  const rule = artifact.recovery.find((r) => r.id === 'dismiss-maintenance-notice');
  if (!rule?.do[0]?.target) throw new Error('fixture drifted: no dismiss rule to sabotage');
  rule.do[0].target.strategies = [{
    tier: 1,
    strategy: { kind: 'role_name', role: 'button', name: 'Dismiss', exact: true },
    confidence: 0.9,
    rationale: 'Deliberately wrong, so the declared remedy fails and the run must ask a human.',
  }];
  rule.maxAttempts = 1;
  return artifact;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
