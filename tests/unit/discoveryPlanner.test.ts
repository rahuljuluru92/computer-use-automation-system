/**
 * The Anthropic adapter.
 *
 * Everything here is mapping, so everything here is testable with a fake client
 * and no key. The two properties worth guarding are that an assistant turn is
 * replayed byte-for-byte rather than reconstructed, and that a refusal - which
 * arrives as a perfectly successful HTTP response - is not read as an empty turn.
 */

import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicPlanner, PlannerError, DEFAULT_MODEL } from '../../src/discovery/planner.ts';
import type { LoopMessage } from '../../src/discovery/loop.ts';
import { DISCOVERY_TOOLS } from '../../src/discovery/tools.ts';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** Captures the request and returns a canned message. */
function fakeClient(reply: Partial<Anthropic.Message> | (() => never)) {
  const sent: CreateParams[] = [];
  const client = {
    messages: {
      create: async (params: CreateParams) => {
        sent.push(params);
        if (typeof reply === 'function') reply();
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: DEFAULT_MODEL,
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
          ...reply,
        } as Anthropic.Message;
      },
    },
  };
  return { client: client as unknown as Anthropic, sent };
}

const observeCall = {
  type: 'tool_use' as const, id: 'tu_1', name: 'observe', input: { depth: 3 },
};

const baseRequest = (messages: LoopMessage[]) => ({
  system: 'you are discovering a procedure',
  tools: DISCOVERY_TOOLS,
  messages,
});

describe('mapping a response back to the loop', () => {
  it('extracts tool calls with their parsed input', async () => {
    const { client } = fakeClient({ content: [observeCall] });
    const turn = await new AnthropicPlanner({ client }).turn(
      baseRequest([{ role: 'user', text: 'Begin.' }]));

    expect(turn.toolCalls).toEqual([{ id: 'tu_1', name: 'observe', input: { depth: 3 } }]);
  });

  it('reports token usage, including what the cache served', async () => {
    const { client } = fakeClient({
      content: [observeCall],
      usage: {
        input_tokens: 120, output_tokens: 40,
        cache_read_input_tokens: 8000, cache_creation_input_tokens: 250,
      } as Anthropic.Usage,
    });
    const turn = await new AnthropicPlanner({ client }).turn(
      baseRequest([{ role: 'user', text: 'Begin.' }]));

    expect(turn.usage).toEqual({
      inputTokens: 120, outputTokens: 40, cacheReadTokens: 8000, cacheWriteTokens: 250,
    });
  });

  it('defaults to Opus 5', async () => {
    const { client, sent } = fakeClient({ content: [observeCall] });
    const planner = new AnthropicPlanner({ client });
    await planner.turn(baseRequest([{ role: 'user', text: 'Begin.' }]));

    expect(planner.model).toBe('claude-opus-5');
    expect(sent[0]!.model).toBe('claude-opus-5');
  });
});

describe('replaying an assistant turn', () => {
  it('sends back exactly what the model produced, not a reconstruction', async () => {
    // The response carried a reasoning block. Rebuilding the turn from the text
    // and tool calls the loop knows about would silently drop it, and reasoning
    // blocks have to be echoed back unaltered to the model that produced them.
    const raw = [
      { type: 'thinking', thinking: 'the savings row is the one I want', signature: 'sig' },
      { type: 'text', text: 'Opening the savings account.' },
      observeCall,
    ];
    const { client, sent } = fakeClient({ content: [observeCall] });

    await new AnthropicPlanner({ client }).turn(baseRequest([
      { role: 'user', text: 'Begin.' },
      { role: 'assistant', text: 'Opening the savings account.', toolCalls: [], raw },
      { role: 'user', results: [{ id: 'tu_1', text: 'ok', isError: false }] },
    ]));

    const assistant = sent[0]!.messages[1]!;
    expect(assistant.content).toBe(raw);
  });

  it('falls back to rebuilding when there is no raw turn to replay', async () => {
    const { client, sent } = fakeClient({ content: [observeCall] });
    await new AnthropicPlanner({ client }).turn(baseRequest([
      { role: 'user', text: 'Begin.' },
      { role: 'assistant', text: 'thinking out loud', toolCalls: [{ id: 'x', name: 'observe', input: {} }] },
      // A trailing user turn, as the loop always sends: it keeps the rolling
      // cache breakpoint off the message under test.
      { role: 'user', results: [{ id: 'x', text: 'ok', isError: false }] },
    ]));

    expect(sent[0]!.messages[1]!.content).toEqual([
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', id: 'x', name: 'observe', input: {} },
    ]);
  });
});

describe('sending tool results', () => {
  it('puts every result for a turn in one user message', async () => {
    // Splitting them across messages teaches the model to stop asking for
    // parallel calls, which costs turns for nothing.
    const { client, sent } = fakeClient({ content: [observeCall] });
    await new AnthropicPlanner({ client }).turn(baseRequest([
      { role: 'user', text: 'Begin.' },
      { role: 'assistant', toolCalls: [] },
      {
        role: 'user',
        results: [
          { id: 'a', text: 'first', isError: false },
          { id: 'b', text: 'second failed', isError: true },
        ],
      },
    ]));

    const content = sent[0]!.messages[2]!.content as Anthropic.ContentBlockParam[];
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a', content: 'first' });
    expect(content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'b', is_error: true });
  });

  it('marks only failures as errors', async () => {
    const { client, sent } = fakeClient({ content: [observeCall] });
    await new AnthropicPlanner({ client }).turn(baseRequest([
      { role: 'user', results: [{ id: 'a', text: 'fine', isError: false }] },
    ]));

    const content = sent[0]!.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).not.toHaveProperty('is_error');
  });
});

describe('prompt caching', () => {
  it('caches the system prompt, which never changes within a run', async () => {
    const { client, sent } = fakeClient({ content: [observeCall] });
    await new AnthropicPlanner({ client }).turn(baseRequest([{ role: 'user', text: 'Begin.' }]));

    const system = sent[0]!.system as Anthropic.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('caches the end of the transcript, so the next turn reads this one back', async () => {
    const { client, sent } = fakeClient({ content: [observeCall] });
    await new AnthropicPlanner({ client }).turn(baseRequest([
      { role: 'user', text: 'Begin.' },
      { role: 'assistant', toolCalls: [] },
      { role: 'user', results: [{ id: 'a', text: 'a whole screen of observation', isError: false }] },
    ]));

    const last = sent[0]!.messages[2]!.content as Anthropic.ContentBlockParam[];
    expect(last[last.length - 1]).toHaveProperty('cache_control', { type: 'ephemeral' });
  });
});

describe('failures the loop has to be told about', () => {
  it('treats a refusal as an error rather than an empty turn', async () => {
    // A refusal is a 200. Reading content without checking stop_reason would
    // hand the loop a turn with no tool calls and no explanation, which it
    // would score as a stall.
    const { client } = fakeClient({ stop_reason: 'refusal' as Anthropic.StopReason, content: [] });

    await expect(new AnthropicPlanner({ client }).turn(
      baseRequest([{ role: 'user', text: 'Begin.' }])))
      .rejects.toThrow(/declined this request/);
  });

  it('says what to do about a rejected credential, and that retrying will not help', async () => {
    const { client } = fakeClient(() => {
      throw new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers());
    });

    await expect(new AnthropicPlanner({ client }).turn(
      baseRequest([{ role: 'user', text: 'Begin.' }])))
      .rejects.toMatchObject({ name: 'PlannerError', retryable: false });
  });

  it('marks a rate limit as worth retrying', async () => {
    const { client } = fakeClient(() => {
      throw new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers());
    });

    const err = await new AnthropicPlanner({ client })
      .turn(baseRequest([{ role: 'user', text: 'Begin.' }]))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlannerError);
    expect((err as PlannerError).retryable).toBe(true);
  });
});
