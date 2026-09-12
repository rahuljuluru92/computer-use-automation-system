/**
 * Writes the reference artifact with its interstitial remedy deliberately
 * pointed at a button that does not exist, exactly like gate-p5.ts's
 * `withABrokenRemedy()` - so `--chaos surprise_modal` genuinely exhausts its
 * declared recovery and has to ask a human, rather than quietly succeeding
 * the way it does for gate-3.
 *
 * Exists as its own file (not only inline in gate-p5.ts) so a live recording
 * can point `cua replay --artifact <this file>` at it directly, with a real
 * operator console and a real person doing the handoff - the same scenario
 * gate-5 proves by script, done for real on camera.
 *
 * Written outside artifacts/ deliberately: this artifact shares its id
 * (cap.member.read_savings_balance) with the real shipped one, and a second
 * file with the same id sitting in the directory the MCP catalog scans is
 * exactly the kind of ambiguity decision #117's re-check-at-call-time guards
 * against - simplest to just never put it where that scan looks.
 *
 *   npx tsx scripts/prepare-live-escalation-demo.ts [output-path]
 */
import { writeFileSync } from 'node:fs';
import { withIntegrity } from '../src/core/integrity.ts';
import { seedArtifact } from '../tests/fixtures/seedArtifact.ts';
import type { CapabilityArtifact } from '../src/core/schema.ts';

const OUT = process.argv[2] ?? '/tmp/live-demo-escalation.json';
/** Generous on purpose: a live recording needs time to get the camera rolling before the clock matters. */
const TIMEOUT_MS = Number(process.argv[3] ?? 900_000);

function withABrokenRemedy(): CapabilityArtifact {
  const artifact = structuredClone(seedArtifact()) as CapabilityArtifact;
  const rule = artifact.recovery.find((r) => r.id === 'dismiss-maintenance-notice');
  if (!rule?.do[0]?.target) throw new Error('fixture drifted: no dismiss rule to sabotage');
  rule.do[0].target.strategies = [{
    tier: 1,
    strategy: { kind: 'role_name', role: 'button', name: 'Dismiss', exact: true },
    confidence: 0.9,
    rationale: 'Deliberately wrong, so the declared remedy fails and the run must ask a human.',
  }];
  rule.maxAttempts = 1;
  artifact.escalation = { ...artifact.escalation, timeoutMs: TIMEOUT_MS };
  return artifact;
}

const artifact = withIntegrity(withABrokenRemedy());
writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n');
console.log(`wrote ${OUT}`);
console.log('Use it with:');
console.log(`  npm run replay -- --artifact ${OUT} --input '{"memberId":"12345"}' \\`);
console.log('                     --chaos surprise_modal --operator http://localhost:4500');
