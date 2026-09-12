/**
 * Watching, while a human drives.
 *
 * When an operator takes the session they act on the real page with a real
 * mouse, and none of it goes through `Executor.act()` - so none of the evidence
 * the executor writes exists for any of it. That is a hole in the audit trail
 * at exactly the point an audit trail matters most: the minutes in which a
 * person touched a customer's account through an automation's session.
 *
 * This closes it by listening in the page itself, and it records one thing
 * about every event: *what was touched*. Never what was typed.
 *
 * That is not squeamishness, it is the same rule as everywhere else in this
 * system. A servicing console is mostly fields whose contents must not reach
 * disk - card numbers, SSNs, passwords - and the evidence writer's redactor can
 * only catch values it has been told about. A capture that recorded values
 * would be a second, un-redacted path to disk, sitting next to a carefully
 * redacted one. "Typed 8 characters into Password" answers every question an
 * audit actually asks; the password itself only adds a way to be wrong.
 *
 * Listeners are installed once per browser context and left in place. They are
 * three passive event listeners and cost nothing measurable, and installing
 * them on demand would mean racing a human who is already clicking.
 */

import type { Page, Frame, BrowserContext } from 'playwright';
import type { HumanAction } from './intervention.ts';

/** Reported by the in-page listener. Values are never part of this. */
interface RawAction {
  kind: 'click' | 'input' | 'submit' | 'navigate' | 'key';
  target: string;
  role: string;
  valueLength?: number;
}

const BINDING = '__cuaHumanAction';

/**
 * Contexts already wired.
 *
 * Playwright throws if a binding name is registered twice on one context, and
 * `addInitScript` accumulates rather than replacing - so a second call would
 * double every event. Both are once-per-context, and this is what remembers it.
 */
const wired = new WeakSet<BrowserContext>();

export class HumanActionCapture {
  #armed = false;
  #actions: HumanAction[] = [];
  #onAction: ((a: HumanAction) => void) | null = null;
  #detach: (() => void) | null = null;

  private constructor(private readonly page: Page) {}

  /**
   * Install the listeners. Safe to call repeatedly on the same page.
   *
   * Returns a capture that is *not* recording: arming is a separate step,
   * because the listeners go in long before anybody escalates.
   */
  static async attach(page: Page): Promise<HumanActionCapture> {
    const capture = new HumanActionCapture(page);
    const context = page.context();

    if (!wired.has(context)) {
      wired.add(context);
      await context.exposeBinding(BINDING, (source, raw) => {
        capture.#record(raw as RawAction, source.frame);
      });
      await context.addInitScript(INSTALL_LISTENERS);
    } else {
      // Another capture owns the binding on this context. Rare - one run, one
      // context - but rebinding would throw, and silently recording nothing
      // would be worse than saying so.
      capture.#detach = () => {};
    }

    // addInitScript only runs on documents loaded from now on, and an
    // escalation happens mid-run with frames already open. So install into
    // what is on screen too; the script guards itself against running twice.
    await capture.#installIntoOpenFrames();

    const onNavigated = (frame: Frame) => {
      if (!capture.#armed) return;
      capture.#record({ kind: 'navigate', target: frame.url(), role: 'document' }, frame);
    };
    page.on('framenavigated', onNavigated);
    const previous = capture.#detach;
    capture.#detach = () => { page.off('framenavigated', onNavigated); previous?.(); };

    return capture;
  }

  /**
   * Start recording. Called when control passes to the operator.
   *
   * Awaits the injection rather than firing it off, because the frames on
   * screen right now are the ones the operator is about to click, and the
   * listeners have to be in them before that happens. Fire-and-forget here
   * loses the first action - and in a one-click intervention the first action
   * is the only action. Caught by the Phase 5 gate, whose audit trail recorded
   * the navigation the operator's click caused but not the click itself.
   */
  async arm(onAction?: (a: HumanAction) => void): Promise<void> {
    this.#armed = true;
    this.#onAction = onAction ?? null;
    await this.#installIntoOpenFrames();
  }

  /**
   * Stop recording and return everything seen.
   *
   * Drains rather than just reads. One run can escalate more than once, and a
   * buffer that accumulated would attribute the first operator's actions to the
   * second intervention as well - an audit trail that says a person did
   * something they did not do is worse than one that says nothing.
   */
  disarm(): HumanAction[] {
    this.#armed = false;
    this.#onAction = null;
    const seen = this.#actions;
    this.#actions = [];
    return seen;
  }

  get actions(): readonly HumanAction[] { return this.#actions; }

  /** Remove the page-level listener. The in-page ones are harmless and stay. */
  dispose(): void {
    this.#detach?.();
    this.#detach = null;
  }

  // -------------------------------------------------------------------------

  async #installIntoOpenFrames(): Promise<void> {
    await Promise.all(this.page.frames().map(async (frame) => {
      try {
        await frame.evaluate(INSTALL_LISTENERS);
      } catch {
        // A frame that is navigating, cross-origin, or already gone. Missing
        // one frame's events must not stop the handoff.
      }
    }));
  }

  #record(raw: RawAction, frame: Frame): void {
    if (!this.#armed) return;
    const action: HumanAction = {
      at: new Date().toISOString(),
      kind: raw.kind,
      target: (raw.target ?? '').slice(0, 120),
      role: raw.role ?? '',
      ...(frameName(frame) ? { frame: frameName(frame) } : {}),
      ...(raw.valueLength !== undefined ? { valueLength: raw.valueLength } : {}),
      ...(raw.kind === 'navigate' ? { url: frame.url() } : {}),
    };
    this.#actions.push(action);
    this.#onAction?.(action);
  }
}

function frameName(frame: Frame): string | undefined {
  const name = frame.name();
  if (name) return name;
  return frame.parentFrame() ? undefined : 'main';
}

/**
 * Runs inside the page.
 *
 * A string, not a function, and that is not a style choice - it is the fix for
 * a bug that silently disabled this entire feature.
 *
 * Playwright serialises a function you hand to `evaluate`/`addInitScript` with
 * `toString()` and runs the text in the browser. But this file is TypeScript
 * executed through tsx, so what `toString()` returns is *esbuild's compiled
 * output*, and esbuild's `keepNames` support wraps inner functions in a
 * `__name(...)` helper that only exists in the module scope it compiled. In the
 * page there is no `__name`, so the injection dies with
 * `ReferenceError: __name is not defined` - inside a `catch` that existed to
 * tolerate frames navigating out from under us. Every click went unrecorded and
 * nothing anywhere said so. An audit trail that fails silently is worse than no
 * audit trail, because it looks exactly like a person who did nothing.
 *
 * A string is not compiled, so nothing can be injected into it. The cost is
 * that this is not type-checked; the benefit is that it is the code that
 * actually runs.
 *
 * Every branch reports an identity and, at most, a length. There is no path
 * through it that sends a field's contents anywhere.
 */
const INSTALL_LISTENERS = `(() => {
  // Idempotent by removal, not by a flag - and the difference is not academic.
  //
  // A "have I run already?" marker has to live somewhere that survives exactly
  // as long as the listeners do, and in a browser there is no such place. A
  // window-level flag outlives a replaced document. A document-level flag is no
  // better: document.open() rewrites a page in the *same* document object, so
  // the property survives while every listener on it is silently dropped. Both
  // then claim "installed" about listeners that no longer exist.
  //
  // So this keeps what it registered, unregisters it, and registers again.
  // Running twice is free; running after the document was rewritten is correct.
  var doc = document;
  var previous = doc.__cuaInstalled || [];
  for (var i = 0; i < previous.length; i++) {
    doc.removeEventListener(previous[i][0], previous[i][1], true);
  }
  var installed = [];
  doc.__cuaInstalled = installed;

  function on(type, fn) {
    doc.addEventListener(type, fn, true);
    installed.push([type, fn]);
  }

  function send(a) {
    try { if (window.__cuaHumanAction) window.__cuaHumanAction(a); } catch (e) {}
  }

  /** The name a person would use for this control, in the order they would try. */
  function nameOf(el) {
    if (!el) return '';
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria;
    var by = el.getAttribute && el.getAttribute('aria-labelledby');
    if (by) {
      var target = document.getElementById(by);
      if (target && target.textContent) return target.textContent.trim();
    }
    if (el.labels && el.labels.length > 0 && el.labels[0].textContent) {
      return el.labels[0].textContent.trim();
    }
    // A submit/button input's value is its visible label, authored by the page
    // rather than entered by a person - it is what the accessible-name
    // algorithm uses. Text inputs are deliberately never read here.
    if (el.tagName === 'INPUT'
        && (el.type === 'submit' || el.type === 'button' || el.type === 'reset')
        && el.value) {
      return el.value;
    }
    if (el.placeholder) return el.placeholder;
    var title = el.getAttribute && el.getAttribute('title');
    if (title) return title;
    var text = (el.textContent || '').trim();
    if (text) return text.slice(0, 120);
    if (el.name) return el.name;
    return el.id || el.tagName.toLowerCase();
  }

  function roleOf(el) {
    if (!el) return '';
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      var t = el.type;
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'password') return 'password';
      return 'textbox';
    }
    return tag;
  }

  // pointerdown, not click, and the reason is a race this lost once. The
  // interesting clicks in a servicing console are the ones that navigate -
  // Acknowledge, Continue, Submit - and click fires with the navigation already
  // committed, so the message out of the frame does not survive the teardown.
  // pointerdown fires before the default action. It is reported as a click
  // because that is what a person reading the trail understands it to be.
  // Keyboard-activated controls do not emit it; the Enter branch covers those.
  on('pointerdown', function (ev) {
    send({ kind: 'click', target: nameOf(ev.target), role: roleOf(ev.target) });
  });

  // change, not input: one event when the field is done, rather than one per
  // keystroke. An audit wants "they filled this in", not a keylog.
  on('change', function (ev) {
    var el = ev.target;
    var value = el && typeof el.value === 'string' ? el.value : '';
    send({ kind: 'input', target: nameOf(el), role: roleOf(el), valueLength: value.length });
  });

  on('submit', function (ev) {
    send({ kind: 'submit', target: nameOf(ev.target), role: 'form' });
  });

  on('keydown', function (ev) {
    // Only keys that commit something. Everything else is typing, and typing is
    // what this deliberately does not record.
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    send({ kind: 'key', target: ev.key + ' in ' + nameOf(ev.target), role: roleOf(ev.target) });
  });
})()`;
