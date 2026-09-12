/**
 * The chaos injector.
 *
 * This is the cheapest file in the target app and the most valuable one. The
 * brief's third-weighted criterion is how replay handles runtime errors and
 * exceptional states, and it is explicit that the interesting failures are not
 * layout drift - they are validation errors, "record not found", permission
 * denials, surprise dialogs, session expiry, transient slowness and outright
 * app errors. No public demo site will produce those on command.
 *
 * Each mode maps to exactly one branch of the replay error taxonomy, which is
 * how the demo proves the taxonomy is real rather than aspirational:
 *
 *   not_found          -> business outcome   (a legitimate answer, exit 0)
 *   permission_denied  -> business outcome / escalation, depending on the step
 *   validation_error   -> business outcome   (the app rejected our input)
 *   surprise_modal     -> recoverable        (declared dismiss rule)
 *   session_timeout    -> recoverable        (declared reauth subflow, once)
 *   slow_load          -> recoverable        (state predicates outwait it)
 *   http_500           -> recoverable then hard failure (bounded retry, then give up)
 *   duplicate_guard    -> hard failure       (the app refuses a repeated submit)
 *
 * Chaos is sticky per session rather than a query parameter, because a replay
 * navigates and clicks its way through several pages and a query parameter
 * would be lost on the first link.
 */

import type { Request, Response, NextFunction } from 'express';

export const CHAOS_MODES = [
  'none',
  'not_found',
  'validation_error',
  'permission_denied',
  'session_timeout',
  'surprise_modal',
  'slow_load',
  'http_500',
  'duplicate_guard',
] as const;

export type ChaosMode = (typeof CHAOS_MODES)[number];

export function isChaosMode(v: string): v is ChaosMode {
  return (CHAOS_MODES as readonly string[]).includes(v);
}

export interface ChaosState {
  mode: ChaosMode;
  /** Page loads seen since the mode was armed. Lets a mode fire on the Nth hit. */
  hits: number;
  /** Set once a mode has fired, for one-shot modes like session_timeout. */
  fired: boolean;
}

export function freshChaos(): ChaosState {
  return { mode: 'none', hits: 0, fired: false };
}

/** Routes that must keep working even under chaos, or the run cannot recover. */
const EXEMPT = new Set(['/_chaos', '/_chaos/reset', '/_tenant', '/_health', '/favicon.ico']);

/**
 * Applies the globally-scoped modes. Modes that depend on business logic
 * (not_found, validation_error, permission_denied, duplicate_guard) are applied
 * by the routes themselves, because they need to look like the application
 * misbehaving rather than the transport misbehaving - which is exactly the
 * distinction the replay engine has to make.
 */
export async function chaosMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const chaos = req.session.chaos;

  if (EXEMPT.has(req.path) || req.path.startsWith('/static')) return next();

  chaos.hits += 1;

  switch (chaos.mode) {
    case 'slow_load': {
      // Slow, not broken. A fixed sleep in the replay engine would either be
      // too short and flake or too long and waste; a state predicate just waits.
      await delay(2_500);
      return next();
    }

    case 'http_500': {
      // Transient: fails the first two attempts, then recovers. A bounded retry
      // policy survives this; an unbounded one hides real outages, and no retry
      // at all turns a blip into a failed capability.
      if (chaos.hits <= 2) {
        res.status(500).type('html').send(errorPage(
          'Server Error',
          'The application encountered an unexpected condition. Reference 0x8004005.',
        ));
        return;
      }
      return next();
    }

    case 'session_timeout': {
      // Fires once, mid-flow, after the operator is already signed in - which
      // is when it actually happens in a bank.
      //
      // It drops the session and lets the request continue rather than
      // redirecting, so the in-frame auth gate renders the sign-in form where
      // the member data should have been. That is what the real thing does,
      // and it is what makes a bounded reauth subflow possible: the recovery
      // rule can fill the form in place and retry the step, instead of having
      // to notice that the whole window navigated somewhere else.
      if (!chaos.fired && chaos.hits >= 3 && req.session.user) {
        chaos.fired = true;
        req.session.user = null;
      }
      return next();
    }

    case 'surprise_modal': {
      // An interstitial the recorded flow never saw: a maintenance notice that
      // blocks the page until dismissed.
      if (!chaos.fired && chaos.hits >= 2) {
        res.locals.surpriseModal = {
          title: 'Scheduled Maintenance Notice',
          body: 'Core processing will be unavailable Sunday 02:00-04:00 ET. '
              + 'Acknowledge to continue.',
        };
      }
      return next();
    }

    default:
      return next();
  }
}

/** Marks a one-shot mode as spent, e.g. once the surprise modal is dismissed. */
export function markFired(req: Request): void {
  req.session.chaos.fired = true;
}

export function errorPage(title: string, body: string): string {
  return `<html><head><title>${title}</title></head>
<body bgcolor="#ffffff"><table width="700" border="0" cellpadding="8"><tr>
<td><font face="Verdana" size="4" color="#a00000"><b>${title}</b></font><br><br>
<font face="Verdana" size="2">${body}</font></td></tr></table></body></html>`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
