import type { CapabilityArtifactInput } from '../../src/core/schema.ts';

/** The smallest artifact that is still a valid capability. Used by schema tests. */
export function minimalArtifact(
  overrides: Partial<CapabilityArtifactInput> = {},
): CapabilityArtifactInput {
  const now = '2026-09-11T00:00:00.000Z';
  return {
    schemaVersion: '1.0.0',
    id: 'cap.member.read_savings_balance',
    version: '1.0.0',
    title: 'Read savings balance',
    description: 'Look up a member and return their current savings balance.',
    target: {
      surface: 'web',
      product: { vendor: 'meridian', app: 'core-servicing' },
      entry: { kind: 'url', template: '{baseUrl}/' },
    },
    inputs: { type: 'object', properties: { memberId: { type: 'string' } }, required: ['memberId'] },
    outputs: { type: 'object', properties: { savingsBalance: { type: 'number' } } },
    steps: [{
      id: 's1',
      intent: 'Click the Search button',
      action: { kind: 'click' },
      actionClass: 'read',
      target: {
        description: 'The Search button on the member search form',
        strategies: [{
          tier: 1,
          strategy: { kind: 'role_name', role: 'button', name: 'Search' },
          confidence: 0.9,
          rationale: 'Accessible name is set by the visible label and is stable across renders.',
        }],
      },
    }],
    provenance: {
      discoveryRunId: 'run-discovery-1',
      model: 'claude-sonnet-5',
      promptVersion: 'v1',
      recordedAt: now,
      compilerVersion: '0.1.0',
      selfVerified: { passed: true, at: now, runId: 'run-verify-1' },
    },
    ...overrides,
  };
}
