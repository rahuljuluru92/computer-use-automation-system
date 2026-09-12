import { existsSync } from 'node:fs';

/**
 * Loads `.env` if there is one, with real environment variables winning over
 * it - an exported key or a CI secret should take precedence over a stale
 * file on a laptop, not the other way round.
 *
 * The wrinkle, found by actually hitting it: "already set" has to mean
 * "set to something," not merely "present in `process.env`." Some sandboxed
 * shells (this one included) pre-export a variable name with an empty string
 * as a placeholder. `process.loadEnvFile`'s own overwrite-avoidance treats
 * that as already configured and leaves it blank, so a real key sitting
 * right there in `.env` is silently shadowed - no error, just a rejected
 * credential deep inside whatever tries to use it later. An empty string is
 * not a value someone set on purpose, so it is cleared before `.env` loads,
 * exactly like a missing key would be.
 */
export function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  for (const key of Object.keys(process.env)) {
    if (process.env[key] === '') delete process.env[key];
  }
  try {
    process.loadEnvFile('.env');
  } catch {
    // A malformed .env should not stop `replay`, which needs no secrets at all.
  }
}
