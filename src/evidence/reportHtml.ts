/**
 * A readable report for one run.
 *
 * Evidence that is technically complete but practically unreadable is evidence
 * nobody checks. run.jsonl has everything, and reading a hundred JSON lines to
 * work out why a capability stopped working is nobody's idea of a good
 * afternoon. This renders the same data as a page: what the run did, what it
 * found, what it decided, and - where it went wrong - what it expected against
 * what it saw, with the screenshots beside it.
 *
 * Images are referenced by relative path rather than inlined as base64. The
 * report lives inside the run directory next to them, so it works from a
 * clone, and a repository does not fill up with megabytes of duplicated
 * pixels.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceEvent } from './events.ts';
import type { ReplayResult } from '../core/result.ts';

export interface ReportInput {
  runId: string;
  events: EvidenceEvent[];
  manifest: Record<string, unknown>;
  result?: ReplayResult | undefined;
}

export function renderReport(input: ReportInput): string {
  const { runId, events, manifest, result } = input;
  const status = String(result?.status ?? manifest.status ?? 'unknown');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Run ${esc(runId)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#f6f7f9; color:#1c1e21;
         font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:28px 20px 80px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:32px 0 10px; text-transform:uppercase;
       letter-spacing:.06em; color:#5b6270; }
  .sub { color:#5b6270; font-size:13px; margin:0 0 20px; }
  .card { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:16px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px;
           font-size:12px; font-weight:600; letter-spacing:.02em; }
  .b-success{background:#e4f5e9;color:#186a3b} .b-business_outcome{background:#e6effc;color:#1d4e89}
  .b-failed{background:#fdeaea;color:#a02020} .b-escalated{background:#fdf1e0;color:#8a5a13}
  .b-blocked_by_policy{background:#efe9fb;color:#553c9a} .b-unknown{background:#eceef1;color:#4a5160}
  .metrics { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0 0; }
  .metric { background:#fff; border:1px solid #dfe3e8; border-radius:8px;
            padding:10px 14px; min-width:104px; }
  .metric .n { font-size:19px; font-weight:650; }
  .metric .k { font-size:11px; color:#5b6270; text-transform:uppercase; letter-spacing:.05em; }
  .metric.hero { border-color:#9ec7a6; background:#f2fbf5; }
  .step { background:#fff; border:1px solid #dfe3e8; border-left-width:4px;
          border-radius:8px; padding:14px 16px; margin-bottom:10px; }
  .s-ok{border-left-color:#3fa45f} .s-recovered{border-left-color:#d79a2b}
  .s-failed{border-left-color:#c93c3c} .s-escalated{border-left-color:#d98324}
  .s-blocked{border-left-color:#7c5cbf} .s-skipped{border-left-color:#aab0ba}
  .step h3 { margin:0 0 6px; font-size:14px; font-weight:600; }
  .meta { color:#5b6270; font-size:12.5px; }
  .meta b { color:#1c1e21; font-weight:600; }
  .warn { color:#8a5a13; }
  .shots { display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
  .shots figure { margin:0; }
  .shots img { max-width:250px; border:1px solid #dfe3e8; border-radius:5px; display:block; }
  .shots figcaption { font-size:11px; color:#5b6270; margin-top:3px; }
  table { border-collapse:collapse; width:100%; background:#fff;
          border:1px solid #dfe3e8; border-radius:8px; overflow:hidden; font-size:12.5px; }
  th { text-align:left; background:#f0f2f5; padding:7px 10px; font-size:11px;
       text-transform:uppercase; letter-spacing:.05em; color:#5b6270; }
  td { padding:6px 10px; border-top:1px solid #eef0f3; vertical-align:top; }
  td.k { white-space:nowrap; color:#5b6270; font-variant-numeric:tabular-nums; }
  tr.problem td { background:#fdf4f4; }
  .kind { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:#4a5160; }
  .fail { background:#fdeaea; border:1px solid #f0c2c2; border-radius:8px; padding:14px 16px; }
  .fail dt { font-size:11px; text-transform:uppercase; letter-spacing:.05em;
             color:#8a3030; margin-top:8px; }
  .fail dd { margin:2px 0 0; font-family:ui-monospace,Menlo,monospace; font-size:12.5px; }
  .note { font-size:12.5px; color:#5b6270; margin-top:8px; }
  .overflow { overflow-x:auto; }
</style></head><body><div class="wrap">

<h1>${esc(String(manifest.capability ?? manifest.goal ?? runId))}
  <span class="badge b-${esc(status)}">${esc(status.replace(/_/g, ' '))}</span></h1>
<p class="sub">Run <code>${esc(runId)}</code>${
  manifest.version ? ` &middot; capability v${esc(String(manifest.version))}` : ''}${
  manifest.tenant ? ` &middot; tenant ${esc(String(manifest.tenant))}` : ''}</p>

${renderSummary(result)}

<div class="metrics">
  ${metric('steps', result?.metrics.stepsExecuted ?? events.filter((e) => e.kind === 'step.end').length)}
  ${metric('retries', result?.metrics.retries ?? 0)}
  ${metric('recoveries', result?.metrics.recoveries ?? 0)}
  ${metric('degraded', result?.metrics.degradedResolutions ?? 0)}
  ${metric('interventions', result?.metrics.interventions ?? 0)}
  ${metric('duration', result ? `${(result.durationMs / 1000).toFixed(1)}s` : '-')}
  ${metric('model calls', result?.metrics.llmCalls ?? 0, true)}
</div>
<p class="note">Model calls are zero by construction on the replay path: the module is
forbidden from importing a model SDK, a source scan re-checks it, and this counter is
asserted in the test suite. Determinism that is only promised is not determinism.</p>

<h2>Steps</h2>
${(result?.steps ?? []).map(renderStep).join('\n') || '<p class="meta">No steps recorded.</p>'}

${renderDrift(result)}

<h2>Event log</h2>
<div class="overflow"><table>
<tr><th>#</th><th>time</th><th>kind</th><th>step</th><th>what happened, and why</th></tr>
${events.map(renderEvent).join('\n')}
</table></div>

</div></body></html>`;
}

function renderSummary(r?: ReplayResult): string {
  if (!r) return '';
  if (r.status === 'success') {
    return `<div class="card"><b>Outputs</b><div class="overflow"><table style="margin-top:8px">
      ${Object.entries(r.outputs).map(([k, v]) =>
        `<tr><td class="k">${esc(k)}</td><td>${esc(JSON.stringify(v))}</td></tr>`).join('')}
    </table></div></div>`;
  }
  if (r.status === 'business_outcome') {
    return `<div class="card">
      <b>Business outcome: <code>${esc(r.outcome.code)}</code></b>
      <p class="meta" style="margin:6px 0 0">${esc(r.outcome.description)}</p>
      <p class="note">This is an answer the caller asked for, not a failure. The run
      completed successfully and reported what the application said.</p>
    </div>`;
  }
  if (r.status === 'failed') {
    return `<div class="fail"><b>Failed: <code>${esc(r.failure.code)}</code></b>
      <p class="meta" style="margin:6px 0 0">${esc(r.failure.message)}</p>
      <dl>
        <dt>at step</dt><dd>${esc(r.failure.stepId ?? '-')}</dd>
        <dt>expected</dt><dd>${esc(r.failure.expected)}</dd>
        <dt>observed</dt><dd>${esc(r.failure.observed)}</dd>
      </dl></div>`;
  }
  if (r.status === 'escalated') {
    // Outputs are present exactly when a human unstuck the run and it went on
    // to finish. Showing them matters: without them the report reads as a run
    // that stopped, when in fact the task was completed - just not unaided.
    const finished = r.outputs && Object.keys(r.outputs).length > 0
      ? `<div class="overflow"><table style="margin-top:8px">
          ${Object.entries(r.outputs).map(([k, v]) =>
            `<tr><td class="k">${esc(k)}</td><td>${esc(JSON.stringify(v))}</td></tr>`).join('')}
        </table></div>
        <p class="note">The task did complete and these outputs are good. It is reported
        as escalated rather than as a clean success because a person had to take the
        session to get here, and a caller that cannot tell those apart will treat them
        the same.</p>`
      : `<p class="note">The run stopped here. ${r.escalation.resolution === 'timed_out'
          ? 'Nobody claimed the intervention, so the declared abandon path ran and the '
            + 'session was left somewhere safe.'
          : 'The operator ended the run deliberately.'}</p>`;
    return `<div class="card"><b>Escalated to a human</b>
      <p class="meta" style="margin:6px 0 0">${esc(r.escalation.detail)}</p>
      <p class="note">Reason <code>${esc(r.escalation.reason)}</code> &middot;
      intervention <code>${esc(r.escalation.interventionId)}</code> &middot;
      ${r.escalation.claimed ? `claimed by ${esc(r.escalation.claimedBy ?? 'an operator')}`
                             : 'never claimed'} &middot;
      resolution <code>${esc(r.escalation.resolution ?? 'pending')}</code> &middot;
      ${r.escalation.humanActionCount} human action(s) recorded.</p>
      ${finished}</div>`;
  }
  return `<div class="card"><b>Blocked by policy</b>
    <p class="meta" style="margin:6px 0 0">${esc(r.policy.reason)}</p>
    <p class="note">Rule <code>${esc(r.policy.rule)}</code>. The guardrail refused the
    action; this is the system working, not failing.</p></div>`;
}

function renderStep(s: ReplayResult['steps'][number], i: number): string {
  const res = s.resolution;
  const shots = s.evidence.filter((e) => e.endsWith('.png'));
  return `<div class="step s-${esc(s.status)}">
    <h3>${i + 1}. ${esc(s.intent)}
      <span class="badge b-${s.status === 'ok' ? 'success' : s.status === 'failed' ? 'failed' : 'unknown'}"
        >${esc(s.status)}</span></h3>
    <div class="meta">
      <b>${esc(s.actionKind)}</b> (${esc(s.actionClass)}) &middot; ${s.durationMs}ms
      ${s.retries ? ` &middot; ${s.retries} retr${s.retries === 1 ? 'y' : 'ies'}` : ''}
      ${s.recoveries.length ? ` &middot; recovered via ${s.recoveries.map((r) => esc(r.ruleId)).join(', ')}` : ''}
    </div>
    ${res ? `<div class="meta${res.degraded ? ' warn' : ''}">
      Found <b>${esc(res.locatorDescription)}</b> at tier <b>${res.winningTier}</b>,
      ${res.agreement} strateg${res.agreement === 1 ? 'y' : 'ies'} in agreement
      ${res.degraded ? ' &mdash; degraded, the preferred strategy missed and this surface has probably changed'
                     : ''}</div>` : ''}
    ${shots.length ? `<div class="shots">${shots.map((p) =>
      `<figure><img src="${esc(p)}" alt="${esc(p)}" loading="lazy">
        <figcaption>${esc(p.split('/').pop() ?? p)}</figcaption></figure>`).join('')}</div>` : ''}
  </div>`;
}

function renderDrift(r?: ReplayResult): string {
  if (!r?.drift.length) return '';
  return `<h2>Drift</h2>
  <div class="card"><p class="meta" style="margin:0 0 10px">
    Each record is a place where the preferred way of finding a control stopped working and a
    fallback carried the step. This is the signal that a surface has changed &mdash; and, across
    tenants running the same product, it is what tells you which steps need an overlay.</p>
  <div class="overflow"><table>
  <tr><th>step</th><th>control</th><th>expected</th><th>actual</th><th>agreement</th></tr>
  ${r.drift.map((d) => `<tr><td class="k">${esc(d.stepId)}</td>
    <td>${esc(d.locatorDescription)}</td><td class="k">tier ${d.expectedTier}</td>
    <td class="k">tier ${d.actualTier}</td><td class="k">${d.agreement}</td></tr>`).join('')}
  </table></div></div>`;
}

function renderEvent(e: EvidenceEvent): string {
  const problem = e.kind === 'locator.fail' || e.kind.startsWith('escalation');
  return `<tr${problem ? ' class="problem"' : ''}>
    <td class="k">${e.seq}</td>
    <td class="k">${esc(e.t.slice(11, 23))}</td>
    <td class="kind">${esc(e.kind)}</td>
    <td class="k">${esc(e.stepId ?? '')}</td>
    <td>${esc(e.message)}</td></tr>`;
}

function metric(k: string, n: string | number, hero = false): string {
  return `<div class="metric${hero ? ' hero' : ''}"><div class="n">${esc(String(n))}</div>
    <div class="k">${esc(k)}</div></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Renders a report for a run directory that already exists on disk. */
export function writeReportForRun(dir: string, result?: ReplayResult): string {
  const events = existsSync(join(dir, 'run.jsonl'))
    ? readFileSync(join(dir, 'run.jsonl'), 'utf8').trim().split('\n')
        .filter(Boolean).map((l) => JSON.parse(l) as EvidenceEvent)
    : [];
  const manifest = existsSync(join(dir, 'manifest.json'))
    ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    : {};
  const runId = String(manifest.runId ?? dir.split('/').pop() ?? 'run');
  return renderReport({ runId, events, manifest, result });
}
