/**
 * Shared scaffolding for the discovery tests.
 *
 * The browser is faked; everything else is real. Policy, lease, evidence and
 * `Executor.act()` are the actual implementations, because the properties these
 * tests assert are properties of the chokepoint - a stubbed executor would make
 * every one of them vacuous.
 */

import { readFileSync } from 'node:fs';
import { parseAriaSnapshot } from '../../src/surface/web/ariaYaml.ts';
import { flattenToSnapshot } from '../../src/surface/web/toUiNodes.ts';
import { ToolRunner } from '../../src/discovery/tools.ts';
import { Executor } from '../../src/exec/executor.ts';
import { SessionLease } from '../../src/exec/lease.ts';
import { PolicyEngine, DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/policyEngine.ts';
import { EvidenceWriter } from '../../src/evidence/writer.ts';
import { Redactor } from '../../src/core/redact.ts';
import type { Surface, ScreenshotOptions } from '../../src/surface/surface.ts';
import type { UiNode, UiSnapshot } from '../../src/surface/uinode.ts';

/**
 * Each test file gets its own directory. They share a parent, and vitest runs
 * files in parallel, so a shared root means one file's afterAll deletes a
 * directory another file is still writing into.
 */
export const scratchRoot = (name: string): string => `evidence/_scratch/${name}`;

export function snap(name: string): UiSnapshot {
  return flattenToSnapshot(
    parseAriaSnapshot(readFileSync(new URL(`./aria/${name}.yaml`, import.meta.url), 'utf8')),
    { url: 'http://localhost:4400/members/12345', title: name, frameNames: ['contentFrame'] },
  );
}

/** A browser that does nothing, remembers everything, and shows what it is told to. */
export class FakeSurface implements Surface {
  readonly kind = 'web' as const;
  current: UiSnapshot;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(initial: UiSnapshot) { this.current = initial; }

  async observe(): Promise<UiSnapshot> { return this.current; }
  async click(node: UiNode): Promise<void> { this.calls.push({ method: 'click', args: [node.ref] }); }
  async type(node: UiNode, text: string): Promise<void> {
    this.calls.push({ method: 'type', args: [node.ref, text] });
  }
  async select(node: UiNode, option: string): Promise<void> {
    this.calls.push({ method: 'select', args: [node.ref, option] });
  }
  async press(key: string): Promise<void> { this.calls.push({ method: 'press', args: [key] }); }
  async scroll(): Promise<void> { this.calls.push({ method: 'scroll', args: [] }); }
  async navigate(target: string): Promise<void> {
    this.calls.push({ method: 'navigate', args: [target] });
  }
  async readText(node: UiNode): Promise<string> { return node.value ?? node.name; }
  async ariaSubtree(): Promise<string> { return ''; }
  async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> { return Buffer.alloc(0); }
  async currentUrl(): Promise<string> { return this.current.url; }
  async close(): Promise<void> {}
}

export interface Harness {
  surface: FakeSurface;
  runner: ToolRunner;
  evidence: EvidenceWriter;
}

export function buildHarness(opts: {
  policy?: Partial<PolicyConfig>;
  params?: Record<string, unknown>;
  secrets?: string[];
  fixture?: string;
  root?: string;
} = {}): Harness {
  const surface = new FakeSurface(snap(opts.fixture ?? 'member-detail'));
  const evidence = new EvidenceWriter({
    runId: `disco-${Math.random().toString(36).slice(2, 8)}`,
    root: opts.root ?? scratchRoot('discovery-tests'),
    redactor: new Redactor(),
  });
  const executor = new Executor({
    surface,
    policy: new PolicyEngine({
      ...DEFAULT_POLICY,
      allowedOrigins: ['http://localhost:4400'],
      ...opts.policy,
    }),
    lease: new SessionLease(evidence.runId),
    evidence,
  });
  const runner = new ToolRunner({
    executor,
    surface,
    evidence,
    params: opts.params ?? {},
    secretParams: opts.secrets ?? [],
  });
  return { surface, runner, evidence };
}
