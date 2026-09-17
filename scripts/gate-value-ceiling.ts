/**
 * The value-ceiling gate, recorded: a numeric `$input` field over a
 * configured maximum needs a human decision, the same way an irreversible
 * action's label does - proven against the real, shipped
 * `cap.member.open_subaccount` artifact, not a fixture built to make the
 * point.
 *
 * Two runs:
 *
 *   gate-value-ceiling-under   deposit 500, under the 5000 ceiling - success,
 *                              with zero escalation of any kind.
 *   gate-value-ceiling-over    deposit 8000, over it - escalates at s10, the
 *                              step that types the deposit, not several steps
 *                              later at commit.
 *
 * The policy used here raises `maxUnapprovedActionClass` past
 * `write_irreversible` and carries no `requireApprovalLabels`, so the
 * ceiling's own effect is legible on its own - both of those would otherwise
 * gate this capability's commit step regardless of amount. Production
 * `config/policy.yaml` carries all three checks together, deliberately, as
 * defense in depth; this gate isolates one of them to demonstrate that it
 * does what it claims, independent of the others.
 *
 *   npx tsx scripts/gate-value-ceiling.ts
 */

import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../apps/meridian-core/server.ts';
import { OPERATOR } from '../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../src/policy/policyEngine.ts';
import { SecretResolver } from '../src/policy/secrets.ts';
import { EvidenceWriter } from '../src/evidence/writer.ts';
import { buildRedactor } from '../src/core/redact.ts';
import { replay } from '../src/replay/replay.ts';
import type { CapabilityArtifact } from '../src/core/schema.ts';
import type { ReplayResult } from '../src/core/result.ts';

const PORT = 4400;
const ARTIFACT_PATH = 'artifacts/cap.member.open_subaccount@1.0.0.json';

function loadArtifact(): CapabilityArtifact {
  return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as CapabilityArtifact;
}

async function main(): Promise<void> {
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;
  const base = `http://localhost:${PORT}`;

  let server: Server | undefined;
  await new Promise<void>((resolve) => {
    server = createApp().listen(PORT, () => resolve());
  });

  const surface = await WebSurface.launch();
  const results: Array<[string, ReplayResult]> = [];

  try {
    results.push(['gate-value-ceiling-under', await run({
      label: 'gate-value-ceiling-under', base, surface, deposit: '500',
      note: 'Under the ceiling - completes with zero escalation of any kind.',
    })]);

    results.push(['gate-value-ceiling-over', await run({
      label: 'gate-value-ceiling-over', base, surface, deposit: '8000',
      note: 'Over the ceiling - escalates at the deposit step itself, not at commit.',
    })]);
  } finally {
    await surface.close();
    await new Promise<void>((done) => { server!.close(() => done()); });
  }

  console.log('\n' + '='.repeat(72));
  for (const [label, result] of results) {
    const detail = result.status === 'success' ? JSON.stringify(result.outputs)
      : result.status === 'escalated' ? `${result.escalation.reason}: ${result.escalation.detail}`
      : result.status === 'failed' ? result.failure.code
      : result.status;
    console.log(
      `${label.padEnd(28)} ${result.status.padEnd(12)} ${detail}\n`
      + `${' '.repeat(28)} steps ${result.metrics.stepsExecuted}  `
      + `interventions ${result.metrics.interventions}  model calls ${result.metrics.llmCalls}`);
  }
  console.log('='.repeat(72));
  console.log('evidence/gate-value-ceiling-*/report.html');

  const cheated = results.filter(([, r]) => r.metrics.llmCalls !== 0);
  if (cheated.length > 0) {
    console.error(`\nFAIL: ${cheated.map(([l]) => l).join(', ')} called a model during replay.`);
    process.exitCode = 1;
  }
}

async function run(o: {
  label: string; base: string; surface: WebSurface; deposit: string; note: string;
}): Promise<ReplayResult> {
  console.log(`--- ${o.label} ---\n${o.note}`);
  // Signed out first: a run left mid-flow by the previous gate's escalation
  // must not carry into the next one's sign-in steps, which the artifact
  // never recorded happening from an already-authenticated screen.
  await o.surface.navigate(`${o.base}/logout`);

  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({ runId: o.label, redactor, meta: { note: o.note } });
  const result = await replay({
    artifact: loadArtifact(),
    inputs: {
      memberId: '12345', subType: 'Savings', nickname: 'Rainy Day Fund',
      deposit: o.deposit, fundingAccount: '0001-4477',
    },
    surface: o.surface,
    policy: new PolicyEngine({
      ...DEFAULT_POLICY, allowedOrigins: [o.base],
      maxUnapprovedActionClass: 'write_irreversible',
      valueLimits: [{ field: 'deposit', max: 5000 }],
    }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: o.base,
  });
  console.log(`  -> ${result.status}\n`);
  return result;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
