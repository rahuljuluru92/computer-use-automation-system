// @ts-check
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * The rule that matters here is the LAST block: the replay path is structurally
 * forbidden from reaching the planner or any model SDK. Determinism claimed in a
 * README is worth nothing; determinism the build refuses to violate is worth
 * something. See docs/adr/0003-determinism-and-error-taxonomy.md.
 */
export default [
  { ignores: ['node_modules/**', 'dist/**', 'evidence/**', 'artifacts/**', 'coverage/**'] },

  js.configs.recommended,

  // Plain node scripts: same globals as the TS sources, no TS rules.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly',
                 URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
                 setTimeout: 'readonly', clearTimeout: 'readonly', AbortSignal: 'readonly' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-undef': 'off', // TypeScript already checks this, and does it better.
      // `export const Foo = z.object(...)` paired with
      // `export type Foo = z.infer<typeof Foo>` is the single-source-of-truth
      // pattern this codebase is built on: one schema, one name, value and type
      // in their two separate declaration spaces. Neither the base rule nor the
      // TS-aware one models that pairing (their `ignoreDeclarationMerge` covers
      // interface/namespace merging, not const+type), so both report it.
      // `tsc` already rejects a genuine duplicate declaration, so switching
      // these off costs no safety and removes the false positives.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'off',
      'eqeqeq': ['error', 'always'],
      'no-console': 'off', // This is a CLI.
    },
  },

  // ---------------------------------------------------------------------------
  // The determinism boundary.
  // ---------------------------------------------------------------------------
  // Replay is the production execution path. If it can reach a model, then
  // "deterministic replay" is a promise rather than a property. These two rules
  // make the promise unbreakable without an explicit, visible eslint-disable.
  {
    files: ['src/replay/**/*.ts', 'src/exec/**/*.ts', 'src/surface/**/*.ts', 'src/policy/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '@anthropic-ai/sdk',
            message: 'The replay path must never call a model. Discovery decides; replay executes. See ADR-0003.' },
        ],
        patterns: [
          { group: ['**/discovery/**', '@/discovery/**'],
            message: 'The replay path must not import the planner. Discovery decides; replay executes. See ADR-0003.' },
        ],
      }],
    },
  },

  // Tests may import anything - including both sides of the boundary, which is
  // exactly what tests/determinism/ needs in order to assert the boundary holds.
  {
    files: ['tests/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
];
