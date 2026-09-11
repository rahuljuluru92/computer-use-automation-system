/**
 * Writing evidence.
 *
 * This is the only path from the running system to disk, and that is on
 * purpose. Redaction is not a step somebody remembers to call - it is a
 * property of the writer, so there is no way to write bytes that skipped it.
 * `tests/safety/redaction-canary.test.ts` pushes planted canaries through a
 * full run and then greps everything this class produced.
 *
 * Screenshots are the exception that proves the rule: an image cannot be
 * redacted after the fact by a text filter, so masking happens at capture
 * time in WebSurface, before the bytes exist. By the time a PNG reaches this
 * class it is already safe, and this class cannot make it so.
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Redactor } from '../core/redact.ts';
import type { EvidenceEvent, EventKind } from './events.ts';

export interface EvidenceWriterOptions {
  runId: string;
  root?: string;
  redactor: Redactor;
  /** Recorded in the manifest so a reader knows what produced this. */
  meta?: Record<string, unknown>;
}

export class EvidenceWriter {
  readonly dir: string;
  readonly runId: string;
  #redactor: Redactor;
  #seq = 0;
  #events: EvidenceEvent[] = [];
  #meta: Record<string, unknown>;
  #closed = false;

  constructor(opts: EvidenceWriterOptions) {
    this.runId = opts.runId;
    this.#redactor = opts.redactor;
    this.#meta = opts.meta ?? {};
    this.dir = join(opts.root ?? 'evidence', opts.runId);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Append one event. Returns it, so callers can log and use in one line. */
  event(
    kind: EventKind,
    message: string,
    data?: Record<string, unknown>,
    stepId?: string,
  ): EvidenceEvent {
    this.#seq += 1;
    const e: EvidenceEvent = {
      seq: this.#seq,
      t: new Date().toISOString(),
      kind,
      message: this.#redactor.redact(message),
      ...(stepId !== undefined ? { stepId } : {}),
      ...(data !== undefined ? { data: this.#redactor.redactValue(data) } : {}),
    };
    this.#events.push(e);
    appendFileSync(join(this.dir, 'run.jsonl'), JSON.stringify(e) + '\n');
    return e;
  }

  get events(): readonly EvidenceEvent[] { return this.#events; }

  /** Writes a JSON document under the run directory. Returns a relative path. */
  json(name: string, value: unknown): string {
    const path = join(this.dir, name);
    mkdirSync(dirOf(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.#redactor.redactValue(value), null, 2));
    return this.rel(path);
  }

  text(name: string, content: string): string {
    const path = join(this.dir, name);
    mkdirSync(dirOf(path), { recursive: true });
    writeFileSync(path, this.#redactor.redact(content));
    return this.rel(path);
  }

  /**
   * Writes an image. Deliberately does NOT redact: by this point the bytes
   * exist and a text filter cannot help. Sensitive regions are masked at
   * capture time in WebSurface.screenshot({ mask }), which is the only place
   * the masking can actually work.
   */
  image(name: string, bytes: Buffer): string {
    const path = join(this.dir, name);
    mkdirSync(dirOf(path), { recursive: true });
    writeFileSync(path, bytes);
    return this.rel(path);
  }

  stepPath(index: number, file: string): string {
    return join('steps', String(index).padStart(2, '0'), file);
  }

  rel(path: string): string {
    return relative(this.dir, path) || path;
  }

  /**
   * Finishes the run: writes the manifest, including what the redactor caught.
   * Reporting redactions is part of the evidence - "nothing was redacted" and
   * "redaction never ran" look identical otherwise.
   */
  close(summary: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#closed = true;
    this.json('manifest.json', {
      runId: this.runId,
      ...this.#meta,
      ...summary,
      events: this.#events.length,
      redaction: {
        registeredValues: this.#redactor.registeredCount,
        hits: this.#redactor.report(),
      },
      writtenAt: new Date().toISOString(),
    });
  }
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'));
}

/** True when a run directory already holds a completed run. */
export function isCompleteRun(dir: string): boolean {
  return existsSync(join(dir, 'manifest.json'));
}
