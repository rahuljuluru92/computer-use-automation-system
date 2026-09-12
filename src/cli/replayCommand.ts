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
import { SecretResolver, applyDemoCredentialDefaults } from '../policy/secrets.ts';
import { EvidenceWriter } from '../evidence/writer.ts';
import { buildRedactor } from '../core/redact.ts';
import { newRunId } from '../core/ids.ts';
import { replay } from '../replay/replay.ts';
import { SessionLease } from '../exec/lease.ts';
import { RemoteBus } from '../escalation/remote.ts';
import { HumanActionCapture } from '../escalation/capture.ts';
import { createHandoff, type EscalationChannel } from '../escalation/handoff.ts';

export interface ReplayCommandOptions {
  artifactPath: string;
  inputJson: string;
  tenant?: string | undefined;
  chaos?: string | undefined;
  /** Names the evidence directory instead of using a timestamped run id. */
  label?: string | undefined;
  /** Base URL of a running `cua operator` console to escalate into. */
  operator?: string | undefined;
  json: boolean;
}

export async function runReplayCommand(opts: ReplayCommandOptions): Promise<number> {
  const artifact = CapabilityArtifact.parse(
    JSON.parse(await readFile(opts.artifactPath, 'utf8')) as unknown,
  );
  if (artifact.integrity && !verifyIntegrity(artifact)) {
    // Two very different causes, and the message has to name both or the
    // second one reads as an accusation. An edited artifact is the case the
    // hash exists for; a schema that has grown a defaulted field since the
    // artifact was signed produces an identical symptom and is nobody's fault.
    console.error(
      `refusing to run: ${opts.artifactPath} does not match its recorded hash.\n`
      + `Either it was edited since it was signed, or the capability schema has\n`
      + `changed under it - a new field with a default is enough to do this, and\n`
      + `the hash covers the whole artifact.\n`
      + `If the change was intentional, re-sign it deliberately:\n`
      + `  npx tsx scripts/resign-artifacts.ts ${opts.artifactPath}`,
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

  // A run that can escalate must be watchable. Handing a human control of a
  // browser they cannot see is not a handoff, and defaulting to headless here
  // would produce a demo where the operator clicks "Take control" and is given
  // nothing. An explicit CUA_HEADED=0 still wins, for CI.
  const headed = process.env.CUA_HEADED === '1'
    || (opts.operator !== undefined && process.env.CUA_HEADED !== '0');
  const surface = await WebSurface.launch({ headless: !headed });

  const lease = new SessionLease(evidence.runId);
  let escalation: EscalationChannel | undefined;
  if (opts.operator) {
    const bus = new RemoteBus({ url: opts.operator });
    if (!await bus.reachable()) {
      await surface.close();
      console.error(
        `no operator console is listening at ${opts.operator}.\n`
        + `Start one first:  npm run operator\n`
        + `Refusing to start a run that says it can escalate but cannot.`);
      return 4;
    }
    escalation = createHandoff({
      bus, lease, evidence,
      runId: evidence.runId,
      capability: { id: artifact.id, version: artifact.version },
      tenant: opts.tenant,
      capture: await HumanActionCapture.attach(surface.page),
    });
    console.log(`escalations for this run go to ${opts.operator}`);
  }

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
      lease,
      escalation,
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
      console.log(`  intervention: ${r.escalation.interventionId}`);
      console.log(`  claimed: ${r.escalation.claimed ? r.escalation.claimedBy ?? 'yes' : 'no one came'}`);
      console.log(`  human actions: ${r.escalation.humanActionCount}`);
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
