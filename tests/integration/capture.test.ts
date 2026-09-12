/**
 * What the audit trail sees while a human drives.
 *
 * Worth its own file against a real browser, because every interesting failure
 * mode here is a browser fact: listeners injected into the wrong document,
 * a binding that is not there yet, an iframe nobody reached into, and an event
 * that fires just as the page it fired in is being torn down.
 *
 * The safety property is the one to protect: identity, never content.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSurface } from '../../src/surface/web/webSurface.ts';
import { HumanActionCapture } from '../../src/escalation/capture.ts';
import type { HumanAction } from '../../src/escalation/intervention.ts';

let surface: WebSurface;
let capture: HumanActionCapture;

const PAGE = `
  <h1>Servicing</h1>
  <label for="who">Operator ID</label><input id="who" name="ctl00_txtWho">
  <label for="pw">Password</label><input id="pw" type="password" name="ctl00_txtPw">
  <button id="save" type="button">Save changes</button>
  <input id="ack" type="submit" value="Acknowledge">
  <iframe srcdoc='<button type="button" aria-label="Inner control">x</button>'></iframe>
`;

beforeAll(async () => {
  surface = await WebSurface.launch();
  capture = await HumanActionCapture.attach(surface.page);
}, 60_000);

afterAll(async () => {
  capture?.dispose();
  await surface?.close();
});

async function record(drive: () => Promise<void>): Promise<HumanAction[]> {
  await surface.page.setContent(PAGE);
  await surface.page.waitForLoadState('domcontentloaded');
  await capture.arm();
  await drive();
  // Bindings cross the process boundary asynchronously; give the last one a
  // turn to land before reading. This is not a wait for a *state change* - the
  // action already happened - so it is not the sleep invariant 5 forbids.
  await surface.page.waitForTimeout(120);
  return capture.disarm();
}

describe('capturing what a human does', () => {
  it('records a click by the control a person would name it by', async () => {
    const actions = await record(async () => {
      await surface.page.click('#save');
    });
    const click = actions.find((a) => a.kind === 'click');
    expect(click?.target).toBe('Save changes');
    expect(click?.role).toBe('button');
  }, 30_000);

  it('names a submit button by its value, not by its control id', async () => {
    // The accessible name of <input type=submit value=Acknowledge> is the
    // value. Falling through to the name attribute produced audit lines
    // reading "ctl00_ContentPlaceHolder1_modal_btnAck_ctl17".
    const actions = await record(async () => {
      await surface.page.click('#ack');
    });
    expect(actions.find((a) => a.kind === 'click')?.target).toBe('Acknowledge');
  }, 30_000);

  it('records that a field was filled, and how much, but never with what', async () => {
    const secret = 'hunter2-not-in-evidence';
    const actions = await record(async () => {
      await surface.page.fill('#who', 'teller.harper');
      await surface.page.fill('#pw', secret);
      await surface.page.click('#save');       // blur, so change fires on both
    });

    const inputs = actions.filter((a) => a.kind === 'input');
    expect(inputs.map((a) => a.target)).toEqual(
      expect.arrayContaining(['Operator ID', 'Password']));
    expect(inputs.find((a) => a.target === 'Password')?.valueLength).toBe(secret.length);

    // The whole point. Nothing anybody typed is anywhere in the record.
    const serialised = JSON.stringify(actions);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('teller.harper');
  }, 30_000);

  it('reaches into an iframe, which is where these apps keep everything', async () => {
    const actions = await record(async () => {
      await surface.page.frameLocator('iframe').getByRole('button').click();
    });
    expect(actions.some((a) => a.kind === 'click' && a.target === 'Inner control')).toBe(true);
  }, 30_000);

  it('works on a page it actually navigated to, not just one set in place', async () => {
    // This is the case that was broken while every other test here passed.
    // `setContent` and a real navigation take different paths through
    // Playwright, and the injected script was dying on a navigated document
    // with `ReferenceError: __name is not defined` - esbuild's keepNames helper
    // travelling inside a compiled function that was then serialised into a
    // browser that has no such helper. It died inside a catch, so the audit
    // trail was empty and nothing said why.
    await surface.page.goto(
      'data:text/html,' + encodeURIComponent('<button id="go">Continue</button>'));
    await capture.arm();

    // Assert the listeners are really registered, not just that nothing threw.
    const installed = await surface.page.evaluate(
      () => ((document as never as Record<string, unknown[]>).__cuaInstalled ?? []).length);
    expect(installed).toBeGreaterThan(0);

    await surface.page.click('#go');
    await surface.page.waitForTimeout(120);
    expect(capture.disarm().some((a) => a.kind === 'click' && a.target === 'Continue')).toBe(true);
  }, 30_000);

  it('records nothing at all until it is armed', async () => {
    await surface.page.setContent(PAGE);
    await surface.page.click('#save');           // before arming
    await surface.page.waitForTimeout(80);
    const actions = await record(async () => { /* arm, then do nothing */ });
    expect(actions.filter((a) => a.kind === 'click')).toHaveLength(0);
  }, 30_000);
});
