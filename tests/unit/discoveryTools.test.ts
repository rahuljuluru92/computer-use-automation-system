/**
 * The tool surface handed to the model.
 *
 * These tests are about what the model *cannot* do. They run against the real
 * Executor - real policy, real lease, real evidence - with only the browser
 * faked, because the guarantees being asserted are guarantees of the chokepoint
 * and would be worth nothing if a stub stood in for it.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { runStrategy } from '../../src/surface/locator/strategies.ts';
import { DISCOVERY_TOOLS, type ToolRunner } from '../../src/discovery/tools.ts';
import type { PolicyConfig } from '../../src/policy/policyEngine.ts';
import type { UiSnapshot } from '../../src/surface/uinode.ts';
import {
  buildHarness, snap, scratchRoot, type FakeSurface,
} from '../fixtures/discoveryHarness.ts';

const ROOT = scratchRoot('discovery-tools');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let surface: FakeSurface;
let runner: ToolRunner;

function build(
  policy: Partial<PolicyConfig> = {},
  params: Record<string, unknown> = {},
  secrets: string[] = [],
): void {
  const h = buildHarness({ policy, params, secrets, root: ROOT });
  surface = h.surface;
  runner = h.runner;
}

beforeEach(() => build());

/** The View link on the Savings row, as the model would be shown it. */
const savingsView = (obs: number) => `o${obs}#f3e44`;

describe('the shape of the tool surface is the security argument', () => {
  it('offers no way to express a selector', () => {
    // Invariant #2, as a test rather than a comment. If a future tool grows a
    // selector parameter, this fails - which is the only reliable way to keep
    // a promise about something that does not exist.
    const forbidden = /css|xpath|selector|queryselector|coordinate|\bx\b.*\by\b/i;
    for (const tool of DISCOVERY_TOOLS) {
      for (const [name, schema] of Object.entries(tool.input_schema.properties)) {
        expect(name, `${tool.name}.${name}`).not.toMatch(forbidden);
        const described = JSON.stringify(schema);
        expect(described, `${tool.name}.${name} description`).not.toMatch(forbidden);
      }
    }
  });

  it('offers a way to hand back to a human, and a way to say a task is impossible', () => {
    const names = DISCOVERY_TOOLS.map((t) => t.name);
    expect(names).toContain('request_human');
    expect(names).toContain('give_up');
    expect(names).toContain('declare_outcome');
  });
});

describe('refs', () => {
  it('will not act before anything has been observed', async () => {
    const r = await runner.run('click', { ref: 'o1#f3e44', intent: 'click something' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/observe first/i);
  });

  it('answers a hallucinated ref with the refs that do exist', async () => {
    await runner.run('observe', {});
    const r = await runner.run('click', { ref: 'o1#nonexistent', intent: 'click the thing' });

    expect(r.ok).toBe(false);
    // The correction has to carry the real options, or the next turn is another
    // guess. A thrown error would have ended the run instead.
    expect(r.text).toMatch(/No control/);
    expect(r.text).toMatch(/Open Sub-Account|View|Sign Out/);
  });

  it('rejects a ref that is not shaped like a ref', async () => {
    await runner.run('observe', {});
    const r = await runner.run('click', { ref: 'the View link', intent: 'view savings' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/is not a ref/);
  });

  it('refuses a ref from an earlier observation', async () => {
    // Decision #34, and the reason refs carry their observation number. A node
    // captured on one screen, then used after the screen moved, once clicked
    // the identically-named control belonging to a different customer.
    await runner.run('observe', {});
    const stale = savingsView(runner.observationCount);

    const acted = await runner.run('click', { ref: stale, intent: 'open the savings account' });
    expect(acted.ok).toBe(true);

    const reused = await runner.run('click', { ref: stale, intent: 'click it again' });
    expect(reused.ok).toBe(false);
    expect(reused.text).toMatch(/from observation 1/);
    expect(reused.text).toMatch(/observe again|Use a ref from the observation above/);
  });

  it('counts an action as an observation, so the model is never shown a stale screen', async () => {
    await runner.run('observe', {});
    expect(runner.observationCount).toBe(1);
    await runner.run('click', { ref: savingsView(1), intent: 'open the savings account' });
    expect(runner.observationCount).toBe(2);
  });
});

describe('what a recorded step contains', () => {
  it('acts through a synthesised bundle, so the recording is what actually drove the browser', async () => {
    await runner.run('observe', {});
    await runner.run('click', { ref: savingsView(1), intent: 'open the savings account' });

    const step = runner.steps[0]!;
    expect(step.target).toBeDefined();
    expect(surface.calls).toContainEqual({ method: 'click', args: ['f3e44'] });

    // Invariant #3: every strategy in the recorded bundle resolves, in the
    // snapshot it was recorded against, to the node that was clicked.
    const recorded = snap('member-detail');
    const clicked = recorded.nodes.find((n) => n.ref === 'f3e44')!;
    for (const st of step.target!.strategies) {
      const r = runStrategy(st.strategy, recorded, {});
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]).toBe(clicked);
    }
  });

  it('classifies the action itself rather than believing the model', async () => {
    await runner.run('observe', {});
    await runner.run('click', { ref: savingsView(1), intent: 'open the savings account' });
    expect(runner.steps[0]!.actionClass).toBe('read');
  });

  it('records the input reference, never the value it stood for', async () => {
    build({}, { memberId: '12345' });
    await runner.run('observe', {});
    // f3e12 is the cell holding 12345; any node will do, the point is the value.
    await runner.run('type', {
      ref: 'o1#f3e12', text: '$input.memberId', intent: 'enter the member id',
    });

    // The browser got the real value...
    expect(surface.calls).toContainEqual({ method: 'type', args: ['f3e12', '12345'] });
    // ...and the recording kept the reference, which is what makes one
    // recording work for every member.
    expect(runner.steps[0]!.data).toEqual({ value: '$input.memberId', sensitivity: 'none' });
  });

  it('marks a secret input as secret and never echoes it', async () => {
    build({}, { password: 'hunter2-correct-horse' }, ['password']);
    await runner.run('observe', {});
    const r = await runner.run('type', {
      ref: 'o1#f3e12', text: '$input.password', intent: 'enter the operator password',
    });

    expect(runner.steps[0]!.data?.sensitivity).toBe('secret');
    expect(r.text).not.toContain('hunter2-correct-horse');
    expect(JSON.stringify(runner.steps)).not.toContain('hunter2-correct-horse');
  });

  it('records a checkpoint against the step whose screen it proves', async () => {
    await runner.run('observe', {});
    await runner.run('click', { ref: savingsView(1), intent: 'open the savings account' });
    const r = await runner.run('assert', {
      ref: `o${runner.observationCount}#f3e64`,
      expect_text: 'Open Sub-Account',
      intent: 'the account screen is showing',
    });

    expect(r.ok).toBe(true);
    expect(runner.steps).toHaveLength(1);
    expect(runner.steps[0]!.checkpoint).toHaveLength(1);
    expect(runner.steps[0]!.checkpoint[0]!.kind).toBe('text_matches');
  });

  it('records an extraction as a typed output', async () => {
    await runner.run('observe', {});
    const r = await runner.run('extract', {
      ref: 'o1#f3e42', name: 'savingsBalance', as: 'currency',
      intent: 'read the savings balance',
    });

    expect(r.ok).toBe(true);
    const spec = runner.steps[0]!.extract[0]!;
    expect(spec.name).toBe('savingsBalance');
    expect(spec.parse.kind).toBe('currency');
  });
});

describe('refusals are explained, not merely returned', () => {
  it('tells the model not to route around a policy denial', async () => {
    build({ denyLabels: ['Sign Out'] });
    await runner.run('observe', {});
    const r = await runner.run('click', { ref: 'o1#f2e9', intent: 'sign out' });

    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Policy refuses/);
    expect(r.text).toMatch(/do not try another route/i);
    // A refused action is not a recorded step.
    expect(runner.steps).toHaveLength(0);
  });

  it('says plainly when a control cannot be described for replay', async () => {
    // A node with nothing durable about it: no name, no row, no label.
    const bare: UiSnapshot = {
      url: 'http://localhost:4400/x', title: 't', structureHash: 'h',
      capturedAt: new Date(0).toISOString(), truncatedNodes: 0,
      nodes: [{
        ref: 'e1', role: 'generic', name: '', state: {}, frameChain: [],
        ancestry: [], nearestLabels: [], depth: 0,
      }],
    };
    surface.current = bare;
    await runner.run('observe', {});
    const r = await runner.run('click', { ref: 'o1#e1', intent: 'click the mystery box' });

    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/cannot be described/);
    expect(runner.steps).toHaveLength(0);
  });
});

describe('the observation the model is shown', () => {
  it('prints refs the model can pass straight back', async () => {
    const r = await runner.run('observe', {});
    expect(r.text).toMatch(/o1#f3e44 link "View"/);
  });

  it('gives a grid control its row and column, so it can be told from its twins', async () => {
    const r = await runner.run('observe', {});
    expect(r.text).toMatch(/o1#f3e44 link "View" \[Accounts row 1, Action\]/);
  });

  it('says when a dialog is covering the page rather than letting it be clicked through', async () => {
    surface.current = { ...snap('surprise-modal'), blockingDialog: { ref: 'd1', name: 'Session Notice' } };
    const r = await runner.run('observe', {});
    expect(r.text).toMatch(/dialog is open and covering the page/);
    expect(r.text).toMatch(/Session Notice/);
  });
});
