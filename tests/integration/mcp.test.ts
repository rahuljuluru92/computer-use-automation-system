/**
 * The P6 gate, verbatim: "Claude invokes the capability over MCP and receives
 * `{savingsBalance: ...}`; a bad member id returns the business outcome, not
 * an exception; an unapproved artifact is refused."
 *
 * A real MCP `Client` and `Server` talk real JSON-RPC over `InMemoryTransport`
 * - the wire format is exactly what a calling agent would send; only the pipe
 * is in-process. Every `tools/call` below runs the real `replay()` path
 * against the real Meridian app in a real (headless) browser. Nothing here is
 * mocked except the transport, and the transport is not the thing being
 * tested.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../../apps/meridian-core/server.ts';
import { OPERATOR } from '../../apps/meridian-core/data/seed.ts';
import { withIntegrity } from '../../src/core/integrity.ts';
import { PolicyEngine, DEFAULT_POLICY } from '../../src/policy/policyEngine.ts';
import { seedArtifact } from '../fixtures/seedArtifact.ts';
import { buildMcpServer } from '../../src/mcp/server.ts';

type TextBlock = { type: 'text'; text: string };

const EVIDENCE_ROOT = 'evidence/_test_mcp';

let httpServer: HttpServer;
let base: string;
let artifactsDir: string;
let client: Client;

beforeAll(async () => {
  process.env.MERIDIAN_USERNAME = OPERATOR.username;
  process.env.MERIDIAN_PASSWORD = OPERATOR.password;

  await new Promise<void>((resolve) => {
    httpServer = createApp().listen(0, () => {
      const a = httpServer.address();
      base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
      resolve();
    });
  });

  artifactsDir = mkdtempSync(join(tmpdir(), 'cua-mcp-artifacts-'));

  const approved = withIntegrity({ ...seedArtifact(), status: 'approved' as const });
  writeFileSync(join(artifactsDir, 'approved.json'), JSON.stringify(approved, null, 2));

  // A second, unapproved capability - proves exclusion from the catalog and a
  // named refusal, rather than only testing the happy path.
  const draft = withIntegrity({
    ...seedArtifact(),
    id: 'cap.member.other_draft_capability',
    status: 'draft' as const,
  });
  writeFileSync(join(artifactsDir, 'draft.json'), JSON.stringify(draft, null, 2));

  const mcpServer = buildMcpServer({
    artifactsDir,
    evidenceDir: EVIDENCE_ROOT,
    baseUrl: base,
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [base] }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
}, 60_000);

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rmSync(artifactsDir, { recursive: true, force: true });
  rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
});

function firstText(content: unknown): string {
  return (content as TextBlock[])[0]?.text ?? '';
}

describe('cua mcp: the capability catalog', () => {
  it('lists only the approved capability, carrying its real input/output schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('cap.member.read_savings_balance');
    expect(names).not.toContain('cap.member.other_draft_capability');
    expect(names).toContain('capability.describe');
    expect(names).toContain('capability.evidence');

    const tool = tools.find((t) => t.name === 'cap.member.read_savings_balance');
    expect(tool?.inputSchema).toMatchObject({ type: 'object' });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('memberId');
  });

  it('invokes the capability and receives typed outputs', async () => {
    const result = await client.callTool({
      name: 'cap.member.read_savings_balance',
      arguments: { memberId: '12345' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'success', outputs: { savingsBalance: 4210.55 },
    });
  }, 30_000);

  it('returns a bad member id as a business outcome, not an exception', async () => {
    const result = await client.callTool({
      name: 'cap.member.read_savings_balance',
      arguments: { memberId: '99999' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'business_outcome', outcome: { code: 'no_such_member' },
    });
  }, 30_000);

  it('refuses to invoke a capability that exists but is not approved', async () => {
    const result = await client.callTool({
      name: 'cap.member.other_draft_capability',
      arguments: { memberId: '12345' },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result.content)).toContain('not approved');
  });

  it('refuses a capability name that does not exist at all', async () => {
    const result = await client.callTool({ name: 'cap.nonexistent.made_up', arguments: {} });

    expect(result.isError).toBe(true);
    expect(firstText(result.content)).toContain('no approved capability');
  });

  it('describes the approved capability as reviewable prose', async () => {
    const result = await client.callTool({
      name: 'capability.describe',
      arguments: { id: 'cap.member.read_savings_balance' },
    });

    expect(result.isError).toBeFalsy();
    expect(firstText(result.content)).toContain('cap.member.read_savings_balance');
  });

  it('reports the evidence produced by the calls above', async () => {
    const result = await client.callTool({
      name: 'capability.evidence',
      arguments: { id: 'cap.member.read_savings_balance' },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
  });
});
