/**
 * Talking to a console that is somewhere else.
 *
 * The run and the console are usually two processes: an operator starts a
 * console once and leaves it open, and runs come and go. The browser, though,
 * stays with the run - it has to, because the point of the handoff is that the
 * human drives *that* session rather than a fresh one. So what crosses the
 * process boundary is the conversation, not the browser.
 *
 * That makes this a thin thing: the same `InterventionSink` the local bus
 * implements, with HTTP behind it. `handoff.ts` cannot tell the difference, and
 * that is the design - the protocol that matters (cede, claim, capture, hand
 * back, re-observe) is written once, against an interface, and runs identically
 * whether the console is in this process or on the other end of a socket.
 *
 * Polling rather than a socket or SSE. A console is a page a person looks at,
 * so the cost of a request every 400ms is nothing, and the failure mode of a
 * poll - it comes back or it does not - is one this code can actually reason
 * about. A dropped socket needs a reconnect policy, which is a state machine
 * nobody would test.
 */

import type { InterventionSink, RaiseInput, BusListener } from './bus.ts';
import { InterventionRecord, type HumanAction, isTerminal } from './intervention.ts';

export interface RemoteBusOptions {
  /** Base URL of a running console, e.g. http://127.0.0.1:4500 */
  url: string;
  pollMs?: number;
  /**
   * How many consecutive failed polls before the run gives up on the console.
   *
   * A console that has gone away is indistinguishable from one nobody is
   * watching, and both mean the same thing to the run: no human is coming.
   * Waiting forever for a process that has exited is the one outcome that is
   * definitely wrong.
   */
  maxConsecutiveFailures?: number;
}

export class RemoteBus implements InterventionSink {
  readonly #base: string;
  readonly #pollMs: number;
  readonly #maxFailures: number;
  readonly #listeners = new Set<BusListener>();
  readonly #records = new Map<string, InterventionRecord>();

  constructor(o: RemoteBusOptions) {
    this.#base = o.url.replace(/\/$/, '');
    this.#pollMs = o.pollMs ?? 400;
    this.#maxFailures = o.maxConsecutiveFailures ?? 25;
  }

  /** True when a console is actually listening. Checked before a run starts. */
  async reachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.#base}/api/interventions`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async raise(input: RaiseInput, opts: { timeoutMs?: number } = {}): Promise<InterventionRecord> {
    const created = await this.#post('/api/interventions', { ...input, ...opts });
    this.#publish(InterventionRecord.parse(created));
    return this.#pollUntilTerminal(input.id);
  }

  get(id: string): InterventionRecord | undefined {
    return this.#records.get(id);
  }

  recordHumanAction(id: string, action: HumanAction): void {
    // Fire and forget, deliberately. This is a heartbeat and an audit line;
    // blocking an operator's click on a POST completing would make the console
    // feel like it was fighting them.
    void this.#post(`/api/interventions/${encodeURIComponent(id)}/actions`, { action })
      .catch(() => { /* the poll loop is what notices a dead console */ });
  }

  recordLeaseTransfers(id: string, transfers: InterventionRecord['leaseTransfers']): void {
    void this.#post(`/api/interventions/${encodeURIComponent(id)}/lease`, { transfers })
      .catch(() => { /* as above */ });
  }

  recordAbandon(id: string, abandon: NonNullable<InterventionRecord['abandon']>): void {
    void this.#post(`/api/interventions/${encodeURIComponent(id)}/abandon`, { abandon })
      .catch(() => { /* as above */ });
  }

  onChange(fn: BusListener): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  // -------------------------------------------------------------------------

  async #pollUntilTerminal(id: string): Promise<InterventionRecord> {
    let failures = 0;
    for (;;) {
      await sleep(this.#pollMs);
      try {
        const res = await fetch(`${this.#base}/api/interventions/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`console returned ${res.status}`);
        const record = InterventionRecord.parse(await res.json());
        failures = 0;
        this.#publish(record);
        if (isTerminal(record.state)) return record;
      } catch {
        failures += 1;
        if (failures >= this.#maxFailures) return this.#giveUp(id);
      }
    }
  }

  /**
   * Synthesise a timeout locally when the console has stopped answering.
   *
   * Returning a record the console never produced is not a lie - the run
   * genuinely does not know what happened, and `timed_out` is exactly the
   * state that means "no human resolved this". The note says why, so nobody
   * reading the evidence later mistakes a dead console for an absent operator.
   */
  #giveUp(id: string): InterventionRecord {
    const known = this.#records.get(id);
    const now = new Date().toISOString();
    const record = InterventionRecord.parse({
      ...(known ?? {
        id, runId: '', capability: { id: '', version: '' },
        reason: 'not_safely_abandonable', detail: '', stepId: '', stepIntent: '',
        raisedAt: now,
      }),
      state: 'timed_out',
      expiresAt: now,
      resolvedAt: now,
      note: `the operator console at ${this.#base} stopped responding, so no human decision arrived`,
    });
    this.#publish(record);
    return record;
  }

  #publish(record: InterventionRecord): void {
    const previous = this.#records.get(record.id);
    this.#records.set(record.id, record);
    // Only on an actual change: the claim hook in handoff.ts moves the lease,
    // and re-running it every 400ms would throw on the second call.
    if (previous && previous.state === record.state
        && previous.humanActions.length === record.humanActions.length) return;
    for (const fn of this.#listeners) {
      try { fn(record); } catch { /* a listener must not break the poll loop */ }
    }
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`console rejected ${path}: ${res.status} ${text}`);
    }
    return res.json();
  }
}

function sleep(ms: number): Promise<void> {
  // The one timer in the execution path, and it is not a wait-for-the-page
  // sleep - it is the interval between asking a remote console a question.
  // Invariant 5 is about never waiting a fixed time for a *state change*; this
  // waits for a human, whose arrival no predicate can observe.
  return new Promise((done) => { const t = setTimeout(done, ms); t.unref?.(); });
}
