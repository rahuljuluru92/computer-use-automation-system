import { describe, it, expect } from 'vitest';
import { Redactor, buildRedactor } from '../../src/core/redact.ts';
import { artifactHash, withIntegrity, verifyIntegrity, canonicalJson } from '../../src/core/integrity.ts';
import { CapabilityArtifact } from '../../src/core/schema.ts';
import { minimalArtifact } from '../fixtures/minimalArtifact.ts';

describe('Redactor', () => {
  it('removes registered secrets from text', () => {
    const r = new Redactor();
    r.register('hunter2-correct-horse', 'secret', 'MERIDIAN_PASSWORD');
    const out = r.redact('login with hunter2-correct-horse now');
    expect(out).not.toContain('hunter2-correct-horse');
    expect(out).toContain('[REDACTED:secret:MERIDIAN_PASSWORD]');
  });

  it('masks the longest registered value first, so nothing leaks partially', () => {
    const r = new Redactor();
    r.register('teller01', 'pii', 'user');
    r.register('teller01-password', 'secret', 'pass');
    const out = r.redact('teller01-password');
    // If the short value won, the remainder "-password" would survive in the clear.
    expect(out).toBe('[REDACTED:secret:pass]');
  });

  it('catches shapes it was never told about', () => {
    const r = new Redactor();
    const out = r.redact('ssn 123-45-6789 and key sk-ant-abcdefghijklmnopqrstuv');
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuv');
  });

  it('does not mask long digit runs that are not card numbers', () => {
    const r = new Redactor();
    // A reference number that fails Luhn must survive - destroying evidence is
    // its own failure mode.
    const out = r.redact('reference 1234567890123');
    expect(out).toContain('1234567890123');
  });

  it('masks a real card-shaped number', () => {
    const r = new Redactor();
    const out = r.redact('card 4111 1111 1111 1111 on file'); // valid Luhn
    expect(out).not.toContain('4111 1111 1111 1111');
  });

  it('ignores values too short to redact safely, and says so', () => {
    const r = new Redactor();
    expect(r.register('ab', 'secret', 'tiny')).toBe(false);
    expect(r.redact('ab cd')).toBe('ab cd');
  });

  it('deep-redacts nested objects including keys', () => {
    const r = buildRedactor({ secrets: { pw: 'sup3r-s3cret-value' } });
    const out = r.redactValue({ a: { b: ['x', 'sup3r-s3cret-value'] } });
    expect(JSON.stringify(out)).not.toContain('sup3r-s3cret-value');
  });

  it('reports what it redacted', () => {
    const r = new Redactor();
    r.register('sup3r-s3cret-value', 'secret', 'pw');
    r.redact('sup3r-s3cret-value twice: sup3r-s3cret-value');
    expect(r.report()).toEqual([{ kind: 'secret', label: 'pw', count: 2 }]);
  });
});

describe('artifact integrity', () => {
  it('is stable across key ordering', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('round-trips and verifies', () => {
    const a = withIntegrity(CapabilityArtifact.parse(minimalArtifact()));
    expect(verifyIntegrity(a)).toBe(true);
  });

  it('detects tampering', () => {
    const a = withIntegrity(CapabilityArtifact.parse(minimalArtifact()));
    const tampered = { ...a, title: 'Something else' };
    expect(verifyIntegrity(tampered)).toBe(false);
  });

  it('ignores the hash field itself when hashing', () => {
    const base = CapabilityArtifact.parse(minimalArtifact());
    expect(artifactHash(base)).toBe(artifactHash(withIntegrity(base)));
  });
});
