/**
 * The first end-to-end proof: a real browser, the real target app, and the
 * whole perception -> resolution -> action chain, with no LLM anywhere.
 *
 * This is deliberately the hardest case in the app - a link in a grid where
 * all three candidates share one accessible name, inside an iframe, on a page
 * whose control ids change on every render.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR, CANARY_SSN } from '../../apps/meridian-core/data/seed.ts';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { resolveBundle } from '../../src/surface/locator/resolve.ts';
import { LocatorBundle } from '../../src/core/schema.ts';
import type { UiSnapshot } from '../../src/surface/uinode.ts';

let server: Server;
let base: string;
let surface: WebSurface;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const a = server.address();
      base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
      resolve();
    });
  });
  surface = await WebSurface.launch();
  await signIn();
}, 60_000);

afterAll(async () => {
  await surface?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bundle = (description: string, strategies: Array<[number, object]>) =>
  LocatorBundle.parse({
    description,
    strategies: strategies.map(([tier, strategy]) => ({
      tier, strategy, confidence: 1 - tier / 10, rationale: 'integration test',
    })),
  });

async function signIn(): Promise<void> {
  await surface.navigate(`${base}/frame/`);
  let snap = await surface.observe();
  const id = must(resolveBundle(
    bundle('Operator ID field', [[3, { kind: 'label_anchored', label: 'Operator ID', controlRole: 'textbox' }]]), snap));
  await surface.type(id, OPERATOR.username);

  snap = await surface.observe();
  const pw = must(resolveBundle(
    bundle('Password field', [[3, { kind: 'label_anchored', label: 'Password', controlRole: 'textbox' }]]), snap));
  await surface.type(pw, OPERATOR.password);

  snap = await surface.observe();
  const btn = must(resolveBundle(
    bundle('Sign In button', [[1, { kind: 'role_name', role: 'button', name: 'Sign In' }]]), snap));
  await surface.click(btn);
}

function must(r: ReturnType<typeof resolveBundle>) {
  if (!r.ok) throw new Error(`resolve failed: ${r.error.detail}`);
  return r.value.node;
}

describe('WebSurface against the real app', () => {
  it('observes a snapshot that descends into the content iframe', async () => {
    await surface.navigate(`${base}/members/12345`);
    const snap: UiSnapshot = await surface.observe();
    expect(snap.nodes.length).toBeGreaterThan(20);
    const framed = snap.nodes.filter((n) => n.frameChain.length > 0);
    expect(framed.length).toBeGreaterThan(0);
    // The real frame name, read off the element - not a positional fallback.
    expect(framed[0]!.frameChain).toEqual(['contentFrame']);
  });

  it('clicks the View link on the Savings row, across a frame, and lands on that account', async () => {
    await surface.navigate(`${base}/members/12345`);
    const snap = await surface.observe();
    const node = must(resolveBundle(bundle('View link on the Savings row', [[2, {
      kind: 'table_cell_relative',
      table: { role: 'table', name: 'Accounts' },
      matchColumn: 'Type', matchValue: 'Savings',
      targetColumn: 'Action', within: { role: 'link' },
    }]]), snap));

    await surface.click(node);
    const after = await surface.observe();
    // Correct row: the Savings account, not Checking or Money Market.
    const text = after.nodes.map((n) => n.name).join(' | ');
    expect(text).toContain('0001-4477');
    expect(text).toContain('$4,210.55');
    expect(text).not.toContain('0002-9910');
  });

  it('picks a different row when asked for a different account type', async () => {
    await surface.navigate(`${base}/members/12345`);
    const snap = await surface.observe();
    const node = must(resolveBundle(bundle('View link on the Money Market row', [[2, {
      kind: 'table_cell_relative',
      table: { role: 'table', name: 'Accounts' },
      matchColumn: 'Type', matchValue: 'Money Market',
      targetColumn: 'Action', within: { role: 'link' },
    }]]), snap));
    await surface.click(node);
    const after = await surface.observe();
    expect(after.nodes.map((n) => n.name).join(' | ')).toContain('0003-2256');
  });

  it('types into a form field found only by the label in the cell beside it', async () => {
    await surface.navigate(`${base}/members/12345/subaccount/new`);
    const snap = await surface.observe();
    const nickname = must(resolveBundle(
      bundle('Nickname field', [[3, { kind: 'label_anchored', label: 'Nickname', controlRole: 'textbox' }]]), snap));
    await surface.type(nickname, 'Vacation Fund');
    const after = await surface.observe();
    expect(after.nodes.some((n) => n.value === 'Vacation Fund' || n.name === 'Vacation Fund')).toBe(true);
  });

  it('reads a value out of the page for extraction', async () => {
    await surface.navigate(`${base}/members/12345/accounts/0001-4477`);
    const snap = await surface.observe();
    // The page shows the same figure twice, as Current Balance and as
    // Available Balance, so a text match on the value is genuinely ambiguous.
    // The label beside it is what distinguishes them - which is how a person
    // reads this screen too.
    const balance = must(resolveBundle(
      bundle('the Current Balance value', [[3, { kind: 'label_anchored', label: 'Current Balance', controlRole: 'cell' }]]),
      snap));
    expect(await surface.readText(balance)).toContain('4,210.55');

    const ambiguous = resolveBundle(
      bundle('the balance, by value', [[4, { kind: 'text', pattern: '^\\$4,210\\.55$' }]]), snap);
    expect(ambiguous.ok).toBe(false);   // two nodes carry that value
  });

  it('detects the surprise modal as a blocking dialog', async () => {
    await surface.navigate(`${base}/_chaos?mode=surprise_modal`);
    await surface.navigate(`${base}/frame/members/search`);
    await surface.navigate(`${base}/frame/members/search`);
    const snap = await surface.observe();
    expect(snap.blockingDialog?.name).toBe('Scheduled Maintenance Notice');
    await surface.navigate(`${base}/_chaos/reset`);
  });

  it('masks sensitive nodes out of a screenshot before the bytes exist', async () => {
    await surface.navigate(`${base}/members/12345`);
    const snap = await surface.observe();
    const ssnCell = snap.nodes.find((n) => n.name === CANARY_SSN);
    expect(ssnCell).toBeDefined();
    const plain = await surface.screenshot();
    const masked = await surface.screenshot({ mask: [ssnCell!] });
    // Masking must actually change the image; an unenforced mask is worse than
    // none, because it is believed.
    expect(Buffer.compare(plain, masked)).not.toBe(0);
  });

  it('refuses to act on a node from an earlier observation', async () => {
    // The dangerous version of this bug is not a crash, it is a success: both
    // member pages carry an identically named "Open Sub-Account" button, so a
    // structural fallback will cheerfully click the wrong member's button and
    // report that everything went fine.
    await surface.navigate(`${base}/members/12345`);
    const snap = await surface.observe();
    const node = snap.nodes.find((n) => n.role === 'button' && n.name === 'Open Sub-Account')!;
    await surface.navigate(`${base}/members/67890`);
    await surface.observe();
    await expect(surface.click(node)).rejects.toThrow(/earlier observation/i);
  });
});
