/**
 * Artifacts must be reviewable by a human, not just parseable by a machine.
 *
 * The brief asks for an artifact that "both a human reviewer and a calling agent
 * should be able to understand". JSON satisfies the agent. This satisfies the
 * reviewer: it renders the same artifact as the sentences a person would use to
 * describe the flow, including *why* each control is found the way it is.
 */

import { readFile } from 'node:fs/promises';
import { CapabilityArtifact } from '../core/schema.ts';
import type { Predicate } from '../core/schema.ts';
import { verifyIntegrity } from '../core/integrity.ts';

export async function explainArtifact(path: string): Promise<string> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return renderExplanation(CapabilityArtifact.parse(raw));
}

export function renderExplanation(a: CapabilityArtifact): string {
  const L: string[] = [];
  const req = new Set(a.inputs.required ?? []);

  L.push(`${a.title}  (${a.id} v${a.version}, ${a.status})`);
  L.push('='.repeat(72));
  L.push(a.description, '');

  L.push(`Target: ${a.target.product.vendor}/${a.target.product.app} on ${a.target.surface}`);
  L.push(`Entry:  ${a.target.entry.template}`);
  if (a.integrity) {
    L.push(`Hash:   ${a.integrity.hash}${verifyIntegrity(a) ? '' : '  *** MISMATCH ***'}`);
  }
  L.push(`Proven: self-verified replay ${a.provenance.selfVerified.passed ? 'PASSED' : 'FAILED'}` +
         ` at ${a.provenance.selfVerified.at}`);
  L.push('');

  L.push('Inputs');
  for (const [name, spec] of Object.entries(a.inputs.properties)) {
    const s = spec as { description?: string; type?: string; 'x-sensitivity'?: string };
    const flags = [req.has(name) ? 'required' : 'optional',
                   s['x-sensitivity'] && s['x-sensitivity'] !== 'none' ? s['x-sensitivity'] : null]
      .filter(Boolean).join(', ');
    L.push(`  ${name}: ${s.type ?? 'any'} (${flags})${s.description ? ` - ${s.description}` : ''}`);
  }
  L.push('');

  L.push('Returns on success');
  for (const [name, spec] of Object.entries(a.outputs.properties)) {
    const s = spec as { description?: string; type?: string };
    L.push(`  ${name}: ${s.type ?? 'any'}${s.description ? ` - ${s.description}` : ''}`);
  }
  L.push('');

  if (a.outcomes.length) {
    L.push('Business outcomes the caller must handle (these are answers, not errors)');
    for (const o of a.outcomes) L.push(`  ${o.code} [${o.severity}] - ${o.description}`);
    L.push('');
  }

  L.push('Steps');
  for (const [i, s] of a.steps.entries()) {
    L.push(`  ${i + 1}. ${s.intent}`);
    L.push(`     action: ${s.action.kind} (${s.actionClass})`);
    if (s.target) {
      L.push(`     find:   ${s.target.description}`);
      for (const st of s.target.strategies) {
        L.push(`               tier ${st.tier} ${st.strategy.kind} ` +
               `(confidence ${st.confidence.toFixed(2)}) - ${st.rationale}`);
      }
      L.push(`     quorum: ${s.target.minAgreement} strategies must agree` +
             `${s.target.allowDegraded ? '; degraded resolution allowed, emits drift' : ''}`);
    }
    if (s.waitFor.length)    L.push(`     wait:   ${s.waitFor.map(describePredicate).join('; ')}`);
    if (s.checkpoint.length) L.push(`     verify: ${s.checkpoint.map(describePredicate).join('; ')}`);
    if (s.extract.length)    L.push(`     read:   ${s.extract.map((e) => `${e.name} (${e.parse.kind})`).join(', ')}`);
    if (s.onOutcome.length)  L.push(`     may end as: ${s.onOutcome.join(', ')}`);
    if (s.recovery.length)   L.push(`     recovers from: ${s.recovery.map((r) => r.description).join('; ')}`);
    L.push('');
  }

  if (a.recovery.length) {
    L.push('Recovery rules active at any step');
    for (const r of a.recovery) L.push(`  ${r.id} (${r.kind}, max ${r.maxAttempts}) - ${r.description}`);
    L.push('');
  }

  const overlays = Object.keys(a.tenancy.overlays);
  if (overlays.length) L.push(`Tenant overlays: ${overlays.join(', ')}`, '');

  return L.join('\n');
}

function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case 'node_present':  return `"${p.locator.description}" is present`;
    case 'node_absent':   return `"${p.locator.description}" is gone`;
    case 'text_matches':  return `"${p.locator.description}" matches /${p.pattern}/`;
    case 'value_equals':  return `"${p.locator.description}" equals "${p.value}"`;
    case 'url_matches':   return `the url matches /${p.pattern}/`;
    case 'aria_subtree':  return `the accessible structure of "${p.root.description}" matches the recorded shape`;
    case 'stable':        return `the page has been still for ${p.forMs}ms`;
    case 'all':           return `all of (${p.of.map(describePredicate).join(', ')})`;
    case 'any':           return `any of (${p.of.map(describePredicate).join(', ')})`;
    case 'not':           return `not (${describePredicate(p.of)})`;
  }
}
