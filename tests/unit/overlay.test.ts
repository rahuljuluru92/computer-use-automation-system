/**
 * `applyOverlay` at the schema level - no browser, no network.
 *
 * The M2 gate (see scripts/gate-m2.ts) proves the summitcu overlay live
 * against a real re-skinned Meridian instance. This file proves the pure
 * transform in isolation: exactly the steps named in the overlay change, and
 * nothing about the flow's shape does.
 */

import { describe, it, expect } from 'vitest';
import { applyOverlay, overriddenSteps, UnknownTenantError } from '../../src/replay/overlay.ts';
import { seedArtifact } from '../fixtures/seedArtifact.ts';

describe('applyOverlay', () => {
  it('throws a legible error for a tenant with no overlay', () => {
    const base = seedArtifact();
    expect(() => applyOverlay(base, 'not-a-real-tenant')).toThrow(UnknownTenantError);
    try {
      applyOverlay(base, 'not-a-real-tenant');
    } catch (err) {
      expect(String(err)).toMatch(/summitcu/); // names what IS known
    }
  });

  it('never mutates the base artifact', () => {
    const base = seedArtifact();
    const before = JSON.stringify(base);
    applyOverlay(base, 'summitcu');
    expect(JSON.stringify(base)).toBe(before);
  });

  it('replaces only the step target named in `targets`', () => {
    const base = seedArtifact();
    const effective = applyOverlay(base, 'summitcu');

    const baseS4 = base.steps.find((s) => s.id === 's4')!;
    const overlaidS4 = effective.steps.find((s) => s.id === 's4')!;
    expect(overlaidS4.target).not.toEqual(baseS4.target);
    expect(overlaidS4.target?.description).toMatch(/Customer Number/);

    // Everything else about the step is untouched.
    expect(overlaidS4.action).toEqual(baseS4.action);
    expect(overlaidS4.data).toEqual(baseS4.data);
  });

  it('replaces only the step checkpoint named in `checkpoints`', () => {
    const base = seedArtifact();
    const effective = applyOverlay(base, 'summitcu');

    const baseS3 = base.steps.find((s) => s.id === 's3')!;
    const overlaidS3 = effective.steps.find((s) => s.id === 's3')!;
    expect(overlaidS3.checkpoint).not.toEqual(baseS3.checkpoint);
    // Its own waitFor (unrelated to the rename) is left alone.
    expect(overlaidS3.waitFor).toEqual(baseS3.waitFor);
  });

  it('leaves every step it does not name completely unchanged', () => {
    const base = seedArtifact();
    const effective = applyOverlay(base, 'summitcu');
    for (const id of ['s1', 's2', 's5', 's6']) {
      expect(effective.steps.find((s) => s.id === id))
        .toEqual(base.steps.find((s) => s.id === id));
    }
  });

  it('prepends tenant recovery rules ahead of the base rules', () => {
    const base = seedArtifact();
    const effective = applyOverlay(base, 'summitcu');
    expect(effective.recovery[0]?.id).toBe('accept-summitcu-consent');
    expect(effective.recovery.slice(1)).toEqual(base.recovery);
  });

  it('does not add, remove or reorder steps', () => {
    const base = seedArtifact();
    const effective = applyOverlay(base, 'summitcu');
    expect(effective.steps.map((s) => s.id)).toEqual(base.steps.map((s) => s.id));
  });

  it('reports every step summitcu touches, across targets and checkpoints', () => {
    const base = seedArtifact();
    expect(overriddenSteps(base, 'summitcu').sort()).toEqual(['s3', 's4']);
  });

  it('reports nothing for a tenant with no overlay', () => {
    const base = seedArtifact();
    expect(overriddenSteps(base, 'unknown')).toEqual([]);
  });
});
