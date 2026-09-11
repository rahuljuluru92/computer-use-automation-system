/**
 * The prompt and its version stamp.
 *
 * Two things matter here and neither is about wording: the version has to
 * identify the bytes that actually drove a run, and a secret must never reach
 * the prompt in the first place.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promptVersion, systemPrompt, type TaskSpec } from '../../src/discovery/prompt.ts';

const task: TaskSpec = {
  goal: 'Read the savings balance for a member.',
  startUrl: 'http://localhost:4400/members/search',
  inputs: [
    { name: 'memberId', value: '12345', description: 'the member to look up' },
    { name: 'password', value: 'hunter2-correct-horse', sensitivity: 'secret' },
  ],
};

describe('the version stamp', () => {
  it('is a hash of the prompt actually on disk', async () => {
    // `provenance.promptVersion` is a contract field, so it has to identify
    // bytes. A hand-maintained version string records an intention to bump a
    // number, which is not a record of what drove the run.
    const file = new URL('../../prompts/discovery.v1.md', import.meta.url);
    const digest = createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex').slice(0, 8);

    expect(promptVersion()).toBe(`discovery.v1+sha256:${digest}`);
  });

  it('is stable across calls', () => {
    expect(promptVersion()).toBe(promptVersion());
  });
});

describe('what reaches the model', () => {
  it('never contains a secret value', () => {
    const text = systemPrompt(task);
    expect(text).not.toContain('hunter2-correct-horse');
  });

  it('tells the model the secret exists and how to reference it', () => {
    // Withholding the value is only safe if the model can still use it. It
    // types `$input.password` and the system supplies the value downstream.
    const text = systemPrompt(task);
    expect(text).toContain('$input.password');
    expect(text).toMatch(/value withheld/);
  });

  it('does show ordinary input values, which are useful context', () => {
    expect(systemPrompt(task)).toContain('12345');
  });

  it('carries the goal and the starting point', () => {
    const text = systemPrompt(task);
    expect(text).toContain('Read the savings balance for a member.');
    expect(text).toContain('http://localhost:4400/members/search');
  });

  it('warns that this application does not change its address bar', () => {
    // Decision #18. Without this the model writes a url_matches checkpoint that
    // passes forever without ever being true.
    expect(systemPrompt(task)).toMatch(/does not change its address bar/);
  });

  it('tells the model a refusal is final', () => {
    expect(systemPrompt(task)).toMatch(/If policy refuses an action, stop/);
  });
});
