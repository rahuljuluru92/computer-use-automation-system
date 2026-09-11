/**
 * "Deterministic replay" is the central claim of this system, so it is worth
 * more than a sentence in a README.
 *
 * Three independent guards enforce it, and this file is the second:
 *
 *   1. eslint  - `no-restricted-imports` in eslint.config.js fails the lint on
 *                any import of the model SDK or the planner from the execution
 *                path. Catches it while you type.
 *   2. this test - a source scan that fails CI even if someone disables the
 *                lint rule inline. Catches it at review time.
 *   3. runtime - every ReplayResult carries `metrics.llmCalls`, asserted 0 by
 *                the integration tests. Catches it in production.
 *
 * Three guards for one property is not paranoia. This is the property the whole
 * design rests on: if replay can consult a model, then replay is not replay, it
 * is a cheaper discovery run wearing a costume.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

/** Modules that execute a saved artifact. None may reach a model. */
const EXECUTION_PATH = ['src/replay', 'src/exec', 'src/surface', 'src/policy'];

/** Imports that would break determinism. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /@anthropic-ai\/sdk/, why: 'the model SDK' },
  { pattern: /\bopenai\b/, why: 'a model SDK' },
  { pattern: /from\s+['"][^'"]*\/discovery\//, why: 'the discovery/planner package' },
  { pattern: /from\s+['"]@\/discovery\//, why: 'the discovery/planner package' },
];

function tsFilesUnder(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

/** Strip comments so a reference inside prose does not fail the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the replay path cannot consult a model', () => {
  for (const dir of EXECUTION_PATH) {
    it(`${dir}/ imports nothing that could make a model call`, () => {
      const offences: string[] = [];
      for (const file of tsFilesUnder(dir)) {
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(src)) {
            offences.push(`${relative(ROOT, file)} imports ${why} (matched ${pattern})`);
          }
        }
      }
      expect(offences, offences.join('\n')).toEqual([]);
    });
  }

  it('guards a non-empty set of directories, so the scan cannot silently pass', () => {
    // A scan that finds no files always passes. This makes that failure visible
    // the moment the layout changes.
    const total = EXECUTION_PATH.flatMap(tsFilesUnder).length;
    expect(total).toBeGreaterThan(0);
  });

  it('would actually catch a violation if one were introduced', () => {
    // Proves the detector works, rather than trusting that it does.
    const sample = `import Anthropic from '@anthropic-ai/sdk';`;
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(true);
    const sample2 = `import { plan } from '../discovery/planner.ts';`;
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample2))).toBe(true);
  });
});
