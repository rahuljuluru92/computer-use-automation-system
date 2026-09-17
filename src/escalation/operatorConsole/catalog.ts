/**
 * The read-only capability catalog view.
 *
 * A separate file from `ui.ts` on purpose: that page is about a single live
 * intervention and polls a mutable API; this one lists static metadata about
 * what is approved to run at all, and is rebuilt fresh on every request
 * rather than pushed to a client that stays open. Different concern, same
 * no-build, inline-HTML, dark-theme style as the rest of this console
 * (decision #131).
 *
 * Reads `loadApprovedCatalog()` (`src/mcp/catalog.ts`) - the identical loader
 * `cua mcp` uses to decide what an agent may call, so this page can never
 * show a capability that catalog would refuse to serve, or vice versa.
 */

import type { CatalogEntry } from '../../mcp/catalog.ts';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function row(entry: CatalogEntry): string {
  const { artifact } = entry;
  const overlays = Object.keys(artifact.tenancy.overlays);
  const classes = artifact.policy.allowedActionClasses.join(', ');
  const outcomes = artifact.outcomes.map((o) => o.code).join(', ') || '—';
  const verified = artifact.provenance.selfVerified.passed
    ? esc(artifact.provenance.selfVerified.at.slice(0, 10))
    : 'no';

  return `<tr>
    <td><code>${esc(artifact.id)}</code></td>
    <td>${esc(artifact.version)}</td>
    <td>${esc(artifact.description)}</td>
    <td>${esc(classes)}</td>
    <td>${esc(outcomes)}</td>
    <td>${overlays.length ? overlays.map(esc).join(', ') : '—'}</td>
    <td>${esc(artifact.provenance.model)}</td>
    <td>${verified}</td>
  </tr>`;
}

export function catalogPage(entries: readonly CatalogEntry[]): string {
  const body = entries.length
    ? `<table>
        <thead><tr>
          <th>id</th><th>version</th><th>description</th><th>action classes</th>
          <th>business outcomes</th><th>tenant overlays</th><th>discovered by</th><th>self-verified</th>
        </tr></thead>
        <tbody>${entries.map(row).join('')}</tbody>
      </table>`
    : '<p class="empty">No approved capabilities. `cua approve --artifact &lt;path&gt;` moves a draft here.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capability catalog</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1117; --panel: #171a23; --line: #262b38; --ink: #e6e9f0; --dim: #98a0b3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { padding: 18px 24px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .sub { color: var(--dim); font-size: 13px; margin-top: 4px; }
  main { padding: 24px; max-width: 1100px; }
  .empty { color: var(--dim); padding: 40px 0; }
  table {
    width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
  }
  th, td {
    text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line);
    font-size: 13px; vertical-align: top;
  }
  th { color: var(--dim); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .4px; }
  tr:last-child td { border-bottom: none; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<header>
  <h1>Capability catalog</h1>
  <div class="sub">What an agent may call over MCP right now - the same list <code>cua mcp</code>'s tools/list serves.</div>
</header>
<main>${body}</main>
</body>
</html>`;
}
