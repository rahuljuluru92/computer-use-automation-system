/**
 * Secret references.
 *
 * An artifact must be publishable - reviewable in a pull request, diffable,
 * shared between tenants - so it can never contain a credential. It contains a
 * *reference*, resolved at run time and registered with the redactor the
 * moment it is resolved, so that the value is already unprintable before
 * anything has a chance to print it.
 */

import type { Redactor } from '../core/redact.ts';

export interface SecretRef { $secret: string }

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === 'object' && v !== null && typeof (v as SecretRef).$secret === 'string';
}

export class SecretResolver {
  constructor(private readonly redactor: Redactor) {}

  /**
   * Resolves `env:NAME`. The scheme exists so that a vault-backed resolver is
   * a new case here rather than a new shape in the artifact.
   */
  resolve(ref: SecretRef): string {
    const [scheme, ...rest] = ref.$secret.split(':');
    const name = rest.join(':');
    if (scheme !== 'env') {
      throw new Error(`unsupported secret scheme "${scheme}" in "${ref.$secret}"`);
    }
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(
        `secret "${ref.$secret}" is not set. Copy .env.example to .env and fill it in.`,
      );
    }
    // Registered before it is returned, so there is no window in which the
    // value exists in the process but is not yet redactable.
    this.redactor.register(value, 'secret', name);
    return value;
  }

  /** Resolves a value that may or may not be a secret reference. */
  materialise(value: unknown): unknown {
    return isSecretRef(value) ? this.resolve(value) : value;
  }
}
