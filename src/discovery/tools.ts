/**
 * The tool surface handed to the model.
 *
 * This is the whole of what a model can do to a bank's back office, and the
 * shape of it is the security argument. Three properties hold by construction
 * rather than by instruction:
 *
 *   The model cannot write a selector. Every tool that touches a control takes
 *   a `ref` - an opaque handle minted by the snapshot it just observed. There
 *   is no tool parameter anywhere below that accepts CSS, XPath, a locator
 *   bundle, or coordinates. Invariant #2 is enforced by the absence of a field.
 *
 *   The model cannot act on a stale observation. Refs are stamped with the
 *   observation that produced them (`o3#f2e14`), so a ref from an earlier
 *   screen is rejected by its own name rather than by luck. Decision #34 came
 *   from exactly this bug: a node captured on member 12345's page, a navigate,
 *   then a click that *succeeded* on the identically-named control belonging to
 *   a different customer. A silent rescue that services the wrong person.
 *
 *   The model cannot bypass the chokepoint. Every acting tool routes through
 *   `Executor.act()`, so policy, lease, evidence and error taxonomy apply to
 *   discovery exactly as they apply to replay.
 *
 * And one property that holds because of what happens between the ref and the
 * action: the system synthesises a LocatorBundle for the node and acts
 * *through that bundle*. The bundle recorded in the artifact is therefore the
 * one that actually drove the browser at record time, which is invariant #3.
 * A bundle that never worked cannot reach an artifact, because a bundle that
 * never worked could not have clicked anything.
 *
 * Errors are returned, never thrown. A hallucinated ref, an unlocatable
 * control and a policy refusal all come back as ordinary tool results carrying
 * what the model needs to correct itself. A thrown error ends a run; a typed
 * error ends a turn.
 */

import type {
  ActionClass, ActionSpec, ExtractSpec, LocatorBundle, Predicate, Sensitivity,
} from '../core/schema.ts';
import type { Executor } from '../exec/executor.ts';
import type { Surface } from '../surface/surface.ts';
import type { UiNode, UiSnapshot } from '../surface/uinode.ts';
import type { EvidenceWriter } from '../evidence/writer.ts';
import type { RejectedStrategy } from '../surface/locator/bundle.ts';
import { synthesizeBundle } from '../surface/locator/bundle.ts';
import { classifyAction } from '../policy/actionClass.ts';
import { interpolate } from '../surface/locator/strategies.ts';

// ---------------------------------------------------------------------------
// What a run produces
// ---------------------------------------------------------------------------

/**
 * One action the model took and the system recorded. Shaped to line up with
 * `Step` in the contract so the compiler assembles rather than translates -
 * the translation would be a second place for the two to drift apart.
 */
export interface RecordedStep {
  index: number;
  intent: string;
  action: ActionSpec;
  /** Classified here by the same function policy uses, never by the model. */
  actionClass: ActionClass;
  target?: LocatorBundle;
  /** The recorded value keeps `$input.x` references, never the literal. */
  data?: { value: string; sensitivity: Sensitivity };
  extract: ExtractSpec[];
  checkpoint: Predicate[];
  /** Structure hashes either side of the action. Backtrack pruning reads these. */
  beforeHash: string;
  afterHash: string;
  beforeUrl: string;
  afterUrl: string;
  /** Strategies generated and discarded, kept for the compile report. */
  rejected: RejectedStrategy[];
}

/** How a discovery run ended, as declared by the model. */
export type Terminal =
  | { kind: 'finish'; outputs: Record<string, unknown> }
  | {
      kind: 'declare_outcome'; code: string; description: string; severity: 'info' | 'warn';
      /**
       * Resolved from the model's own `ref`, the same way every other tool's
       * target is resolved - never synthesised from the description text.
       * Absent when the model omitted `ref` (or it didn't resolve): the
       * outcome is still recorded here, but the compiler drops it rather than
       * shipping a detector with nothing to detect (decision #122).
       */
      detectTarget?: LocatorBundle;
      expectText?: string;
    }
  | { kind: 'give_up'; reason: string }
  | { kind: 'request_human'; reason: string; question: string };

export interface ToolResult {
  ok: boolean;
  /** What the model sees. The only channel back into the loop. */
  text: string;
  /**
   * Why it failed, for the loop's bookkeeping. The loop needs to count policy
   * refusals to know when an agent is circling a wall, and matching on the
   * prose would break the moment the wording improved.
   */
  code?: ToolFailure;
}

export type ToolFailure =
  | 'no_observation' | 'bad_ref' | 'stale_ref' | 'unknown_ref'
  | 'unlocatable' | 'policy_denied' | 'needs_approval' | 'action_failed'
  | 'unknown_tool';

export interface ToolRunnerOptions {
  executor: Executor;
  surface: Surface;
  evidence: EvidenceWriter;
  /** Task inputs. Literals equal to one of these canonicalise to `$input.<name>`. */
  params: Record<string, unknown>;
  /**
   * Inputs whose values must never appear in a tool result, a recorded step or
   * a prompt. The model refers to them by reference and never sees them.
   */
  secretParams?: string[];
  /**
   * Maps a secret input name to the environment variable replay should read it
   * from - `password` -> `MERIDIAN_PASSWORD`. A credential is a property of the
   * environment, not a parameter every caller supplies, so the *recorded* step
   * says `$secret.MERIDIAN_PASSWORD` even though the model wrote
   * `$input.password`. Without this the compiled capability would demand an
   * operator password from whoever invokes it.
   */
  secretEnv?: Record<string, string>;
  /** Cap on nodes rendered into one observation, to bound the context window. */
  maxNodes?: number;
}

// ---------------------------------------------------------------------------
// The tool definitions - plain data, deliberately not the SDK's types
// ---------------------------------------------------------------------------

/**
 * Kept as inert JSON Schema so this module never imports the Anthropic SDK:
 * the planner wires these to the client, and the tool surface stays unit
 * testable without a network or a key. It also keeps the determinism boundary
 * a one-line question - this file has no model dependency to leak.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const REF = {
  type: 'string',
  description:
    'A ref exactly as printed by the most recent observe, including its o<N># prefix, '
    + 'for example "o3#f2e14". Never invent one and never reuse a ref from an earlier '
    + 'observation - the screen has moved on and the same name may now mean a different control.',
};

const INTENT = {
  type: 'string',
  description:
    'What this step is for, in the language of the task rather than the page - '
    + '"open the savings account" rather than "click the third link". This is recorded '
    + 'into the capability and read by humans reviewing it.',
};

export const DISCOVERY_TOOLS: ToolDefinition[] = [
  {
    name: 'observe',
    description:
      'Look at the screen. Returns every control worth acting on, each with a ref you can '
      + 'pass to the other tools. Call this first, and again whenever you are unsure what '
      + 'is in front of you. Acting already re-observes for you, so you rarely need two in a row.',
    input_schema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', description: 'Optional tree depth cap for a very large screen.' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click a control - a link, a button, a checkbox.',
    input_schema: {
      type: 'object',
      properties: { ref: REF, intent: INTENT },
      required: ['ref', 'intent'],
    },
  },
  {
    name: 'type',
    description:
      'Type into a field. To enter a task input, pass its reference rather than its value: '
      + 'text "$input.memberId" records a capability that works for every member, while typing '
      + '"12345" records one that only ever works for member 12345. Secret inputs can only be '
      + 'entered this way, because you are never shown their values.',
    input_schema: {
      type: 'object',
      properties: {
        ref: REF,
        text: {
          type: 'string',
          description: 'The text, or an input reference such as "$input.memberId".',
        },
        intent: INTENT,
      },
      required: ['ref', 'text', 'intent'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown.',
    input_schema: {
      type: 'object',
      properties: {
        ref: REF,
        option: { type: 'string', description: 'The option label, or an "$input.x" reference.' },
        intent: INTENT,
      },
      required: ['ref', 'option', 'intent'],
    },
  },
  {
    name: 'press',
    description:
      'Press a key, such as Enter or Tab. Pass the ref of the control it applies to whenever '
      + 'there is one: "press Enter" in a step list hides whether a form was submitted, and the '
      + 'control is what tells the system - and a human reviewer - which it was.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. "Enter".' },
        ref: REF,
        intent: INTENT,
      },
      required: ['key', 'intent'],
    },
  },
  {
    name: 'navigate',
    description:
      'Go to a URL. Prefer clicking your way there: a recorded click survives a change of '
      + 'URL scheme, a recorded URL does not. Use this for the starting screen, or when no '
      + 'control leads where you need to go.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          // URL templates are interpolated by Executor.interpolateUrl, which
          // uses braces. Text fields use $input.x. Telling the model the wrong
          // one here would produce a capability that navigates to a literal.
          description: 'Absolute URL. Reference a task input with braces, e.g. '
            + 'https://host/members/{memberId} - note this differs from text fields, '
            + 'which use $input.memberId.',
        },
        intent: INTENT,
      },
      required: ['url', 'intent'],
    },
  },
  {
    name: 'extract',
    description:
      'Read a value off the screen and record it as one of the capability\'s outputs. This is '
      + 'how the task returns an answer - a balance, a reference number, a status.',
    input_schema: {
      type: 'object',
      properties: {
        ref: REF,
        name: { type: 'string', description: 'Output name, e.g. "savingsBalance".' },
        as: {
          type: 'string',
          enum: ['text', 'currency', 'number', 'date'],
          description: 'How to parse it. Use currency for money, so the output is a number.',
        },
        sensitivity: {
          type: 'string',
          enum: ['none', 'pii', 'secret'],
          description: 'Mark anything regulated as pii so it is redacted from evidence.',
        },
        intent: INTENT,
      },
      required: ['ref', 'name', 'as', 'intent'],
    },
  },
  {
    name: 'assert',
    description:
      'Record that something must be true here for the step to have worked - the checkpoint '
      + 'replay will verify. Assert what proves you arrived, not what happens to be on screen. '
      + 'Note that this application does not change its address bar as you move around, so a '
      + 'checkpoint has to be about what is on the page.',
    input_schema: {
      type: 'object',
      properties: {
        ref: REF,
        expect_text: {
          type: 'string',
          description: 'Optional: require this text. Omit to require only that the control exists.',
        },
        intent: INTENT,
      },
      required: ['ref', 'intent'],
    },
  },
  {
    name: 'declare_outcome',
    description:
      'The application gave a legitimate answer that is not success - no such member, account '
      + 'restricted, request refused. This is information the caller asked for, not a failure, '
      + 'and recording it here is what lets replay tell the two apart. Ends the run. If the '
      + 'refusal is written somewhere on screen, pass its ref so replay can recognise the same '
      + 'condition again - without one, this outcome cannot be detected later and will be '
      + 'recorded without a detector. If you see a validation or policy error, declare it '
      + 'immediately; do not try to correct the input, retry, or find another path first.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable lower_snake code, e.g. "no_such_member".' },
        description: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'warn'] },
        ref: {
          ...REF,
          description: 'Optional: the ref of the text or banner on screen that says this '
            + `happened, so replay can recognise it again. ${REF.description}`,
        },
        expect_text: {
          type: 'string',
          description: 'Optional, only meaningful with ref: require this exact text at that '
            + 'node. Omit to require only that the node is present.',
        },
      },
      required: ['code', 'description'],
    },
  },
  {
    name: 'finish',
    description: 'The task is complete. Pass the outputs you extracted. Ends the run.',
    input_schema: {
      type: 'object',
      properties: {
        outputs: { type: 'object', description: 'Output name to value, as extracted.' },
      },
      required: ['outputs'],
    },
  },
  {
    name: 'give_up',
    description:
      'The task cannot be completed here, and no human could unblock it either. Say what you '
      + 'tried. Ends the run. Prefer request_human when a person could resolve it.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
  {
    name: 'request_human',
    description:
      'A person is needed - an approval, a credential, a judgement call that is not yours to '
      + 'make. Ends the run and hands over with your question attached.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        question: { type: 'string', description: 'The specific question for the human.' },
      },
      required: ['reason', 'question'],
    },
  },
];

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export class ToolRunner {
  #snapshot: UiSnapshot | undefined;
  #observation = 0;
  #steps: RecordedStep[] = [];
  #terminal: Terminal | undefined;

  constructor(private readonly o: ToolRunnerOptions) {}

  get steps(): readonly RecordedStep[] { return this.#steps; }
  get terminal(): Terminal | undefined { return this.#terminal; }
  get snapshot(): UiSnapshot | undefined { return this.#snapshot; }
  get observationCount(): number { return this.#observation; }

  async run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'observe':         return this.#observe(num(input.depth));
      case 'click':           return this.#act('click', input);
      case 'type':            return this.#act('type', input);
      case 'select':          return this.#act('select', input);
      case 'press':           return this.#act('press', input);
      case 'navigate':        return this.#navigate(input);
      case 'extract':         return this.#extract(input);
      case 'assert':          return this.#assert(input);
      case 'declare_outcome': return this.#declareOutcome(input);
      case 'finish':          return this.#finish(input);
      case 'give_up':         return this.#end({ kind: 'give_up', reason: str(input.reason) });
      case 'request_human':
        return this.#end({
          kind: 'request_human',
          reason: str(input.reason),
          question: str(input.question),
        });
      default:
        return fail(
          `No tool called "${name}". Available: ${DISCOVERY_TOOLS.map((t) => t.name).join(', ')}.`,
          'unknown_tool');
    }
  }

  // -------------------------------------------------------------------------

  async #observe(depth?: number): Promise<ToolResult> {
    const snapshot = await this.o.surface.observe(depth === undefined ? {} : { depth });
    this.#snapshot = snapshot;
    this.#observation += 1;
    this.o.evidence.event('observe',
      `Observed ${snapshot.title || snapshot.url} - ${snapshot.nodes.length} nodes.`,
      { url: snapshot.url, structureHash: snapshot.structureHash, observation: this.#observation });
    return { ok: true, text: this.#render(snapshot) };
  }

  /** Click, type, select and press - everything that takes a ref and changes something. */
  async #act(kind: 'click' | 'type' | 'select' | 'press', input: Record<string, unknown>): Promise<ToolResult> {
    const intent = str(input.intent);

    // `press` is the one action that may legitimately have no target.
    const wantsRef = kind !== 'press' || input.ref !== undefined;
    let node: UiNode | undefined;
    if (wantsRef) {
      const found = this.#resolveRef(input.ref);
      if (!found.ok) return found.result;
      node = found.node;
    }
    const snapshot = this.#snapshot;
    if (!snapshot) return fail('Nothing has been observed yet. Call observe first.', 'no_observation');

    // The value the model supplied, kept as written so `$input.x` survives into
    // the artifact, and resolved only on the way to the browser.
    let template: string | undefined;
    if (kind === 'type') template = str(input.text);
    if (kind === 'select') template = str(input.option);
    const sensitivity = template === undefined ? 'none' : this.#sensitivityOf(template);
    const resolved = template === undefined ? undefined : interpolate(template, this.o.params);
    const recorded = template === undefined ? undefined : this.#asRecorded(template);

    let bundle: LocatorBundle | undefined;
    let rejected: RejectedStrategy[] = [];
    if (node) {
      const synth = synthesizeBundle(node, snapshot, { description: intent, params: this.o.params });
      if (!synth.ok) {
        // Honest dead end: the control is visible but nothing durable describes
        // it, so no artifact could replay this click. Better to say so now than
        // to record a locator that only ever worked once.
        return fail(
          `That control cannot be described in a way replay could find again: ${synth.reason}. `
          + `Pick a control with a name, or one inside a table row that identifies it.`, 'unlocatable');
      }
      bundle = synth.bundle;
      rejected = synth.rejected;
    }

    const action: ActionSpec =
      kind === 'click' ? { kind: 'click' }
      : kind === 'type' ? { kind: 'type', clearFirst: true }
      : kind === 'select' ? { kind: 'select' }
      : { kind: 'press', key: str(input.key) };

    const outcome = await this.o.executor.act({
      stepId: `d${this.#steps.length + 1}`,
      action,
      ...(bundle ? { target: bundle } : {}),
      ...(resolved === undefined ? {} : { text: resolved }),
      ...(sensitivity === 'secret' ? { sensitive: true } : {}),
      params: this.o.params,
      snapshot,
    });

    if (!outcome.ok) return this.#explainFailure(outcome);

    this.#record({
      intent,
      action,
      actionClass: classifyAction(action, node),
      ...(bundle ? { target: bundle } : {}),
      ...(recorded === undefined ? {} : { data: { value: recorded, sensitivity } }),
      rejected,
      beforeHash: snapshot.structureHash,
      beforeUrl: snapshot.url,
    });

    return this.#observeAfter(outcome.snapshot);
  }

  async #navigate(input: Record<string, unknown>): Promise<ToolResult> {
    const intent = str(input.intent);
    const template = str(input.url);
    const snapshot = this.#snapshot ?? await this.o.surface.observe({});

    const action: ActionSpec = { kind: 'navigate', urlTemplate: template };
    const outcome = await this.o.executor.act({
      stepId: `d${this.#steps.length + 1}`,
      action,
      params: this.o.params,
      snapshot,
    });
    if (!outcome.ok) return this.#explainFailure(outcome);

    this.#record({
      intent,
      action,
      actionClass: classifyAction(action),
      rejected: [],
      beforeHash: snapshot.structureHash,
      beforeUrl: snapshot.url,
    });
    return this.#observeAfter(outcome.snapshot);
  }

  async #extract(input: Record<string, unknown>): Promise<ToolResult> {
    const found = this.#resolveRef(input.ref);
    if (!found.ok) return found.result;
    const snapshot = this.#snapshot!;
    const intent = str(input.intent);
    const name = str(input.name);

    const synth = synthesizeBundle(found.node, snapshot, {
      description: `value of ${name}`,
      params: this.o.params,
      // This node's own text is the value about to be read - a strategy keyed
      // on it is certain to be wrong on the next render, not merely likely to
      // go stale eventually (decision #126).
      forExtraction: true,
    });
    if (!synth.ok) {
      return fail(`That value cannot be described for replay: ${synth.reason}.`, 'unlocatable');
    }

    // Read before acting. `act` re-observes, which retires this node, and the
    // surface refuses to touch a node from an earlier observation (#34). The
    // action is read-only, so reading first changes nothing.
    //
    // This call goes straight to the surface rather than through
    // `executor.act()`, so - unlike every other tool here - it does not get
    // that chokepoint's try/catch for free. `readText` can throw the same
    // staleness `SurfaceError` a click or type would (a ref from a prior
    // observation, reused after something else already navigated in the same
    // turn), so it needs the identical typed-result treatment: returned to
    // the model as a correctable tool result, never thrown out of the loop.
    const sensitivityEarly = (str(input.sensitivity) || 'none') as Sensitivity;
    let shown: string;
    if (sensitivityEarly === 'none') {
      try {
        shown = await this.o.surface.readText(found.node);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.o.evidence.event('action', `extract failed: ${message}`,
          { actionKind: 'extract', error: message });
        return this.#explainFailure({
          ok: false, code: 'surface_error', retryable: true,
          expected: `to read the value of "${name}" from "${found.node.name || found.node.role}"`,
          observed: message,
        });
      }
    } else {
      shown = '[redacted]';
    }

    const action: ActionSpec = { kind: 'extract' };
    const outcome = await this.o.executor.act({
      stepId: `d${this.#steps.length + 1}`,
      action,
      target: synth.bundle,
      params: this.o.params,
      snapshot,
    });
    if (!outcome.ok) return this.#explainFailure(outcome);

    const sensitivity = sensitivityEarly;
    const spec: ExtractSpec = {
      name,
      from: synth.bundle,
      parse: parseSpecFor(str(input.as)),
      sensitivity,
    };

    this.#record({
      intent,
      action,
      actionClass: classifyAction(action, found.node),
      target: synth.bundle,
      extract: [spec],
      rejected: synth.rejected,
      beforeHash: snapshot.structureHash,
      beforeUrl: snapshot.url,
    });

    return { ok: true, text: `Recorded output "${name}" (${str(input.as)}). Current value: ${shown}` };
  }

  async #assert(input: Record<string, unknown>): Promise<ToolResult> {
    const found = this.#resolveRef(input.ref);
    if (!found.ok) return found.result;
    const snapshot = this.#snapshot!;
    const intent = str(input.intent);

    const synth = synthesizeBundle(found.node, snapshot, { description: intent, params: this.o.params });
    if (!synth.ok) return fail(`That checkpoint cannot be described for replay: ${synth.reason}.`, 'unlocatable');

    const expect = input.expect_text === undefined ? undefined : str(input.expect_text);
    const predicate: Predicate = expect === undefined
      ? { kind: 'node_present', locator: synth.bundle }
      : { kind: 'text_matches', locator: synth.bundle, pattern: escapeRegex(expect) };

    // A checkpoint belongs to the step whose screen it proves. If nothing has
    // happened yet it stands alone, describing the state the flow starts from.
    const last = this.#steps[this.#steps.length - 1];
    if (last) {
      last.checkpoint.push(predicate);
    } else {
      this.#record({
        intent,
        action: { kind: 'assert' },
        actionClass: classifyAction({ kind: 'assert' }, found.node),
        target: synth.bundle,
        checkpoint: [predicate],
        rejected: synth.rejected,
        beforeHash: snapshot.structureHash,
        beforeUrl: snapshot.url,
      });
    }

    this.o.evidence.event('checkpoint', `Recorded checkpoint: ${intent}`, { expect }, `d${this.#steps.length}`);
    return { ok: true, text: `Checkpoint recorded: ${intent}` };
  }

  async #declareOutcome(input: Record<string, unknown>): Promise<ToolResult> {
    const severity = str(input.severity) === 'warn' ? 'warn' : 'info';
    const expectText = input.expect_text === undefined ? undefined : str(input.expect_text);

    // `ref` is optional here, unlike `assert` - the model is ending the run
    // either way, and refusing to end it over an unlocatable node would be
    // worse than shipping an undetectable (and therefore dropped, decision
    // #122) outcome. A bad ref is still reported, so the model sees why.
    let detectTarget: LocatorBundle | undefined;
    if (input.ref !== undefined) {
      const found = this.#resolveRef(input.ref);
      if (!found.ok) return found.result;
      const snapshot = this.#snapshot!;
      const synth = synthesizeBundle(found.node, snapshot, {
        description: str(input.description) || `outcome ${str(input.code)}`,
        params: this.o.params,
      });
      if (synth.ok) detectTarget = synth.bundle;
      // Synthesis failing here is not a reason to fail the tool call - the
      // model saw a real refusal and is reporting it; the compiler is the
      // place that decides an undetectable outcome should be dropped.
    }

    return this.#end({
      kind: 'declare_outcome',
      code: str(input.code),
      description: str(input.description),
      severity,
      ...(detectTarget ? { detectTarget } : {}),
      ...(expectText !== undefined ? { expectText } : {}),
    });
  }

  async #finish(input: Record<string, unknown>): Promise<ToolResult> {
    const outputs = typeof input.outputs === 'object' && input.outputs !== null
      ? input.outputs as Record<string, unknown>
      : {};
    return this.#end({ kind: 'finish', outputs });
  }

  #end(t: Terminal): ToolResult {
    this.#terminal = t;
    this.o.evidence.event('note', `Discovery ended: ${t.kind}.`, { ...t });
    return { ok: true, text: `Recorded. The run ends here (${t.kind}).` };
  }

  // -------------------------------------------------------------------------
  // Ref handling - where a hallucination becomes a correctable turn
  // -------------------------------------------------------------------------

  #resolveRef(raw: unknown): { ok: true; node: UiNode } | { ok: false; result: ToolResult } {
    const snapshot = this.#snapshot;
    if (!snapshot) {
      return { ok: false, result: fail('Nothing has been observed yet. Call observe first.', 'no_observation') };
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, result: fail('That tool needs a ref from the most recent observe.', 'bad_ref') };
    }

    const m = /^o(\d+)#(.+)$/.exec(raw.trim());
    if (!m) {
      return { ok: false, result: fail(
        `"${raw}" is not a ref. Refs look like "o${this.#observation}#f2e14" and are printed by observe. `
        + `${this.#refHint(snapshot)}`, 'bad_ref') };
    }

    // The stale-ref guard. Without the observation stamp this check is
    // impossible: refs are reused across renders, so an old one can silently
    // match a different control on the new screen.
    const seen = Number(m[1]);
    if (seen !== this.#observation) {
      return { ok: false, result: fail(
        `That ref is from observation ${seen} and the screen is now at observation ${this.#observation}. `
        + `Refs do not survive a change of screen - the same name can mean a different control. `
        + `Use a ref from the observation above, or call observe again.`, 'stale_ref') };
    }

    const node = snapshot.nodes.find((n) => n.ref === m[2]);
    if (!node) {
      return { ok: false, result: fail(
        `No control "${raw}" on this screen. ${this.#refHint(snapshot)}`, 'unknown_ref') };
    }
    return { ok: true, node };
  }

  /** Listing the real refs is what turns a wrong guess into a corrected turn. */
  #refHint(snapshot: UiSnapshot): string {
    const actionable = snapshot.nodes.filter(isActionable).slice(0, 25);
    if (actionable.length === 0) return 'There are no actionable controls on this screen.';
    return `Controls here: ${actionable.map((n) => `o${this.#observation}#${n.ref} (${n.role} "${n.name}")`).join(', ')}.`;
  }

  // -------------------------------------------------------------------------

  /** Translates the executor's typed failure into something the model can act on. */
  #explainFailure(outcome: Extract<Awaited<ReturnType<Executor['act']>>, { ok: false }>): ToolResult {
    if (outcome.code === 'policy_denied') {
      return fail(
        `Policy refuses this action: ${outcome.observed}. This is not something you can work `
        + `around - do not try another route to the same effect. If the task genuinely requires `
        + `it, call request_human.`, 'policy_denied');
    }
    if (outcome.code === 'needs_approval') {
      return fail(
        `This action needs human approval before it can run: ${outcome.observed}. `
        + `Call request_human and say what you are trying to do.`, 'needs_approval');
    }
    return fail(
      `The ${outcome.code.replace(/_/g, ' ')} - expected ${outcome.expected}, observed ${outcome.observed}.`
      + (outcome.retryable ? ' Observe again and reconsider; the screen may still have been moving.' : ''));
  }

  #record(partial: Omit<RecordedStep, 'index' | 'afterHash' | 'afterUrl' | 'extract' | 'checkpoint'>
    & Partial<Pick<RecordedStep, 'extract' | 'checkpoint'>>): void {
    this.#steps.push({
      index: this.#steps.length,
      extract: [],
      checkpoint: [],
      // Filled by #observeAfter; a step is not complete until we have looked at
      // what it did, which is also what makes oscillation detectable.
      afterHash: partial.beforeHash,
      afterUrl: partial.beforeUrl,
      ...partial,
    });
  }

  /**
   * Waits for the page to stop moving, then shows it.
   *
   * The executor snapshots the instant its action returns, which for anything
   * that navigates is the *old* screen - replay never notices because its
   * `waitFor` predicates re-observe until they pass, but discovery has no
   * predicate to wait on yet. So: observe until two consecutive observations
   * agree on structure.
   *
   * That is a state predicate, not a duration (invariant #5) - it asks "has
   * the page stopped changing", and a settled page answers on the first extra
   * observation. Bounded, so a page that animates forever costs a known amount
   * rather than hanging the run.
   */
  async #settled(first: UiSnapshot): Promise<UiSnapshot> {
    // Ask the surface first: it can see in-flight requests, which two quick
    // samples cannot. Without this, both samples land before the navigation
    // even starts, agree with each other, and declare the old screen settled.
    await this.o.surface.settle?.();

    let previous = first;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = await this.o.surface.observe();
      if (next.structureHash === previous.structureHash) return next;
      previous = next;
    }
    return previous;
  }

  async #observeAfter(observed: UiSnapshot): Promise<ToolResult> {
    const snapshot = await this.#settled(observed);
    this.#snapshot = snapshot;
    this.#observation += 1;
    const last = this.#steps[this.#steps.length - 1];
    if (last) {
      last.afterHash = snapshot.structureHash;
      last.afterUrl = snapshot.url;
    }
    return { ok: true, text: this.#render(snapshot) };
  }

  #sensitivityOf(template: string): Sensitivity {
    const secrets = this.o.secretParams ?? [];
    return secrets.some((s) => template.includes(`$input.${s}`)) ? 'secret' : 'none';
  }

  /** What goes into the artifact, as opposed to what goes into the browser. */
  #asRecorded(template: string): string {
    let out = template;
    for (const [name, env] of Object.entries(this.o.secretEnv ?? {})) {
      out = out.split(`$input.${name}`).join(`$secret.${env}`);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Rendering - the model's entire view of the screen
  // -------------------------------------------------------------------------

  #render(snapshot: UiSnapshot): string {
    const cap = this.o.maxNodes ?? 120;
    const interesting = snapshot.nodes.filter(isInteresting);
    // Actionable controls first: if anything has to be dropped, it must not be
    // the thing the model needs to click.
    const ranked = [...interesting].sort((a, b) => rank(isActionable(a)) - rank(isActionable(b)));
    const shown = ranked.slice(0, cap);
    const dropped = interesting.length - shown.length + snapshot.truncatedNodes;

    const lines = shown
      .sort((a, b) => interesting.indexOf(a) - interesting.indexOf(b))
      .map((n) => this.#line(n));

    const header = [
      `Observation ${this.#observation} - ${snapshot.title || '(untitled)'}`,
      `url: ${snapshot.url}`,
      snapshot.blockingDialog
        ? `A dialog is open and covering the page: "${snapshot.blockingDialog.name}". `
          + `Deal with it before anything else.`
        : undefined,
    ].filter((s): s is string => s !== undefined);

    const footer = dropped > 0
      ? `\n(${dropped} further nodes not shown. Narrow with observe depth if you need them.)`
      : '';

    return `${header.join('\n')}\n\n${lines.join('\n')}${footer}`;
  }

  #line(n: UiNode): string {
    const bits = [`o${this.#observation}#${n.ref}`, n.role];
    if (n.name) bits.push(JSON.stringify(n.name));
    if (n.value !== undefined && n.value !== '') bits.push(`= ${JSON.stringify(n.value)}`);

    const tc = n.tableContext;
    if (tc?.colHeader !== undefined) {
      const where = tc.table ? `${tc.table} ` : '';
      bits.push(`[${where}row ${(tc.rowIndex ?? 0)}, ${tc.colHeader}]`);
    } else if (n.nearestLabels.length > 0) {
      bits.push(`[labelled ${JSON.stringify(n.nearestLabels[0]!)}]`);
    }

    const state = Object.entries(n.state).filter(([, v]) => v === true).map(([k]) => k);
    if (state.length > 0) bits.push(`(${state.join(', ')})`);
    return `  ${bits.join(' ')}`;
  }
}

// ---------------------------------------------------------------------------

/** Controls worth offering: anything the model could act on, plus readable text. */
function isInteresting(n: UiNode): boolean {
  if (isActionable(n)) return true;
  return n.name.trim() !== '' || (n.value !== undefined && n.value.trim() !== '');
}

function isActionable(n: UiNode): boolean {
  return ['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'option']
    .includes(n.role);
}

function parseSpecFor(as: string): ExtractSpec['parse'] {
  switch (as) {
    case 'currency': return { kind: 'currency', locale: 'en-US' };
    case 'number':   return { kind: 'number' };
    case 'date':     return { kind: 'date' };
    default:         return { kind: 'text', trim: true };
  }
}

function fail(text: string, code: ToolFailure = 'action_failed'): ToolResult {
  return { ok: false, text, code };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function rank(b: boolean): number {
  return b ? 0 : 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
