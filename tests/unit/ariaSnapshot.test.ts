/**
 * Tested against snapshots captured from a real browser against the real
 * target app (scripts/capture-fixtures.mjs), not against hand-written YAML
 * that happens to match my assumptions about the format.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAriaSnapshot } from '../../src/surface/web/ariaYaml.ts';
import { flattenToSnapshot } from '../../src/surface/web/toUiNodes.ts';
import type { UiSnapshot } from '../../src/surface/uinode.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/aria/${name}.yaml`, import.meta.url), 'utf8');

const snapshotOf = (name: string, url = 'http://localhost:4400/x'): UiSnapshot =>
  flattenToSnapshot(parseAriaSnapshot(fixture(name)), { url, title: name });

describe('parsing Playwright AI-mode aria snapshots', () => {
  it('parses roles, names, refs and boxes', () => {
    const roots = parseAriaSnapshot(fixture('member-detail'));
    expect(roots.length).toBeGreaterThan(0);
    const flat: string[] = [];
    const rec = (ns: typeof roots): void => {
      for (const n of ns) { flat.push(n.role); rec(n.children); }
    };
    rec(roots);
    expect(flat).toContain('table');
    expect(flat).toContain('columnheader');
    expect(flat).toContain('link');
  });

  it('lifts a link href out of its /url pseudo-child', () => {
    const s = snapshotOf('member-detail');
    // Parsed separately because url lives on ParsedAriaNode, not UiNode.
    const roots = parseAriaSnapshot(fixture('member-detail'));
    let found: string | undefined;
    const rec = (ns: typeof roots): void => {
      for (const n of ns) {
        if (n.role === 'link' && n.name === 'View' && n.url) found ??= n.url;
        rec(n.children);
      }
    };
    rec(roots);
    expect(found).toContain('/accounts/');
    expect(s.nodes.length).toBeGreaterThan(10);
  });

  it('survives an empty snapshot without throwing', () => {
    expect(parseAriaSnapshot('')).toEqual([]);
  });
});

describe('frame chains', () => {
  it('descends into the content iframe', () => {
    const s = snapshotOf('member-detail');
    const inFrame = s.nodes.filter((n) => n.frameChain.length > 0);
    expect(inFrame.length).toBeGreaterThan(0);
    expect(inFrame.every((n) => n.frameChain.length === 1)).toBe(true);
  });

  it('uses caller-supplied frame names when available, positional order when not', () => {
    // The aria tree does not expose an iframe's name or title, so the parser
    // alone can only go by document order. WebSurface reads the real name off
    // the element and passes it in.
    const roots = parseAriaSnapshot(fixture('member-detail'));
    const anonymous = flattenToSnapshot(roots, { url: 'x', title: 'x' });
    expect(anonymous.nodes.find((n) => n.frameChain.length)!.frameChain).toEqual(['frame#0']);

    const named = flattenToSnapshot(roots, { url: 'x', title: 'x', frameNames: ['contentFrame'] });
    expect(named.nodes.find((n) => n.frameChain.length)!.frameChain).toEqual(['contentFrame']);
  });

  it('never lets Playwright\'s frame ordinal into a chain, because it is not stable', () => {
    // Two renders of the same screen came back as f2 and f11. Using that
    // ordinal would break the structure hash between identical screens.
    const a = snapshotOf('member-detail');
    const b = snapshotOf('member-detail-rerender');
    expect(a.nodes.some((n) => n.frameChain.some((f) => /^f\d+$/.test(f)))).toBe(false);
    expect(a.nodes.find((n) => n.frameChain.length)!.frameChain)
      .toEqual(b.nodes.find((n) => n.frameChain.length)!.frameChain);
  });

  it('keeps top-level chrome out of the frame chain', () => {
    const s = snapshotOf('member-detail');
    const signOut = s.nodes.find((n) => n.role === 'link' && n.name === 'Sign Out');
    expect(signOut?.frameChain).toEqual([]);
  });
});

describe('table context', () => {
  it('gives every account row its column headers', () => {
    const s = snapshotOf('member-detail');
    const savingsCell = s.nodes.find((n) => n.role === 'cell' && n.name === 'Savings');
    expect(savingsCell?.tableContext?.table).toBe('Accounts');
    expect(savingsCell?.tableContext?.colHeader).toBe('Type');
    expect(savingsCell?.tableContext?.rowHeaders).toContain('0001-4477');
    expect(savingsCell?.tableContext?.rowHeaders).toContain('$4,210.55');
  });

  it('is what distinguishes three View links that share one accessible name', () => {
    const s = snapshotOf('member-detail');
    const views = s.nodes.filter((n) => n.role === 'link' && n.name === 'View');
    expect(views.length).toBe(3);
    // Role+name is ambiguous by construction. Row data is not.
    const rows = views.map((v) => v.tableContext?.rowHeaders.join('|') ?? v.nearestLabels.join('|'));
    expect(new Set(rows).size).toBe(3);
  });
});

describe('structure hash', () => {
  it('is identical across two renders whose control ids all changed', () => {
    // The whole point: the app regenerates every id, and the shape is stable.
    const a = snapshotOf('member-detail');
    const b = snapshotOf('member-detail-rerender');
    expect(a.structureHash).toBe(b.structureHash);
  });

  it('differs between genuinely different screens', () => {
    expect(snapshotOf('member-detail').structureHash)
      .not.toBe(snapshotOf('account-detail').structureHash);
  });

  it('distinguishes a not-found result from an ordinary search screen', () => {
    // Oscillation detection depends on this: "I searched and got nothing" must
    // not hash the same as "I am about to search".
    expect(snapshotOf('not-found').structureHash)
      .not.toBe(snapshotOf('member-search').structureHash);
  });
});

describe('blocking dialogs', () => {
  it('flags the surprise modal so the executor can refuse to act behind it', () => {
    const s = snapshotOf('surprise-modal');
    expect(s.blockingDialog?.name).toBe('Scheduled Maintenance Notice');
  });

  it('reports no dialog on an ordinary screen', () => {
    expect(snapshotOf('member-detail').blockingDialog).toBeUndefined();
  });
});

describe('form labelling', () => {
  it('associates labels with their controls on the sub-account form', () => {
    const s = snapshotOf('subaccount-form');
    const deposit = s.nodes.find((n) => n.role === 'textbox' && /Initial Deposit/.test(n.name));
    expect(deposit).toBeDefined();
  });
});

describe('a plain <div> that carries the actual content', () => {
  // Found live against saucedemo.com's checkout overview page: its entire
  // price breakdown is rendered as non-semantic `<div>`s, which Playwright's
  // AI-mode snapshot reports as role "generic" - exactly the role this
  // parser also uses for pure layout wrappers. A blanket exclusion by role
  // cannot tell "noise" from "the actual number the model was asked to
  // read" apart, and dropped both identically.
  const yaml = `
- generic [ref=e1]:
  - generic [ref=e2]:
  - generic [ref=e3]: "Total: $32.39"
  - generic [ref=e4]:
    - button "Finish" [ref=e5]
`;

  it('keeps a structural-role node that carries its own text', () => {
    const s = flattenToSnapshot(parseAriaSnapshot(yaml), { url: 'x', title: 'x' });
    const total = s.nodes.find((n) => n.ref === 'e3');
    expect(total?.name).toBe('Total: $32.39');
  });

  it('still drops a structural-role node that is a pure, empty wrapper', () => {
    const s = flattenToSnapshot(parseAriaSnapshot(yaml), { url: 'x', title: 'x' });
    expect(s.nodes.find((n) => n.ref === 'e1')).toBeUndefined();
    expect(s.nodes.find((n) => n.ref === 'e2')).toBeUndefined();
    expect(s.nodes.find((n) => n.ref === 'e4')).toBeUndefined();
  });

  it('does not touch nodes that were never structural in the first place', () => {
    const s = flattenToSnapshot(parseAriaSnapshot(yaml), { url: 'x', title: 'x' });
    expect(s.nodes.find((n) => n.ref === 'e5')?.role).toBe('button');
  });
});
