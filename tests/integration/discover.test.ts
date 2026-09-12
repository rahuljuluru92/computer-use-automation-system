/**
 * The whole pipeline, end to end, with no model and no API key.
 *
 * A scripted planner drives the real browser against the real Meridian
 * instance; the tool surface synthesises real locator bundles from real
 * snapshots; the compiler prunes, canonicalises and then verifies by actually
 * replaying what it produced in a second, cold browser session.
 *
 * The planner is scripted, but nothing else is faked, which makes this the
 * compiler's regression test: when the one real model run misbehaves, this
 * says whether the machinery or the model is at fault. It is also the reason
 * `provenance.model` exists as a recorded field - an artifact compiled from
 * this run says `scripted:fixture`, and must never claim otherwise.
 *
 * Refs are resolved from each observation as it arrives rather than hardcoded,
 * because Meridian regenerates every control id on every render - which is the
 * property the whole locator engine exists for.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { rmSync } from 'node:fs';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR } from '../../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../../src/policy/policyEngine.ts';
import { SecretResolver } from '../../src/policy/secrets.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { buildRedactor } from '../../src/core/redact.ts';
import { newRunId } from '../../src/core/ids.ts';
import { SessionLease } from '../../src/exec/lease.ts';
import { Executor } from '../../src/exec/executor.ts';
import { replay } from '../../src/replay/replay.ts';
import { ToolRunner } from '../../src/discovery/tools.ts';
import {
  discover, type Planner, type PlannerRequest, type PlannerTurn,
} from '../../src/discovery/loop.ts';
import { compile } from '../../src/discovery/compiler.ts';
import { verifyIntegrity } from '../../src/core/integrity.ts';
import type { CapabilityArtifact } from '../../src/core/schema.ts';

const EVIDENCE_ROOT = 'evidence/_scratch/discover-e2e';

let server: Server;
let base: string;

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
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A planner that follows a script but reads the screen
// ---------------------------------------------------------------------------

interface Find { role: string; name?: string; contains?: string }

type Move =
  | { tool: 'navigate'; url: string; intent: string }
  | { tool: 'type'; find: Find; text: string; intent: string }
  | { tool: 'click'; find: Find; intent: string }
  | { tool: 'extract'; find: Find; name: string; as: string; intent: string }
  | { tool: 'finish'; outputs: Record<string, unknown> };

/**
 * Picks refs out of the observation the tool surface just printed. This is the
 * part a real model does by reading; doing it by regex keeps the run
 * deterministic without making the rest of the system any less real.
 */
function findRef(observation: string, find: Find): string {
  const line = observation.split('\n').find((l) => {
    const m = /^\s*(o\d+#\S+)\s+(\S+)\s*(?:"([^"]*)")?(.*)$/.exec(l);
    if (!m) return false;
    if (m[2] !== find.role) return false;
    if (find.name !== undefined && m[3] !== find.name) return false;
    if (find.contains !== undefined && !l.includes(find.contains)) return false;
    return true;
  });
  if (!line) {
    throw new Error(
      `the script expected ${JSON.stringify(find)} on this screen and it was not there.\n`
      + `Observation was:\n${observation}`);
  }
  return /^\s*(o\d+#\S+)/.exec(line)![1]!;
}

class ScriptedPlanner implements Planner {
  readonly model = 'scripted:fixture';
  #i = 0;
  constructor(private readonly moves: Move[]) {}

  async turn(req: PlannerRequest): Promise<PlannerTurn> {
    const usage = { inputTokens: 0, outputTokens: 0 };

    // A scripted run has no judgement to exercise, so a failed tool call is a
    // broken test, not a turn to recover from. Surfacing it here means the
    // failure names itself instead of reappearing as a missing control later.
    const last = req.messages[req.messages.length - 1];
    if (last?.role === 'user' && last.results?.some((r) => r.isError)) {
      throw new Error(`tool call failed: ${last.results.filter((r) => r.isError).map((r) => r.text).join(' | ')}`);
    }
    // The run begins by looking, exactly as the prompt tells a model to.
    if (this.#i === 0 && lastObservation(req) === undefined) {
      this.#i = 0;
      return { toolCalls: [{ id: 'obs', name: 'observe', input: {} }], usage };
    }
    const move = this.moves[this.#i++];
    if (!move) return { toolCalls: [], usage };

    const observation = lastObservation(req) ?? '';
    const id = `t${this.#i}`;

    switch (move.tool) {
      case 'navigate':
        return { toolCalls: [{ id, name: 'navigate', input: { url: move.url, intent: move.intent } }], usage };
      case 'type':
        return { toolCalls: [{ id, name: 'type', input: {
          ref: findRef(observation, move.find), text: move.text, intent: move.intent,
        } }], usage };
      case 'click':
        return { toolCalls: [{ id, name: 'click', input: {
          ref: findRef(observation, move.find), intent: move.intent,
        } }], usage };
      case 'extract':
        return { toolCalls: [{ id, name: 'extract', input: {
          ref: findRef(observation, move.find), name: move.name, as: move.as, intent: move.intent,
        } }], usage };
      case 'finish':
        return { toolCalls: [{ id, name: 'finish', input: { outputs: move.outputs } }], usage };
    }
  }
}

function lastObservation(req: PlannerRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    const text = m.results?.map((r) => r.text).join('\n') ?? m.text ?? '';
    if (text.includes('Observation ')) return text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------

const GOAL = 'Look up a member and read their current savings balance';

function script(): Move[] {
  return [
    { tool: 'navigate', url: `${base}/members/search`, intent: 'open the servicing console' },
    { tool: 'type', find: { role: 'textbox', name: 'Operator ID' }, text: '$input.operatorId',
      intent: 'enter the operator id' },
    { tool: 'type', find: { role: 'textbox', name: 'Password' }, text: '$input.operatorPassword',
      intent: 'enter the operator password' },
    { tool: 'click', find: { role: 'button', name: 'Sign In' }, intent: 'sign in' },
    { tool: 'type', find: { role: 'textbox', name: 'Member ID' }, text: '$input.memberId',
      intent: 'enter the member id to look up' },
    { tool: 'click', find: { role: 'button', name: 'Search' }, intent: 'run the member search' },
    { tool: 'click', find: { role: 'link', name: 'View', contains: 'row 1' },
      intent: "open the member's savings account" },
    { tool: 'extract', find: { role: 'cell', contains: 'labelled "Current Balance"' },
      name: 'savingsBalance', as: 'currency', intent: 'read the current savings balance' },
    { tool: 'finish', outputs: { savingsBalance: 4210.55 } },
  ];
}

async function runDiscovery() {
  const redactor = buildRedactor({
    secrets: { MERIDIAN_PASSWORD: OPERATOR.password, MERIDIAN_USERNAME: OPERATOR.username },
  });
  const evidence = new EvidenceWriter({
    runId: newRunId('discovery'), root: EVIDENCE_ROOT, redactor,
  });
  const params = {
    memberId: '12345',
    operatorId: OPERATOR.username,
    operatorPassword: OPERATOR.password,
  };

  const surface = await WebSurface.launch();
  try {
    const runner = new ToolRunner({
      executor: new Executor({
        surface,
        policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
        lease: new SessionLease(evidence.runId),
        evidence,
      }),
      surface,
      evidence,
      params,
      secretParams: ['operatorPassword'],
      secretEnv: { operatorId: 'MERIDIAN_USERNAME', operatorPassword: 'MERIDIAN_PASSWORD' },
    });

    const run = await discover({
      planner: new ScriptedPlanner(script()),
      runner,
      evidence,
      system: 'scripted',
      budget: { maxTurns: 20 },
    });
    return { run, params, redactor };
  } finally {
    await surface.close();
  }
}

/** Replays a candidate in a browser that has never seen this application. */
function verifier(redactor: ReturnType<typeof buildRedactor>) {
  return async (artifact: CapabilityArtifact) => {
    const surface = await WebSurface.launch();
    const evidence = new EvidenceWriter({
      runId: newRunId('verify'), root: EVIDENCE_ROOT, redactor,
    });
    try {
      return await replay({
        artifact,
        inputs: { memberId: '12345' },
        surface,
        policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
        evidence,
        secrets: new SecretResolver(redactor),
        baseUrl: base,
      });
    } finally {
      await surface.close();
    }
  };
}

// ---------------------------------------------------------------------------

describe('discovery to capability, end to end', () => {
  it('records a flow, compiles it, and proves it by replaying it cold', async () => {
    const { run, params, redactor } = await runDiscovery();

    expect(run.stop.kind).toBe('terminal');
    expect(run.terminal?.kind).toBe('finish');
    expect(run.steps.length).toBeGreaterThan(5);

    const result = await compile({
      run,
      task: {
        id: 'cap.member.read_savings_balance',
        version: '1.0.0',
        title: 'Read a savings balance',
        description: GOAL,
        inputs: [
          { name: 'memberId', description: 'the member to look up' },
          { name: 'operatorId', sensitivity: 'secret' },
          { name: 'operatorPassword', sensitivity: 'secret' },
        ],
        entryUrlTemplate: `${base}/members/search`,
        product: { vendor: 'Meridian', app: 'Core Servicing Console' },
      },
      provenance: {
        model: 'scripted:fixture',
        promptVersion: 'n/a',
        discoveryRunId: 'e2e',
      },
      params,
      verify: verifier(redactor),
    });

    if (!result.ok) throw new Error(`compile failed: ${result.reason}`);

    // Verified by an actual replay, in a browser that started cold.
    expect(result.artifact.provenance.selfVerified.passed).toBe(true);
    expect(result.verification.status).toBe('success');
    if (result.verification.status === 'success') {
      expect(result.verification.outputs.savingsBalance).toBe(4210.55);
    }
    // And the replay that verified it consulted no model.
    expect(result.verification.metrics.llmCalls).toBe(0);
  }, 180_000);

  it('produces an artifact that is honest about what made it', async () => {
    const { run, params, redactor } = await runDiscovery();
    const result = await compile({
      run,
      task: {
        id: 'cap.member.read_savings_balance', version: '1.0.0',
        title: 'Read a savings balance', description: GOAL,
        inputs: [
          { name: 'memberId' },
          { name: 'operatorId', sensitivity: 'secret' },
          { name: 'operatorPassword', sensitivity: 'secret' },
        ],
        entryUrlTemplate: `${base}/members/search`,
        product: { vendor: 'Meridian', app: 'Core Servicing Console' },
      },
      provenance: { model: 'scripted:fixture', promptVersion: 'n/a', discoveryRunId: 'e2e' },
      params,
      verify: verifier(redactor),
    });

    if (!result.ok) throw new Error(`compile failed: ${result.reason}`);
    const a = result.artifact;

    // Never claims to have been discovered by a model it was not discovered by.
    expect(a.provenance.model).toBe('scripted:fixture');
    expect(a.status).toBe('draft');
    expect(verifyIntegrity(a)).toBe(true);

    // The caller supplies a member id. The caller does not supply an operator
    // password - that is a property of the environment replay runs in.
    expect(Object.keys(a.inputs.properties)).toEqual(['memberId']);
    expect(JSON.stringify(a)).not.toContain(OPERATOR.password);
    expect(JSON.stringify(a)).toContain('$secret.MERIDIAN_PASSWORD');

    // One recording, generalised: the member id is a reference everywhere.
    expect(JSON.stringify(a.steps)).not.toContain('"12345"');
  }, 180_000);
});
