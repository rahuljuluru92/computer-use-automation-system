/**
 * The chokepoint.
 *
 * Every action taken against any surface, by discovery or by replay, goes
 * through `Executor.act()`. Nothing else in the system calls a Surface method
 * that changes anything. That single fact is what makes four separate promises
 * enforceable rather than aspirational:
 *
 *   policy    - a guardrail that cannot be talked out of, because it is not
 *               being asked; it is the function that decides whether the
 *               browser gets called.
 *   lease     - only whoever currently holds control may act, at the
 *               generation they planned under.
 *   evidence  - nothing happens without a record of it, because the record is
 *               written by the same function that does the thing.
 *   taxonomy  - one place classifies what went wrong, so every caller gets the
 *               same vocabulary.
 *
 * Discovery and replay share this. That is deliberate: it means a locator
 * bundle recorded during discovery was resolved by exactly the code that will
 * resolve it in production, so an artifact cannot contain a bundle that has
 * never actually worked.
 */

import type { ActionSpec, ActionClass, LocatorBundle } from '../core/schema.ts';
import type { Surface } from '../surface/surface.ts';
import { SurfaceError } from '../surface/surface.ts';
import type { UiNode, UiSnapshot } from '../surface/uinode.ts';
import type { ResolutionTrace, DriftRecord, FailureCode } from '../core/result.ts';
import { resolveBundle } from '../surface/locator/resolve.ts';
import type { PolicyEngine} from '../policy/policyEngine.ts';
import { type PolicyDecision } from '../policy/policyEngine.ts';
import type { SessionLease, LeaseViolation } from './lease.ts';
import type { EvidenceWriter } from '../evidence/writer.ts';

export interface ExecutorOptions {
  surface: Surface;
  policy: PolicyEngine;
  lease: SessionLease;
  evidence: EvidenceWriter;
  /** The caller has authorised irreversible actions for this run. */
  approvalGranted?: boolean;
}

export interface ActRequest {
  stepId: string;
  action: ActionSpec;
  /** Absent for actions with no target, such as navigate or press. */
  target?: LocatorBundle | undefined;
  /** Already-materialised text, secrets resolved. */
  text?: string | undefined;
  declaredClass?: ActionClass | undefined;
  params: Record<string, unknown>;
  snapshot: UiSnapshot;
  /** Marks the value as sensitive, so it is registered before it is typed. */
  sensitive?: boolean;
}

export type ActOutcome =
  | { ok: true; node?: UiNode; resolution?: ResolutionTrace; drift?: DriftRecord; snapshot: UiSnapshot }
  | { ok: false; code: FailureCode; expected: string; observed: string; retryable: boolean }
  | { ok: false; code: 'needs_approval'; expected: string; observed: string; decision: PolicyDecision }
  | { ok: false; code: 'policy_denied'; expected: string; observed: string; decision: PolicyDecision };

export class Executor {
  #plannedGeneration: number;

  constructor(private readonly o: ExecutorOptions) {
    this.#plannedGeneration = o.lease.generation;
  }

  /** Called after a handoff, so subsequent actions carry the new generation. */
  syncGeneration(): number {
    this.#plannedGeneration = this.o.lease.generation;
    return this.#plannedGeneration;
  }

  get plannedGeneration(): number { return this.#plannedGeneration; }

  async act(req: ActRequest): Promise<ActOutcome> {
    const { surface, policy, lease, evidence } = this.o;

    // 1. Control. An action decided before a handoff must not land after it.
    try {
      lease.assertHeldBy('automation', this.#plannedGeneration);
    } catch (e) {
      const v = e as LeaseViolation;
      evidence.event('policy.check', v.message, { expected: v.expected, actual: v.actual }, req.stepId);
      return { ok: false, code: 'surface_error', retryable: false,
        expected: `automation holds the session at generation ${this.#plannedGeneration}`,
        observed: `${v.actual.controller} holds it at generation ${v.actual.generation}` };
    }

    // 2. Resolve, if this action has a target.
    let node: UiNode | undefined;
    let resolution: ResolutionTrace | undefined;
    let drift: DriftRecord | undefined;

    if (req.target) {
      const r = resolveBundle(req.target, req.snapshot, req.params, { stepId: req.stepId });
      if (!r.ok) {
        evidence.event('locator.fail', `Could not find ${req.target.description}. ${r.error.detail}`,
          { ...r.error }, req.stepId);
        return {
          ok: false,
          code: r.error.reason === 'ambiguous' ? 'locator_ambiguous' : 'locator_unresolved',
          expected: req.target.description,
          observed: r.error.detail,
          // Worth one more look: the page may simply not have finished moving.
          retryable: true,
        };
      }
      node = r.value.node;
      resolution = r.value.trace;
      drift = r.value.drift;

      evidence.event('locator.resolve',
        resolution.degraded
          ? `Found ${req.target.description} via tier ${resolution.winningTier} after the preferred `
            + `strategy missed; ${resolution.agreement} strategies agree, so proceeding degraded.`
          : `Found ${req.target.description} via tier ${resolution.winningTier}.`,
        { ...resolution }, req.stepId);

      if (drift) {
        evidence.event('drift', drift.note, { ...drift }, req.stepId);
      }
    }

    // 3. Policy. Before anything touches the browser.
    const destinationUrl = req.action.kind === 'navigate'
      ? interpolateUrl(req.action.urlTemplate, req.params)
      : undefined;

    const decision = policy.check({
      action: req.action,
      target: node,
      currentUrl: req.snapshot.url,
      destinationUrl,
      declaredClass: req.declaredClass,
      approvalGranted: this.o.approvalGranted ?? false,
    });

    evidence.event('policy.check',
      decision.verdict === 'allow'
        ? `Policy allows this ${decision.actionClass} action.`
        : `Policy says ${decision.verdict}: ${decision.reason}`,
      { ...decision }, req.stepId);

    if (decision.verdict === 'deny') {
      return { ok: false, code: 'policy_denied', decision,
        expected: `an action permitted by policy`, observed: decision.reason };
    }
    if (decision.verdict === 'require_approval') {
      return { ok: false, code: 'needs_approval', decision,
        expected: `approval for a ${decision.actionClass} action`, observed: decision.reason };
    }

    // 4. Refuse to act behind a dialog nobody has accounted for. Clicking
    //    something underneath a modal is how automation ends up doing the
    //    right thing to the wrong screen.
    if (req.snapshot.blockingDialog && req.action.kind !== 'assert' && req.action.kind !== 'extract') {
      const d = req.snapshot.blockingDialog;
      if (!node || !isInsideDialog(node, d.name)) {
        evidence.event('locator.fail',
          `Refusing to act: "${d.name}" is open and covering the page. `
          + `No recovery rule claimed it.`, { dialog: d }, req.stepId);
        return { ok: false, code: 'precondition_failed', retryable: false,
          expected: 'no blocking dialog', observed: `"${d.name}" is open` };
      }
    }

    // 5. Do it.
    const started = Date.now();
    try {
      await this.#dispatch(req, node, destinationUrl);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      evidence.event('action', `The ${req.action.kind} failed: ${message}`,
        { actionKind: req.action.kind, error: message }, req.stepId);
      return {
        ok: false,
        code: e instanceof SurfaceError ? 'surface_error' : 'surface_error',
        expected: `${req.action.kind} on "${node?.name ?? destinationUrl ?? 'the page'}"`,
        observed: message,
        // A stale node is the common cause and re-observing usually fixes it.
        retryable: true,
      };
    }

    evidence.event('action',
      `${describeAction(req.action)}${node ? ` on "${node.name || node.role}"` : ''}.`,
      { actionKind: req.action.kind, durationMs: Date.now() - started,
        target: node ? { role: node.role, name: node.name, frame: node.frameChain } : undefined },
      req.stepId);

    const snapshot = await surface.observe();
    return { ok: true, snapshot, ...(node ? { node } : {}), ...(resolution ? { resolution } : {}), ...(drift ? { drift } : {}) };
  }

  async #dispatch(req: ActRequest, node: UiNode | undefined, destinationUrl?: string): Promise<void> {
    const { surface } = this.o;
    switch (req.action.kind) {
      case 'click':
        await surface.click(expectNode(node, 'click'));
        return;
      case 'type':
        await surface.type(expectNode(node, 'type'), req.text ?? '',
          { clearFirst: req.action.clearFirst });
        return;
      case 'select':
        await surface.select(expectNode(node, 'select'), req.text ?? '');
        return;
      case 'press':
        await surface.press(req.action.key);
        return;
      case 'navigate':
        await surface.navigate(destinationUrl ?? req.action.urlTemplate);
        return;
      case 'scroll':
        await surface.scroll(req.action.direction, req.action.amount);
        return;
      case 'extract':
      case 'assert':
        return; // read-only; handled by the step runner
    }
  }
}

function expectNode(node: UiNode | undefined, what: string): UiNode {
  if (!node) throw new SurfaceError(`${what} requires a target, but none was resolved`);
  return node;
}

function isInsideDialog(node: UiNode, dialogName: string): boolean {
  return node.ancestry.some((a) => a.name === dialogName)
      || node.name === dialogName;
}

export function interpolateUrl(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = params[key];
    return v === undefined ? whole : String(v);
  });
}

function describeAction(a: ActionSpec): string {
  switch (a.kind) {
    case 'click':    return 'Clicked';
    case 'type':     return 'Typed into';
    case 'select':   return 'Selected an option in';
    case 'press':    return `Pressed ${a.key}`;
    case 'navigate': return 'Navigated';
    case 'scroll':   return `Scrolled ${a.direction}`;
    case 'extract':  return 'Read';
    case 'assert':   return 'Asserted';
  }
}
