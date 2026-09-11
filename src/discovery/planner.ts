/**
 * The only file in this system that knows Anthropic exists.
 *
 * It contains no decisions. It maps a `PlannerRequest` onto one Messages API
 * call and maps the response back into a `PlannerTurn`, and that is all. Every
 * judgement about what to do with a turn - budgets, oscillation, refusals,
 * when to stop - lives in `loop.ts`, which has no model dependency and is
 * therefore testable without a key.
 *
 * That split is also what makes invariant #1 cheap to enforce. "Does replay
 * call a model?" reduces to "does anything on the replay path import this
 * file?", which eslint answers at build time.
 *
 * ## Two things here are less obvious than they look
 *
 * **Assistant turns are replayed verbatim.** The response's `content` array is
 * carried back through `PlannerTurn.raw` and returned to the API unchanged,
 * rather than rebuilt from the text and tool calls the loop knows about.
 * Rebuilding would silently drop reasoning blocks, which must be echoed back
 * unaltered to the model that produced them.
 *
 * **Thinking and effort are deliberately not set.** On Claude Opus 5 thinking
 * is on by default and effort defaults to high, so omitting both parameters is
 * exactly the configuration we want - and it keeps this file working against
 * the installed SDK, which predates `output_config`. If the SDK is upgraded,
 * the place to set effort explicitly is the request below, not a call site.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LoopMessage, Planner, PlannerRequest, PlannerTurn } from './loop.ts';
import type { ToolDefinition } from './tools.ts';

/**
 * Default per the model guidance in `claude-api`: Opus 5 unless a caller names
 * something else. Not lowered for cost - that is the operator's call to make,
 * explicitly, not one to bury in a default.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Discovery turns are short - a sentence of reasoning and a tool call - so a
 * non-streaming request at this ceiling stays well inside the SDK's HTTP
 * timeout. Streaming would buy nothing here and would complicate the seam.
 */
const MAX_TOKENS = 16_000;

export interface AnthropicPlannerOptions {
  model?: string;
  maxTokens?: number;
  /** Injectable for tests; constructed from the environment otherwise. */
  client?: Anthropic;
}

/** Raised when the API answered, but not with something the loop can use. */
export class PlannerError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'PlannerError';
  }
}

export class AnthropicPlanner implements Planner {
  readonly model: string;
  readonly #client: Anthropic;
  readonly #maxTokens: number;

  constructor(opts: AnthropicPlannerOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.#maxTokens = opts.maxTokens ?? MAX_TOKENS;
    // The SDK resolves credentials itself - ANTHROPIC_API_KEY, an auth token,
    // or a logged-in profile - so an unset API key does not mean no
    // credentials. It also retries 429 and 5xx on its own; adding a second
    // retry layer here would multiply the backoff without improving anything.
    this.#client = opts.client ?? new Anthropic();
  }

  async turn(req: PlannerRequest): Promise<PlannerTurn> {
    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create({
        model: this.model,
        max_tokens: this.#maxTokens,
        // Render order is tools -> system -> messages. Two breakpoints: one
        // after the system prompt, which never changes within a run, and one
        // at the end of the transcript, which is rewritten every turn but is
        // append-only - so each turn reads the previous turn's prefix back
        // instead of paying for the whole conversation again. The transcript
        // grows by an entire screen per turn, so this is the larger of the two.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        tools: req.tools.map(toSdkTool),
        messages: withRollingCacheBreakpoint(req.messages.map(toSdkMessage)),
      });
    } catch (e) {
      throw asPlannerError(e);
    }

    // A refusal arrives as a successful response, so reading content without
    // checking would hand the loop an empty turn and no explanation.
    if ((message.stop_reason as string) === 'refusal') {
      throw new PlannerError(
        'The model declined this request. Discovery cannot continue; a human should '
        + 'look at the task and the target application.',
        false);
    }

    const toolCalls = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        // The SDK has already parsed this. Never match on its serialised form:
        // escaping of unicode and slashes is not stable across models.
        input: (b.input ?? {}) as Record<string, unknown>,
      }));

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const usage = message.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };

    return {
      ...(text === '' ? {} : { text }),
      toolCalls,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(typeof usage.cache_read_input_tokens === 'number'
          ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
        ...(typeof usage.cache_creation_input_tokens === 'number'
          ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
      },
      // Verbatim, for the next request. See the header note.
      raw: message.content,
    };
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Marks the end of the transcript as cacheable, so the next turn reads this
 * turn's prefix rather than re-paying for it. Append-only by construction: the
 * loop never edits an earlier message, which is what makes the prefix stable.
 */
function withRollingCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === 'string' || last.content.length === 0) return messages;

  const blocks = [...last.content];
  const tail = blocks[blocks.length - 1]!;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;

  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

function toSdkTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  };
}

function toSdkMessage(m: LoopMessage): Anthropic.MessageParam {
  if (m.role === 'assistant') {
    // Replay what the model actually said, not a reconstruction of it.
    if (m.raw !== undefined) {
      return { role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] };
    }
    const content: Anthropic.ContentBlockParam[] = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const c of m.toolCalls) {
      content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    }
    return { role: 'assistant', content };
  }

  // Every tool result for one turn goes back in a single user message.
  // Splitting them across messages teaches the model to stop asking for
  // parallel calls, which costs turns for no reason.
  const content: Anthropic.ContentBlockParam[] = [];
  for (const r of m.results ?? []) {
    content.push({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.text,
      ...(r.isError ? { is_error: true } : {}),
    });
  }
  if (m.text) content.push({ type: 'text', text: m.text });
  return { role: 'user', content };
}

/**
 * Most specific first. The distinction that matters to a caller is whether
 * waiting would help: a rate limit or an overloaded server is worth another
 * attempt, a malformed request or a bad key never is.
 */
function asPlannerError(e: unknown): PlannerError {
  if (e instanceof Anthropic.AuthenticationError) {
    return new PlannerError(
      'The Anthropic API rejected the credentials. Set ANTHROPIC_API_KEY, or sign in '
      + 'so the SDK can find a profile.', false);
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new PlannerError(`The API rejected the request: ${e.message}`, false);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new PlannerError(`Rate limited, and the SDK's retries did not clear it: ${e.message}`, true);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new PlannerError(`Could not reach the Anthropic API: ${e.message}`, true);
  }
  if (e instanceof Anthropic.APIError) {
    return new PlannerError(`Anthropic API error ${e.status}: ${e.message}`, (e.status ?? 0) >= 500);
  }
  return new PlannerError(e instanceof Error ? e.message : String(e), false);
}
