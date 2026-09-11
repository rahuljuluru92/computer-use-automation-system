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
import { existsSync } from 'node:fs';
import * as z from 'zod';
import { CapabilityArtifact } from '../core/schema.ts';
import { ReplayResult } from '../core/result.ts';

const COMMANDS = ['discover', 'replay', 'explain', 'approve', 'operator', 'mcp'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `
cua - computer-use capability system

  cua discover --goal <text> --target <url> [--input <json>] [--id <cap.x.y>]
               [--version <semver>] [--model <id>] [--max-steps <n>]
      Drive a live surface with a model until the goal is met, then compile and
      self-verify a capability artifact. Requires ANTHROPIC_API_KEY.
      Writes nothing unless the compiled artifact replays successfully.

  cua replay --artifact <path> [--input <json>] [--tenant <id>] [--chaos <mode>] [--label <name>]
      Execute a saved artifact deterministically. Never calls a model.
      --label names the evidence directory, so a demo run is findable later.

  cua explain --artifact <path>
      Render an artifact as reviewable prose.
  cua explain --schema [--result]
      Print the JSON Schema for the capability contract (or the result contract).

  cua approve --artifact <path>
      Move draft -> approved. Required before unattended invocation over MCP.

  cua operator [--port <n>]        Escalation console.
  cua mcp                          Serve approved capabilities over MCP (stdio).
`;

/**
 * Load `.env` if there is one.
 *
 * `.env.example` has documented an ANTHROPIC_API_KEY line since Phase 0 and
 * nothing ever read it, so anyone following the README put their key in a file
 * the process ignored and got an authentication error for their trouble.
 *
 * Real environment variables win: `process.loadEnvFile` does not overwrite what
 * is already set, so an exported key or a CI secret still takes precedence over
 * a stale file on a laptop.
 */
function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  try {
    process.loadEnvFile('.env');
  } catch {
    // A malformed .env should not stop `replay`, which needs no secrets at all.
  }
}

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
      'max-steps': { type: 'string' },
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
        json: values.json ?? false,
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
        label: values.label,
        json: values.json ?? false,
      });
    }

    // Phases 5-6. Each is wired to its module as that phase lands; the CLI
    // surface is fixed now so the README's demo path never has to change.
    case 'approve':
    case 'operator':
    case 'mcp':
      console.error(`"${command}" is not implemented yet.`);
      return 70; // EX_SOFTWARE
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
