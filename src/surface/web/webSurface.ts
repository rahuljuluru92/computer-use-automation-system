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
    await this.#act(node, async (l) => { await l.click({ timeout: this.#actionTimeout }); }, 'click');
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

  async #act(node: UiNode, run: (l: Locator) => Promise<void>, what: string): Promise<void> {
    const locator = await this.#locatorFor(node);
    try {
      await run(locator);
    } catch (cause) {
      throw new SurfaceError(
        `could not ${what} "${node.name || node.role}" - the node may have gone stale`,
        { cause },
      );
    }
  }

  /**
   * Ref first, structural fallback second - but only ever for a node from the
   * current observation.
   *
   * That last clause is load-bearing, and it was added because an integration
   * test caught the alternative doing real damage. A node was captured on
   * member 12345's page, the browser then navigated to member 67890, and the
   * stale click *succeeded*: the ref matched nothing, the structural fallback
   * ran, and it happily found the identically-named "Open Sub-Account" button
   * on the wrong member's page. The fallback had silently rescued a stale
   * reference by acting on a different record entirely - which in a servicing
   * console means opening an account for the wrong person.
   *
   * So the fallback is not a rescue. It exists only for the case where
   * `aria-ref` is unavailable (an undocumented selector engine could change
   * under us) while the page is otherwise exactly where we left it. A node
   * from an older observation is refused outright, and the executor's
   * resolve-then-act cycle re-observes anyway.
   */
  async #locatorFor(node: UiNode): Promise<Locator> {
    if (!this.#lastSnapshot?.nodes.includes(node)) {
      throw new SurfaceError(
        `refusing to act on "${node.name || node.role}": it comes from an earlier `
        + `observation and the page has moved since. Re-observe before acting.`,
      );
    }
    const byRef = this.#page.locator(`aria-ref=${node.ref}`);
    try {
      if (await byRef.count() === 1) return byRef;
    } catch { /* fall through to the structural locator */ }
    return this.#structuralLocator(node);
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
