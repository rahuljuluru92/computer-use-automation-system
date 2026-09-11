/**
 * A ~40-line in-memory session, rather than a dependency.
 *
 * Two reasons this is hand-rolled. First, the app is a local demo target and
 * an in-memory map is honestly all it needs. Second, and more usefully, the
 * `session_timeout` chaos mode needs to invalidate a session at a precise
 * point mid-flow; owning the store makes that three lines instead of a fight
 * with someone else's expiry semantics.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { freshChaos, type ChaosState } from './chaos.ts';

export interface Session {
  id: string;
  user: string | null;
  chaos: ChaosState;
  /** Reference numbers already issued, so duplicate_guard has something to guard. */
  submitted: Set<string>;
  /** Pending sub-account request, carried between form and confirmation step. */
  pending: Record<string, string> | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session: Session;
    }
  }
}

const STORE = new Map<string, Session>();
const COOKIE = 'meridian_sid';

function create(): Session {
  return { id: randomUUID(), user: null, chaos: freshChaos(), submitted: new Set(), pending: null };
}

export function sessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const sid = parseCookie(req.headers.cookie)[COOKIE];
  let session = sid ? STORE.get(sid) : undefined;
  if (!session) {
    session = create();
    STORE.set(session.id, session);
    res.setHeader('Set-Cookie', `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax`);
  }
  req.session = session;
  next();
}

function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      return idx === -1
        ? [part.trim(), '']
        : [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
    }),
  );
}

/** Used by tests and by `/_chaos/reset` to get a clean slate. */
export function resetAllSessions(): void {
  STORE.clear();
}
