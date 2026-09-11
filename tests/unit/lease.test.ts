import { describe, it, expect } from 'vitest';
import { SessionLease, LeaseViolation } from '../../src/exec/lease.ts';

describe('SessionLease', () => {
  it('starts with automation in control at generation 1', () => {
    const l = new SessionLease('s1');
    expect(l.controller).toBe('automation');
    expect(l.generation).toBe(1);
    l.assertHeldBy('automation', 1); // does not throw
  });

  it('rejects an action planned under a stale generation', () => {
    const l = new SessionLease('s1');
    const planned = l.generation;
    l.cede('none', 'stuck: unknown dialog');
    // This is the split-brain case: the action was decided before the handoff.
    expect(() => l.assertHeldBy('automation', planned)).toThrow(LeaseViolation);
  });

  it('rejects the right holder at the wrong generation', () => {
    const l = new SessionLease('s1');
    l.cede('none', 'stuck');
    l.claim('operator-1');
    l.reclaim();
    // Automation is back in control, but not at the generation it planned under.
    expect(l.controller).toBe('automation');
    expect(() => l.assertHeldBy('automation', 1)).toThrow(LeaseViolation);
    l.assertHeldBy('automation', l.generation); // current generation is fine
  });

  it('refuses a claim on a session automation never ceded', () => {
    const l = new SessionLease('s1');
    // An operator cannot barge into a running automation from the console.
    expect(() => l.claim('operator-1')).toThrow(LeaseViolation);
  });

  it('runs a full handoff cycle and bumps generation each time', () => {
    const l = new SessionLease('s1');
    expect(l.generation).toBe(1);
    l.cede('none', 'recovery exhausted');
    expect(l.generation).toBe(2);
    l.claim('operator-1');
    expect(l.generation).toBe(3);
    expect(l.controller).toBe('operator');
    l.reclaim();
    expect(l.generation).toBe(4);
    expect(l.controller).toBe('automation');
  });

  it('records an auditable history of every transfer', () => {
    const l = new SessionLease('s1');
    l.cede('none', 'stuck: permission denied');
    l.claim('operator-1');
    l.reclaim('operator finished the manual step');
    expect(l.history.map((h) => `${h.from}->${h.to}`)).toEqual([
      'automation->none', 'none->operator', 'operator->automation',
    ]);
    expect(l.history[0]!.reason).toBe('stuck: permission denied');
  });

  it('reports a violation with both expected and actual state, for debugging', () => {
    const l = new SessionLease('s1');
    l.cede('none', 'stuck');
    try {
      l.assertHeldBy('automation', 1);
      expect.unreachable('should have thrown');
    } catch (e) {
      const v = e as LeaseViolation;
      expect(v.expected).toEqual({ controller: 'automation', generation: 1 });
      expect(v.actual).toEqual({ controller: 'none', generation: 2 });
      expect(v.message).toContain('stuck');
    }
  });
});
