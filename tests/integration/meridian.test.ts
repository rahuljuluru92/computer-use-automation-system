/**
 * The target app has to behave the way the replay engine will assume it does.
 *
 * These are not tests of a deliverable - Meridian Core is scaffolding. They
 * exist because every later phase is calibrated against this app's behaviour,
 * so if a chaos mode silently stops firing, the error-taxonomy demo quietly
 * turns into a happy-path demo and nothing else would catch it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR, CANARY_SSN } from '../../apps/meridian-core/data/seed.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A cookie-carrying fetch, because the whole app is session-driven. */
function client() {
  let cookie = '';
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(base + path, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
}

async function signIn(go: ReturnType<typeof client>): Promise<void> {
  await go('/');
  const res = await go('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: OPERATOR.username, password: OPERATOR.password }),
  });
  expect(res.status).toBe(302);
}

describe('Meridian Core: the flows the capability will record', () => {
  it('signs in and reaches member search', async () => {
    const go = client();
    await signIn(go);
    expect(await (await go('/members/search')).text()).toContain('Member Search');
  });

  it('looks up a member and reads a savings balance', async () => {
    const go = client();
    await signIn(go);
    expect((await go('/members/lookup?memberId=12345')).status).toBe(302);
    const detail = await (await go('/members/12345')).text();
    expect(detail).toContain('Jordan Avery');
    const account = await (await go('/members/12345/accounts/0001-4477')).text();
    expect(account).toContain('$4,210.55');
  });

  it('regenerates every control id between renders, so CSS selectors are dead', async () => {
    const go = client();
    const ids = (html: string): string[] => [...html.matchAll(/id="(ctl00[^"]*)"/g)].map((m) => m[1]!);
    const first = ids(await (await go('/')).text());
    const second = ids(await (await go('/')).text());
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toEqual(second);
  });

  it('renders regulated data on the page, so redaction has something to prove', async () => {
    const go = client();
    await signIn(go);
    expect(await (await go('/members/12345')).text()).toContain(CANARY_SSN);
  });
});

describe('Meridian Core: business outcomes (answers, not failures)', () => {
  it('reports a missing member as page content with HTTP 200', async () => {
    const go = client();
    await signIn(go);
    const res = await go('/members/lookup?memberId=99999');
    // A replay keyed off HTTP status would miss this entirely, which is why
    // outcome detection is declared against the accessibility tree instead.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('No member record found');
  });

  it('denies a restricted member that genuinely exists', async () => {
    const go = client();
    await signIn(go);
    const body = await (await go('/members/55555')).text();
    expect(body).toContain('Permission denied');
    expect(body).not.toContain('No member record found'); // not the same thing
  });
});

describe('Meridian Core: chaos modes', () => {
  const arm = async (go: ReturnType<typeof client>, mode: string): Promise<void> => {
    expect((await go(`/_chaos?mode=${mode}`)).status).toBe(200);
  };

  it('rejects an unknown mode rather than silently doing nothing', async () => {
    const go = client();
    expect((await go('/_chaos?mode=banana')).status).toBe(400);
  });

  it('not_found makes a real member report as missing', async () => {
    const go = client();
    await signIn(go); await arm(go, 'not_found');
    expect(await (await go('/members/lookup?memberId=12345')).text())
      .toContain('No member record found');
  });

  it('http_500 fails twice then recovers, so bounded retry survives it', async () => {
    const go = client();
    await signIn(go); await arm(go, 'http_500');
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await go('/members/search')).status);
    expect(codes).toEqual([500, 500, 200, 200]);
  });

  it('session_timeout fires mid-flow and bounces to the login page', async () => {
    const go = client();
    await signIn(go); await arm(go, 'session_timeout');
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await go('/members/search');
      results.push(r.status === 302 ? (r.headers.get('location') ?? '') : 'ok');
    }
    expect(results.slice(0, 2)).toEqual(['ok', 'ok']);
    expect(results[2]).toContain('expired=1');
  });

  it('surprise_modal injects a blocking dialog with an accessible name', async () => {
    const go = client();
    await signIn(go); await arm(go, 'surprise_modal');
    await go('/members/search');
    const body = await (await go('/members/search')).text();
    expect(body).toContain('role="dialog"');
    expect(body).toContain('Scheduled Maintenance Notice');
  });

  it('validation_error rejects input the caller believes is valid', async () => {
    const go = client();
    await signIn(go); await arm(go, 'validation_error');
    const res = await go('/members/12345/subaccount/review', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        subType: 'Savings', nickname: 'Vacation Fund', deposit: '500', funding: '0002-9910',
      }),
    });
    expect(await res.text()).toContain('FUND-LIM-02');
  });

  it('permission_denied blocks a member who is not otherwise restricted', async () => {
    const go = client();
    await signIn(go); await arm(go, 'permission_denied');
    // 12345 is an ordinary active member; the denial is injected, not intrinsic.
    const body = await (await go('/members/12345')).text();
    expect(body).toContain('Permission denied');
  });

  it('slow_load delays without breaking, so state predicates can outwait it', async () => {
    const go = client();
    await signIn(go); await arm(go, 'slow_load');
    const started = Date.now();
    const res = await go('/members/search');
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);            // slow, not broken
    expect(elapsed).toBeGreaterThan(2_000);  // a fixed sleep would either flake or waste
  });

  it('duplicate_guard refuses an identical resubmit with 409', async () => {
    const go = client();
    await signIn(go); await arm(go, 'duplicate_guard');
    const submit = async (): Promise<Response> => {
      await go('/members/12345/subaccount/review', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          subType: 'Savings', nickname: 'Vacation Fund', deposit: '500', funding: '0002-9910',
        }),
      });
      return go('/members/12345/subaccount/commit', { method: 'POST' });
    };
    expect((await submit()).status).toBe(200);
    const second = await submit();
    expect(second.status).toBe(409);
    expect(await second.text()).toContain('DUP-GUARD-01');
  });
});
