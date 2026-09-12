import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityArtifact } from '../../src/core/schema.ts';
import { withIntegrity } from '../../src/core/integrity.ts';
import { minimalArtifact } from '../fixtures/minimalArtifact.ts';
import { runApproveCommand } from '../../src/cli/approveCommand.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cua-approve-'));
  path = join(dir, 'artifact.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(overrides: Parameters<typeof minimalArtifact>[0] = {}): void {
  const artifact = withIntegrity(CapabilityArtifact.parse(minimalArtifact(overrides)));
  writeFileSync(path, JSON.stringify(artifact, null, 2));
}

describe('cua approve', () => {
  it('moves a draft artifact to approved and re-signs it', async () => {
    write({ status: 'draft' });
    const before = CapabilityArtifact.parse(JSON.parse(readFileSync(path, 'utf8')));

    const code = await runApproveCommand({ artifactPath: path });

    expect(code).toBe(0);
    const after = CapabilityArtifact.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(after.status).toBe('approved');
    expect(after.integrity?.hash).not.toBe(before.integrity?.hash);
  });

  it('is idempotent on an already-approved artifact', async () => {
    write({ status: 'approved' });
    const code = await runApproveCommand({ artifactPath: path });
    expect(code).toBe(0);
    const after = CapabilityArtifact.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(after.status).toBe('approved');
  });

  it('refuses a deprecated artifact', async () => {
    write({ status: 'deprecated' });
    const code = await runApproveCommand({ artifactPath: path });
    expect(code).not.toBe(0);
    const after = CapabilityArtifact.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(after.status).toBe('deprecated');
  });

  it('refuses an artifact that does not match its recorded hash', async () => {
    write({ status: 'draft' });
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as { title: string };
    tampered.title = 'a different title, hash unchanged';
    writeFileSync(path, JSON.stringify(tampered));

    const code = await runApproveCommand({ artifactPath: path });

    expect(code).not.toBe(0);
    const after = JSON.parse(readFileSync(path, 'utf8')) as { status: string };
    expect(after.status).toBe('draft'); // untouched - refusing means refusing to write
  });

  it('refuses something that is not a valid capability artifact at all', async () => {
    writeFileSync(path, JSON.stringify({ not: 'an artifact' }));
    const code = await runApproveCommand({ artifactPath: path });
    expect(code).not.toBe(0);
  });
});
