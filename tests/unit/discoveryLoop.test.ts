/**
 * The discovery loop, driven by a scripted planner.
 *
 * No key, no network, no model. The loop takes a `Planner` precisely so that
 * the control flow - budgets, oscillation, stalls, refusals - can be tested
 * deterministically. If any of this needed a live model to exercise, it would
 * not be tested at all, which is how budget logic normally ships broken.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import {
  discover, type Planner, type PlannerRequest, type PlannerTurn, type LoopMessage,
} from '../../src/discovery/loop.ts';
import { buildHarness, snap, scratchRoot, type Harness } from '../fixtures/discoveryHarness.ts';

const ROOT = scratchRoot('discovery-loop');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A planner that reads from a script and records what it was asked. */
class ScriptedPlanner implements Planner {
  readonly model = 'scripted';
  readonly requests: Array<{ messages: LoopMessage[] }> = [];
  #i = 0;

  constructor(private readonly script: Array<Partial<PlannerTurn>>) {}

  async turn(req: PlannerRequest): Promise<PlannerTurn> {
    // Snapshot the messages: the loop mutates the array it passed in.
    this.requests.push({ messages: [...req.messages] });
    const next = this.script[this.#i++] ?? {};
    return {
      toolCalls: next.toolCalls ?? [],
      ...(next.text === undefined ? {} : { text: next.text }),
      usage: next.usage ?? { inputTokens: 100, outputTokens: 20 },
    };
  }
}

const call = (name: string, input: Record<string, unknown> = {}, id = `t${Math.random()}`) =>
  ({ id, name, input });

const run = (h: Harness, planner: Planner, budget = {}) =>
  discover({ planner, runner: h.runner, evidence: h.evidence, system: 'test', budget });

/** Every user message the loop injected, as plain text. */
const injected = (planner: ScriptedPlanner): string[] =>
  planner.requests.flatMap((r) =>
    r.messages.filter((m): m is Extract<LoopMessage, { role: 'user' }> => m.role === 'user')
      .map((m) => m.text ?? ''))
    .filter((t) => t !== '');


/** Makes the surface alternate between two screens: a real there-and-back cycle. */
function pingPong(h: Harness, a = 'member-detail', b = 'account-detail'): void {
  let flip = false;
  const original = h.surface.observe.bind(h.surface);
  h.surface.observe = async () => {
    h.surface.current = snap(flip ? b : a);
    flip = !flip;
    return original();
  };
}

describe('a run that completes', () => {
  it('ends on the terminal the model declared, and returns it', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      { toolCalls: [call('finish', { outputs: { savingsBalance: 4210.55 } })] },
    ]);

    const result = await run(h, planner);

    expect(result.stop.kind).toBe('terminal');
    expect(result.terminal).toEqual({ kind: 'finish', outputs: { savingsBalance: 4210.55 } });
    expect(result.metrics.turns).toBe(2);
    expect(result.metrics.toolCalls).toBe(2);
  });

  it('records a business outcome as an ending, not as a failure', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      { toolCalls: [call('declare_outcome', { code: 'no_such_member', description: 'No member record found.' })] },
    ]);

    const result = await run(h, planner);
    expect(result.terminal).toMatchObject({ kind: 'declare_outcome', code: 'no_such_member' });
  });

  it('counts its model calls, because replay must be able to prove it made none', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      { toolCalls: [call('give_up', { reason: 'nope' })] },
    ]);

    const result = await run(h, planner);
    expect(result.metrics.llmCalls).toBe(2);
    expect(result.metrics.inputTokens).toBe(200);
  });

  it('ignores tool calls decided before the run ended', async () => {
    // The model asked for three things in one turn. The second ends the run,
    // so the third was decided without knowing that - acting on it would be
    // acting on a stale plan.
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      {
        toolCalls: [
          call('observe'),
          call('finish', { outputs: {} }),
          call('click', { ref: 'o1#f3e44', intent: 'should never happen' }),
        ],
      },
    ]);

    const result = await run(h, planner);
    expect(result.stop.kind).toBe('terminal');
    expect(h.surface.calls.filter((c) => c.method === 'click')).toHaveLength(0);
  });
});

describe('budgets', () => {
  it('stops at the turn limit', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner(Array(20).fill({ toolCalls: [call('observe')] }));
    const result = await run(h, planner, { maxTurns: 3 });

    expect(result.stop).toEqual({ kind: 'max_turns', limit: 3 });
    expect(result.metrics.turns).toBe(3);
  });

  it('stops on the token budget', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner(
      Array(20).fill({ toolCalls: [call('observe')], usage: { inputTokens: 500, outputTokens: 100 } }));
    const result = await run(h, planner, { maxTokens: 1000 });

    expect(result.stop).toEqual({ kind: 'token_budget', limit: 1000 });
    // Checked before spending, so it stops having spent 1200, not 12000.
    expect(result.metrics.inputTokens + result.metrics.outputTokens).toBeLessThan(2000);
  });

  it('stops on the wall clock', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner(Array(5).fill({ toolCalls: [call('observe')] }));
    const result = await run(h, planner, { maxWallClockMs: 0 });
    expect(result.stop.kind).toBe('wall_clock');
  });
});

describe('a model that stops acting', () => {
  it('is nudged once before the run is abandoned', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { text: 'Let me think about this.' },
      { toolCalls: [call('observe')] },
      { toolCalls: [call('finish', { outputs: {} })] },
    ]);

    const result = await run(h, planner);
    expect(result.stop.kind).toBe('terminal');
    expect(injected(planner).some((t) => /did not use a tool/.test(t))).toBe(true);
  });

  it('is abandoned after two turns without a tool call', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([{ text: 'Hmm.' }, { text: 'Still thinking.' }]);
    const result = await run(h, planner);

    expect(result.stop).toMatchObject({ kind: 'planner_stalled' });
  });
});

describe('oscillation', () => {
  it('tells the model it is going in circles before it gives up on it', async () => {
    // The fake surface never changes, so every action returns to the same
    // state - the shape of a real cycle on a legacy grid.
    const h = buildHarness({ root: ROOT });
    // The surface ping-pongs between two screens, so the run keeps arriving
    // back somewhere it has already been - a genuine cycle, as opposed to
    // merely standing still, which is not one.
    pingPong(h);
    const planner = new ScriptedPlanner(Array(10).fill({ toolCalls: [call('observe')] }));

    const result = await run(h, planner, { maxStateRepeats: 2 });

    // Feedback came first...
    const nudges = injected(planner).filter((t) => /back on (a|the) screen/.test(t));
    expect(nudges.length).toBeGreaterThan(0);
    expect(result.metrics.oscillationWarnings).toBeGreaterThan(0);

    // ...and only then did the budget end it.
    expect(result.stop).toMatchObject({ kind: 'oscillation', times: 3 });
  });

  it('names the turn the model was last in that state, so the advice is actionable', async () => {
    const h = buildHarness({ root: ROOT });
    pingPong(h);
    const planner = new ScriptedPlanner(Array(10).fill({ toolCalls: [call('observe')] }));

    await run(h, planner, { maxStateRepeats: 2 });
    expect(injected(planner).some((t) => /you were on at turn \d+/.test(t))).toBe(true);
  });

  it('does not fire while a form is being filled in', async () => {
    // The structure hash excludes values, so every keystroke leaves it
    // identical. Counting that as a revisit ended a real discovery run after
    // three fields of a login form.
    const h = buildHarness({ root: ROOT, params: { memberId: '12345' } });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      ...Array.from({ length: 6 }, (_, i) => ({
        toolCalls: [call('type', {
          ref: `o${i + 1}#f3e12`, text: '$input.memberId', intent: 'fill a field',
        })],
      })),
      { toolCalls: [call('finish', { outputs: {} })] },
    ]);

    const result = await discover({
      planner, runner: h.runner, evidence: h.evidence, system: 'test',
      budget: { maxStateRepeats: 2 },
    });

    expect(result.stop.kind).toBe('terminal');
    expect(result.metrics.oscillationWarnings).toBe(0);
  });

  it('does not fire when the screen keeps changing', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      { toolCalls: [call('observe')] },
      { toolCalls: [call('finish', { outputs: {} })] },
    ]);
    // Each turn lands on a different screen.
    const fixtures = ['member-detail', 'account-detail', 'member-search'];
    let i = 0;
    const original = h.surface.observe.bind(h.surface);
    h.surface.observe = async () => {
      const { snap } = await import('../fixtures/discoveryHarness.ts');
      h.surface.current = snap(fixtures[Math.min(i++, fixtures.length - 1)]!);
      return original();
    };

    const result = await run(h, planner);
    expect(result.metrics.oscillationWarnings).toBe(0);
    expect(result.stop.kind).toBe('terminal');
  });
});

describe('policy refusals', () => {
  it('ends the run when the model keeps trying a door that is locked', async () => {
    const h = buildHarness({ policy: { denyLabels: ['Sign Out'] }, root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      ...Array(6).fill({ toolCalls: [call('click', { ref: 'o1#f2e9', intent: 'sign out' })] }),
    ]);

    const result = await run(h, planner, { maxPolicyDenials: 2 });

    expect(result.stop).toEqual({ kind: 'policy_denials', limit: 2 });
    expect(result.metrics.policyDenials).toBe(2);
    // Nothing refused was ever recorded as a step.
    expect(result.steps).toHaveLength(0);
  });

  it('lets one refusal pass, so the model can ask for a human instead', async () => {
    const h = buildHarness({ policy: { denyLabels: ['Sign Out'] }, root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      { toolCalls: [call('click', { ref: 'o1#f2e9', intent: 'sign out' })] },
      { toolCalls: [call('request_human', { reason: 'policy refused', question: 'May I sign out?' })] },
    ]);

    const result = await run(h, planner, { maxPolicyDenials: 3 });
    expect(result.terminal).toMatchObject({ kind: 'request_human' });
  });
});

describe('the transcript', () => {
  it('is kept for the evidence bundle', async () => {
    const h = buildHarness({ root: ROOT });
    const planner = new ScriptedPlanner([
      { toolCalls: [call('observe')] },
      { toolCalls: [call('finish', { outputs: {} })] },
    ]);

    const result = await run(h, planner);
    expect(result.transcript[0]).toEqual({ role: 'user', text: 'Begin.' });
    expect(result.transcript.some((m) => m.role === 'assistant')).toBe(true);
  });
});
