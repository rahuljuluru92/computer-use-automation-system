/**
 * `cua catalog` - the same approved-capability list `/catalog` and `cua mcp`
 * serve, as a table on stdout for anyone driving the CLI without the
 * operator console open.
 */

import { loadApprovedCatalog } from '../mcp/catalog.ts';

export interface CatalogCommandOptions {
  artifactsDir?: string | undefined;
  json: boolean;
}

export async function runCatalogCommand(opts: CatalogCommandOptions): Promise<number> {
  const entries = await loadApprovedCatalog(opts.artifactsDir ?? 'artifacts');

  if (opts.json) {
    console.log(JSON.stringify(entries.map((e) => ({
      id: e.artifact.id,
      version: e.artifact.version,
      description: e.artifact.description,
      actionClasses: e.artifact.policy.allowedActionClasses,
      outcomes: e.artifact.outcomes.map((o) => o.code),
      tenantOverlays: Object.keys(e.artifact.tenancy.overlays),
      model: e.artifact.provenance.model,
      selfVerified: e.artifact.provenance.selfVerified.passed,
    })), null, 2));
    return 0;
  }

  if (entries.length === 0) {
    console.log('No approved capabilities. `cua approve --artifact <path>` moves a draft here.');
    return 0;
  }

  for (const { artifact } of entries) {
    const overlays = Object.keys(artifact.tenancy.overlays);
    const outcomes = artifact.outcomes.map((o) => o.code);
    console.log(`${artifact.id}@${artifact.version}`);
    console.log(`  ${artifact.description}`);
    console.log(`  action classes: ${artifact.policy.allowedActionClasses.join(', ')}`);
    console.log(`  business outcomes: ${outcomes.length ? outcomes.join(', ') : '(none)'}`);
    console.log(`  tenant overlays: ${overlays.length ? overlays.join(', ') : '(none)'}`);
    console.log(`  discovered by: ${artifact.provenance.model}`);
    console.log('');
  }
  return 0;
}
