/**
 * `cua mcp` - approved capabilities served as a tool an AI agent can call.
 *
 * The brief's stretch goal #1: "expose saved artifacts as a catalog of
 * callable capabilities ... and show one being invoked." This is not a new
 * execution path - every `tools/call` is `replay()`, the exact production
 * path `cua replay` drives from a terminal, with the same policy engine,
 * evidence writer and redaction. The only new thing here is the transport.
 *
 * `tools/list` is a map over the approved subset of the artifact registry:
 * the artifact already carries JSON Schema for its inputs and outputs
 * (decision #7), so there is nothing to translate - `Tool.inputSchema` on the
 * wire and `CapabilityArtifact.inputs` on disk are the same shape by
 * construction. `tools/call` refuses anything not `approved`: a draft or
 * candidate artifact does not exist as far as an unattended caller is
 * concerned, which is the entire safety argument for the status field.
 *
 * ADR-0003 (replay never calls a model) applies here exactly as it does to
 * `cua replay` - this module imports no model SDK and calls nothing but
 * `replay()`. Serving a capability over MCP does not reopen the decision
 * loop; it is still deterministic replay, wearing a different transport.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  type Tool, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSurface } from '../surface/web/webSurface.ts';
import { PolicyEngine } from '../policy/policyEngine.ts';
import { loadPolicy } from '../policy/loadPolicy.ts';
import { SecretResolver, applyDemoCredentialDefaults } from '../policy/secrets.ts';
import { EvidenceWriter } from '../evidence/writer.ts';
import { buildRedactor } from '../core/redact.ts';
import { newRunId } from '../core/ids.ts';
import { replay } from '../replay/replay.ts';
import type { ReplayResult } from '../core/result.ts';
import { explainArtifact } from '../capability/explain.ts';
import { loadApprovedCatalog, loadAnyArtifact, type CatalogEntry } from './catalog.ts';

const DESCRIBE_TOOL = 'capability.describe';
const EVIDENCE_TOOL = 'capability.evidence';

export interface McpServerOptions {
  artifactsDir?: string;
  evidenceDir?: string;
  baseUrl?: string;
  /** Defaults to `loadPolicy()` - the same config `cua replay` uses. Tests inject one scoped to an ephemeral port. */
  policy?: PolicyEngine;
}

/**
 * The tool's `outputSchema` must be one fixed shape the client can validate
 * every response against - but a capability answers in more than one way
 * (success, or a declared business outcome), and those two are different
 * shapes on purpose (the same reasoning as `ReplayResult`'s discriminated
 * union). So the wire contract is an envelope: `status` plus whichever of
 * `outputs` (the artifact's real, typed success schema - not narrowed away)
 * or `outcome` (loosely shaped; outcomes are declared by code and
 * description, not a per-code data schema) is present. Advertising the raw
 * success schema alone would make a business-outcome response fail the
 * client's own validation - caught by this file's own integration test.
 */
function toolFor(entry: CatalogEntry): Tool {
  return {
    name: entry.artifact.id,
    description: `${entry.artifact.description} (v${entry.artifact.version})`,
    inputSchema: entry.artifact.inputs,
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        outputs: entry.artifact.outputs,
        outcome: { type: 'object' },
      },
      required: ['status'],
    },
  };
}

function idArg(args: unknown): string | undefined {
  return typeof args === 'object' && args !== null && 'id' in args
    ? String((args as { id: unknown }).id)
    : undefined;
}

function refuse(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Builds the server. Callers choose the transport (stdio for the CLI, in-memory for tests). */
export function buildMcpServer(opts: McpServerOptions = {}): Server {
  const artifactsDir = opts.artifactsDir ?? 'artifacts';
  const evidenceDir = opts.evidenceDir ?? 'evidence';
  const baseUrl = opts.baseUrl ?? process.env.MERIDIAN_BASE_URL ?? 'http://localhost:4400';
  const policy = opts.policy ?? new PolicyEngine(loadPolicy());

  const server = new Server(
    { name: 'cua-capability-catalog', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const catalog = await loadApprovedCatalog(artifactsDir);
    const tools: Tool[] = [
      ...catalog.map(toolFor),
      {
        name: DESCRIBE_TOOL,
        description: 'Render an approved capability as reviewable prose: what it does, needs, and returns.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: EVIDENCE_TOOL,
        description: 'List recent evidence runs recorded for an approved capability.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    ];
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === DESCRIBE_TOOL) return describeCapability(artifactsDir, args);
    if (name === EVIDENCE_TOOL) return evidenceForCapability(evidenceDir, args);

    const catalog = await loadApprovedCatalog(artifactsDir);
    const entry = catalog.find((e) => e.artifact.id === name);
    if (!entry) {
      const anyMatch = await loadAnyArtifact(artifactsDir, name);
      return refuse(anyMatch
        ? `blocked_by_policy: "${name}" exists but is not approved (status: ${anyMatch.status}) `
          + `- it cannot be invoked unattended. Run: cua approve --artifact <path>`
        : `blocked_by_policy: no approved capability named "${name}".`);
    }

    return invokeCapability(entry, (args ?? {}) as Record<string, unknown>, baseUrl, evidenceDir, policy);
  });

  return server;
}

async function invokeCapability(
  entry: CatalogEntry,
  inputs: Record<string, unknown>,
  baseUrl: string,
  evidenceRoot: string,
  policy: PolicyEngine,
): Promise<CallToolResult> {
  await applyDemoCredentialDefaults();
  const redactor = buildRedactor({
    secrets: {
      MERIDIAN_PASSWORD: process.env.MERIDIAN_PASSWORD,
      MERIDIAN_USERNAME: process.env.MERIDIAN_USERNAME,
    },
  });
  const evidence = new EvidenceWriter({
    runId: newRunId('mcp'),
    root: evidenceRoot,
    redactor,
    meta: { capability: entry.artifact.id, version: entry.artifact.version, via: 'mcp' },
  });
  const surface = await WebSurface.launch({ headless: true });
  try {
    const result = await replay({
      artifact: entry.artifact,
      inputs,
      surface,
      policy,
      evidence,
      secrets: new SecretResolver(redactor),
      baseUrl,
    });
    return toCallToolResult(result);
  } finally {
    await surface.close();
  }
}

/**
 * Business outcome and success both come back `isError: false` - the same
 * reasoning that keeps `business_outcome` out of `failed` in `ReplayResult`
 * and exits the CLI 0. A calling agent that cannot tell "no such member" from
 * a crash will retry a legitimate answer as if it were a bug.
 */
function toCallToolResult(result: ReplayResult): CallToolResult {
  switch (result.status) {
    case 'success':
      return {
        content: [{ type: 'text', text: `success: ${JSON.stringify(result.outputs)}` }],
        structuredContent: { status: 'success', outputs: result.outputs },
      };
    case 'business_outcome':
      return {
        content: [{ type: 'text',
          text: `business_outcome: ${result.outcome.code} - ${result.outcome.description}` }],
        structuredContent: { status: 'business_outcome',
          outcome: { code: result.outcome.code, description: result.outcome.description, ...result.outcome.data } },
      };
    case 'escalated':
      if (result.outputs) {
        return {
          content: [{ type: 'text', text: `escalated, then completed: ${JSON.stringify(result.outputs)}` }],
          structuredContent: { status: 'escalated', outputs: result.outputs },
        };
      }
      return refuse(
        `escalated: ${result.escalation.reason} - ${result.escalation.detail}. `
        + `No operator console was reachable from this MCP call, so the run could not be handed over.`,
      );
    case 'failed':
      return refuse(`failed: ${result.failure.code} - ${result.failure.message}`);
    case 'blocked_by_policy':
      return refuse(`blocked_by_policy: ${result.policy.rule} - ${result.policy.reason}`);
  }
}

async function describeCapability(artifactsDir: string, args: unknown): Promise<CallToolResult> {
  const id = idArg(args);
  if (!id) return refuse('capability.describe needs { id }');
  const catalog = await loadApprovedCatalog(artifactsDir);
  const entry = catalog.find((e) => e.artifact.id === id);
  if (!entry) return refuse(`blocked_by_policy: no approved capability named "${id}".`);
  return { content: [{ type: 'text', text: await explainArtifact(entry.path) }] };
}

async function evidenceForCapability(evidenceRoot: string, args: unknown): Promise<CallToolResult> {
  const id = idArg(args);
  if (!id) return refuse('capability.evidence needs { id }');

  let runIds: string[];
  try {
    runIds = await readdir(evidenceRoot);
  } catch {
    runIds = [];
  }

  const runs: Array<{ runId: string; status: unknown; writtenAt: unknown; report: string }> = [];
  for (const runId of runIds) {
    try {
      const manifest = JSON.parse(
        await readFile(join(evidenceRoot, runId, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      if (manifest.capability === id) {
        runs.push({
          runId, status: manifest.status, writtenAt: manifest.writtenAt,
          report: join(evidenceRoot, runId, 'report.html'),
        });
      }
    } catch {
      continue;
    }
  }
  runs.sort((a, b) => String(b.writtenAt).localeCompare(String(a.writtenAt)));

  return {
    content: [{ type: 'text', text: runs.length
      ? `${runs.length} run(s) for ${id}:\n${runs.map((r) => `  ${r.runId}  ${r.status}  ${r.report}`).join('\n')}`
      : `no evidence recorded yet for ${id}.` }],
    structuredContent: { runs },
  };
}
