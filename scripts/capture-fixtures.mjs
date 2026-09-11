/**
 * Captures real aria snapshots from Meridian Core as test fixtures.
 *
 * The parser and the locator strategies are tested against genuine output from
 * a real browser against the real target, not against hand-written YAML that
 * happens to match my assumptions. Re-run this after changing the app's markup:
 *   npm run app   (in another shell)
 *   node scripts/capture-fixtures.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.MERIDIAN_BASE_URL ?? 'http://localhost:4400';
const OUT = new URL('../tests/fixtures/aria/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

async function signIn() {
  await page.goto(`${BASE}/frame/`);
  await page.getByLabel('Operator ID').fill('teller01');
  await page.getByLabel('Password').fill('CANARY-PWD-do-not-log-7f3a91');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForLoadState('networkidle');
}

async function capture(name, url) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  const snap = await page.locator('body').ariaSnapshot({ mode: 'ai', boxes: true });
  writeFileSync(`${OUT}${name}.yaml`, snap);
  console.log(`  ${name}.yaml  (${snap.split('\n').length} lines)`);
}

await signIn();
await capture('member-detail', `${BASE}/members/12345`);
await capture('account-detail', `${BASE}/members/12345/accounts/0001-4477`);
await capture('member-search', `${BASE}/members/search`);
await capture('not-found', `${BASE}/frame/members/lookup?memberId=99999`);
await capture('subaccount-form', `${BASE}/members/12345/subaccount/new`);

// A second render of the same screen: control ids differ, structure does not.
await capture('member-detail-rerender', `${BASE}/members/12345`);

await page.goto(`${BASE}/_chaos?mode=surprise_modal`);
await page.goto(`${BASE}/frame/members/search`);
await capture('surprise-modal', `${BASE}/frame/members/search`);
await page.goto(`${BASE}/_chaos/reset`);

await browser.close();
console.log('fixtures written to tests/fixtures/aria/');
