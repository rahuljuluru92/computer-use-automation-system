/**
 * Classifying how dangerous an action is.
 *
 * The artifact declares an actionClass per step, but a declaration is a claim,
 * and claims from a compiler that was itself driven by a model deserve
 * checking. So the policy engine independently classifies every action from
 * what it can see - the verb, the control, and the words on the control - and
 * takes the *more* cautious of the two.
 *
 * Being wrong in the safe direction costs an approval prompt. Being wrong in
 * the other direction moves someone's money.
 */

import type { ActionClass, ActionSpec } from '../core/schema.ts';
import type { UiNode } from '../surface/uinode.ts';

/** Words that mark a control as committing something. */
const IRREVERSIBLE = [
  /\bconfirm\b/i, /\bsubmit\b/i, /\bapprove\b/i, /\bpost\b/i,
  /\btransfer\b/i, /\bwire\b/i, /\bpay\b/i, /\bwithdraw\b/i,
  /\bdelete\b/i, /\bremove\b/i, /\bclose\s+account\b/i, /\bopen\s+account\b/i,
  /\bissue\b/i, /\bsend\b/i, /\bfinali[sz]e\b/i, /\bcommit\b/i,
];

/** Words that look alarming but only move you between screens. */
const NAVIGATIONAL = [
  /\bcontinue\b/i, /\bnext\b/i, /\breview\b/i, /\bsearch\b/i,
  /\bview\b/i, /\bback\b/i, /\bcancel\b/i, /\bsign in\b/i,
];

export function classifyAction(action: ActionSpec, target?: UiNode): ActionClass {
  switch (action.kind) {
    // Reading changes nothing and is always safe to repeat.
    case 'extract':
    case 'assert':
    case 'scroll':
      return 'read';

    // Navigation is reversible in the sense that matters: it commits nothing.
    case 'navigate':
      return 'read';

    // Filling a field is reversible until something is submitted.
    case 'type':
    case 'select':
      return 'write_reversible';

    case 'press':
      // Enter in a form is a submit in disguise, which is exactly the kind of
      // thing that slips past a reviewer reading a step list.
      return action.key === 'Enter' ? classifyByLabel(target) : 'read';

    case 'click':
      return classifyByLabel(target);
  }
}

function classifyByLabel(target?: UiNode): ActionClass {
  const label = `${target?.name ?? ''} ${target?.value ?? ''}`.trim();
  if (!label) return 'write_reversible';   // unknown control: assume it writes
  if (NAVIGATIONAL.some((re) => re.test(label)) && !IRREVERSIBLE.some((re) => re.test(label))) {
    return 'read';
  }
  if (IRREVERSIBLE.some((re) => re.test(label))) return 'write_irreversible';
  return 'write_reversible';
}

const ORDER: Record<ActionClass, number> = {
  read: 0, write_reversible: 1, write_irreversible: 2,
};

/** The more cautious of two classifications. */
export function mostCautious(a: ActionClass, b: ActionClass): ActionClass {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export function isAtLeast(actual: ActionClass, threshold: ActionClass): boolean {
  return ORDER[actual] >= ORDER[threshold];
}
