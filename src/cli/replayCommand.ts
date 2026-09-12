/**
 * `cua replay` - the production execution path, from a terminal.
 *
 * Deliberately usable with no ANTHROPIC_API_KEY set. That is not a convenience;
 * it is the demonstration. A capability that still needs a model at invocation
 * time has not actually been captured.
 */

import { readFile } from 'node:fs/promises';
import { CapabilityArtifact } from '../core/schema.ts';
import { verifyIntegrity } from '../core/integrity.ts';
import { EXIT_CODES, type ReplayResult } from '../core/result.ts';
import { WebSurface } from '../surface/web/webSurface.ts';
import { PolicyEngine } from '../policy/policyEngine.ts';
import { loadPolicy } from '../policy/loadPolicy.ts';
import { SecretResolver } from '../policy/secrets.ts';
import { EvidenceWriter } from '../evidence/writer.ts';
import { buildRedactor } from '../core/redact.ts';
import { newRunId } from '../core/ids.ts';
import { replay } from '../replay/replay.ts';

export interface ReplayCommandOptions {
  artifactPath: string;
  inputJson: string;
  tenant?: string | undefined;
  chaos?: string | undefined;
  /** Names the evidence directory instead of using a timestamped run id. */
  label?: string | undefined;
  json: boolean;
}

async function applyDemoCredentialDefaults(): Promise<void> {
  if (process.env.MERIDIAN_USERNAME && process.env.MERIDIAN_PASSWORD) return;
  try {
    const { OPERATOR } = await import('../../apps/meridian-core/data/seed.ts');
    process.env.MERIDIAN_USERNAME ??= OPERATOR.username;
    process.env.MERIDIAN_PASSWORD ??= OPERATOR.password;
  } catch {
    // Not the bundled demo app. The pre-flight check in replay() will report
    // any credential this artifact needs and the environment lacks.
  }
}

export async function runReplayCommand(opts: ReplayCommandOptions): Promise<number> {
  const artifact = CapabilityArtifact.parse(
    JSON.parse(await readFile(opts.artifactPath, 'utf8')) as unknown,
  );
  if (artifact.integrity && !verifyIntegrity(artifact)) {
    console.error(
      `refusing to run: ${opts.artifactPath} has been edited since it was signed.\n`
      + `Its recorded hash no longer matches its content.`,
    );
    return 4;
  }

  const inputs = JSON.parse(opts.inputJson) as Record<string, unknown>;
  const baseUrl = process.env.MERIDIAN_BASE_URL ?? 'http://localhost:4400';

  // The environment wins; the demo target's own credentials fill in, so the
  // README's path runs on a clean clone with no secrets configured at all -
  // which for replay is the whole point, since it must also run with no API
  // key. Read from the seed rather than written out again: this same value has
  // drifted twice already. A real target sets the variables and never reaches
  // the fallback.
  await applyDemoCredentialDefaults();

  const redactor = buildRedactor({
    secrets: {
      MERIDIAN_PASSWORD: process.env.MERIDIAN_PASSWORD,
      MERIDIAN_USERNAME: process.env.MERIDIAN_USERNAME,
    },
  });
  const evidence = new EvidenceWriter({
    runId: opts.label ?? newRunId('replay'),
    redactor,
    meta: { capability: artifact.id, version: artifact.version, tenant: opts.tenant },
  });

  const surface = await WebSurface.launch({ headless: process.env.CUA_HEADED !== '1' });
  try {
    // Chaos is armed through the app's own control route, so the run itself is
    // an ordinary run. Injecting faults through the automation would prove
    // nothing about how it copes with an application that misbehaves.
    if (opts.chaos) {
      await surface.navigate(`${baseUrl}/_chaos?mode=${opts.chaos}`);
      evidence.event('note', `Armed the target's "${opts.chaos}" condition for this run.`,
        { chaos: opts.chaos });
    }

    const result = await replay({
      artifact, inputs, surface,
      policy: new PolicyEngine(loadPolicy()),
      evidence,
      secrets: new SecretResolver(redactor),
      baseUrl,
      tenant: opts.tenant,
    });

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result, evidence.dir);
    return EXIT_CODES[result.status];
  } finally {
    await surface.close();
  }
}

function printHuman(r: ReplayResult, dir: string): void {
  const line = '-'.repeat(64);
  console.log(line);
  switch (r.status) {
    case 'success':
      console.log(`SUCCESS  ${r.capability.id} v${r.capability.version}`);
      for (const [k, v] of Object.entries(r.outputs)) console.log(`  ${k}: ${JSON.stringify(v)}`);
      break;
    case 'business_outcome':
      // Printed as a result, and exiting zero, because that is what it is.
      console.log(`BUSINESS OUTCOME  ${r.outcome.code}`);
      console.log(`  ${r.outcome.description}`);
      for (const [k, v] of Object.entries(r.outcome.data)) console.log(`  ${k}: ${JSON.stringify(v)}`);
      break;
    case 'failed':
      console.log(`FAILED  ${r.failure.code} at ${r.failure.stepId ?? '(entry)'}`);
      console.log(`  ${r.failure.message}`);
      console.log(`  expected: ${r.failure.expected}`);
      console.log(`  observed: ${r.failure.observed}`);
      break;
    case 'escalated':
      console.log(`ESCALATED  ${r.escalation.reason}`);
      console.log(`  ${r.escalation.detail}`);
      console.log(`  resolution: ${r.escalation.resolution ?? 'pending'}`);
      break;
    case 'blocked_by_policy':
      console.log(`BLOCKED BY POLICY  ${r.policy.rule}`);
      console.log(`  ${r.policy.reason}`);
      break;
  }
  console.log(line);
  console.log(`steps ${r.metrics.stepsExecuted}  retries ${r.metrics.retries}  `
            + `recoveries ${r.metrics.recoveries}  degraded ${r.metrics.degradedResolutions}  `
            + `model calls ${r.metrics.llmCalls}`);
  console.log(`evidence: ${dir}/report.html`);
}
