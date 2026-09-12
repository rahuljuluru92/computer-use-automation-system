/**
 * The M2 gate, recorded: a second, re-skinned tenant of Meridian Core
 * (`summitcu`) proves Section 3.7's generalization claim live, not just in
 * the write-up.
 *
 * Same reference artifact as the P5 gate and for the same reason (see
 * gate-p5.ts's own note): the model-discovered artifact never saw a second
 * tenant, so it cannot be the thing whose overlay is being demonstrated.
 * `tests/fixtures/seedArtifact.ts` carries a `summitcu` tenant overlay
 * declaratively - a locator replacement, a checkpoint replacement, and one
 * recovery rule for a consent notice this tenant adds - built the way
 * decision #87's overlay design says overlays should be built: in response
 * to what a re-skinned tenant actually breaks, not to a support ticket.
 *
 * Three runs:
 *
 *   gate-m2-canonical            the base capability, unmodified, against the
 *                                 canonical Meridian skin - the control.
 *   gate-m2-summitcu-degraded     the SAME unmodified capability against the
 *                                 summitcu skin, with no --tenant flag - shows
 *                                 the degradation an overlay exists to fix.
 *   gate-m2-summitcu-overlaid     the capability run with --tenant summitcu -
 *                                 the overlay applied, replaying end to end.
 *
 *   npx tsx scripts/gate-m2.ts
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
import { seedArtifact } from '../tests/fixtures/seedArtifact.ts';
import type { ReplayResult } from '../src/core/result.ts';

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
  const results: Array<[string, ReplayResult]> = [];

  try {
    results.push(['gate-m2-canonical', await run({
      label: 'gate-m2-canonical', base, surface, tenant: 'meridian',
      note: 'The base capability against the canonical Meridian skin - the control this gate '
          + 'compares against.',
    })]);

    results.push(['gate-m2-summitcu-degraded', await run({
      label: 'gate-m2-summitcu-degraded', base, surface, tenant: 'summitcu',
      note: 'The SAME unmodified capability, no --tenant flag, against the summitcu skin. It '
          + 'renames "Member ID" to "Customer Number" and adds a consent notice sign-in never '
          + 'produced before - so this run genuinely degrades. This is the evidence that '
          + 'motivates writing an overlay, not a contrived failure.',
    })]);

    results.push(['gate-m2-summitcu-overlaid', await run({
      label: 'gate-m2-summitcu-overlaid', base, surface, tenant: 'summitcu', applyTenant: true,
      note: 'The same capability with the summitcu overlay applied (--tenant summitcu): the '
          + 'renamed field is resolved, the renamed sign-in checkpoint is resolved, and the '
          + 'consent notice is cleared by a declared recovery rule. Same steps, same output.',
    })]);
  } finally {
    await surface.close();
    await new Promise<void>((done) => server!.close(() => { done(); }));
  }

  console.log('\n' + '='.repeat(72));
  for (const [label, result] of results) {
    const detail = result.status === 'success' ? JSON.stringify(result.outputs)
      : result.status === 'failed' ? `${result.failure.code} at ${result.failure.stepId}`
      : result.status === 'business_outcome' ? result.outcome.code
      : result.status;
    console.log(
      `${label.padEnd(28)} ${result.status.padEnd(18)} ${detail}\n`
      + `${' '.repeat(28)} steps ${result.metrics.stepsExecuted}  recoveries ${result.metrics.recoveries}`
      + `  model calls ${result.metrics.llmCalls}`);
  }
  console.log('='.repeat(72));
  console.log('evidence/gate-m2-*/report.html');

  const cheated = results.filter(([, r]) => r.metrics.llmCalls !== 0);
  if (cheated.length > 0) throw new Error(`a model was consulted in: ${cheated.map(([l]) => l).join(', ')}`);

  const [canonical, degraded, overlaid] = results.map(([, r]) => r);
  if (canonical!.status !== 'success') throw new Error('the control run did not succeed - fixture drifted');
  if (degraded!.status !== 'failed') throw new Error('the un-overlaid run against summitcu did not degrade - the demo proves nothing');
  if (overlaid!.status !== 'success') throw new Error('the overlaid run against summitcu did not succeed');
}

interface RunArgs {
  label: string;
  base: string;
  surface: WebSurface;
  tenant: string;
  /** Whether replay() should apply this tenant's overlay (the `--tenant` flag). */
  applyTenant?: boolean;
  note: string;
}

async function run(a: RunArgs): Promise<ReplayResult> {
  rmSync(`evidence/${a.label}`, { recursive: true, force: true });
  await a.surface.navigate(`${a.base}/_chaos/reset`);
  // Armed through the app's own control route, same as chaos - the run
  // itself stays an ordinary run driven entirely through /frame.
  await a.surface.navigate(`${a.base}/_tenant?name=${a.tenant}`);

  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({
    runId: a.label, redactor,
    meta: {
      gate: a.label,
      demonstrates: a.note,
      artifact: 'tests/fixtures/seedArtifact.ts (hand-authored reference capability)',
      tenantSkin: a.tenant,
      overlayApplied: Boolean(a.applyTenant),
    },
  });
  evidence.event('note', a.note, { gate: a.label });

  const result = await replay({
    artifact: seedArtifact(),
    inputs: { memberId: '12345' },
    surface: a.surface,
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [a.base] }),
    evidence,
    secrets: new SecretResolver(redactor),
    baseUrl: a.base,
    ...(a.applyTenant ? { tenant: a.tenant } : {}),
  });
  console.log(`${a.label}: ${result.status}`);
  return result;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
