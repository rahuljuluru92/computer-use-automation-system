import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { CapabilityArtifact, Predicate } from '../../src/core/schema.ts';
import { minimalArtifact } from '../fixtures/minimalArtifact.ts';

describe('CapabilityArtifact', () => {
  it('parses a minimal artifact and applies contract defaults', () => {
    const a = CapabilityArtifact.parse(minimalArtifact());
    expect(a.status).toBe('draft');                       // never approved by accident
    expect(a.policy.allowedActionClasses).not.toContain('write_irreversible');
    expect(a.steps[0]!.target!.minAgreement).toBe(2);     // quorum on by default
    expect(a.steps[0]!.target!.requireUnique).toBe(true);
  });

  it('rejects an id that is not a dotted capability name', () => {
    expect(() => CapabilityArtifact.parse(minimalArtifact({ id: 'NotADottedId' }))).toThrow();
  });

  it('rejects a non-semver version', () => {
    expect(() => CapabilityArtifact.parse(minimalArtifact({ version: 'v1' }))).toThrow();
  });

  it('requires at least one step and at least one location strategy', () => {
    expect(() => CapabilityArtifact.parse(minimalArtifact({ steps: [] }))).toThrow();
  });

  it('requires a rationale on every location strategy', () => {
    const a = minimalArtifact();
    // Section 3.2 asks for robustness reasoning; the schema enforces it.
    (a.steps[0]!.target!.strategies[0] as { rationale: string }).rationale = '';
    expect(() => CapabilityArtifact.parse(a)).toThrow();
  });

  it('emits a JSON Schema for the whole contract', () => {
    const js = z.toJSONSchema(CapabilityArtifact, { io: 'input' }) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(js.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'version', 'inputs', 'outputs', 'outcomes', 'steps']),
    );
  });
});

describe('Predicate', () => {
  it('nests arbitrarily through all/any/not', () => {
    const p = Predicate.parse({
      kind: 'all',
      of: [
        { kind: 'url_matches', pattern: '/members/\\d+' },
        { kind: 'not', of: { kind: 'any', of: [{ kind: 'stable', forMs: 300 }] } },
      ],
    });
    expect(p.kind).toBe('all');
  });

  it('rejects an unknown predicate kind', () => {
    expect(() => Predicate.parse({ kind: 'vibes', of: [] })).toThrow();
  });
});
