/**
 * The prompt, and the version stamped into every artifact it produces.
 *
 * The text lives in `prompts/discovery.v1.md` rather than in a template literal
 * here, for two reasons. It is the part of this system most likely to be edited
 * by someone who is not editing code, and it shows up in a diff as prose rather
 * than as an escaped string. More importantly `provenance.promptVersion` is a
 * field in the capability contract, which means it has to mean something.
 *
 * So the version carries a hash of the bytes that were actually used:
 *
 *     discovery.v1+sha256:19f3c0a8
 *
 * A prompt edited without a version bump still produces a different stamp. The
 * alternative - a hand-maintained version string - records the author's
 * intention to change the version, which is not the same thing as a record of
 * what drove the run.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Sensitivity } from '../core/schema.ts';

export interface TaskInput {
  name: string;
  /** The value used for this run. Never rendered for a secret. */
  value: unknown;
  description?: string;
  sensitivity?: Sensitivity;
}

export interface TaskSpec {
  /** What the capability should do, in the caller's words. */
  goal: string;
  startUrl: string;
  inputs: TaskInput[];
  /** Anything the operator would have told a new colleague. Optional. */
  notes?: string;
}

const PROMPT_FILE = new URL('../../prompts/discovery.v1.md', import.meta.url);
const PROMPT_NAME = 'discovery.v1';

let cached: { text: string; version: string } | undefined;

function load(): { text: string; version: string } {
  if (!cached) {
    const text = readFileSync(PROMPT_FILE, 'utf8');
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 8);
    cached = { text, version: `${PROMPT_NAME}+sha256:${digest}` };
  }
  return cached;
}

/** Goes into `provenance.promptVersion`. Identifies bytes, not intentions. */
export function promptVersion(): string {
  return load().version;
}

/**
 * The system prompt for one discovery run: the standing instructions, then the
 * task.
 *
 * Secret inputs are named but never valued. The model is told they exist and
 * how to reference them, and that is all it needs - `$input.password` is enough
 * to type a password it has never seen. Nothing here is a filter over a value
 * that was already in the prompt; the value never arrives.
 */
export function systemPrompt(task: TaskSpec): string {
  const { text } = load();
  return `${text}\n${taskSection(task)}`;
}

function taskSection(task: TaskSpec): string {
  const lines: string[] = ['', '---', '', '# This task', '', task.goal, ''];

  if (task.inputs.length > 0) {
    lines.push('## Inputs available to you', '');
    for (const input of task.inputs) {
      const secret = input.sensitivity === 'secret';
      const shown = secret
        ? '(value withheld - reference it and the system supplies it)'
        : `= ${JSON.stringify(String(input.value))}`;
      const note = input.description ? ` - ${input.description}` : '';
      lines.push(`- \`$input.${input.name}\` ${shown}${note}`);
    }
    lines.push('');
  }

  lines.push(`Start at ${task.startUrl}.`, '');

  if (task.notes) {
    lines.push('## Notes from the operator', '', task.notes, '');
  }

  lines.push('Begin by observing the screen.');
  return lines.join('\n');
}
