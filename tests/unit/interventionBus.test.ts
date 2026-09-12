/**
 * The bus is what holds a run open while a human decides, so the properties
 * worth testing are the ones that decide whether a run hangs or resumes
 * underneath somebody who is still typing.
 *
 * Real timers, small timeouts. A fake clock would test the arithmetic and not
 * the thing that actually goes wrong, which is a timer that was never rearmed.
 */

import { describe, it, expect } from 'vitest';
import { InterventionBus, InterventionError } from '../../src/escalation/bus.ts';
import type { RaiseInput } from '../../src/escalation/bus.ts';
import type { HumanAction } from '../../src/escalation/intervention.ts';

function input(id = 'int-1'): RaiseInput {
  return {
    id,
    runId: 'run-1',
    capability: { id: 'cap.member.read_savings_balance', version: '1.0.0' },
    reason: 'recovery_exhausted',
    detail: 'the sign-in form did not accept the operator credentials',
    stepId: 's3',
    stepIntent: 'sign in',
    actionKind: 'click',
    actionClass: 'read',
    url: 'http://localhost:4400/frame/login',
    title: 'Sign in',
  };
}

const action = (kind: HumanAction['kind'] = 'click'): HumanAction => ({
  at: new Date().toISOString(), kind, target: 'Sign In', role: 'button',
});

describe('InterventionBus', () => {
  it('publishes as pending and resolves only when a human decides', async () => {
    const bus = new InterventionBus({ timeoutMs: 10_000 });
    const waiting = bus.raise(input());

    expect(bus.get('int-1')?.state).toBe('pending');
    expect(bus.pending()).toHaveLength(1);

    bus.claim('int-1', 'rahul');
    expect(bus.get('int-1')?.state).toBe('claimed');
    // Claiming is not deciding: the run is still waiting.
    expect(bus.pending()).toHaveLength(1);

    bus.resolve('int-1', 'resolved', 'signed in by hand');
    const record = await waiting;
    expect(record.state).toBe('resolved');
    expect(record.resolution).toBe('resolved');
    expect(record.claimedBy).toBe('rahul');
    expect(record.note).toBe('signed in by hand');
  });

  it('times out when nobody comes, rather than waiting forever', async () => {
    const bus = new InterventionBus({ timeoutMs: 60 });
    const record = await bus.raise(input());
    expect(record.state).toBe('timed_out');
    expect(record.resolution).toBeUndefined();
    expect(record.note).toContain('nobody responded');
  });

  it('gives a human who arrives a fresh window', async () => {
    const bus = new InterventionBus({ timeoutMs: 120 });
    const waiting = bus.raise(input());

    await new Promise((r) => setTimeout(r, 90));    // most of the first window
    bus.claim('int-1', 'rahul');
    await new Promise((r) => setTimeout(r, 90));    // past it, had it not reset

    // Still theirs. A deadline measured from when the run got stuck would have
    // expired here, and taken the session back while they were working in it.
    expect(bus.get('int-1')?.state).toBe('claimed');
    bus.resolve('int-1', 'resolved');
    expect((await waiting).state).toBe('resolved');
  });

  it('treats a captured human action as proof they are still there', async () => {
    const bus = new InterventionBus({ timeoutMs: 120 });
    const waiting = bus.raise(input());
    bus.claim('int-1', 'rahul');

    // Someone working a slow form: four actions across more than three windows.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 90));
      bus.recordHumanAction('int-1', action());
    }
    expect(bus.get('int-1')?.state).toBe('claimed');
    expect(bus.get('int-1')?.humanActions).toHaveLength(4);

    bus.resolve('int-1', 'resolved');
    expect((await waiting).humanActions).toHaveLength(4);
  });

  it('expires one window after a claimed intervention goes quiet', async () => {
    const bus = new InterventionBus({ timeoutMs: 60 });
    const waiting = bus.raise(input());
    bus.claim('int-1', 'rahul');
    // They took it and walked away. This is the case the naive "expire N
    // seconds after raising" rule turns into a hang.
    const record = await waiting;
    expect(record.state).toBe('timed_out');
    expect(record.claimedBy).toBe('rahul');
  });

  it('refuses to resolve something nobody claimed', async () => {
    const bus = new InterventionBus({ timeoutMs: 5_000 });
    const waiting = bus.raise(input());
    // "Resolved" is a claim about what a human did in the browser. A console
    // that can assert it without anybody having held the session can lie to
    // the run about what happened to a customer's account.
    expect(() => bus.resolve('int-1', 'resolved')).toThrow(InterventionError);
    bus.claim('int-1', 'rahul');
    bus.resolve('int-1', 'aborted');
    expect((await waiting).state).toBe('aborted');
  });

  it('refuses a second claim on the same intervention', async () => {
    const bus = new InterventionBus({ timeoutMs: 5_000 });
    const waiting = bus.raise(input());
    bus.claim('int-1', 'rahul');
    expect(() => bus.claim('int-1', 'someone-else')).toThrow(/cannot be claimed/);
    bus.resolve('int-1', 'resolved');
    await waiting;
  });

  it('reports an unknown id rather than inventing one', () => {
    const bus = new InterventionBus();
    expect(() => bus.claim('nope', 'rahul')).toThrow(InterventionError);
    expect(bus.get('nope')).toBeUndefined();
  });

  it('notifies subscribers on every transition', async () => {
    const bus = new InterventionBus({ timeoutMs: 5_000 });
    const states: string[] = [];
    bus.onChange((r) => states.push(r.state));

    const waiting = bus.raise(input());
    bus.claim('int-1', 'rahul');
    bus.recordHumanAction('int-1', action('input'));
    bus.resolve('int-1', 'skipped');
    await waiting;

    expect(states).toEqual(['pending', 'claimed', 'claimed', 'skipped']);
  });

  it('survives a listener that throws', async () => {
    const bus = new InterventionBus({ timeoutMs: 5_000 });
    bus.onChange(() => { throw new Error('a disconnected console'); });
    const waiting = bus.raise(input());
    bus.claim('int-1', 'rahul');
    bus.resolve('int-1', 'resolved');
    // The run waiting on this bus must not be taken down by the page watching it.
    expect((await waiting).state).toBe('resolved');
  });

  it('settles everything still open on shutdown', async () => {
    const bus = new InterventionBus({ timeoutMs: 60_000 });
    const a = bus.raise(input('int-a'));
    const b = bus.raise(input('int-b'));
    bus.claim('int-b', 'rahul');

    bus.shutdown();

    // A console going down must not leave a run waiting on a promise nobody
    // can resolve any more - that hangs the run on exit, which is worse than
    // whatever caused the escalation.
    expect((await a).state).toBe('timed_out');
    expect((await b).state).toBe('timed_out');
    expect((await b).note).toContain('shutting down');
  });

  it('lists newest first, and separates open from settled', async () => {
    const bus = new InterventionBus({ timeoutMs: 5_000 });
    const first = bus.raise(input('int-a'));
    await new Promise((r) => setTimeout(r, 5));
    bus.raise(input('int-b'));

    bus.claim('int-a', 'rahul');
    bus.resolve('int-a', 'resolved');
    await first;

    expect(bus.list().map((r) => r.id)).toEqual(['int-b', 'int-a']);
    expect(bus.pending().map((r) => r.id)).toEqual(['int-b']);
  });
});
