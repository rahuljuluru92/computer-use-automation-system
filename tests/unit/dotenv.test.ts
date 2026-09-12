import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../../src/core/dotenv.ts';

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cua-dotenv-'));
  cwd = process.cwd();
  process.chdir(dir);
  delete process.env.CUA_TEST_VAR;
});

afterEach(() => {
  process.chdir(cwd);
  delete process.env.CUA_TEST_VAR;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadDotEnv', () => {
  it('is a no-op when there is no .env file', () => {
    expect(() => loadDotEnv()).not.toThrow();
    expect(process.env.CUA_TEST_VAR).toBeUndefined();
  });

  it('fills in a variable from .env when nothing set it first', () => {
    writeFileSync('.env', 'CUA_TEST_VAR=from-dotenv\n');
    loadDotEnv();
    expect(process.env.CUA_TEST_VAR).toBe('from-dotenv');
  });

  it('lets a real, non-empty environment variable win over .env', () => {
    process.env.CUA_TEST_VAR = 'from-shell';
    writeFileSync('.env', 'CUA_TEST_VAR=from-dotenv\n');
    loadDotEnv();
    expect(process.env.CUA_TEST_VAR).toBe('from-shell');
  });

  it('does not treat an empty exported variable as "already set"', () => {
    // The bug this guards: a sandboxed shell can pre-export a variable name
    // with an empty string, which process.loadEnvFile's own overwrite
    // avoidance would otherwise honor - silently shadowing a real value
    // sitting in .env with no error anywhere.
    process.env.CUA_TEST_VAR = '';
    writeFileSync('.env', 'CUA_TEST_VAR=from-dotenv\n');
    loadDotEnv();
    expect(process.env.CUA_TEST_VAR).toBe('from-dotenv');
  });
});
