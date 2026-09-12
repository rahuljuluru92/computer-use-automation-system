#!/usr/bin/env node
/**
 * cua - the one entry point.
 *
 * Commands map one-to-one onto the lifecycle of a capability:
 *
 *   discover  a goal + a target      -> a self-verified artifact   (needs a model)
 *   replay    an artifact + inputs   -> a typed result             (needs NO model)
 *   explain   an artifact            -> prose a human can review
 *   approve   an artifact            -> cleared for unattended use
 *   operator  the escalation console
 *   mcp       serve approved capabilities to a calling agent
 *
 * Argument parsing is node:util's parseArgs. A CLI framework would be three
 * dependencies to save thirty lines.
 */

import { parseArgs } from 'node:util';
import * as z from 'zod';
import { CapabilityArtifact } from '../core/schema.ts';
import { ReplayResult } from '../core/result.ts';
import { loadDotEnv } from '../core/dotenv.ts';

const COMMANDS = ['discover', 'replay', 'explain', 'approve', 'operator', 'mcp'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `
cua - computer-use capability system

  cua discover --goal <text> --target <url> [--input <json>] [--id <cap.x.y>]
               [--version <semver>] [--model <id>] [--max-steps <n>] [--max-wall-clock-ms <ms>]
      Drive a live surface with a model until the goal is met, then compile and
      self-verify a capability artifact. Requires ANTHROPIC_API_KEY.
      Writes nothing unless the compiled artifact replays successfully.
      Default budget: 40 turns or 5 minutes, whichever comes first - an
      unfamiliar site the model has to explore may need more of either.

  cua replay --artifact <path> [--input <json>] [--tenant <id>] [--chaos <mode>] [--label <name>]
             [--operator <url>]
      Execute a saved artifact deterministically. Never calls a model.
      --label names the evidence directory, so a demo run is findable later.
      --operator routes escalations to a running console, and runs headed so a
      human can actually be handed the session. Without it, a run that gets
      stuck fails cleanly and says there was nobody to ask.

  cua explain --artifact <path>
      Render an artifact as reviewable prose.
  cua explain --schema [--result]
      Print the JSON Schema for the capability contract (or the result contract).

  cua approve --artifact <path>
      Move draft -> approved. Required before unattended invocation over MCP.

  cua operator [--port <n>] [--timeout <ms>]
      The escalation console. Start it before a run that might need a human.
      Loopback only. --timeout is how long an intervention tolerates silence
      before the run abandons; any operator activity resets it.
  cua mcp                          Serve approved capabilities over MCP (stdio).
`;

function fail(message: string): never {
  console.error(`error: ${message}\n${USAGE}`);
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE.trim());
    return 0;
  }
  if (!COMMANDS.includes(command as Command)) fail(`unknown command "${command}"`);

  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      goal: { type: 'string' },
      target: { type: 'string' },
      artifact: { type: 'string' },
      input: { type: 'string' },
      tenant: { type: 'string' },
      chaos: { type: 'string' },
      label: { type: 'string' },
      port: { type: 'string' },
      operator: { type: 'string' },
      timeout: { type: 'string' },
      'max-steps': { type: 'string' },
      'max-wall-clock-ms': { type: 'string' },
      id: { type: 'string' },
      version: { type: 'string' },
      model: { type: 'string' },
      schema: { type: 'boolean' },
      result: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) { console.log(USAGE.trim()); return 0; }

  switch (command as Command) {
    case 'explain': {
      if (values.schema) {
        const schema = values.result
          ? z.toJSONSchema(ReplayResult, { io: 'output' })
          : z.toJSONSchema(CapabilityArtifact, { io: 'input' });
        console.log(JSON.stringify(schema, null, 2));
        return 0;
      }
      if (!values.artifact) fail('explain needs --artifact <path> or --schema');
      const { explainArtifact } = await import('../capability/explain.ts');
      console.log(await explainArtifact(values.artifact));
      return 0;
    }

    case 'replay': {
      if (!values.artifact) fail('replay needs --artifact <path>');
      const { runReplayCommand } = await import('./replayCommand.ts');
      return runReplayCommand({
        artifactPath: values.artifact,
        inputJson: values.input ?? '{}',
        tenant: values.tenant,
        chaos: values.chaos,
        label: values.label,
        operator: values.operator,
        json: values.json ?? false,
      });
    }

    case 'operator': {
      const { runOperatorCommand } = await import('./operatorCommand.ts');
      return runOperatorCommand({
        port: values.port ? Number(values.port) : undefined,
        timeoutMs: values.timeout ? Number(values.timeout) : undefined,
      });
    }

    case 'discover': {
      if (!values.goal) fail('discover needs --goal <text>');
      if (!values.target) fail('discover needs --target <url>');
      const { runDiscoverCommand } = await import('./discoverCommand.ts');
      return runDiscoverCommand({
        goal: values.goal,
        target: values.target,
        inputJson: values.input ?? '{}',
        id: values.id,
        version: values.version,
        model: values.model,
        maxTurns: values['max-steps'] ? Number(values['max-steps']) : undefined,
        maxWallClockMs: values['max-wall-clock-ms'] ? Number(values['max-wall-clock-ms']) : undefined,
        label: values.label,
        json: values.json ?? false,
      });
    }

    case 'approve': {
      if (!values.artifact) fail('approve needs --artifact <path>');
      const { runApproveCommand } = await import('./approveCommand.ts');
      return runApproveCommand({ artifactPath: values.artifact });
    }

    case 'mcp': {
      const { buildMcpServer } = await import('../mcp/server.ts');
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const server = buildMcpServer();
      const transport = new StdioServerTransport();
      // stdout is the JSON-RPC channel; every human-readable line goes to stderr.
      transport.onclose = () => process.exit(0);
      await server.connect(transport);
      console.error('cua mcp: serving approved capabilities over stdio (Ctrl+C to stop)');
      return new Promise<number>(() => {}); // the transport owns the process lifetime now
    }
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
