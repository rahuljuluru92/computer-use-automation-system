import { randomUUID } from 'node:crypto';

/** Run ids sort chronologically as filenames, which matters when reading evidence/. */
export function newRunId(kind: 'discovery' | 'replay' | 'verify' | 'mcp'): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${ts}-${kind}-${randomUUID().slice(0, 8)}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
