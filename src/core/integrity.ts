import { createHash } from 'node:crypto';
import type { CapabilityArtifact } from './schema.ts';

/**
 * Stable hash of an artifact, computed over everything except the hash itself.
 *
 * Keys are sorted before serialisation so that two artifacts which differ only
 * in property order hash identically - otherwise "did this capability change?"
 * would depend on how the JSON happened to be written.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

export function artifactHash(artifact: CapabilityArtifact): string {
  const { integrity: _omit, ...rest } = artifact;
  return 'sha256:' + createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

export function withIntegrity(artifact: CapabilityArtifact): CapabilityArtifact {
  return { ...artifact, integrity: { hash: artifactHash(artifact) } };
}

/** Returns true when the stored hash still matches the content. */
export function verifyIntegrity(artifact: CapabilityArtifact): boolean {
  return artifact.integrity?.hash === artifactHash(artifact);
}
