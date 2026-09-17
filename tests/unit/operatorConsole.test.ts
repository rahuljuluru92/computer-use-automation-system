/**
 * The console, and the wire between it and a run in another process.
 *
 * Two things are being checked here and only one of them is plumbing. The
 * plumbing is the routes. The other is that `RemoteBus` and `InterventionBus`
 * are genuinely interchangeable behind `InterventionSink` - because that is the
 * claim that lets the handoff protocol be written once and be correct whether
 * the operator is in this process or on the other end of a socket.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InterventionBus } from '../../src/escalation/bus.ts';
import type { RaiseInput } from '../../src/escalation/bus.ts';
import { startOperatorConsole, type RunningConsole } from '../../src/escalation/operatorConsole/server.ts';
import { RemoteBus } from '../../src/escalation/remote.ts';
import { CapabilityArtifact } from '../../src/core/schema.ts';
import { withIntegrity } from '../../src/core/integrity.ts';
import { minimalArtifact } from '../fixtures/minimalArtifact.ts';

const EVIDENCE_ROOT = 'evidence/_test_console';

let bus: InterventionBus;
let console_: RunningConsole;
let base: string;

beforeAll(async () => {
  mkdirSync(join(EVIDENCE_ROOT, 'steps', '04'), { recursive: true });
  // Not a real PNG, but the server only reads and serves bytes.
  writeFileSync(join(EVIDENCE_ROOT, 'steps', '04', 'escalation.png'), Buffer.from('PNG-BYTES'));
  writeFileSync('evidence/_test_console_secret.txt', 'must never be served');

  bus = new InterventionBus({ timeoutMs: 30_000 });
  console_ = await startOperatorConsole({ bus, port: 0 });
  base = console_.url;
});

afterAll(async () => {
  bus.shutdown();
  await console_.close();
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
  rmSync('evidence/_test_console_secret.txt', { force: true });
});

function input(id: string, extra: Partial<RaiseInput> = {}): RaiseInput {
  return {
    id,
    runId: 'run-1',
    capability: { id: 'cap.member.read_savings_balance', version: '1.0.0' },
    reason: 'recovery_exhausted',
    detail: 'the account row never appeared',
    stepId: 's4',
    stepIntent: 'open the savings account',
    actionKind: 'click',
    actionClass: 'read',
    url: 'http://localhost:4400/frame/members/12345',
    title: 'Member 12345',
    ...extra,
  };
}

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the operator console', () => {
  it('serves a page a person can actually open', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Operator console');
    expect(html).toContain('Take control');
  });

  it('accepts an intervention raised by a run in another process', async () => {
    const res = await post('/api/interventions', { ...input('int-remote'), timeoutMs: 30_000 });
    expect(res.status).toBe(201);
    const record = await res.json() as Record<string, unknown>;
    expect(record.state).toBe('pending');
    expect(bus.get('int-remote')?.stepIntent).toBe('open the savings account');
  });

  it('lists what is waiting', async () => {
    const res = await fetch(`${base}/api/interventions`);
    const body = await res.json() as { interventions: Array<{ id: string }> };
    expect(body.interventions.map((r) => r.id)).toContain('int-remote');
  });

  it('refuses a claim with no operator named', async () => {
    // The name is the audit record. A claim without one is an anonymous person
    // taking a customer's session.
    const res = await post('/api/interventions/int-remote/claim', { operatorId: '  ' });
    expect(res.status).toBe(400);
  });

  it('refuses to resolve something nobody claimed', async () => {
    const res = await post('/api/interventions/int-remote/resolve', { resolution: 'resolved' });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('wrong_state');
  });

  it('rejects a resolution that is not one of the three', async () => {
    await post('/api/interventions/int-remote/claim', { operatorId: 'rahul' });
    const res = await post('/api/interventions/int-remote/resolve', { resolution: 'sort-of' });
    expect(res.status).toBe(400);
  });

  it('claims and resolves, and settles the waiting run', async () => {
    const waiting = bus.raise(input('int-cycle'));
    expect((await post('/api/interventions/int-cycle/claim', { operatorId: 'rahul' })).status).toBe(200);
    expect((await post('/api/interventions/int-cycle/resolve',
      { resolution: 'resolved', note: 'unlocked it' })).status).toBe(200);

    const record = await waiting;
    expect(record.resolution).toBe('resolved');
    expect(record.claimedBy).toBe('rahul');
    expect(record.note).toBe('unlocked it');
  });

  it('404s an intervention it has never heard of', async () => {
    const res = await fetch(`${base}/api/interventions/nope`);
    expect(res.status).toBe(404);
  });

  it('serves the screenshot of the screen the run stopped on', async () => {
    bus.raise(input('int-shot', {
      screenshotPath: 'steps/04/escalation.png', evidenceDir: EVIDENCE_ROOT,
    }));
    const res = await fetch(`${base}/api/interventions/int-shot/screenshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('PNG-BYTES');
  });

  it('refuses a screenshot path that escapes its evidence directory', async () => {
    // The path arrived over HTTP from another process. A console that will
    // serve any path a POST names is a file-read primitive wearing a hat.
    bus.raise(input('int-escape', {
      screenshotPath: '../_test_console_secret.txt', evidenceDir: EVIDENCE_ROOT,
    }));
    const res = await fetch(`${base}/api/interventions/int-escape/screenshot`);
    expect(res.status).toBe(403);
  });
});

describe('the read-only capability catalog at /catalog', () => {
  const CATALOG_DIR = 'evidence/_test_console_catalog';
  let catalogConsole: RunningConsole;
  let catalogBase: string;

  beforeAll(async () => {
    mkdirSync(CATALOG_DIR, { recursive: true });
    writeFileSync(join(CATALOG_DIR, 'approved.json'), JSON.stringify(
      withIntegrity(CapabilityArtifact.parse(minimalArtifact({
        id: 'cap.x.catalog_test', status: 'approved',
        tenancy: { canonical: true, overlays: { summitcu: {} } },
      }))),
    ));
    writeFileSync(join(CATALOG_DIR, 'draft.json'), JSON.stringify(
      withIntegrity(CapabilityArtifact.parse(minimalArtifact({ id: 'cap.x.still_draft', status: 'draft' }))),
    ));
    const b = new InterventionBus({ timeoutMs: 30_000 });
    catalogConsole = await startOperatorConsole({ bus: b, port: 0, artifactsDir: CATALOG_DIR });
    catalogBase = catalogConsole.url;
  });

  afterAll(async () => {
    await catalogConsole.close();
    rmSync(CATALOG_DIR, { recursive: true, force: true });
  });

  it('lists an approved capability, never a draft one', async () => {
    const res = await fetch(`${catalogBase}/catalog`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('cap.x.catalog_test');
    expect(html).not.toContain('cap.x.still_draft');
  });

  it('shows the tenant overlay a capability carries', async () => {
    const html = await (await fetch(`${catalogBase}/catalog`)).text();
    expect(html).toContain('summitcu');
  });
});

describe('RemoteBus talks to a console in another process', () => {
  it('raises, waits, and comes back with what the human decided', async () => {
    const remote = new RemoteBus({ url: base, pollMs: 30 });
    expect(await remote.reachable()).toBe(true);

    const waiting = remote.raise(input('int-wire'), { timeoutMs: 30_000 });

    // The console side, as a person would drive it.
    await vi_waitFor(() => bus.get('int-wire') !== undefined);
    await post('/api/interventions/int-wire/claim', { operatorId: 'rahul' });
    await post('/api/interventions/int-wire/resolve', { resolution: 'skipped', note: 'did it by hand' });

    const record = await waiting;
    expect(record.state).toBe('skipped');
    expect(record.resolution).toBe('skipped');
    expect(record.claimedBy).toBe('rahul');
  });

  it('tells its listeners about a claim, which is what moves the lease', async () => {
    const remote = new RemoteBus({ url: base, pollMs: 30 });
    const seen: string[] = [];
    remote.onChange((r) => seen.push(r.state));

    const waiting = remote.raise(input('int-notify'), { timeoutMs: 30_000 });
    await vi_waitFor(() => bus.get('int-notify') !== undefined);
    await post('/api/interventions/int-notify/claim', { operatorId: 'rahul' });
    await vi_waitFor(() => seen.includes('claimed'));
    await post('/api/interventions/int-notify/resolve', { resolution: 'resolved' });
    await waiting;

    // Exactly one 'claimed', despite polling every 30ms: the hook that fires on
    // it moves the lease, and a second call would throw.
    expect(seen.filter((s) => s === 'claimed')).toHaveLength(1);
    expect(seen).toEqual(['pending', 'claimed', 'resolved']);
  });

  it('gives up on a console that has stopped answering, rather than hanging', async () => {
    const dead = new RemoteBus({
      url: 'http://127.0.0.1:1', pollMs: 10, maxConsecutiveFailures: 3,
    });
    expect(await dead.reachable()).toBe(false);

    const record = await dead.raise(input('int-dead')).catch((e: Error) => e);
    // A POST to a dead console throws; that is the honest failure and the
    // caller reports it. What must not happen is waiting forever.
    expect(record).toBeInstanceOf(Error);
  });
});

/** Poll until a condition holds. Small, because vitest's waitFor is opt-in. */
async function vi_waitFor(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never held');
}
