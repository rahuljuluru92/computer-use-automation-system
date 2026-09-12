/**
 * The approved-capability catalog an MCP server exposes.
 *
 * Loading is permissive about the directory - a file that doesn't parse as an
 * artifact is skipped rather than crashing the whole catalog - and strict
 * about what it serves: only `status === 'approved'`, and only if the
 * artifact's own hash still matches its content (decision #113: a grown
 * schema or an edited file invalidates the hash, and that is correct). An
 * unattended caller cannot invoke what a human has not signed off on.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityArtifact } from '../core/schema.ts';
import { verifyIntegrity } from '../core/integrity.ts';

export interface CatalogEntry {
  artifact: CapabilityArtifact;
  path: string;
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

async function parseArtifact(path: string): Promise<CapabilityArtifact | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const result = CapabilityArtifact.safeParse(raw);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every artifact in `dir` that is approved and whose hash still checks out. */
export async function loadApprovedCatalog(dir = 'artifacts'): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const file of await jsonFiles(dir)) {
    const path = join(dir, file);
    const artifact = await parseArtifact(path);
    if (!artifact) continue;
    if (artifact.status !== 'approved') continue;
    if (artifact.integrity && !verifyIntegrity(artifact)) continue;
    entries.push({ artifact, path });
  }
  return entries;
}

/**
 * Finds an artifact by id regardless of status, so a refusal can say *why* -
 * "not approved" is a different message than "no such capability", and a
 * caller correcting itself needs to know which one happened.
 */
export async function loadAnyArtifact(dir: string, id: string): Promise<CapabilityArtifact | undefined> {
  for (const file of await jsonFiles(dir)) {
    const artifact = await parseArtifact(join(dir, file));
    if (artifact?.id === id) return artifact;
  }
  return undefined;
}
