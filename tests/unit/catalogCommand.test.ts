import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityArtifact } from '../../src/core/schema.ts';
import { withIntegrity } from '../../src/core/integrity.ts';
import { minimalArtifact } from '../fixtures/minimalArtifact.ts';
import { runCatalogCommand } from '../../src/cli/catalogCommand.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cua-catalog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, overrides: Parameters<typeof minimalArtifact>[0] = {}): void {
  const artifact = withIntegrity(CapabilityArtifact.parse(minimalArtifact(overrides)));
  writeFileSync(join(dir, name), JSON.stringify(artifact, null, 2));
}

describe('cua catalog', () => {
  it('lists only approved artifacts, the same filter cua mcp applies', async () => {
    write('draft.json', { id: 'cap.x.draft', status: 'draft' });
    write('approved.json', { id: 'cap.x.approved', status: 'approved' });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
    try {
      await runCatalogCommand({ artifactsDir: dir, json: true });
    } finally {
      vi.restoreAllMocks();
    }

    const printed = JSON.parse(logs.join('')) as Array<{ id: string }>;
    expect(printed.map((e) => e.id)).toEqual(['cap.x.approved']);
  });

  it('says plainly when nothing is approved yet, rather than printing an empty table', async () => {
    write('draft.json', { id: 'cap.x.draft', status: 'draft' });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
    try {
      await runCatalogCommand({ artifactsDir: dir, json: false });
    } finally {
      vi.restoreAllMocks();
    }

    expect(logs.join('\n')).toMatch(/No approved capabilities/);
  });

  it('reports the fields a reviewer would want at a glance', async () => {
    write('approved.json', {
      id: 'cap.x.approved', status: 'approved',
      tenancy: { canonical: true, overlays: { summitcu: {} } },
    });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
    try {
      await runCatalogCommand({ artifactsDir: dir, json: true });
    } finally {
      vi.restoreAllMocks();
    }

    const [entry] = JSON.parse(logs.join('')) as Array<{ tenantOverlays: string[]; actionClasses: string[] }>;
    expect(entry!.tenantOverlays).toEqual(['summitcu']);
    expect(entry!.actionClasses).toContain('read');
  });
});
