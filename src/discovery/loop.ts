/**
 * The discovery loop.
 *
 * A model proposes tool calls, the ToolRunner executes them through the
 * chokepoint, results go back. That much is unremarkable. What this file is
 * actually for is the part that is not: deciding when a run has stopped being
 * productive, and saying so in a way the run can recover from.
 *
 * The loop never imports a model SDK. It takes a `Planner` - one function, one
 * turn - so the whole of this control flow is testable against a scripted
 * planner with no key and no network. `planner.ts` is the only file that knows
 * Anthropic exists, and it contains no decisions.
 *
 * Budgets are all four of the things that actually run out: turns, wall clock,
 * tokens, and patience. The fourth is the interesting one.
 *
 * ## Oscillation: feedback before detection
 *
 * A hostile legacy grid will walk an agent into a cycle - click through, get
 * bounced back, click through again. The naive handling is a detector that
 * ends the run, which converts a recoverable confusion into a failure.
 *
 * So the same snapshot-hash history that backtrack pruning will read is also
 * used, first, to *tell the model* it has been here before:
 *
 *     "You are back at the state you were in after step 4. Whatever you just
 *      did returned you to where you started - try a different approach."
 *
 * Only when the same state is reached more times than the budget allows does
 * the run stop. A detector ends a run; feedback rescues one.
 */

import type { EvidenceWriter } from '../evidence/writer.ts';
import type { RecordedStep, Terminal, ToolDefinition, ToolRunner } from './tools.ts';
import { DISCOVERY_TOOLS } from './tools.ts';

// ---------------------------------------------------------------------------
// The planner seam
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LoopMessage =
  | { role: 'user'; text?: string; results?: Array<{ id: string; text: string; isError: boolean }> }
  | { role: 'assistant'; text?: string; toolCalls: ToolCall[] };

export interface PlannerRequest {
  system: string;
  tools: ToolDefinition[];
  messages: LoopMessage[];
}

export interface PlannerTurn {
  text?: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * One turn of a model. Deliberately the smallest interface that can express
 * the loop, so that swapping the model - or removing it, in a test - changes
 * nothing about the control flow being tested.
 */
export interface Planner {
  readonly model: string;
  turn(req: PlannerRequest): Promise<PlannerTurn>;
}

// ---------------------------------------------------------------------------
// Budgets and stopping
// ---------------------------------------------------------------------------

export interface DiscoveryBudget {
  /** Model turns, not tool calls: a turn may carry several. */
  maxTurns: number;
  maxWallClockMs: number;
  /** Input + output tokens across the run. */
  maxTokens: number;
  /**
   * How many times the model may be refused by policy before the run ends. One
   * refusal is information; three is an agent circling a wall, and every lap
   * costs tokens and produces nothing.
   */
  maxPolicyDenials: number;
  /** How many times one screen may recur before the run is called a cycle. */
  maxStateRepeats: number;
}

export const DEFAULT_BUDGET: DiscoveryBudget = {
  maxTurns: 40,
  maxWallClockMs: 5 * 60_000,
  maxTokens: 400_000,
  maxPolicyDenials: 3,
  maxStateRepeats: 3,
};

export type StopReason =
  | { kind: 'terminal'; terminal: Terminal }
  | { kind: 'max_turns'; limit: number }
  | { kind: 'wall_clock'; limitMs: number }
  | { kind: 'token_budget'; limit: number }
  | { kind: 'policy_denials'; limit: number }
  | { kind: 'oscillation'; hash: string; times: number }
  | { kind: 'planner_stalled'; detail: string };

export interface DiscoveryMetrics {
  turns: number;
  toolCalls: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  policyDenials: number;
  oscillationWarnings: number;
}

export interface DiscoveryRun {
  steps: readonly RecordedStep[];
  /** How the model said it ended. Absent when a budget ended it instead. */
  terminal?: Terminal;
  stop: StopReason;
  metrics: DiscoveryMetrics;
  /** The conversation, for the evidence bundle. */
  transcript: readonly LoopMessage[];
}

export interface DiscoverOptions {
  planner: Planner;
  runner: ToolRunner;
  evidence: EvidenceWriter;
  system: string;
  budget?: Partial<DiscoveryBudget>;
  tools?: ToolDefinition[];
}

// ---------------------------------------------------------------------------

export async function discover(opts: DiscoverOptions): Promise<DiscoveryRun> {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const tools = opts.tools ?? DISCOVERY_TOOLS;
  const { planner, runner, evidence } = opts;

  const started = Date.now();
  const messages: LoopMessage[] = [{ role: 'user', text: 'Begin.' }];

  const metrics: DiscoveryMetrics = {
    turns: 0, toolCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0,
    durationMs: 0, policyDenials: 0, oscillationWarnings: 0,
  };

  // Structure hash -> the turn at which we were last in that state. Shared
  // ancestry with backtrack pruning: both questions are "have I been here".
  const seenStates = new Map<string, number>();
  const stateCount = new Map<string, number>();
  let consecutiveStalls = 0;

  const finish = (reason: StopReason): DiscoveryRun => {
    metrics.durationMs = Date.now() - started;
    evidence.event('note',
      `Discovery stopped: ${reason.kind}. ${metrics.turns} turns, ${metrics.toolCalls} tool calls, `
      + `${metrics.inputTokens + metrics.outputTokens} tokens.`,
      { stop: reason, metrics });
    return {
      steps: runner.steps,
      ...(runner.terminal ? { terminal: runner.terminal } : {}),
      stop: reason,
      metrics,
      transcript: messages,
    };
  };

  for (;;) {
    // Budgets are checked before spending, not after: the point of a token
    // budget is not to report that it was exceeded.
    if (metrics.turns >= budget.maxTurns) return finish({ kind: 'max_turns', limit: budget.maxTurns });
    if (Date.now() - started >= budget.maxWallClockMs) {
      return finish({ kind: 'wall_clock', limitMs: budget.maxWallClockMs });
    }
    if (metrics.inputTokens + metrics.outputTokens >= budget.maxTokens) {
      return finish({ kind: 'token_budget', limit: budget.maxTokens });
    }

    const turn = await planner.turn({ system: opts.system, tools, messages });
    metrics.turns += 1;
    metrics.llmCalls += 1;
    metrics.inputTokens += turn.usage.inputTokens;
    metrics.outputTokens += turn.usage.outputTokens;

    evidence.event('llm.call',
      `Turn ${metrics.turns}: the model asked for ${turn.toolCalls.length} tool call(s).`,
      {
        model: planner.model,
        tools: turn.toolCalls.map((c) => c.name),
        usage: turn.usage,
      });

    messages.push({
      role: 'assistant',
      ...(turn.text === undefined ? {} : { text: turn.text }),
      toolCalls: turn.toolCalls,
    });

    // A turn with no tool call has not moved the run. One nudge, then stop -
    // a model that will not act is not going to start on the third ask.
    if (turn.toolCalls.length === 0) {
      consecutiveStalls += 1;
      if (consecutiveStalls >= 2) {
        return finish({
          kind: 'planner_stalled',
          detail: 'two consecutive turns without a tool call',
        });
      }
      messages.push({
        role: 'user',
        text: 'That turn did not use a tool. Use a tool to act, or call finish, '
          + 'declare_outcome, request_human or give_up to end the run.',
      });
      continue;
    }
    consecutiveStalls = 0;

    const results: Array<{ id: string; text: string; isError: boolean }> = [];
    for (const call of turn.toolCalls) {
      const result = await runner.run(call.name, call.input);
      metrics.toolCalls += 1;
      results.push({ id: call.id, text: result.text, isError: !result.ok });

      if (result.code === 'policy_denied' || result.code === 'needs_approval') {
        metrics.policyDenials += 1;
      }

      // The model ended the run. Stop reading its remaining tool calls: they
      // were decided before it knew this one landed.
      if (runner.terminal) break;
    }

    messages.push({ role: 'user', results });

    const terminal = runner.terminal;
    if (terminal) return finish({ kind: 'terminal', terminal });

    if (metrics.policyDenials >= budget.maxPolicyDenials) {
      return finish({ kind: 'policy_denials', limit: budget.maxPolicyDenials });
    }

    // Oscillation, on the state the run is actually in now.
    const hash = runner.snapshot?.structureHash;
    if (hash !== undefined) {
      const times = (stateCount.get(hash) ?? 0) + 1;
      stateCount.set(hash, times);

      if (times > budget.maxStateRepeats) {
        return finish({ kind: 'oscillation', hash, times });
      }
      if (times > 1) {
        const firstSeenAt = seenStates.get(hash);
        metrics.oscillationWarnings += 1;
        evidence.event('note',
          `The run is back at a screen it has already been on (seen ${times} times).`,
          { structureHash: hash, times });
        messages.push({
          role: 'user',
          text: firstSeenAt === undefined
            ? 'You are back on a screen you have already visited. Whatever you just did '
              + 'returned you to where you were - try a different approach.'
            : `You are back on the screen you were on at turn ${firstSeenAt}. Whatever you `
              + `just did returned you to where you were. Try a different approach rather `
              + `than repeating it; if there is no other route, call request_human or give_up.`,
        });
      }
      if (!seenStates.has(hash)) seenStates.set(hash, metrics.turns);
    }
  }
}
