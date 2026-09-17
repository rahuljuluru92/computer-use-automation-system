/**
 * Discovers `cap.member.open_subaccount` live, in two runs, against an
 * in-process Meridian Core - the second real capability, and the first one
 * to ship with an actual, replay-checked business outcome (decision #114
 * narrowed for this one capability; still not for read_savings_balance,
 * which never saw an error path).
 *
 *   Run A (clean)   sign in, search, open the sub-account form, fill it,
 *                   review, confirm, land on the done screen, extract the
 *                   reference and account numbers. This is the primary run:
 *                   its steps become the artifact.
 *
 *   Run B (chaos)   the same task, on a session with validation_error armed
 *                   first. The review screen refuses the deposit with
 *                   "exceeds the daily funding limit" regardless of amount,
 *                   and the discovery-outcome prompt variant tells the model
 *                   to declare that immediately rather than try to fix it.
 *                   Only its terminal is kept - its steps are discarded.
 *
 * Both runs need `--approve-irreversible`'s equivalent (`approvalGranted:
 * true` on the Executor): the commit step matches `requireApprovalLabels`
 * ("confirm and open"), and policy refuses an irreversible action during
 * discovery by default. A human is watching this recording end to end, which
 * is exactly the case that flag exists for - and it has no effect on the
 * shipped artifact, which is independently gated at replay time regardless.
 *
 *   npx tsx scripts/discover-open-subaccount.ts
 *
 * Requires ANTHROPIC_API_KEY. Writes nothing unless compile() verifies both
 * the success path and the outcome scenario against a cold browser.
 */

import type { Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadDotEnv } from '../src/core/dotenv.ts';
import { createApp } from '../apps/meridian-core/server.ts';
import { OPERATOR } from '../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../src/surface/web/webSurface.ts';
import { PolicyEngine } from '../src/policy/policyEngine.ts';
import { loadPolicy } from '../src/policy/loadPolicy.ts';
import { SecretResolver } from '../src/policy/secrets.ts';
import { EvidenceWriter } from '../src/evidence/writer.ts';
import { buildRedactor } from '../src/core/redact.ts';
import { newRunId } from '../src/core/ids.ts';
import { SessionLease } from '../src/exec/lease.ts';
import { Executor } from '../src/exec/executor.ts';
import { replay } from '../src/replay/replay.ts';
import { ToolRunner } from '../src/discovery/tools.ts';
import { discover, type DiscoveryRun } from '../src/discovery/loop.ts';
import { AnthropicPlanner } from '../src/discovery/planner.ts';
import { systemPrompt, promptVersion, type PromptVariant, type TaskInput } from '../src/discovery/prompt.ts';
import { compile, type CompileInput, type OutcomeScenario } from '../src/discovery/compiler.ts';
import type { CapabilityArtifact } from '../src/core/schema.ts';

const MODEL = 'claude-sonnet-5';
const MEMBER_ID = '12345';

const TASK_INPUTS: TaskInput[] = [
  { name: 'memberId', value: MEMBER_ID, description: 'the member to open a sub-account for' },
  { name: 'subType', value: 'Savings', description: 'Savings, Money Market, or Certificate' },
  { name: 'nickname', value: 'Rainy Day Fund', description: 'a label for the new sub-account' },
  { name: 'deposit', value: '500', description: 'the opening deposit amount' },
  { name: 'fundingAccount', value: '0001-4477', description: 'the existing account to fund it from' },
];

const GOAL = 'Open a new sub-account for a member, funded from one of their existing '
  + 'accounts, and record the reference number and new account number the console '
  + 'gives back once it is opened.';

async function main(): Promise<void> {
  loadDotEnv();
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;

  // Fixed at Meridian's standard port, not an ephemeral one (unlike the gate
  // scripts, which replay an already-compiled artifact and don't care what
  // port it happened to run on). This artifact's `entry.template` bakes in
  // whatever `base` is at compile time - an ephemeral port produced a
  // capability that could only ever replay against this one process, the way
  // gate-m2.ts's throwaway server never has to persist past its own run.
  // Matches the existing `read_savings_balance` artifact and the README's
  // documented `npm run app` port.
  const PORT = Number(process.env.MERIDIAN_PORT ?? 4400);
  const base = `http://localhost:${PORT}`;
  let server: Server | undefined;
  await new Promise<void>((resolve) => {
    server = createApp().listen(PORT, () => resolve());
  });

  try {
    console.log(`Meridian Core listening at ${base}\n`);

    console.log('--- Run A: clean happy path ---');
    const runA = await recordOnce({ base, label: 'discover-open-subaccount-happy', variant: 'default' });
    console.log(
      `  ${runA.stop.kind} after ${runA.metrics.turns} turns, ${runA.steps.length} steps, `
      + `terminal: ${runA.terminal?.kind ?? '(none)'}\n`);

    console.log('--- Run B: validation_error armed, discovery-outcome prompt ---');
    const armUrl = `${base}/_chaos?mode=validation_error`;
    const runB = await recordOnce({
      base, label: 'discover-open-subaccount-outcome', variant: 'outcome',
      armUrl, maxTurns: 25,
    });
    console.log(
      `  ${runB.stop.kind} after ${runB.metrics.turns} turns, ${runB.steps.length} steps, `
      + `terminal: ${runB.terminal?.kind ?? '(none)'}`);
    if (runB.terminal?.kind === 'declare_outcome') {
      console.log(`  declared: ${runB.terminal.code} (detector: ${runB.terminal.detectTarget ? 'yes' : 'NONE'})\n`);
    } else {
      console.log(
        `  did not end in declare_outcome - it ${runB.terminal ? `ended in ${runB.terminal.kind}` : `ran out on ${runB.stop.kind}`}. `
        + 'Cannot add an outcome scenario from this run.\n');
    }

    const redactor = buildRedactor({
      secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
    });

    // Whatever code the model actually chose - never overwritten here. The
    // script cannot know in advance what it will call the refusal; the
    // scenario just has to check the compiler against the same code the
    // model declared, not a code this script decided on beforehand.
    const scenario: OutcomeScenario | undefined = runB.terminal?.kind === 'declare_outcome'
      ? { run: runB, armUrl, expectedCode: runB.terminal.code }
      : undefined;

    console.log('--- Compiling (verifies success and, if present, the outcome scenario) ---');
    const result = await compile({
      run: runA,
      task: {
        id: 'cap.member.open_subaccount',
        version: '1.0.0',
        title: 'Open a member sub-account',
        description: GOAL,
        inputs: declaredInputs().map((t): CompileInput => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.sensitivity ? { sensitivity: t.sensitivity } : {}),
        })),
        entryUrlTemplate: base,
        product: { vendor: 'Meridian', app: 'Core Servicing Console' },
      },
      provenance: {
        model: MODEL,
        promptVersion: promptVersion('default'),
        discoveryRunId: newRunId('discovery'),
      },
      params: taskParams(),
      verify: verifier(base, redactor),
      ...(scenario ? { additionalOutcomeScenarios: [scenario] } : {}),
    });

    console.log(`\ncompile: ${result.ok ? 'OK' : 'FAILED'}`);
    console.log(`  recorded ${result.report.recordedSteps} steps, kept ${result.report.compiledSteps}`);
    if (result.report.droppedOutcomes.length > 0) {
      console.log(`  dropped outcomes: ${result.report.droppedOutcomes.join('; ')}`);
    }
    if (!result.ok) {
      console.log(`  reason: ${result.reason}`);
      process.exitCode = 1;
      return;
    }

    console.log(`  outcomes shipped: ${result.artifact.outcomes.map((o) => o.code).join(', ') || '(none)'}`);
    console.log(`  self-verified by replay: run ${result.verification.runId}`);

    const path = join('artifacts', `${result.artifact.id}@${result.artifact.version}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(redactor.redactValue(result.artifact), null, 2)}\n`);
    console.log(`\nwrote ${path}`);
  } finally {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  }
}

/** Used to interpolate the discovery session - the model needs credentials by
 *  reference to sign in, even though they never end up as caller inputs. */
function taskParams(): Record<string, unknown> {
  return {
    ...callerInputs(),
    operatorId: OPERATOR.username,
    operatorPassword: OPERATOR.password,
  };
}

/**
 * What an actual caller of the shipped capability supplies - never operator
 * credentials, which `SecretResolver` resolves from the environment at
 * replay time regardless of what `inputs` carries (decision #88). Passing
 * the discovery-time `taskParams()` (which includes them) to `replay()`
 * fails the artifact's own `inputs` schema (`additionalProperties: false`)
 * with a field the contract never declared - caught on the first live run.
 */
function callerInputs(): Record<string, unknown> {
  return Object.fromEntries(TASK_INPUTS.map((t) => [t.name, t.value]));
}

/**
 * `TASK_INPUTS` alone leaves the model unable to sign in - `systemPrompt`
 * only tells it about the inputs it is handed, and the operator credentials
 * live in `taskParams()` for interpolation, not in the declared list. This is
 * exactly what `discoverCommand.ts`'s own `declared` array does for the CLI
 * path; missed here on the first pass, and both runs failed identically for
 * it (Run A: request_human, unable to sign in; Run B: declared
 * operator_authentication_failed - a real outcome, just not the intended one,
 * both runs blocked on the same missing input before ever reaching the task).
 */
function declaredInputs(): TaskInput[] {
  return [
    ...TASK_INPUTS,
    { name: 'operatorId', value: OPERATOR.username },
    { name: 'operatorPassword', value: OPERATOR.password, sensitivity: 'secret' },
  ];
}

async function recordOnce(o: {
  base: string; label: string; variant: PromptVariant; armUrl?: string; maxTurns?: number;
}): Promise<DiscoveryRun> {
  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({
    runId: o.label,
    redactor,
    meta: { goal: GOAL, target: o.base, promptVersion: promptVersion(o.variant) },
  });

  const surface = await WebSurface.launch({ headless: process.env.CUA_HEADED !== '1' });
  try {
    // Armed before the model ever sees a screen, so this is not a step the
    // model took - it is the precondition the task happens under, the same
    // way a real degraded session would look to whoever is signed into it.
    if (o.armUrl) await surface.navigate(o.armUrl);

    const lease = new SessionLease(evidence.runId);
    const executor = new Executor({
      surface,
      policy: new PolicyEngine({ ...loadPolicy(), allowedOrigins: [o.base] }),
      lease,
      evidence,
      // A human (this script, run deliberately and watched) authorises this
      // one recording to cross the irreversible-action line - independent of
      // the approval the shipped capability still requires at replay time.
      approvalGranted: true,
    });
    const runner = new ToolRunner({
      executor, surface, evidence,
      params: taskParams(),
      secretParams: ['operatorPassword'],
      secretEnv: { operatorId: 'MERIDIAN_USERNAME', operatorPassword: 'MERIDIAN_PASSWORD' },
    });

    const run = await discover({
      planner: new AnthropicPlanner({ model: MODEL }),
      runner,
      evidence,
      system: systemPrompt({ goal: GOAL, startUrl: o.base, inputs: declaredInputs() }, o.variant),
      budget: o.maxTurns ? { maxTurns: o.maxTurns } : {},
    });
    // discover() does not close its own evidence - discoverCommand.ts's CLI
    // path does this explicitly, and this script is the same kind of caller.
    // Without it the manifest (and the redaction report inside it) never gets
    // written, which is the one thing decision #43 says must never look the
    // same as "redaction never ran".
    evidence.close({ discovery: run.metrics, terminal: run.terminal?.kind ?? null });
    return run;
  } finally {
    await surface.close();
  }
}

/**
 * Fresh browser, fresh evidence, per invariant #4 and decision #87.
 *
 * The primary (non-scenario) replay grants approval for this one proof-run.
 * `open_subaccount`'s commit step matches `requireApprovalLabels`, same as it
 * would for any real invocation - `replay()` correctly escalates there, and
 * with nobody at the operator console the escalation times out, so the
 * compiler's own verification of the happy path could never reach `success`,
 * never see the real "done" screen, and never prove the extract steps work.
 *
 * `ReplayOptions.approvalGranted` already existed for exactly this shape of
 * problem - no other call site in this codebase sets it (`cua replay` and the
 * MCP server never do, and correctly so: a production invocation must always
 * be gated). This is the one place it belongs: a single, human-supervised
 * proof-run performed by whoever just ran discovery, immediately discarded
 * as evidence, never reachable by a caller. It changes nothing about how the
 * *shipped* artifact behaves - every real replay of it still escalates for a
 * human exactly as before.
 *
 * The outcome scenario gets no such grant, and does not need it: the
 * declared outcome's detector fires on the review screen, before the flow
 * ever reaches the commit step - and if some future scenario's flow reached
 * further than expected, refusing it there is the correct, safe outcome, not
 * a bug to route around.
 */
function verifier(base: string, redactor: ReturnType<typeof buildRedactor>) {
  return async (artifact: CapabilityArtifact, scenario?: { armUrl: string }) => {
    const surface = await WebSurface.launch({ headless: process.env.CUA_HEADED !== '1' });
    const evidence = new EvidenceWriter({
      runId: newRunId('verify'),
      redactor,
      meta: { verifying: artifact.id, version: artifact.version, ...(scenario ? { scenario } : {}) },
    });
    try {
      if (scenario) await surface.navigate(scenario.armUrl);
      return await replay({
        artifact,
        inputs: callerInputs(),
        surface,
        policy: new PolicyEngine({ ...loadPolicy(), allowedOrigins: [base] }),
        evidence,
        secrets: new SecretResolver(redactor),
        baseUrl: base,
        approvalGranted: scenario === undefined,
      });
    } finally {
      await surface.close();
    }
  };
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
