/**
 * The console page.
 *
 * One file, no build step, no framework, and it polls. That is a deliberate
 * choice rather than a corner cut: the interesting engineering in this feature
 * is the lease protocol and the capture, and a console with a toolchain would
 * add review surface to the least interesting part of it while making the
 * demonstration harder to run.
 *
 * The layout is organised around the single question an operator has when this
 * page lights up: *should I take this?* So the reason, the step, the detail and
 * a picture of the stuck screen come first, and the buttons that change
 * anything come last.
 *
 * Note there is no free-text anything that reaches the run. The operator picks
 * one of three decisions and may attach a note for the record. Everything else
 * they do, they do in the browser the run is holding - which is the whole idea.
 */

export function consolePage(): string {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator console</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1117; --panel: #171a23; --line: #262b38;
    --ink: #e6e9f0; --dim: #98a0b3;
    --warn: #f0b429; --bad: #ef5f5f; --good: #4ec9a5; --info: #6ba7f5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    padding: 18px 24px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .sub { color: var(--dim); font-size: 13px; }
  main { padding: 24px; max-width: 900px; }
  .empty { color: var(--dim); padding: 40px 0; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 18px 20px; margin-bottom: 16px;
  }
  .card.live { border-color: var(--warn); }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .tag {
    font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase; letter-spacing: .6px;
    padding: 5px 8px; border-radius: 5px; border: 1px solid var(--line); color: var(--dim);
  }
  .tag.pending { color: var(--warn); border-color: var(--warn); }
  .tag.claimed { color: var(--info); border-color: var(--info); }
  .tag.resolved, .tag.skipped { color: var(--good); border-color: var(--good); }
  .tag.aborted, .tag.timed_out { color: var(--bad); border-color: var(--bad); }
  .detail { font-size: 15px; margin: 4px 0 14px; }
  dl { display: grid; grid-template-columns: 150px 1fr; gap: 6px 16px; margin: 0 0 14px; font-size: 13px; }
  dt { color: var(--dim); }
  dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  img.shot {
    width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 14px;
    background: #000;
  }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  button {
    font: 500 13px/1 inherit; padding: 10px 14px; border-radius: 7px;
    border: 1px solid var(--line); background: #222634; color: var(--ink); cursor: pointer;
  }
  button:hover { border-color: var(--dim); }
  button.primary { background: var(--warn); color: #17181d; border-color: var(--warn); font-weight: 600; }
  button.good { background: var(--good); color: #10201b; border-color: var(--good); font-weight: 600; }
  button.bad { color: var(--bad); }
  input[type=text] {
    font: 13px/1 inherit; padding: 10px 12px; border-radius: 7px; flex: 1 1 240px;
    border: 1px solid var(--line); background: #12141c; color: var(--ink);
  }
  .hint { color: var(--dim); font-size: 12.5px; margin: 10px 0 0; }
  ul.log { list-style: none; padding: 0; margin: 10px 0 0; font-size: 12.5px; color: var(--dim); }
  ul.log li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 0; }
  .err { color: var(--bad); font-size: 13px; margin-top: 10px; min-height: 18px; }
</style>
</head>
<body>
<header>
  <h1>Operator console</h1>
  <span class="sub" id="status">connecting...</span>
  <span class="sub" id="who"></span>
</header>
<main>
  <div id="list"><p class="empty">No interventions. A run will appear here the moment it gets stuck.</p></div>
</main>
<script>
(function () {
  var elList = document.getElementById('list');
  var elStatus = document.getElementById('status');
  var elWho = document.getElementById('who');
  var lastError = '';

  function operatorId() {
    var id = null;
    try { id = window.localStorage.getItem('cua.operator'); } catch (e) { id = null; }
    if (!id) {
      id = window.prompt('Your name, for the audit record:', '') || '';
      id = id.trim();
      if (!id) return '';
      try { window.localStorage.setItem('cua.operator', id); } catch (e) { /* private mode */ }
    }
    return id;
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j && j.error ? j.error : 'request failed');
        return j;
      });
    }).then(refresh, function (err) {
      lastError = err.message; refresh();
    });
  }

  function take(id) {
    var who = operatorId();
    if (!who) return;
    lastError = '';
    post('/api/interventions/' + encodeURIComponent(id) + '/claim', { operatorId: who });
  }

  function decide(id, resolution) {
    var note = document.getElementById('note-' + id);
    lastError = '';
    post('/api/interventions/' + encodeURIComponent(id) + '/resolve', {
      resolution: resolution,
      note: note ? note.value : ''
    });
  }

  window.__take = take;
  window.__decide = decide;

  function card(r) {
    var live = r.state === 'pending' || r.state === 'claimed';
    var h = '<div class="card' + (live ? ' live' : '') + '">';
    h += '<div class="row">';
    h += '<span class="tag ' + esc(r.state) + '">' + esc(r.state.replace('_', ' ')) + '</span>';
    h += '<span class="tag">' + esc(r.reason.replace(/_/g, ' ')) + '</span>';
    h += '<span class="sub">' + esc(r.capability.id) + ' v' + esc(r.capability.version) + '</span>';
    h += '</div>';
    h += '<p class="detail">' + esc(r.detail) + '</p>';

    h += '<dl>';
    h += '<dt>step</dt><dd>' + esc(r.stepId) + ' &mdash; ' + esc(r.stepIntent) + '</dd>';
    h += '<dt>next action</dt><dd>' + esc(r.actionKind) + ' (' + esc(r.actionClass) + ')</dd>';
    h += '<dt>page</dt><dd>' + esc(r.title || '(untitled)') + '<br>' + esc(r.url) + '</dd>';
    h += '<dt>raised</dt><dd>' + esc(r.raisedAt) + '</dd>';
    if (live) h += '<dt>abandons at</dt><dd>' + esc(r.expiresAt) + '</dd>';
    if (r.claimedBy) h += '<dt>held by</dt><dd>' + esc(r.claimedBy) + '</dd>';
    if (r.resolution) h += '<dt>resolution</dt><dd>' + esc(r.resolution) + '</dd>';
    if (r.note) h += '<dt>note</dt><dd>' + esc(r.note) + '</dd>';
    if (r.abandon) {
      h += '<dt>abandon</dt><dd>' + esc(r.abandon.kind) + ' &mdash; '
         + (r.abandon.performed ? 'performed' : 'NOT performed') + ': ' + esc(r.abandon.detail) + '</dd>';
    }
    h += '</dl>';

    if (r.screenshotPath) {
      h += '<img class="shot" alt="the screen the run stopped on" src="/api/interventions/'
         + encodeURIComponent(r.id) + '/screenshot?t=' + encodeURIComponent(r.raisedAt) + '">';
    }

    if (r.state === 'pending') {
      h += '<div class="actions"><button class="primary" onclick="__take(\\'' + esc(r.id) + '\\')">'
         + 'Take control</button></div>';
      h += '<p class="hint">Taking control stops automation and hands you the browser it is already '
         + 'holding. Everything you do there is recorded as an audit trail &mdash; what you touch, '
         + 'never what you type.</p>';
    } else if (r.state === 'claimed') {
      h += '<div class="actions">';
      h += '<input type="text" id="note-' + esc(r.id) + '" placeholder="What did you do? (recorded)">';
      h += '</div><div class="actions" style="margin-top:10px">';
      h += '<button class="good" onclick="__decide(\\'' + esc(r.id) + '\\',\\'resolved\\')">Hand back &mdash; fixed</button>';
      h += '<button onclick="__decide(\\'' + esc(r.id) + '\\',\\'skipped\\')">Hand back &mdash; skip this step</button>';
      h += '<button class="bad" onclick="__decide(\\'' + esc(r.id) + '\\',\\'aborted\\')">Abort the run</button>';
      h += '</div>';
      h += '<p class="hint">&ldquo;Fixed&rdquo; resumes the step, which re-checks itself before acting &mdash; '
         + 'if you already did what it was about to do, it will notice and move on rather than doing it twice.</p>';
    }

    if (r.humanActions && r.humanActions.length) {
      h += '<ul class="log">';
      for (var i = 0; i < r.humanActions.length; i++) {
        var a = r.humanActions[i];
        h += '<li>' + esc(a.at.slice(11, 19)) + '  ' + esc(a.kind) + '  ' + esc(a.target)
           + (a.valueLength !== undefined ? '  (' + a.valueLength + ' chars)' : '') + '</li>';
      }
      h += '</ul>';
    }

    h += '<div class="err">' + esc(live ? lastError : '') + '</div>';
    h += '</div>';
    return h;
  }

  function render(list) {
    if (!list.length) {
      elList.innerHTML = '<p class="empty">No interventions. A run will appear here the '
        + 'moment it gets stuck.</p>';
      return;
    }
    elList.innerHTML = list.map(card).join('');
  }

  function refresh() {
    return fetch('/api/interventions')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var open = j.interventions.filter(function (r) {
          return r.state === 'pending' || r.state === 'claimed';
        }).length;
        elStatus.textContent = open
          ? open + ' waiting on you'
          : 'connected, nothing waiting';
        var who = null;
        try { who = window.localStorage.getItem('cua.operator'); } catch (e) { who = null; }
        elWho.textContent = who ? 'signed in as ' + who : '';
        render(j.interventions);
      })
      .catch(function () { elStatus.textContent = 'console unreachable'; });
  }

  refresh();
  setInterval(refresh, 1000);
})();
</script>
</body>
</html>`;
