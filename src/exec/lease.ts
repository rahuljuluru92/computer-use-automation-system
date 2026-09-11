/**
 * Who is driving?
 *
 * The brief asks for a way to "pause, cede control, and resume on the *same*
 * session", and for "a way to know who is (or should be) in control". That is a
 * concurrency problem wearing a UX costume: two parties share one browser, and
 * the expensive bug is both of them acting at once - automation resuming while
 * a human is still mid-form, silently undoing their work.
 *
 * The fix is a lease with a generation counter. Every transfer bumps the
 * generation. Every action carries the generation it was planned under, and is
 * rejected if it no longer matches. So a stale action - one decided before a
 * handoff and executed after it - cannot land. Split-brain stops being a race
 * to lose and becomes a rejected call with a clear message.
 *
 * This is deliberately not a mutex. A mutex tells you the resource is busy; a
 * lease tells you *who* has it and *since when*, which is what an operator
 * console and an audit log both need.
 */

export type Controller = 'automation' | 'operator' | 'none';

export interface LeaseState {
  sessionId: string;
  controller: Controller;
  holderId: string | null;
  generation: number;
  since: string;
  /** Why control last moved. Surfaced in the operator console and evidence. */
  reason: string | null;
}

export class LeaseViolation extends Error {
  constructor(
    message: string,
    readonly expected: { controller: Controller; generation: number },
    readonly actual: { controller: Controller; generation: number },
  ) {
    super(message);
    this.name = 'LeaseViolation';
  }
}

export interface LeaseTransfer {
  generation: number;
  at: string;
  from: Controller;
  to: Controller;
  reason: string;
}

export class SessionLease {
  #state: LeaseState;
  readonly #history: LeaseTransfer[] = [];

  constructor(sessionId: string) {
    this.#state = {
      sessionId,
      controller: 'automation',
      holderId: 'automation',
      generation: 1,
      since: new Date().toISOString(),
      reason: 'session started',
    };
  }

  get state(): Readonly<LeaseState> {
    return { ...this.#state };
  }

  get generation(): number {
    return this.#state.generation;
  }

  get controller(): Controller {
    return this.#state.controller;
  }

  /** Every transfer so far. Written into evidence so handoffs are auditable. */
  get history(): readonly LeaseTransfer[] {
    return this.#history;
  }

  /**
   * Assert the caller may act right now, under the generation it planned in.
   *
   * The generation check is the part that matters. Checking only `controller`
   * would still allow an action decided before a handoff to execute after
   * control came back - the state would look correct and the action would be
   * wrong.
   */
  assertHeldBy(controller: Controller, generation: number): void {
    if (this.#state.controller !== controller || this.#state.generation !== generation) {
      throw new LeaseViolation(
        `Refusing to act: planned as ${controller}@gen${generation}, but the session is ` +
          `held by ${this.#state.controller}@gen${this.#state.generation}` +
          (this.#state.reason ? ` (${this.#state.reason})` : ''),
        { controller, generation },
        { controller: this.#state.controller, generation: this.#state.generation },
      );
    }
  }

  canAct(controller: Controller, generation: number): boolean {
    return this.#state.controller === controller && this.#state.generation === generation;
  }

  /** Automation gives up control. Returns the new generation. */
  cede(to: Controller, reason: string, holderId: string | null = null): number {
    return this.#transfer(to, reason, holderId);
  }

  /** A human takes the session. Fails if it was not offered to them. */
  claim(holderId: string, reason = 'operator claimed the session'): number {
    if (this.#state.controller === 'automation') {
      throw new LeaseViolation(
        'Cannot claim a session that automation has not ceded. ' +
          'Escalation must come from the run, not from the console.',
        { controller: 'none', generation: this.#state.generation },
        { controller: this.#state.controller, generation: this.#state.generation },
      );
    }
    return this.#transfer('operator', reason, holderId);
  }

  /** Control returns to automation after a handoff. */
  reclaim(reason = 'operator handed control back'): number {
    return this.#transfer('automation', reason, 'automation');
  }

  #transfer(to: Controller, reason: string, holderId: string | null): number {
    const from = this.#state.controller;
    const generation = this.#state.generation + 1;
    const at = new Date().toISOString();
    this.#state = { ...this.#state, controller: to, holderId, generation, since: at, reason };
    this.#history.push({ generation, at, from, to, reason });
    return generation;
  }
}
