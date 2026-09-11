/**
 * The event stream.
 *
 * The brief asks for "a structured log of what the agent did and why". Those
 * are two different requirements and it is tempting to satisfy only the first,
 * because structured data is easy to emit and explanations are not.
 *
 * So every event carries both: `data` for machines, and `message` - a single
 * plain sentence - for the person reading run.jsonl at two in the morning
 * trying to work out why a capability stopped working. The message is not a
 * label for the event kind; it says what happened and, where it is not
 * obvious, why the system did what it did next.
 */

export type EventKind =
  | 'run.start' | 'run.end' | 'note'
  | 'step.begin' | 'step.end'
  | 'observe'
  | 'locator.resolve' | 'locator.fail' | 'drift'
  | 'policy.check'
  | 'action'
  | 'wait' | 'checkpoint' | 'precondition'
  | 'recovery'
  | 'outcome.detected'
  | 'extract'
  | 'lease.transfer'
  | 'escalation.raised' | 'escalation.claimed' | 'escalation.resumed' | 'escalation.timeout'
  | 'llm.call';

export interface EvidenceEvent {
  seq: number;
  t: string;
  kind: EventKind;
  stepId?: string;
  /** One plain sentence: what happened, and why it mattered. */
  message: string;
  data?: Record<string, unknown>;
}

/** Kinds that mean something went wrong, for the report's filtering. */
export const PROBLEM_KINDS = new Set<EventKind>([
  'locator.fail', 'escalation.raised', 'escalation.timeout',
]);
