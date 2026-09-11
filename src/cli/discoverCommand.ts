/**
 * `cua discover` - the one command that needs a model.
 *
 * A goal and a URL go in; a self-verified capability comes out, or nothing
 * does. There is no third outcome: `compile()` will not return an artifact it
 * has not replayed, so a run that produced a flow the system cannot execute
 * leaves a diagnostic behind and exits non-zero rather than writing something
 * that looks like a capability.
 *
 * Two details in the wiring matter more than they look.
 *
 * **Verification runs in a fresh browser.** Replaying inside the session that
 * just did the discovering would verify almost nothing - already signed in,
 * already on the right screen, cookies already set. The capability has to work
 * from cold, so it is verified from cold.
 *
 * **Credentials never become inputs.** The operator password is given to the
 * run as a secret parameter, the model references it without seeing it, and
 * the recorded step says `$secret.MERIDIAN_PASSWORD`. A capability that
 * demanded an operator password from whoever invoked it would have captured
 * the wrong thing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WebSurface } from '../surface/web/webSurface.ts';
import { PolicyEngine } from '../policy/policyEngine.ts';
import { loadPolicy } from '../policy/loadPolicy.ts';
import { SecretResolver } from '../policy/secrets.ts';
import { EvidenceWriter } from '../evidence/writer.ts';
import { buildRedactor } from '../core/redact.ts';
import { newRunId } from '../core/ids.ts';
import { SessionLease } from '../exec/lease.ts';
import { Executor } from '../exec/executor.ts';
import { replay } from '../replay/replay.ts';
import type { CapabilityArtifact } from '../core/schema.ts';
import { ToolRunner } from '../discovery/tools.ts';
import { discover } from '../discovery/loop.ts';
import { AnthropicPlanner } from '../discovery/planner.ts';
import { systemPrompt, promptVersion, type TaskInput } from '../discovery/prompt.ts';
import { compile, type CompileInput } from '../discovery/compiler.ts';

export interface DiscoverCommandOptions {
  goal: string;
  target: string;
  /** Task inputs as JSON, e.g. '{"memberId":"12345"}'. */
  inputJson: string;
  id?: string | undefined;
  version?: string | undefined;
  maxTurns?: number | undefined;
  model?: string | undefined;
  label?: string | undefined;
  json: boolean;
}

/** The operator credentials the target needs, and where replay will read them. */
const CREDENTIALS: Record<string, string> = {
  operatorId: 'MERIDIAN_USERNAME',
  operatorPassword: 'MERIDIAN_PASSWORD',
};

export async function runDiscoverCommand(opts: DiscoverCommandOptions): Promise<number> {
  const taskInputs = JSON.parse(opts.inputJson) as Record<string, unknown>;
  const baseUrl = new URL(opts.target).origin;

  const username = process.env.MERIDIAN_USERNAME;
  const password = process.env.MERIDIAN_PASSWORD;

  // Params the run can reference. Credentials sit alongside task inputs so the
  // model can sign in by reference, and are marked secret so neither the prompt
  // nor any tool result ever carries their values.
  const params: Record<string, unknown> = {
    ...taskInputs,
    ...(username ? { operatorId: username } : {}),
    ...(password ? { operatorPassword: password } : {}),
  };
  const secretParams = password ? ['operatorPassword'] : [];

  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: password, MERIDIAN_USERNAME: username },
  });
  const evidence = new EvidenceWriter({
    runId: opts.label ?? newRunId('discovery'),
    redactor,
    meta: { goal: opts.goal, target: opts.target, promptVersion: promptVersion() },
  });

  const declared: TaskInput[] = [
    ...Object.entries(taskInputs).map(([name, value]): TaskInput => ({ name, value })),
    ...(username ? [{ name: 'operatorId', value: username } as TaskInput] : []),
    ...(password
      ? [{ name: 'operatorPassword', value: password, sensitivity: 'secret' } as TaskInput]
      : []),
  ];

  const planner = new AnthropicPlanner(opts.model ? { model: opts.model } : {});
  evidence.event('run.start',
    `Discovering: ${opts.goal}`,
    { target: opts.target, model: planner.model, promptVersion: promptVersion() });

  const surface = await WebSurface.launch({ headless: process.env.CUA_HEADED !== '1' });
  let run;
  try {
    const lease = new SessionLease(evidence.runId);
    const executor = new Executor({
      surface,
      policy: new PolicyEngine({ ...loadPolicy(), allowedOrigins: [baseUrl] }),
      lease,
      evidence,
    });
    const runner = new ToolRunner({
      executor, surface, evidence, params, secretParams, secretEnv: CREDENTIALS,
    });

    run = await discover({
      planner,
      runner,
      evidence,
      system: systemPrompt({ goal: opts.goal, startUrl: opts.target, inputs: declared }),
      ...(opts.maxTurns ? { budget: { maxTurns: opts.maxTurns } } : {}),
    });
  } finally {
    // Closed before verification: the capability has to work from cold, and a
    // still-open signed-in session is the opposite of cold.
    await surface.close();
  }

  console.error(
    `discovery: ${run.stop.kind} after ${run.metrics.turns} turns, `
    + `${run.steps.length} steps recorded, `
    + `${run.metrics.inputTokens + run.metrics.outputTokens} tokens.`);

  const id = opts.id ?? deriveId(opts.goal);
  const version = opts.version ?? '1.0.0';

  const result = await compile({
    run,
    task: {
      id,
      version,
      title: opts.goal,
      description: opts.goal,
      inputs: declared.map((d): CompileInput => ({
        name: d.name,
        ...(d.sensitivity ? { sensitivity: d.sensitivity } : {}),
      })),
      entryUrlTemplate: opts.target,
      product: { vendor: 'Meridian', app: 'Core Servicing Console' },
    },
    provenance: {
      model: planner.model,
      promptVersion: promptVersion(),
      discoveryRunId: evidence.runId,
    },
    params,
    verify: verifier(baseUrl, taskInputs, redactor),
  });

  evidence.event('note', `Compile ${result.ok ? 'succeeded' : 'failed'}.`, { report: result.report });
  evidence.close({ discovery: run.metrics, compiled: result.ok });

  if (!result.ok) {
    console.error(`\ncompile failed: ${result.reason}`);
    console.error(
      `  recorded ${result.report.recordedSteps} steps, kept ${result.report.compiledSteps}`);
    console.error(`  evidence: ${evidence.dir}`);
    return 1;
  }

  const path = join('artifacts', `${id}@${version}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(redactor.redactValue(result.artifact), null, 2)}\n`);

  if (opts.json) {
    console.log(JSON.stringify({ artifact: path, report: result.report }, null, 2));
  } else {
    console.log(
      `\nwrote ${path}\n`
      + `  ${result.report.compiledSteps} steps `
      + `(${result.report.recordedSteps} recorded, `
      + `${result.report.pruned.length} pruned as detours)\n`
      + `  inputs: ${result.report.inputsUsed.join(', ') || 'none'}\n`
      + `  self-verified by replay: run ${result.verification.runId}\n`
      + `  evidence: ${evidence.dir}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------

/**
 * Replays a candidate artifact in a browser that has never seen this
 * application, with its own evidence directory, so the verification run stands
 * on its own as proof.
 */
function verifier(baseUrl: string, inputs: Record<string, unknown>, redactor: ReturnType<typeof buildRedactor>) {
  return async (artifact: CapabilityArtifact) => {
    const surface = await WebSurface.launch({ headless: process.env.CUA_HEADED !== '1' });
    const evidence = new EvidenceWriter({
      runId: newRunId('verify'),
      redactor,
      meta: { verifying: artifact.id, version: artifact.version },
    });
    try {
      return await replay({
        artifact,
        inputs,
        surface,
        policy: new PolicyEngine({ ...loadPolicy(), allowedOrigins: [baseUrl] }),
        evidence,
        secrets: new SecretResolver(redactor),
        baseUrl,
      });
    } finally {
      await surface.close();
    }
  };
}

/**
 * A deterministic id from the goal, so the demo path needs no extra flag.
 * Crude on purpose - naming a capability well is a judgement call, which is
 * why `--id` exists and why the metadata pass that would do this properly is
 * still a documented gap rather than something faked here.
 */
export function deriveId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 5)
    .join('_');
  return `cap.discovered.${slug || 'untitled'}`;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'their', 'there', 'this', 'that', 'with', 'from', 'into',
  'then', 'them', 'his', 'her', 'its', 'are', 'was', 'has', 'had',
]);
