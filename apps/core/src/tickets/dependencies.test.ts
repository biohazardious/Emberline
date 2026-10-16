import { AgentTicketDraft, UpdateTicketBody } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { defaultTierEdges, resolveBatchDependencies, wouldCreateCycle } from './dependencies.js';

const t = (id: string, persona: string, ref?: string, dependsOn?: string[]) => ({ id, key: id.toUpperCase(), persona: persona as never, ref, dependsOn });
const keys = new Map([['MPG-38', 'old38']]);

describe('ticket dependencies', () => {
  it('resolves refs and existing keys, case-insensitively', () => {
    const { edges, dropped } = resolveBatchDependencies(
      [t('a', 'ui_ux', 'brand-assets'), t('b', 'coder', 'android-shell'), t('c', 'coder', 'apk-build', ['Brand-Assets', 'android-shell']), t('d', 'qa', 'qa', ['apk-build', 'mpg-38'])],
      keys,
      [],
    );
    expect(edges).toEqual([
      { ticketId: 'c', dependsOnId: 'a' },
      { ticketId: 'c', dependsOnId: 'b' },
      { ticketId: 'd', dependsOnId: 'c' },
      { ticketId: 'd', dependsOnId: 'old38' },
    ]);
    expect(dropped).toEqual([]);
  });

  it('drops unknown refs, self edges and cycle-closing edges but keeps the rest', () => {
    const { edges, dropped } = resolveBatchDependencies(
      [t('a', 'coder', 'x', ['y', 'nope']), t('b', 'coder', 'y', ['x']), t('c', 'qa', 'z', ['z'])],
      keys,
      [],
    );
    expect(edges).toEqual([{ ticketId: 'a', dependsOnId: 'b' }]);
    expect(dropped).toEqual([
      { ticketId: 'a', ref: 'nope', reason: 'unknown' },
      { ticketId: 'b', ref: 'x', reason: 'cycle' },
      { ticketId: 'c', ref: 'z', reason: 'self' },
    ]);
  });

  it('reports a ref that normalizes to an earlier ticket\'s ref; the first one wins', () => {
    const { edges, dropped } = resolveBatchDependencies(
      [t('a', 'coder', 'Brand_Assets'), t('b', 'ui_ux', 'brand-assets'), t('c', 'qa', 'qa', ['brand-assets'])],
      keys,
      [],
    );
    expect(dropped).toEqual([{ ticketId: 'b', ref: 'brand-assets', reason: 'duplicate_ref' }]);
    expect(edges).toEqual([{ ticketId: 'c', dependsOnId: 'a' }]);
  });

  it('reports repeated refs also when no ticket declares a dependency', () => {
    const { edges, dropped } = resolveBatchDependencies(
      [t('a', 'architect', 'brand-assets'), t('b', 'coder', 'brand_assets')],
      keys,
      [],
    );
    expect(dropped).toEqual([{ ticketId: 'b', ref: 'brand_assets', reason: 'duplicate_ref' }]);
    expect(edges).toEqual([{ ticketId: 'b', dependsOnId: 'a' }]);
  });

  it('falls back to the default tiers when every declared dependency was dropped', () => {
    const { edges, dropped } = resolveBatchDependencies(
      [t('a', 'coder', 'a'), t('b', 'qa', 'b', ['nope']), t('c', 'ui_ux', 'c', ['c'])],
      keys,
      [],
    );
    expect(edges).toEqual([{ ticketId: 'b', dependsOnId: 'a' }, { ticketId: 'b', dependsOnId: 'c' }]);
    expect(dropped).toEqual([
      { ticketId: 'b', ref: 'nope', reason: 'unknown' },
      { ticketId: 'c', ref: 'c', reason: 'self' },
    ]);
  });

  it('applies the default persona tiers when no draft states dependencies', () => {
    expect(defaultTierEdges([{ id: 'arch', persona: 'architect' }, { id: 'c', persona: 'coder' }, { id: 'u', persona: 'ui_ux' }, { id: 'q', persona: 'qa' }])).toEqual([
      { ticketId: 'c', dependsOnId: 'arch' },
      { ticketId: 'u', dependsOnId: 'arch' },
      { ticketId: 'q', dependsOnId: 'c' },
      { ticketId: 'q', dependsOnId: 'u' },
    ]);
    // Missing tier 1: qa depends on tier 0 directly; a single tier gets no edges.
    expect(defaultTierEdges([{ id: 'd', persona: 'dba' }, { id: 'q', persona: 'qa' }])).toEqual([{ ticketId: 'q', dependsOnId: 'd' }]);
    expect(defaultTierEdges([{ id: 'c', persona: 'coder' }, { id: 'u', persona: 'ui_ux' }])).toEqual([]);
  });

  it('uses the default tiers through resolveBatchDependencies when no draft has dependsOn', () => {
    const { edges } = resolveBatchDependencies([t('a', 'architect'), t('c', 'coder', 'c', [])], keys, []);
    expect(edges).toEqual([{ ticketId: 'c', dependsOnId: 'a' }]);
  });

  it('detects cycles through existing edges', () => {
    expect(wouldCreateCycle([{ ticketId: 'b', dependsOnId: 'a' }, { ticketId: 'c', dependsOnId: 'b' }], { ticketId: 'a', dependsOnId: 'c' })).toBe(true);
    expect(wouldCreateCycle([{ ticketId: 'b', dependsOnId: 'a' }], { ticketId: 'c', dependsOnId: 'a' })).toBe(false);
  });
});

describe('dependency protocol fields', () => {
  it('normalizes draft refs instead of rejecting the draft', () => {
    const ref = (value: unknown) => AgentTicketDraft.parse({ title: 'x', ref: value }).ref;
    expect(ref('Brand-Assets')).toBe('brand-assets');
    expect(ref('bad ref!')).toBe('bad-ref-');
    expect(ref('brand_assets')).toBe('brand-assets');
    expect(ref('--Lead')).toBe('lead');
    expect(ref(7)).toBe('7');
    expect(ref('x'.repeat(50))).toBe('x'.repeat(40));
    expect(ref('!!!')).toBeUndefined();
    expect(ref({ nested: true })).toBeUndefined();
    expect(AgentTicketDraft.parse({ title: 'x' }).ref).toBeUndefined();
  });

  it('normalizes dependsOn: one string, numbers, junk entries and more than 10', () => {
    const deps = (value: unknown) => AgentTicketDraft.parse({ title: 'x', dependsOn: value }).dependsOn;
    expect(deps(['a'])).toEqual(['a']);
    expect(deps('apk-build')).toEqual(['apk-build']);
    expect(deps(['a', 3, null, { b: 1 }, ' c '])).toEqual(['a', '3', 'c']);
    expect(deps(Array.from({ length: 11 }, (_, i) => `r${i}`))).toHaveLength(10);
    expect(deps({ not: 'a list' })).toBeUndefined();
    expect(AgentTicketDraft.parse({ title: 'x' }).dependsOn).toBeUndefined();
  });

  it('matches a dependsOn entry written like the ref was before normalization', () => {
    const { edges } = resolveBatchDependencies(
      [t('a', 'ui_ux', 'brand-assets'), t('b', 'coder', 'apk', ['Brand_Assets'])],
      keys,
      [],
    );
    expect(edges).toEqual([{ ticketId: 'b', dependsOnId: 'a' }]);
  });

  it('drops an edge that closes a cycle through existing edges', () => {
    // old38 already waits on old39, which waits on the batch ticket a: a -> old38 would loop.
    const existing = [
      { ticketId: 'old38', dependsOnId: 'old39' },
      { ticketId: 'old39', dependsOnId: 'a' },
    ];
    const { edges, dropped } = resolveBatchDependencies(
      [t('a', 'coder', 'a', ['MPG-38']), t('b', 'qa', 'b', ['a'])],
      keys,
      existing,
    );
    expect(dropped).toEqual([{ ticketId: 'a', ref: 'MPG-38', reason: 'cycle' }]);
    expect(edges).toEqual([{ ticketId: 'b', dependsOnId: 'a' }]);
  });

  it('accepts dependsOn on ticket updates', () => {
    expect(UpdateTicketBody.parse({ dependsOn: ['MPG-1'] }).dependsOn).toEqual(['MPG-1']);
    expect(UpdateTicketBody.safeParse({ dependsOn: Array.from({ length: 21 }, (_, i) => `k${i}`) }).success).toBe(false);
  });
});
