/**
 * Redaction.
 *
 * The rule this file enforces: secrets and regulated data never reach disk.
 * Not "are usually removed" - never reach disk, because every byte written to
 * evidence/ or artifacts/ passes through a Redactor first (see
 * src/evidence/writer.ts), and tests/safety/ proves it by pushing canary values
 * through a full demo run and grepping the output.
 *
 * Two mechanisms, deliberately different:
 *
 *   Registered values  - exact strings we know are sensitive (a resolved
 *                        password, a PII-marked input). Matched literally, so
 *                        there are no false negatives from a clever regex.
 *
 *   Patterns           - shapes we recognise even when we were never told about
 *                        them (SSNs, card numbers, bearer tokens). This is the
 *                        safety net for data that arrives from the *app* rather
 *                        than from us, which is most of it.
 *
 * Registered values are the load-bearing one. Patterns catch what we did not
 * anticipate, and a bank's back office is full of things nobody anticipated.
 */

export type RedactionKind = 'secret' | 'pii' | 'pattern';

export interface RedactionHit {
  kind: RedactionKind;
  label: string;
  count: number;
}

interface RegisteredValue {
  value: string;
  kind: RedactionKind;
  label: string;
}

/** Shapes that are sensitive regardless of whether anyone registered them. */
const DEFAULT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'card', re: /\b(?:\d[ -]?){13,19}\b/g },
  // Long opaque tokens: sk-..., ghp_..., bearer blobs.
  { label: 'api_key', re: /\b(?:sk|pk|ghp|gho|xox[abpr])[-_][A-Za-z0-9_-]{16,}\b/g },
  { label: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

export class Redactor {
  readonly #values: RegisteredValue[] = [];
  readonly #patterns = DEFAULT_PATTERNS;
  readonly #hits = new Map<string, RedactionHit>();

  /**
   * Register a value that must never appear in output.
   *
   * Short values are ignored on purpose: registering a 2-character password
   * would redact half the page and make evidence useless, which is its own kind
   * of failure. Anything that short should not be a secret in the first place,
   * and the caller is told via the return value.
   */
  register(value: string | undefined, kind: RedactionKind, label: string): boolean {
    if (!value || value.length < 4) return false;
    if (this.#values.some((v) => v.value === value)) return true;
    this.#values.push({ value, kind, label });
    return true;
  }

  registerAll(values: Iterable<string>, kind: RedactionKind, label: string): void {
    for (const v of values) this.register(v, kind, label);
  }

  /** Replace every registered value and every known pattern in `text`. */
  redact(text: string): string {
    let out = text;

    // Longest-first, so a password that contains a username does not get
    // partially masked into something still readable.
    const sorted = [...this.#values].sort((a, b) => b.value.length - a.value.length);
    for (const { value, kind, label } of sorted) {
      if (!out.includes(value)) continue;
      const count = out.split(value).length - 1;
      out = out.split(value).join(`[REDACTED:${kind}:${label}]`);
      this.#note(kind, label, count);
    }

    for (const { label, re } of this.#patterns) {
      out = out.replace(re, (match) => {
        // Card pattern is greedy enough to catch ordinary long digit runs
        // (reference numbers, timestamps). Luhn-check before masking so we do
        // not destroy legitimate evidence.
        if (label === 'card' && !looksLikeCard(match)) return match;
        this.#note('pattern', label, 1);
        return `[REDACTED:pattern:${label}]`;
      });
    }

    return out;
  }

  /** Deep-redact an arbitrary JSON-serialisable value, keys included. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as unknown as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([k, v]) => [this.redact(k), this.redactValue(v)]),
      ) as unknown as T;
    }
    return value;
  }

  /** What was redacted, and how often. Written into each run's manifest. */
  report(): RedactionHit[] {
    return [...this.#hits.values()].sort((a, b) => b.count - a.count);
  }

  get registeredCount(): number {
    return this.#values.length;
  }

  #note(kind: RedactionKind, label: string, count: number): void {
    const key = `${kind}:${label}`;
    const existing = this.#hits.get(key);
    if (existing) existing.count += count;
    else this.#hits.set(key, { kind, label, count });
  }
}

/** Luhn check, so ordinary long digit strings survive redaction. */
function looksLikeCard(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Build the redactor for a run: every configured secret, plus any input the
 * artifact marked sensitive. Called once at run start, before anything is
 * written.
 */
export function buildRedactor(opts: {
  secrets?: Record<string, string | undefined>;
  sensitiveInputs?: Record<string, unknown>;
}): Redactor {
  const r = new Redactor();
  for (const [label, value] of Object.entries(opts.secrets ?? {})) {
    r.register(value, 'secret', label);
  }
  for (const [label, value] of Object.entries(opts.sensitiveInputs ?? {})) {
    if (typeof value === 'string') r.register(value, 'pii', label);
  }
  return r;
}
