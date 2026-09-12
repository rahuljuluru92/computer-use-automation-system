/**
 * `npm run demo:stretch` - "show one being invoked."
 *
 * Quarantined from the core demo path on purpose (the plan's own rule: no
 * stretch goal may appear in scripts/demo.sh or the README's primary demo).
 * This script IS the calling agent for the purpose of the demo: a real MCP
 * `Client` talks real JSON-RPC over stdio to a real `cua mcp` child process,
 * which serves the approved capability by running the exact same `replay()`
 * path `cua replay` uses from a terminal. Nothing here is a model - see
 * ADR-0003 and tests/determinism/no-llm-on-replay-path.test.ts, which now
 * also guards src/mcp.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function line(): void { console.log('-'.repeat(72)); }

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/cli/index.ts', 'mcp'],
    cwd: process.cwd(),
    env,
  });
  const client = new Client({ name: 'demo-stretch-agent', version: '1.0.0' });
  await client.connect(transport);

  try {
    line();
    console.log('tools/list - the approved-capability catalog:');
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`  ${t.name}  -  ${t.description}`);

    line();
    console.log('tools/call  cap.member.read_savings_balance  { memberId: "12345" }');
    const ok = await client.callTool({
      name: 'cap.member.read_savings_balance', arguments: { memberId: '12345' },
    });
    console.log(`  isError: ${Boolean(ok.isError)}`);
    console.log(`  structuredContent: ${JSON.stringify(ok.structuredContent)}`);

    line();
    console.log('tools/call  cap.member.read_savings_balance  { memberId: "99999" }  (a bad id)');
    console.log('  Note: this artifact is the real, model-discovered one (Phase 4) - the model');
    console.log('  only ever walked the happy path in its one discovery run, so it declared no');
    console.log('  business outcomes (decision #114). A bad id therefore surfaces as a typed,');
    console.log('  bounded `failed` here, not a business outcome - which is still the point:');
    console.log('  a structured refusal over MCP, never a thrown exception. The hand-authored');
    console.log('  reference artifact DOES declare "no_such_member" as a business outcome -');
    console.log('  see tests/integration/mcp.test.ts and REPORT.md ("Cuts") for that case.');
    const outcome = await client.callTool({
      name: 'cap.member.read_savings_balance', arguments: { memberId: '99999' },
    });
    console.log(`  isError: ${Boolean(outcome.isError)}`);
    console.log(`  ${(outcome.content as Array<{ text?: string }>)[0]?.text}`);

    line();
    console.log('tools/call  cap.nonexistent.made_up  (nothing this name refers to is approved)');
    const refused = await client.callTool({ name: 'cap.nonexistent.made_up', arguments: {} });
    console.log(`  isError: ${Boolean(refused.isError)}`);
    console.log(`  ${(refused.content as Array<{ text?: string }>)[0]?.text}`);

    line();
    console.log('tools/call  capability.evidence  { id: "cap.member.read_savings_balance" }');
    const evidence = await client.callTool({
      name: 'capability.evidence', arguments: { id: 'cap.member.read_savings_balance' },
    });
    console.log(`  ${(evidence.content as Array<{ text?: string }>)[0]?.text}`);
    line();
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
