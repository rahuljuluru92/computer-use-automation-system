/**
 * The guardrail.
 *
 * The single most important property of this file is *where it is called
 * from*: inside `Executor.act()`, which is the only place in the system that
 * touches a Surface. Not in a prompt, not at call sites, not as a convention
 * that reviewers are asked to uphold.
 *
 * That matters because the alternative - telling the model what it may not do
 * - is not a guardrail at all. A prompt is a request. A model that has been
 * confused, or fed a hostile string from a page it is reading, can ignore a
 * request. It cannot ignore a function that refuses to call the browser. In a
 * regulated environment the difference between those two designs is the whole
 * ballgame.
 *
 * Three checks, in order of how cheap they are to be wrong about:
 *
 *   1. Origin and route allowlist - is this even a system we are allowed to
 *      touch?
 *   2. Action kind - is this a verb we permit at all here?
 *   3. Action class - is this reversible, and if not, has someone said yes?
 */

import type { ActionClass, ActionSpec } from '../core/schema.ts';
import type { UiNode } from '../surface/uinode.ts';
import { classifyAction, mostCautious, isAtLeast } from './actionClass.ts';

export interface PolicyConfig {
  /** Origins the agent may operate on. Exact scheme+host+port. */
  allowedOrigins: string[];
  /** Glob-ish path patterns within those origins. `*` matches one segment,
   *  `**` matches any number. Empty means all paths on an allowed origin. */
  allowedPaths: string[];
  /** Verbs permitted at all. */
  allowedActionKinds: ActionSpec['kind'][];
  /** The highest action class allowed without explicit approval. */
  maxUnapprovedActionClass: ActionClass;
  /** Control labels that always require approval, whatever else is true. */
  requireApprovalLabels: string[];
  /** Control labels that are refused outright, approval or not. */
  denyLabels: string[];
  /**
   * A numeric `$input` field whose value exceeds `max` needs a human decision,
   * the same way an irreversible action's label does. Keyed by field name
   * rather than by capability: this demo has one target app and one
   * financial field worth fencing, and scoping this to a specific capability
   * id is exactly the kind of thing a per-capability policy file would carry
   * in a deployment with more of them (decision #127).
   */
  valueLimits: Array<{ field: string; max: number }>;
}

export const DEFAULT_POLICY: PolicyConfig = {
  allowedOrigins: [],
  allowedPaths: [],
  allowedActionKinds: ['click', 'type', 'select', 'press', 'navigate', 'scroll', 'extract', 'assert'],
  // Discovery and unapproved replay may fill a form; they may not commit it.
  maxUnapprovedActionClass: 'write_reversible',
  requireApprovalLabels: [],
  denyLabels: [],
  valueLimits: [],
};

export interface PolicyRequest {
  action: ActionSpec;
  target?: UiNode | undefined;
  currentUrl: string;
  /** Where a `navigate` intends to go. */
  destinationUrl?: string | undefined;
  /** What the artifact claims this step's class is. */
  declaredClass?: ActionClass | undefined;
  /** True when the caller has authorised irreversible actions for this run. */
  approvalGranted?: boolean;
  /**
   * The raw fact, not a verdict: which `$input` field this action's value
   * came from, and what it resolved to. Supplied by whoever calls
   * `Executor.act()` (the only place that can materialise `step.data` against
   * `params`), never pre-judged there - the same division of labour as
   * `declaredClass`: the caller states what it observed, policy decides what
   * it means, independently, inside the one chokepoint (decision #127).
   */
  valueRef?: { field: string; value: number } | undefined;
}

export type PolicyDecision =
  | { verdict: 'allow'; actionClass: ActionClass }
  | { verdict: 'deny'; rule: string; reason: string; actionClass: ActionClass }
  | { verdict: 'require_approval'; rule: string; reason: string; actionClass: ActionClass };

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  check(req: PolicyRequest): PolicyDecision {
    // The artifact says what a step is; we work it out independently and take
    // the more cautious answer. A declaration is a claim, and this one was
    // written by a compiler that a model drove.
    const inferred = classifyAction(req.action, req.target);
    const actionClass = req.declaredClass
      ? mostCautious(req.declaredClass, inferred)
      : inferred;

    const label = `${req.target?.name ?? ''} ${req.target?.value ?? ''}`.trim();

    for (const pattern of this.config.denyLabels) {
      if (new RegExp(pattern, 'i').test(label)) {
        return { verdict: 'deny', rule: `denyLabels:${pattern}`, actionClass,
          reason: `the control "${label}" matches a denied pattern and is never actionable` };
      }
    }

    if (!this.config.allowedActionKinds.includes(req.action.kind)) {
      return { verdict: 'deny', rule: 'allowedActionKinds', actionClass,
        reason: `action "${req.action.kind}" is not permitted by policy` };
    }

    // Navigation is checked against where it is going; everything else against
    // where it already is. Checking only the current url would let a single
    // navigate walk the agent straight off the allowlist.
    const urlToCheck = req.action.kind === 'navigate'
      ? (req.destinationUrl ?? req.currentUrl)
      : req.currentUrl;
    const urlVerdict = this.checkUrl(urlToCheck);
    if (urlVerdict) return { ...urlVerdict, actionClass };

    for (const pattern of this.config.requireApprovalLabels) {
      if (new RegExp(pattern, 'i').test(label)) {
        if (req.approvalGranted) break;
        return { verdict: 'require_approval', rule: `requireApprovalLabels:${pattern}`, actionClass,
          reason: `the control "${label}" always requires a human decision` };
      }
    }

    if (isAtLeast(actionClass, 'write_irreversible')
        && !isAtLeast(this.config.maxUnapprovedActionClass, 'write_irreversible')
        && !req.approvalGranted) {
      return { verdict: 'require_approval', rule: 'maxUnapprovedActionClass', actionClass,
        reason: `"${label || req.action.kind}" is irreversible and this run is not approved for `
              + `irreversible actions. You never let a discovery agent move money.` };
    }

    if (req.valueRef) {
      const limit = this.config.valueLimits.find((l) => l.field === req.valueRef!.field);
      if (limit && req.valueRef.value > limit.max && !req.approvalGranted) {
        return { verdict: 'require_approval', rule: `valueLimits:${limit.field}`, actionClass,
          reason: `$input.${limit.field} is ${req.valueRef.value}, over the ${limit.max} ceiling `
                + `for this field - a value this size needs a human decision, not a policy default.` };
      }
    }

    return { verdict: 'allow', actionClass };
  }

  private checkUrl(url: string): Omit<PolicyDecision & { verdict: 'deny' }, 'actionClass'> | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { verdict: 'deny', rule: 'allowedOrigins', reason: `"${url}" is not a usable url` };
    }
    if (this.config.allowedOrigins.length > 0
        && !this.config.allowedOrigins.includes(parsed.origin)) {
      return { verdict: 'deny', rule: 'allowedOrigins',
        reason: `origin ${parsed.origin} is not on the allowlist `
              + `(${this.config.allowedOrigins.join(', ') || 'empty'})` };
    }
    if (this.config.allowedPaths.length > 0
        && !this.config.allowedPaths.some((p) => matchPath(p, parsed.pathname))) {
      return { verdict: 'deny', rule: 'allowedPaths',
        reason: `path ${parsed.pathname} is not on the allowlist` };
    }
    return null;
  }
}

/** `*` matches one path segment, `**` matches any number. */
export function matchPath(pattern: string, path: string): boolean {
  const rx = '^' + pattern
    .split('/')
    .map((seg) => {
      if (seg === '**') return '.*';
      if (seg === '*') return '[^/]*';
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/')
    .replace(/\/\.\*$/, '(/.*)?')
  + '$';
  return new RegExp(rx).test(path);
}
