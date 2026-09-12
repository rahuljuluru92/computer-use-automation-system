/**
 * The web implementation of the Surface port.
 *
 * The division of labour here is the point:
 *
 *   **Resolution happens in our own model.** A LocatorBundle is resolved
 *   against a parsed accessibility snapshot (src/surface/locator), producing a
 *   UiNode. Nothing synthesises a selector, and nothing asks Playwright to
 *   decide which node was meant.
 *
 *   **Action happens by reference.** Playwright's `aria-ref=` selector points
 *   straight at the node the snapshot described, piercing frames on its own.
 *
 * That split is not just tidy, it is necessary. Delegating resolution to
 * Playwright's own matchers looked attractive until it was tried against this
 * app: `getByRole('row').filter({ hasText: 'Savings' })` matches *two* rows,
 * because the outer layout table's row transitively contains every word on the
 * page, and the subsequent link lookup then matches all three View links. On a
 * table-inside-a-table legacy layout - which is the normal case here - text
 * filtering is simply not sound. Our parsed tree knows the real row and column
 * of every node, so it gets the right answer.
 *
 * A ref is only valid for the snapshot it came from. When the page has moved
 * underneath us the ref does not match something else - it matches nothing and
 * times out. That is the safe failure, and it is what the `re_resolve_locator`
 * recovery rule keys off. Timeouts on ref actions are therefore kept short: a
 * stale ref should be discovered in a second, not in thirty.
 *
 * `aria-ref` is used by Playwright's own tooling but is not part of the
 * documented public API, so every action falls back to a role+name+index
 * locator built from the same snapshot if the ref route fails.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Locator, type FrameLocator } from 'playwright';
import type { Surface, ScreenshotOptions } from '../surface.ts';
import { SurfaceError } from '../surface.ts';
import type { UiNode, UiSnapshot } from '../uinode.ts';
import { parseAriaSnapshot } from './ariaYaml.ts';
import { flattenToSnapshot } from './toUiNodes.ts';

export interface WebSurfaceOptions {
  headless?: boolean;
  /** Short on purpose: a stale ref should fail fast so recovery can re-resolve. */
  actionTimeoutMs?: number;
  viewport?: { width: number; height: number };
}

export class WebSurface implements Surface {
  readonly kind = 'web' as const;

  #browser: Browser;
  #context: BrowserContext;
  #page: Page;
  #actionTimeout: number;
  /** The snapshot the current refs belong to. Used for the fallback locator. */
  #lastSnapshot: UiSnapshot | null = null;

  private constructor(browser: Browser, context: BrowserContext, page: Page, timeout: number) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#actionTimeout = timeout;
  }

  static async launch(opts: WebSurfaceOptions = {}): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    return new WebSurface(browser, context, page, opts.actionTimeoutMs ?? 5_000);
  }

  /** The live Playwright page. Needed by the escalation handoff, which must
   *  give a human the *same* session rather than a fresh one. */
  get page(): Page { return this.#page; }

  // -------------------------------------------------------------------------
  // Perceive
  // -------------------------------------------------------------------------

  /**
   * Meridian navigates its *content frame*, not the top-level page, so a
   * page-level load state is already satisfied and tells you nothing - this
   * has to be a question about network activity or it answers about the wrong
   * document. Verified against the real app: immediately after a submit the
   * frame still reports the old URL; after this it reports the new one.
   *
   * A page that never goes quiet stops being waited on rather than hanging the
   * run; the caller's own checkpoint is what decides whether that mattered.
   */
  async settle(): Promise<void> {
    try {
      await this.#page.waitForLoadState('networkidle', { timeout: 5_000 });
    } catch {
      // Still busy. Observing now is not wrong, only early, and the step's
      // checkpoint is what turns "early" into a diagnosable failure.
    }
  }

  async observe(opts: { depth?: number } = {}): Promise<UiSnapshot> {
    try {
      const yaml = await this.#page.locator('body').ariaSnapshot({
        mode: 'ai',
        boxes: true,
        ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      });
      const snapshot = flattenToSnapshot(parseAriaSnapshot(yaml), {
        url: this.#page.url(),
        title: await this.#page.title(),
        frameNames: await this.#frameNames(),
        ...(opts.depth !== undefined ? { maxDepth: opts.depth } : {}),
      });
      this.#lastSnapshot = snapshot;
      return snapshot;
    } catch (cause) {
      throw new SurfaceError('failed to observe the page', { cause });
    }
  }

  /**
   * Real frame names in document order, read off the elements themselves.
   *
   * The accessibility tree does not expose an iframe's name or title, so
   * without this the frame chain would be positional. Positional chains stop
   * being true the moment someone adds a banner.
   */
  async #frameNames(): Promise<string[]> {
    const handles = await this.#page.locator('iframe').all();
    const names: string[] = [];
    for (const h of handles) {
      const name = (await h.getAttribute('name'))
        ?? (await h.getAttribute('title'))
        ?? (await h.getAttribute('id'))
        ?? '';
      names.push(name);
    }
    return names;
  }

  // -------------------------------------------------------------------------
  // Act
  // -------------------------------------------------------------------------

  async click(node: UiNode): Promise<void> {
    await this.#act(
      node,
      async (l) => { await l.click({ timeout: this.#actionTimeout }); },
      'click',
      (l) => this.#rescueSubmit(l),
    );
  }

  /**
   * Works around a Playwright input-routing bug that silently eats form
   * submissions.
   *
   * Once an iframe has navigated *because of a form submission*, synthesized
   * clicks in that frame stop triggering any further form submission. The click
   * lands - the element receives it, the submit event fires - and the browser
   * then does nothing at all. No request is made.
   *
   * Reproduced in forty lines of static HTML with none of this project in the
   * path, against Playwright 1.63.0:
   *
   *     iframe -> submit form A -> submit form B     B never submits
   *     iframe -> location.href -> submit form B     B submits
   *     iframe -> (nothing)     -> submit form B     B submits
   *
   * It is the prior *form* navigation that poisons the frame, and every way of
   * addressing that frame afterwards is affected equally - reused or fresh
   * FrameLocator, Frame object, frame by name. Meridian walks straight into it:
   * sign-in is a POST form and every screen after it is reached by submitting
   * another one.
   *
   * `requestSubmit()` is the DOM's own "behave as if the user clicked this
   * submit button" - it fires the submit event and runs constraint validation,
   * unlike `submit()`, which skips both. A form the browser would have refused
   * is still refused here.
   *
   * Submitting twice is the only failure here that would really matter, so
   * `#act` calls this only when nothing navigated during the click, and it acts
   * only on a still-attached submit control.
   */
  async #rescueSubmit(locator: Locator): Promise<void> {
    try {
      await locator.evaluate((el) => {
        const input = el as HTMLInputElement | HTMLButtonElement;
        if (!el.isConnected) return;
        const form = input.form;
        if (!form) return;
        if (input.type !== 'submit' && input.type !== 'image') return;

        // The browser would refuse an invalid form, so this must too. Both
        // routes below skip constraint validation, and that difference is
        // exactly what would let an artifact submit something a person could
        // not have.
        if (!form.checkValidity()) { form.reportValidity(); return; }

        const view = el.ownerDocument.defaultView;
        if (form.method.toLowerCase() === 'get' && view) {
          // A GET form is only a URL, and navigating to one is the single
          // thing a poisoned frame still does reliably. requestSubmit() is the
          // more faithful call and was tried first, but it goes through the
          // same submission path the bug eats: it worked about two runs in
          // three, which is worse than not working at all.
          const url = new URL(form.action, el.ownerDocument.baseURI);
          const data = new FormData(form, input);
          const query = new URLSearchParams();
          data.forEach((value, key) => query.append(key, String(value)));
          url.search = query.toString();
          view.location.href = url.toString();
          return;
        }

        // POST has no URL to navigate to. requestSubmit() carries the submitter
        // so the right button's name and value are sent, and a frame's *first*
        // submission is unaffected by the bug in any case.
        form.requestSubmit(input);
      }, undefined, { timeout: this.#actionTimeout });
    } catch {
      // The element is gone, which means the click navigated and worked.
    }
  }

  async type(node: UiNode, text: string, opts: { clearFirst?: boolean } = {}): Promise<void> {
    await this.#act(node, async (l) => {
      if (opts.clearFirst ?? true) await l.fill('', { timeout: this.#actionTimeout });
      await l.fill(text, { timeout: this.#actionTimeout });
    }, 'type');
  }

  async select(node: UiNode, option: string): Promise<void> {
    await this.#act(node, async (l) => { await l.selectOption(option, { timeout: this.#actionTimeout }); }, 'select');
  }

  async press(key: string): Promise<void> {
    await this.#page.keyboard.press(key);
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    await this.#page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * amount * 100);
  }

  async navigate(target: string): Promise<void> {
    try {
      await this.#page.goto(target, { waitUntil: 'domcontentloaded' });
    } catch (cause) {
      throw new SurfaceError(`failed to navigate to ${target}`, { cause });
    }
  }

  async readText(node: UiNode): Promise<string> {
    const locator = await this.#locatorFor(node);
    const text = await locator.textContent({ timeout: this.#actionTimeout });
    return (text ?? '').trim();
  }

  async ariaSubtree(node: UiNode): Promise<string> {
    const locator = await this.#locatorFor(node);
    return locator.ariaSnapshot({ timeout: this.#actionTimeout });
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    // Masking happens here rather than at the evidence writer, because by the
    // time an image is bytes it is too late to redact it.
    const mask: Locator[] = [];
    for (const n of opts.mask ?? []) {
      try { mask.push(await this.#locatorFor(n)); } catch { /* a gone node needs no mask */ }
    }
    return this.#page.screenshot({
      fullPage: opts.fullPage ?? false,
      ...(mask.length ? { mask, maskColor: '#000000' } : {}),
    });
  }

  async currentUrl(): Promise<string> {
    return this.#page.url();
  }

  async close(): Promise<void> {
    await this.#context.close();
    await this.#browser.close();
  }

  // -------------------------------------------------------------------------

  /**
   * Perform an action, and do not mistake a successful one for a failure.
   *
   * A click that submits a form destroys the element it clicked. Playwright's
   * post-action checks then run against a document that no longer exists and
   * time out - on an action that worked. Verified against the real app: the
   * click threw `TimeoutError: locator.click: Timeout 5000ms exceeded` while
   * the request went out and the page arrived on the next screen.
   *
   * Reported as a failure, that is worse than a crash. The executor returns
   * `surface_error`, replay retries a step that already happened, and on a
   * form that moves money "it timed out, try again" is how you submit twice.
   *
   * So navigation is watched for the duration of the action. If a frame moved,
   * the action did what it was asked and the timeout was an artefact of it
   * succeeding. Any other failure is still a failure.
   */
  async #act(
    node: UiNode,
    run: (l: Locator) => Promise<void>,
    what: string,
    /** Runs only if the action moved nothing. See #rescueSubmit. */
    rescue?: (l: Locator) => Promise<void>,
  ): Promise<void> {
    const locator = await this.#locatorFor(node);

    let navigated = false;
    const onNavigate = (): void => { navigated = true; };
    this.#page.on('framenavigated', onNavigate);

    try {
      await run(locator);
      if (rescue && !navigated) await rescue(locator);
    } catch (cause) {
      if (navigated && isTimeout(cause)) return;
      throw new SurfaceError(
        `could not ${what} "${node.name || node.role}" - the node may have gone stale`,
        { cause },
      );
    } finally {
      this.#page.off('framenavigated', onNavigate);
    }
  }

  /**
   * Structural first, `aria-ref` as a fallback - and only ever for a node from
   * the current observation.
   *
   * That last clause is load-bearing, and it was added because an integration
   * test caught the alternative doing real damage. A node was captured on
   * member 12345's page, the browser then navigated to member 67890, and the
   * stale click *succeeded*: it found the identically-named "Open Sub-Account"
   * button on the wrong member's page. In a servicing console that means
   * opening an account for the wrong person, so a node from an older
   * observation is refused outright.
   *
   * The ordering was the other way round until it was measured. Decision #31
   * said "resolution in our model, action by aria-ref", on the reasoning that
   * an exact reference beats a reconstructed selector. Acting through it turns
   * out not to work:
   *
   *   Clicking a submit button through `aria-ref` fires the click event and
   *   the form's submit event, and then performs no navigation at all - zero
   *   network requests. The same element clicked through a role or CSS locator
   *   in the same session at the same moment issues the request. It dispatches
   *   events without performing default actions.
   *
   *   It is also not reliably resolvable: the same reference that clicked a
   *   moment earlier can time out on the next attempt.
   *
   * Both were reproduced repeatedly against the real application. The reason
   * this went unnoticed is worth recording: replay resolves a bundle and acts
   * without re-observing first, so its references are usually stale, `count()`
   * returns 0, and it has been falling through to the structural locator all
   * along. Replay worked by accident. Discovery observes immediately before
   * acting, so its references are fresh, so it took the broken path every time.
   *
   * `aria-ref` is kept as the fallback rather than deleted because it is exact
   * when it does resolve, and the structural locator cannot describe a node
   * with no accessible name.
   */
  async #locatorFor(node: UiNode): Promise<Locator> {
    if (!this.#lastSnapshot?.nodes.includes(node)) {
      throw new SurfaceError(
        `refusing to act on "${node.name || node.role}": it comes from an earlier `
        + `observation and the page has moved since. Re-observe before acting.`,
      );
    }
    const structural = this.#structuralLocator(node);
    try {
      if (await structural.count() >= 1) return structural;
    } catch { /* an unnameable node; fall through */ }

    const byRef = this.#page.locator(`aria-ref=${node.ref}`);
    try {
      if (await byRef.count() === 1) return byRef;
    } catch { /* neither worked; let the action report the failure */ }
    return structural;
  }

  #structuralLocator(node: UiNode): Locator {
    let scope: Page | FrameLocator = this.#page;
    for (const frame of node.frameChain) {
      scope = scope.frameLocator(
        `iframe[name="${frame}"], iframe[title="${frame}"], iframe[id="${frame}"]`,
      );
    }
    const matches = (this.#lastSnapshot?.nodes ?? []).filter((n) =>
      n.role === node.role
      && n.name === node.name
      && n.frameChain.join('>') === node.frameChain.join('>'));
    const index = Math.max(0, matches.findIndex((n) => n.ref === node.ref));

    const base = node.name
      ? scope.getByRole(node.role as Parameters<Page['getByRole']>[0], { name: node.name, exact: true })
      : scope.getByRole(node.role as Parameters<Page['getByRole']>[0]);
    return matches.length > 1 ? base.nth(index) : base;
  }
}

/** Playwright's timeout, however it happens to be surfaced. */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error
    && (cause.name === 'TimeoutError' || /Timeout .*exceeded/.test(cause.message));
}
