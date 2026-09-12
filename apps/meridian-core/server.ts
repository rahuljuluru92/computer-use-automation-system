/**
 * Meridian Core - a deliberately hostile stand-in for a credit-union servicing
 * console.
 *
 * Why this exists rather than a public demo site: the brief's third-weighted
 * criterion is how replay handles runtime errors and exceptional states, and
 * the interesting ones - permission denials, session expiry, surprise dialogs,
 * transient 500s - cannot be produced on demand against someone else's site.
 * Neither can a second tenant skin of the same vendor product.
 *
 * The frame split is the other thing worth understanding here. Chrome (header,
 * nav) is served at the top level; every actual screen is served under /frame
 * and displayed inside a content iframe, with in-app links navigating the frame
 * rather than the page. That is how this generation of application was built,
 * and it has a consequence the replay engine has to live with: **the top-level
 * URL stops changing as you work**. A checkpoint written as "the url matches
 * /members/\d+" would pass forever without ever being true. So checkpoints are
 * written against the accessibility tree instead, and the frame chain is part
 * of how a control is located.
 *
 * Session expiry also renders the sign-in form *inside* the frame, which is
 * both what really happens and a clean target for a bounded reauth subflow.
 *
 * Flows:
 *   sign in -> member search -> member detail -> account detail (read balance)
 *   sign in -> member detail -> open sub-account -> review -> confirm -> reference
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sessionMiddleware } from './session.ts';
import { chaosMiddleware, isChaosMode, errorPage, markFired, CHAOS_MODES } from './chaos.ts';
import { newRender, ctl } from './ids.ts';
import { findMember, OPERATOR, MEMBERS } from './data/seed.ts';
import { TENANTS, isTenantName } from './tenants.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MERIDIAN_PORT ?? 4400);

const fmt = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Screens that exist at the top level purely to host the content frame. */
const SHELL_PATHS = [
  '/members/search',
  '/members/:id',
  '/members/:id/accounts/:acct',
  '/members/:id/subaccount/new',
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders one screen. `newRender()` here is what makes every control id on the
 * page differ from the last time it was served.
 *
 * Inside the frame we emit the content document only; the chrome lives in the
 * parent. Outside it, nothing but chrome plus the iframe.
 */
function page(
  req: express.Request,
  res: express.Response,
  view: string,
  locals: Record<string, unknown> = {},
): void {
  newRender();
  const base = {
    ctl,
    fmt,
    user: req.session.user,
    tenant: TENANTS[req.session.tenant],
    linkBase: req.baseUrl,
    currentPath: req.originalUrl,
    surpriseModal: res.locals.surpriseModal ?? null,
  };
  res.render(view, { ...base, ...locals }, (err, body) => {
    if (err) { res.status(500).send(errorPage('Render Error', String(err))); return; }
    res.render('_content', { ...base, ...locals, title: locals.title ?? 'Meridian', body },
      (wErr, html) => {
        if (wErr) { res.status(500).send(errorPage('Render Error', String(wErr))); return; }
        res.type('html').send(html);
      });
  });
}

function shell(req: express.Request, res: express.Response): void {
  newRender();
  res.render('_shell', {
    ctl,
    user: req.session.user,
    tenant: TENANTS[req.session.tenant],
    title: 'Meridian Core',
    frameSrc: '/frame' + req.originalUrl,
  }, (err, html) => {
    if (err) { res.status(500).send(errorPage('Render Error', String(err))); return; }
    res.type('html').send(html);
  });
}

/**
 * In-frame auth gate. Renders sign-in inside the content frame rather than
 * bouncing the whole window - which is what the real thing does, and what makes
 * a bounded reauth subflow possible.
 */
function requireAuth(req: express.Request, res: express.Response): boolean {
  if (req.session.user) return true;
  page(req, res, 'login', {
    title: 'Sign In', expired: true, error: null,
    uid: ctl('pnlLogin', 'txtOperatorId'),
    pid: ctl('pnlLogin', 'txtPassword'),
    sid: ctl('pnlLogin', 'btnSignIn'),
  });
  return false;
}

/**
 * Some tenants require an operator to click through a consent notice before
 * servicing tools open, once per session. Rendered inside the frame, same
 * reasoning as session-expiry sign-in (decision #19): the flow never leaves
 * the content document the automation is already watching.
 */
function requireConsent(req: express.Request, res: express.Response): boolean {
  if (!TENANTS[req.session.tenant].requiresConsent || req.session.consented) return true;
  page(req, res, 'consent', { title: 'Consent Required' });
  return false;
}

// ---------------------------------------------------------------------------
// The screens. Mounted under /frame; `req.baseUrl` keeps every link in-frame.
// ---------------------------------------------------------------------------

function contentRouter(): express.Router {
  const r = express.Router();

  r.get('/', (req, res) => {
    page(req, res, 'login', {
      title: 'Sign In', expired: req.query.expired === '1', error: null,
      uid: ctl('pnlLogin', 'txtOperatorId'),
      pid: ctl('pnlLogin', 'txtPassword'),
      sid: ctl('pnlLogin', 'btnSignIn'),
    });
  });

  r.post('/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (username === OPERATOR.username && password === OPERATOR.password) {
      req.session.user = username;
      res.redirect(`${req.baseUrl}/members/search`);
      return;
    }
    page(req, res, 'login', {
      title: 'Sign In', expired: false, error: 'Invalid operator ID or password.',
      uid: ctl('pnlLogin', 'txtOperatorId'),
      pid: ctl('pnlLogin', 'txtPassword'),
      sid: ctl('pnlLogin', 'btnSignIn'),
    });
  });

  r.get('/logout', (req, res) => { req.session.user = null; res.redirect(`${req.baseUrl}/`); });

  r.get('/members/search', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
    page(req, res, 'search', {
      title: 'Member Search', error: null, notFound: false, searchedId: '',
      midInput: ctl('pnlSearch', 'txtMemberId'),
      btnSearch: ctl('pnlSearch', 'btnSearch'),
    });
  });

  r.get('/members/lookup', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
    const id = String(req.query.memberId ?? '').trim();
    // "record not found" is page content with HTTP 200, exactly as a real app
    // does it. Status-code-driven detection would never see this.
    const member = req.session.chaos.mode === 'not_found' ? undefined : findMember(id);
    if (!member) {
      page(req, res, 'search', {
        title: 'Member Search', error: null, notFound: true, searchedId: id || '(blank)',
        midInput: ctl('pnlSearch', 'txtMemberId'),
        btnSearch: ctl('pnlSearch', 'btnSearch'),
      });
      return;
    }
    res.redirect(`${req.baseUrl}/members/${member.id}`);
  });

  r.get('/members/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
    const member = findMember(String(req.params.id));
    if (!member) { res.status(404).send(errorPage('Not Found', 'No such member record.')); return; }
    if (req.session.chaos.mode === 'permission_denied' || member.status === 'Restricted') {
      page(req, res, 'denied', { title: 'Access Restricted' });
      return;
    }
    page(req, res, 'member', { title: `Member ${member.id}`, member });
  });

  r.get('/members/:id/accounts/:acct', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
    const member = findMember(String(req.params.id));
    const account = member?.accounts.find((a) => a.number === String(req.params.acct));
    if (!member || !account) { res.status(404).send(errorPage('Not Found', 'No such account.')); return; }
    if (req.session.chaos.mode === 'permission_denied') {
      page(req, res, 'denied', { title: 'Access Restricted' });
      return;
    }
    page(req, res, 'account', { title: `Account ${account.number}`, member, account });
  });

  const formIds = (): Record<string, string> => ({
    type: ctl('pnlSub', 'ddlSubType'),
    nickname: ctl('pnlSub', 'txtNickname'),
    deposit: ctl('pnlSub', 'txtDeposit'),
    funding: ctl('pnlSub', 'ddlFunding'),
    submit: ctl('pnlSub', 'btnContinue'),
  });

  r.get('/members/:id/subaccount/new', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
    const member = findMember(String(req.params.id));
    if (!member) { res.status(404).send(errorPage('Not Found', 'No such member.')); return; }
    page(req, res, 'subaccount_new', {
      title: 'Open Sub-Account', member, errors: [], values: {}, f: formIds(),
    });
  });

  r.post('/members/:id/subaccount/review', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
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

    // The app rejects input the caller believes is valid: automation did
    // everything right and the answer is still no.
    if (req.session.chaos.mode === 'validation_error') {
      errors.push('Initial Deposit exceeds the daily funding limit for this member. (Policy: FUND-LIM-02)');
    }

    if (errors.length) {
      page(req, res, 'subaccount_new', { title: 'Open Sub-Account', member, errors, values, f: formIds() });
      return;
    }
    req.session.pending = values;
    page(req, res, 'subaccount_confirm', {
      title: 'Confirm Sub-Account', member, pending: values,
      btnConfirm: ctl('pnlConfirm', 'btnCommit'),
    });
  });

  r.post('/members/:id/subaccount/commit', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!requireConsent(req, res)) return;
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
    page(req, res, 'subaccount_done', {
      title: 'Sub-Account Opened', member, pending,
      reference: `SUB-${Date.now().toString(36).toUpperCase().slice(-8)}`,
      accountNumber: `00${7 + member.accounts.length}-${Math.floor(1000 + Math.random() * 8999)}`,
    });
  });

  r.post('/consent/accept', (req, res) => {
    if (!requireAuth(req, res)) return;
    req.session.consented = true;
    res.redirect(String(req.body.back || `${req.baseUrl}/members/search`));
  });

  r.post('/_dismiss', (req, res) => {
    markFired(req);
    res.redirect(String(req.body.back || `${req.baseUrl}/members/search`));
  });

  return r;
}

// ---------------------------------------------------------------------------

export function createApp(): express.Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', join(HERE, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(sessionMiddleware);
  app.use(chaosMiddleware);

  // Chaos control and health sit outside the frame split and outside chaos
  // itself, so a run can always arm, reset, and recover.
  app.get('/_chaos', (req, res) => {
    const mode = String(req.query.mode ?? '');
    if (!isChaosMode(mode)) { res.status(400).json({ error: 'unknown mode', valid: CHAOS_MODES }); return; }
    req.session.chaos = { mode, hits: 0, fired: false };
    res.json({ ok: true, mode });
  });
  app.get('/_chaos/reset', (req, res) => {
    req.session.chaos = { mode: 'none', hits: 0, fired: false };
    res.json({ ok: true, mode: 'none' });
  });
  // Tenant skin, armed through its own control route for the same reason
  // chaos is: the run itself stays an ordinary run driven through /frame.
  app.get('/_tenant', (req, res) => {
    const name = String(req.query.name ?? '');
    if (!isTenantName(name)) {
      res.status(400).json({ error: 'unknown tenant', valid: Object.keys(TENANTS) });
      return;
    }
    req.session.tenant = name;
    req.session.consented = false;
    res.json({ ok: true, tenant: name });
  });
  app.get('/_health', (_req, res) => { res.json({ ok: true, members: MEMBERS.length }); });

  // The content frame. Everything real happens here.
  app.use('/frame', contentRouter());

  // Top level: sign-in is unframed; every working screen is chrome plus iframe.
  app.get('/', (req, res) => {
    if (req.session.user) { res.redirect('/members/search'); return; }
    page(req, res, 'login', {
      title: 'Sign In', expired: req.query.expired === '1', error: null,
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
      title: 'Sign In', expired: false, error: 'Invalid operator ID or password.',
      uid: ctl('pnlLogin', 'txtOperatorId'),
      pid: ctl('pnlLogin', 'txtPassword'),
      sid: ctl('pnlLogin', 'btnSignIn'),
    });
  });
  app.get('/logout', (req, res) => { req.session.user = null; res.redirect('/'); });

  for (const p of SHELL_PATHS) app.get(p, shell);

  app.use((req, res) => {
    res.status(404).send(errorPage('Page Not Found', `No handler for ${req.path}.`));
  });

  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  createApp().listen(PORT, () => {
    console.log(`Meridian Core listening on http://localhost:${PORT}`);
    console.log(`  operator: ${OPERATOR.username}  (password in apps/meridian-core/data/seed.ts)`);
    console.log(`  chaos:    http://localhost:${PORT}/_chaos?mode=<${CHAOS_MODES.join('|')}>`);
  });
}
