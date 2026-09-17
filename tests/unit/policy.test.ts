import { describe, it, expect } from 'vitest';
import { PolicyEngine, DEFAULT_POLICY, matchPath } from '../../src/policy/policyEngine.ts';
import { loadPolicy } from '../../src/policy/loadPolicy.ts';
import { classifyAction, mostCautious } from '../../src/policy/actionClass.ts';
import { SecretResolver } from '../../src/policy/secrets.ts';
import { Redactor } from '../../src/core/redact.ts';
import type { UiNode } from '../../src/surface/uinode.ts';

const node = (name: string, role = 'button'): UiNode => ({
  ref: 'e1', role, name, state: {}, frameChain: [], ancestry: [], nearestLabels: [], depth: 1,
});

const engine = (over: Partial<typeof DEFAULT_POLICY> = {}) =>
  new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: ['http://localhost:4400'], ...over });

const at = 'http://localhost:4400/members/12345';

describe('action classification', () => {
  it('treats reading and navigating as safe', () => {
    expect(classifyAction({ kind: 'extract' })).toBe('read');
    expect(classifyAction({ kind: 'navigate', urlTemplate: '/x' })).toBe('read');
  });

  it('treats filling a field as reversible', () => {
    expect(classifyAction({ kind: 'type', clearFirst: true })).toBe('write_reversible');
  });

  it('reads the words on the control to spot a commit', () => {
    expect(classifyAction({ kind: 'click' }, node('Confirm and Open Account'))).toBe('write_irreversible');
    expect(classifyAction({ kind: 'click' }, node('Transfer Funds'))).toBe('write_irreversible');
  });

  it('does not panic at navigational words', () => {
    expect(classifyAction({ kind: 'click' }, node('Continue'))).toBe('read');
    expect(classifyAction({ kind: 'click' }, node('Search'))).toBe('read');
    expect(classifyAction({ kind: 'click' }, node('View'))).toBe('read');
  });

  it('catches Enter as a disguised submit', () => {
    // A step list reading "press Enter" hides a commit from a human reviewer.
    expect(classifyAction({ kind: 'press', key: 'Enter' }, node('Confirm'))).toBe('write_irreversible');
    expect(classifyAction({ kind: 'press', key: 'Tab' }, node('Confirm'))).toBe('read');
  });

  it('assumes an unrecognised control writes something', () => {
    expect(classifyAction({ kind: 'click' }, node(''))).toBe('write_reversible');
  });

  it('takes the more cautious of two classifications', () => {
    expect(mostCautious('read', 'write_irreversible')).toBe('write_irreversible');
    expect(mostCautious('write_reversible', 'read')).toBe('write_reversible');
  });
});

describe('the allowlist', () => {
  it('permits an ordinary action on an allowed origin', () => {
    expect(engine().check({ action: { kind: 'click' }, target: node('View'), currentUrl: at }).verdict)
      .toBe('allow');
  });

  it('refuses an action on an origin that is not allowlisted', () => {
    const d = engine().check({ action: { kind: 'click' }, target: node('View'),
      currentUrl: 'https://evil.example.com/x' });
    expect(d.verdict).toBe('deny');
    if (d.verdict === 'deny') expect(d.rule).toBe('allowedOrigins');
  });

  it('checks where a navigate is GOING, not where it is', () => {
    // Checking only the current url would let one navigate walk the agent
    // straight off the allowlist, after which every later check passes.
    const d = engine().check({
      action: { kind: 'navigate', urlTemplate: 'x' },
      currentUrl: at,
      destinationUrl: 'https://evil.example.com/exfiltrate',
    });
    expect(d.verdict).toBe('deny');
  });

  it('refuses a verb that is not permitted', () => {
    const d = engine({ allowedActionKinds: ['extract', 'assert'] })
      .check({ action: { kind: 'click' }, target: node('View'), currentUrl: at });
    expect(d.verdict).toBe('deny');
    if (d.verdict === 'deny') expect(d.rule).toBe('allowedActionKinds');
  });

  it('matches path patterns with * and **', () => {
    expect(matchPath('/members/*', '/members/12345')).toBe(true);
    expect(matchPath('/members/*', '/members/12345/accounts/1')).toBe(false);
    expect(matchPath('/members/**', '/members/12345/accounts/1')).toBe(true);
    expect(matchPath('/admin/**', '/members/12345')).toBe(false);
  });
});

describe('irreversible actions', () => {
  it('requires approval, rather than proceeding', () => {
    const d = engine().check({ action: { kind: 'click' }, target: node('Confirm and Open Account'), currentUrl: at });
    expect(d.verdict).toBe('require_approval');
    if (d.verdict === 'require_approval') expect(d.actionClass).toBe('write_irreversible');
  });

  it('proceeds once approval has been granted for the run', () => {
    const d = engine().check({ action: { kind: 'click' }, target: node('Confirm and Open Account'),
      currentUrl: at, approvalGranted: true });
    expect(d.verdict).toBe('allow');
  });

  it('overrides an artifact that under-declares a step as safe', () => {
    // The artifact is a claim written by a compiler a model drove. We classify
    // independently and take the more cautious answer.
    const d = engine().check({ action: { kind: 'click' }, target: node('Confirm and Open Account'),
      currentUrl: at, declaredClass: 'read' });
    expect(d.verdict).toBe('require_approval');
  });

  it('honours an artifact that over-declares a step as dangerous', () => {
    const d = engine().check({ action: { kind: 'click' }, target: node('Continue'),
      currentUrl: at, declaredClass: 'write_irreversible' });
    expect(d.verdict).toBe('require_approval');
  });

  it('refuses a denied label even with approval granted', () => {
    const d = engine({ denyLabels: ['\\bpurge\\b'] })
      .check({ action: { kind: 'click' }, target: node('Purge Records'),
        currentUrl: at, approvalGranted: true });
    expect(d.verdict).toBe('deny');
  });
});

describe('the shipped policy file', () => {
  it('loads and denies anything off localhost', () => {
    const e = new PolicyEngine(loadPolicy('config/policy.yaml'));
    expect(e.check({ action: { kind: 'click' }, target: node('View'), currentUrl: at }).verdict)
      .toBe('allow');
    expect(e.check({ action: { kind: 'click' }, target: node('View'),
      currentUrl: 'https://example.com/' }).verdict).toBe('deny');
  });

  it('gates the confirm button on the real target app', () => {
    const e = new PolicyEngine(loadPolicy('config/policy.yaml'));
    expect(e.check({ action: { kind: 'click' }, target: node('Confirm and Open Account'),
      currentUrl: at }).verdict).toBe('require_approval');
  });
});

describe('value ceilings', () => {
  // decision #127: the field name and its resolved value are supplied as a
  // raw fact by the caller (mirroring declaredClass) - the engine alone
  // decides whether a configured limit applies and whether it is exceeded.
  const ceiling = engine({ valueLimits: [{ field: 'deposit', max: 5000 }] });

  it('allows a value at or under the ceiling', () => {
    const d = ceiling.check({ action: { kind: 'type', clearFirst: true }, target: node('Initial Deposit', 'textbox'),
      currentUrl: at, valueRef: { field: 'deposit', value: 5000 } });
    expect(d.verdict).toBe('allow');
  });

  it('requires approval once a value exceeds its configured ceiling', () => {
    const d = ceiling.check({ action: { kind: 'type', clearFirst: true }, target: node('Initial Deposit', 'textbox'),
      currentUrl: at, valueRef: { field: 'deposit', value: 8000 } });
    expect(d.verdict).toBe('require_approval');
    if (d.verdict === 'require_approval') {
      expect(d.rule).toBe('valueLimits:deposit');
      expect(d.reason).toMatch(/8000/);
      expect(d.reason).toMatch(/5000/);
    }
  });

  it('proceeds once approval has been granted for the run', () => {
    const d = ceiling.check({ action: { kind: 'type', clearFirst: true }, target: node('Initial Deposit', 'textbox'),
      currentUrl: at, valueRef: { field: 'deposit', value: 8000 }, approvalGranted: true });
    expect(d.verdict).toBe('allow');
  });

  it('ignores a field with no configured limit', () => {
    const d = ceiling.check({ action: { kind: 'type', clearFirst: true }, target: node('Nickname', 'textbox'),
      currentUrl: at, valueRef: { field: 'nickname', value: 999999 } });
    expect(d.verdict).toBe('allow');
  });

  it('does nothing when the action carries no valueRef at all', () => {
    // Most actions never resolve a numeric $input - the check has to be
    // opt-in per action, not something every click has to pay for.
    const d = ceiling.check({ action: { kind: 'click' }, target: node('View'), currentUrl: at });
    expect(d.verdict).toBe('allow');
  });
});

describe('secret references', () => {
  it('resolves from the environment and registers with the redactor first', () => {
    process.env.CUA_TEST_SECRET = 'a-very-secret-value-xyz';
    const r = new Redactor();
    const value = new SecretResolver(r).resolve({ $secret: 'env:CUA_TEST_SECRET' });
    expect(value).toBe('a-very-secret-value-xyz');
    // Already unprintable before anything had a chance to print it.
    expect(r.redact(`password=${value}`)).not.toContain('a-very-secret-value-xyz');
    delete process.env.CUA_TEST_SECRET;
  });

  it('fails with a usable message when a secret is missing', () => {
    expect(() => new SecretResolver(new Redactor()).resolve({ $secret: 'env:NOT_SET_ANYWHERE' }))
      .toThrow(/\.env\.example/);
  });

  it('rejects an unsupported scheme rather than guessing', () => {
    expect(() => new SecretResolver(new Redactor()).resolve({ $secret: 'vault://x' }))
      .toThrow(/unsupported secret scheme/);
  });
});
