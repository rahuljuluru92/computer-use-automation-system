/**
 * Re-sign shipped artifacts after a schema change.
 *
 * `integrity.hash` covers the artifact's whole content, so adding a field to
 * the schema - even one with a default nobody wrote by hand - changes every
 * existing artifact the moment it is parsed, and the integrity check correctly
 * refuses to run it. That is the check doing its job: "this file is not what
 * was signed" is exactly true, and silently tolerating it would mean the hash
 * protected nothing.
 *
 * The right response is to re-sign deliberately, which is what this does, and
 * to be able to see in the diff exactly what the schema added. It is a
 * maintenance tool, not part of the demo path - and it never changes anything
 * but the hash.
 *
 *   npx tsx scripts/resign-artifacts.ts artifacts/*.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CapabilityArtifact } from '../src/core/schema.ts';
import { withIntegrity, verifyIntegrity, artifactHash } from '../src/core/integrity.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: npx tsx scripts/resign-artifacts.ts <artifact.json> [...]');
  process.exit(2);
}

let changed = 0;
for (const path of paths) {
  const parsed = CapabilityArtifact.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const before = parsed.integrity?.hash;
  const after = artifactHash(parsed);

  if (before === after) {
    console.log(`unchanged  ${path}`);
    continue;
  }

  const signed = withIntegrity(parsed);
  if (!verifyIntegrity(signed)) throw new Error(`re-signing ${path} did not verify`);
  writeFileSync(path, JSON.stringify(signed, null, 2) + '\n');
  changed += 1;
  console.log(`re-signed  ${path}`);
  console.log(`           ${before ?? '(unsigned)'} -> ${after}`);
}

console.log(`\n${changed} of ${paths.length} artifact(s) re-signed.`);
