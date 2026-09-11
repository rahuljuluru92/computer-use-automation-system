/**
 * Meridian Core - a deliberately hostile stand-in for a credit-union servicing
 * console.
 *
 * Why this exists rather than a public demo site: the brief's third-weighted
 * criterion is how replay handles runtime errors and exceptional states, and
 * the interesting ones - permission denials, session expiry, surprise dialogs,
 * transient 500s - cannot be produced on demand against someone else's site.
 * Neither can a second tenant skin of the same vendor product. Everything this
 * app does that looks like set dressing is load-bearing for something the
 * submission has to demonstrate.
 *
 * The flows:
 *   sign in -> member search -> member detail -> account detail (read balance)
 *   sign in -> member search -> member detail -> open sub-account -> review -> confirm
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sessionMiddleware } from './session.ts';
import { chaosMiddleware, isChaosMode, errorPage, markFired, CHAOS_MODES } from './chaos.ts';
import { newRender, ctl } from './ids.ts';
import { findMember, OPERATOR, MEMBERS } from './data/seed.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MERIDIAN_PORT ?? 4400);

/**
 * Exported as a factory rather than started at import time, so integration
 * tests can run it on an ephemeral port without a shell and without racing a
 * fixed port.
 */
export function createApp(): express.Express {
const app = express();
app.set('view engine', 'ejs');
app.set('views', join(HERE, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use(chaosMiddleware);

const fmt = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Renders through the layout. Calling newRender() here is what makes every
 * control id on the page different from the last time it was served.
 */
function page(
  req: express.Request,
  res: express.Response,
  view: string,
  locals: Record<string, unknown> = {},
): void {
  newRender();
  const base = {
    ctl, fmt,
    user: req.session.user,
    currentPath: req.originalUrl,
    surpriseModal: res.locals.surpriseModal ?? null,
  };
  res.render(view, { ...base, ...locals }, (err, body) => {
    if (err) { res.status(500).send(errorPage('Render Error', String(err))); return; }
    res.render('_layout', { ...base, ...locals, title: locals.title ?? 'Meridian', body },
      (lErr, html) => {
        if (lErr) { res.status(500).send(errorPage('Render Error', String(lErr))); return; }
        res.type('html').send(html);
      });
  });
}

function requireAuth(req: express.Request, res: express.Response): boolean {
  if (req.session.user) return true;
  res.redirect('/?expired=1');
  return false;
}

// ---------------------------------------------------------------------------
// Chaos control. Exempt from the chaos middleware so a run can always recover.
// ---------------------------------------------------------------------------

app.get('/_chaos', (req, res) => {
  const mode = String(req.query.mode ?? '');
  if (!isChaosMode(mode)) {
    res.status(400).json({ error: `unknown mode`, valid: CHAOS_MODES });
    return;
  }
  req.session.chaos = { mode, hits: 0, fired: false };
  res.json({ ok: true, mode });
});

app.get('/_chaos/reset', (req, res) => {
  req.session.chaos = { mode: 'none', hits: 0, fired: false };
  res.json({ ok: true, mode: 'none' });
});

app.get('/_health', (_req, res) => { res.json({ ok: true, members: MEMBERS.length }); });

app.post('/_dismiss', (req, res) => {
  markFired(req);
  res.redirect(String(req.body.back || '/members/search'));
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  page(req, res, 'login', {
    title: 'Sign In',
    expired: req.query.expired === '1',
    error: null,
    uid: ctl('pnlLogin', 'txtOperatorId'),
    pid: ctl('pnlLogin', 'txtPassword'),
    sid: ctl('pnlLogin', 'btnSignIn'),
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (username === OPERATOR.username && password === OPERATOR.password) {
    req.session.user = username;
    res.redirect('/members/search');
    return;
  }
  page(req, res, 'login', {
    title: 'Sign In', expired: false,
    error: 'Invalid operator ID or password.',
    uid: ctl('pnlLogin', 'txtOperatorId'),
    pid: ctl('pnlLogin', 'txtPassword'),
    sid: ctl('pnlLogin', 'btnSignIn'),
  });
});

app.get('/logout', (req, res) => { req.session.user = null; res.redirect('/'); });

// ---------------------------------------------------------------------------
// Member search and detail
// ---------------------------------------------------------------------------

app.get('/members/search', (req, res) => {
  if (!requireAuth(req, res)) return;
  page(req, res, 'search', {
    title: 'Member Search', error: null, notFound: false, searchedId: '',
    midInput: ctl('pnlSearch', 'txtMemberId'),
    btnSearch: ctl('pnlSearch', 'btnSearch'),
  });
});

app.get('/members/lookup', (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = String(req.query.memberId ?? '').trim();
  const chaos = req.session.chaos.mode;

  // "record not found" is a legitimate answer, and it is rendered as content
  // with a 200 - exactly as a real app does. A replay that keys off HTTP status
  // would miss it entirely, which is why outcome detection is declared against
  // the accessibility tree instead.
  const forcedNotFound = chaos === 'not_found';
  const member = forcedNotFound ? undefined : findMember(id);

  if (!member) {
    page(req, res, 'search', {
      title: 'Member Search', error: null, notFound: true, searchedId: id || '(blank)',
      midInput: ctl('pnlSearch', 'txtMemberId'),
      btnSearch: ctl('pnlSearch', 'btnSearch'),
    });
    return;
  }
  res.redirect(`/members/${member.id}`);
});

app.get('/members/:id', (req, res) => {
  if (!requireAuth(req, res)) return;
  const member = findMember(String(req.params.id));
  if (!member) { res.status(404).send(errorPage('Not Found', 'No such member record.')); return; }

  if (req.session.chaos.mode === 'permission_denied' || member.status === 'Restricted') {
    page(req, res, 'denied', { title: 'Access Restricted' });
    return;
  }
  page(req, res, 'member', { title: `Member ${member.id}`, member });
});

app.get('/members/:id/accounts/:acct', (req, res) => {
  if (!requireAuth(req, res)) return;
  const member = findMember(String(req.params.id));
  const account = member?.accounts.find((a) => a.number === String(req.params.acct));
  if (!member || !account) {
    res.status(404).send(errorPage('Not Found', 'No such account.'));
    return;
  }
  if (req.session.chaos.mode === 'permission_denied') {
    page(req, res, 'denied', { title: 'Access Restricted' });
    return;
  }
  page(req, res, 'account', { title: `Account ${account.number}`, member, account });
});

// ---------------------------------------------------------------------------
// Open sub-account: form -> review -> commit
// ---------------------------------------------------------------------------

const formIds = (): Record<string, string> => ({
  type: ctl('pnlSub', 'ddlSubType'),
  nickname: ctl('pnlSub', 'txtNickname'),
  deposit: ctl('pnlSub', 'txtDeposit'),
  funding: ctl('pnlSub', 'ddlFunding'),
  submit: ctl('pnlSub', 'btnContinue'),
});

app.get('/members/:id/subaccount/new', (req, res) => {
  if (!requireAuth(req, res)) return;
  const member = findMember(String(req.params.id));
  if (!member) { res.status(404).send(errorPage('Not Found', 'No such member.')); return; }
  page(req, res, 'subaccount_new', {
    title: 'Open Sub-Account', member, errors: [], values: {}, f: formIds(),
  });
});

app.post('/members/:id/subaccount/review', (req, res) => {
  if (!requireAuth(req, res)) return;
  const member = findMember(String(req.params.id));
  if (!member) { res.status(404).send(errorPage('Not Found', 'No such member.')); return; }

  const values = req.body as Record<string, string>;
  const errors: string[] = [];

  if (!values.subType) errors.push('Sub-Account Type is required.');
  if (!values.nickname?.trim()) errors.push('Nickname is required.');
  const deposit = Number(values.deposit);
  if (!values.deposit || Number.isNaN(deposit)) errors.push('Initial Deposit must be a number.');
  else if (deposit < 25) errors.push('Initial Deposit must be at least 25.00.');
  if (!values.funding) errors.push('Funding Account is required.');

  // Injected validation failure: the app rejects input that is, as far as the
  // caller is concerned, perfectly valid. This is the case where the automation
  // did everything right and the answer is still "no".
  if (req.session.chaos.mode === 'validation_error') {
    errors.push('Initial Deposit exceeds the daily funding limit for this member. (Policy: FUND-LIM-02)');
  }

  if (errors.length) {
    page(req, res, 'subaccount_new', {
      title: 'Open Sub-Account', member, errors, values, f: formIds(),
    });
    return;
  }

  req.session.pending = values;
  page(req, res, 'subaccount_confirm', {
    title: 'Confirm Sub-Account', member, pending: values,
    btnConfirm: ctl('pnlConfirm', 'btnCommit'),
  });
});

app.post('/members/:id/subaccount/commit', (req, res) => {
  if (!requireAuth(req, res)) return;
  const member = findMember(String(req.params.id));
  const pending = req.session.pending;
  if (!member || !pending) {
    res.status(400).send(errorPage('Session Error', 'No pending sub-account request.'));
    return;
  }

  const key = `${member.id}:${pending.subType}:${pending.nickname}`;
  if (req.session.chaos.mode === 'duplicate_guard' && req.session.submitted.has(key)) {
    res.status(409).send(errorPage(
      'Duplicate Request',
      'An identical sub-account request was already submitted in this session. '
      + 'Submitting again would create a second account. (Policy: DUP-GUARD-01)',
    ));
    return;
  }
  req.session.submitted.add(key);

  const reference = `SUB-${Date.now().toString(36).toUpperCase().slice(-8)}`;
  const accountNumber = `00${7 + member.accounts.length}-${
    Math.floor(1000 + Math.random() * 8999)}`;

  page(req, res, 'subaccount_done', {
    title: 'Sub-Account Opened', member, pending, reference, accountNumber,
  });
});

app.use((req, res) => {
  res.status(404).send(errorPage('Page Not Found', `No handler for ${req.path}.`));
});

  return app;
}

// Only listen when run directly, not when imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  createApp().listen(PORT, () => {
    console.log(`Meridian Core listening on http://localhost:${PORT}`);
    console.log(`  operator: ${OPERATOR.username}  (password in apps/meridian-core/data/seed.ts)`);
    console.log(`  chaos:    http://localhost:${PORT}/_chaos?mode=<${CHAOS_MODES.join('|')}>`);
  });
}
