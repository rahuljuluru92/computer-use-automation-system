/**
 * `cua approve` - draft/candidate -> approved, bound to the artifact's hash.
 *
 * A separate, explicit, human-triggered step from compiling on purpose
 * (decision #83: compiled artifacts are always `draft`, never `approved`).
 * Passing self-verification means the compiler could replay what it
 * produced; it says nothing about whether a human has reviewed the flow for
 * a bank's back office. `cua mcp` refuses to serve anything short of
 * `approved` - this command is the only way to cross that line.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { CapabilityArtifact } from '../core/schema.ts';
import { verifyIntegrity, withIntegrity } from '../core/integrity.ts';

export interface ApproveCommandOptions {
  artifactPath: string;
}

export async function runApproveCommand(opts: ApproveCommandOptions): Promise<number> {
  const raw = JSON.parse(await readFile(opts.artifactPath, 'utf8')) as unknown;
  const parsed = CapabilityArtifact.safeParse(raw);
  if (!parsed.success) {
    console.error(`refusing to approve: ${opts.artifactPath} does not satisfy the capability schema.\n`
      + parsed.error.message);
    return 4;
  }

  const artifact = parsed.data;
  if (artifact.integrity && !verifyIntegrity(artifact)) {
    console.error(
      `refusing to approve: ${opts.artifactPath} does not match its recorded hash.\n`
      + `Either it was edited since it was signed, or the capability schema has changed under it.\n`
      + `Re-sign it deliberately first, then look at the diff:\n`
      + `  npx tsx scripts/resign-artifacts.ts ${opts.artifactPath}`,
    );
    return 4;
  }

  if (artifact.status === 'deprecated') {
    console.error(`refusing to approve: ${artifact.id}@${artifact.version} is deprecated.`);
    return 4;
  }

  if (artifact.status === 'approved') {
    console.log(`${artifact.id}@${artifact.version} is already approved (${artifact.integrity?.hash}).`);
    return 0;
  }

  const approved = withIntegrity({ ...artifact, status: 'approved' as const });
  await writeFile(opts.artifactPath, JSON.stringify(approved, null, 2) + '\n');

  console.log(`${approved.id}@${approved.version} approved.`);
  console.log(`  hash: ${approved.integrity?.hash}`);
  console.log(`  it may now be invoked unattended, e.g. over MCP:  npm run mcp`);
  return 0;
}
