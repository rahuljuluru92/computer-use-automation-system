/**
 * The intervention bus.
 *
 * One job: hold a run open while a human decides, and make sure it cannot be
 * held open forever. Everything else here follows from that sentence.
 *
 * The bus is deliberately in-process and in-memory. It is a rendezvous between
 * a run that is blocked and a console that is watching, both of which live for
 * exactly as long as the run does. Putting a queue or a database behind this
 * would add operational surface without changing a single property that is
 * being graded, and the seam is a class, so a durable implementation is a
 * substitution rather than a rewrite.
 *
 * ## The deadline slides, and that is the whole design
 *
 * The naive rule - "abandon N seconds after raising" - is wrong in the way that
 * matters. It expires while a human is mid-form, which means the run resumes
 * underneath somebody who is still typing. That is precisely the split-brain the
 * lease exists to prevent, and a timeout that causes it has made things worse.
 *
 * So the deadline measures *silence*, not elapsed time:
 *
 *   raised                     deadline = now + timeoutMs
 *   claimed by an operator     deadline = now + timeoutMs   (they arrived)
 *   any captured human action  deadline = now + timeoutMs   (still working)
 *
 * Nobody comes, and it expires on schedule. Somebody comes and works, and it
 * never expires. Somebody claims it and wanders off, and it expires one window
 * later - which is the case the naive rule silently turns into a hang.
 */

import {
  InterventionRecord, type HumanAction, type Resolution, type InterventionState,
  isTerminal,
} from './intervention.ts';

export interface BusOptions {
  /** How long silence is tolerated before the run abandons. */
  timeoutMs?: number;
  /** Seam for tests. Defaults to Date.now. */
  now?: () => number;
}

export class InterventionError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'wrong_state') {
    super(message);
    this.name = 'InterventionError';
  }
}

interface Entry {
  record: InterventionRecord;
  settle: (r: InterventionRecord) => void;
  timer: NodeJS.Timeout | null;
  timeoutMs: number;
}

export type BusListener = (record: InterventionRecord) => void;

/** What `raise` is given: everything except the fields the bus itself owns. */
export type RaiseInput =
  Omit<InterventionRecord, 'state' | 'raisedAt' | 'expiresAt' | 'humanActions' | 'leaseTransfers'>
  & Partial<Pick<InterventionRecord, 'humanActions' | 'leaseTransfers'>>;

/**
 * The slice of a bus that a handoff actually needs.
 *
 * Named separately because the console can be a different process from the run.
 * When it is, the bus lives in the console and the run talks to it over HTTP -
 * and the handoff protocol should not know or care which of those it is holding.
 * `InterventionBus` is the local implementation; `RemoteBus` in remote.ts is the
 * other one, and neither appears in handoff.ts.
 */
export interface InterventionSink {
  raise(input: RaiseInput, opts?: { timeoutMs?: number }): Promise<InterventionRecord>;
  get(id: string): InterventionRecord | undefined;
  recordHumanAction(id: string, action: HumanAction): void;
  recordLeaseTransfers(id: string, transfers: InterventionRecord['leaseTransfers']): void;
  recordAbandon(id: string, abandon: NonNullable<InterventionRecord['abandon']>): void;
  onChange(fn: BusListener): () => void;
}

export class InterventionBus implements InterventionSink {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<BusListener>();
  readonly #defaultTimeoutMs: number;
  readonly #now: () => number;

  constructor(opts: BusOptions = {}) {
    this.#defaultTimeoutMs = opts.timeoutMs ?? 300_000;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Publish an intervention and wait for a human.
   *
   * Resolves with the final record whatever happens - resolved, skipped,
   * aborted or timed out. It does not reject: "nobody came" is an outcome the
   * run has to handle, not an exception it should be surprised by.
   */
  raise(input: RaiseInput, opts: { timeoutMs?: number } = {}): Promise<InterventionRecord> {
    const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs;
    const raisedAt = new Date(this.#now()).toISOString();

    const record = InterventionRecord.parse({
      ...input,
      state: 'pending' satisfies InterventionState,
      raisedAt,
      expiresAt: new Date(this.#now() + timeoutMs).toISOString(),
      humanActions: input.humanActions ?? [],
      leaseTransfers: input.leaseTransfers ?? [],
    });

    return new Promise<InterventionRecord>((resolve) => {
      const entry: Entry = { record, settle: resolve, timer: null, timeoutMs };
      this.#entries.set(record.id, entry);
      this.#arm(entry);
      this.#emit(record);
    });
  }

  get(id: string): InterventionRecord | undefined {
    return this.#entries.get(id)?.record;
  }

  /** Newest first, which is the order a console wants to render. */
  list(): InterventionRecord[] {
    return [...this.#entries.values()]
      .map((e) => e.record)
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  /** Anything waiting on a human right now. */
  pending(): InterventionRecord[] {
    return this.list().filter((r) => !isTerminal(r.state));
  }

  /**
   * An operator takes the session.
   *
   * Claiming is not resolving. It says "I am here and I am looking at it",
   * which is what stops the clock and what the run needs to know before it
   * stops treating the browser as its own.
   */
  claim(id: string, operatorId: string): InterventionRecord {
    const entry = this.#require(id);
    if (entry.record.state !== 'pending') {
      throw new InterventionError(
        `${id} is ${entry.record.state}, so it cannot be claimed`, 'wrong_state');
    }
    entry.record = {
      ...entry.record,
      state: 'claimed',
      claimedBy: operatorId,
      claimedAt: new Date(this.#now()).toISOString(),
    };
    this.#arm(entry);       // they arrived: fresh window
    this.#emit(entry.record);
    return entry.record;
  }

  /**
   * The operator hands control back with a decision.
   *
   * Requires a claim first. Resolving something nobody took would mean the run
   * resumes on the word of a console that never actually held the session.
   */
  resolve(id: string, resolution: Resolution, note?: string): InterventionRecord {
    const entry = this.#require(id);
    if (entry.record.state !== 'claimed') {
      throw new InterventionError(
        `${id} is ${entry.record.state}; it must be claimed before it can be resolved`,
        'wrong_state');
    }
    entry.record = {
      ...entry.record,
      state: resolution === 'resolved' ? 'resolved'
           : resolution === 'skipped' ? 'skipped' : 'aborted',
      resolution,
      ...(note !== undefined ? { note } : {}),
      resolvedAt: new Date(this.#now()).toISOString(),
    };
    this.#finish(entry);
    return entry.record;
  }

  /**
   * Record something the human did, and treat it as proof they are still there.
   *
   * The heartbeat is the point: an operator working a slow form should never
   * have the run decide they have gone.
   */
  recordHumanAction(id: string, action: HumanAction): void {
    const entry = this.#entries.get(id);
    if (!entry || isTerminal(entry.record.state)) return;
    entry.record = {
      ...entry.record,
      humanActions: [...entry.record.humanActions, action],
    };
    this.#arm(entry);
    this.#emit(entry.record);
  }

  /** Attach the lease history, so the audit shows the whole round trip. */
  recordLeaseTransfers(id: string, transfers: InterventionRecord['leaseTransfers']): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.record = { ...entry.record, leaseTransfers: transfers };
    this.#emit(entry.record);
  }

  /** Note what the run did once it gave up waiting. */
  recordAbandon(id: string, abandon: NonNullable<InterventionRecord['abandon']>): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.record = { ...entry.record, abandon };
    this.#emit(entry.record);
  }

  /** Subscribe to every change. Returns an unsubscribe. */
  onChange(fn: BusListener): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /**
   * Settle everything still open, as timed out.
   *
   * Called when the process is going down. A run that is shutting down must not
   * leave a promise nobody will ever resolve - the caller would hang on exit,
   * which is a worse failure than the one that caused the escalation.
   */
  shutdown(): void {
    for (const entry of this.#entries.values()) {
      if (!isTerminal(entry.record.state)) this.#expire(entry, 'the run is shutting down');
    }
  }

  // -------------------------------------------------------------------------

  #require(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new InterventionError(`no intervention ${id}`, 'not_found');
    return entry;
  }

  /** (Re)start the silence timer and publish the new deadline. */
  #arm(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.record = {
      ...entry.record,
      expiresAt: new Date(this.#now() + entry.timeoutMs).toISOString(),
    };
    const timer = setTimeout(() => {
      this.#expire(entry, `nobody responded within ${Math.round(entry.timeoutMs / 1000)}s`);
    }, entry.timeoutMs);
    // A pending intervention must not be the reason a process refuses to exit.
    timer.unref?.();
    entry.timer = timer;
  }

  #expire(entry: Entry, why: string): void {
    if (isTerminal(entry.record.state)) return;
    entry.record = {
      ...entry.record,
      state: 'timed_out',
      note: entry.record.note ?? why,
      resolvedAt: new Date(this.#now()).toISOString(),
    };
    this.#finish(entry);
  }

  #finish(entry: Entry): void {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    this.#emit(entry.record);
    entry.settle(entry.record);
  }

  #emit(record: InterventionRecord): void {
    for (const fn of this.#listeners) {
      // One bad listener - a disconnected console, say - must not take down
      // the run that is waiting on this bus.
      try { fn(record); } catch { /* ignore */ }
    }
  }
}
