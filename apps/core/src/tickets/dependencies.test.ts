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
  it('lower-cases and validates draft refs and caps dependsOn', () => {
    expect(AgentTicketDraft.parse({ title: 'x', ref: 'Brand-Assets' }).ref).toBe('brand-assets');
    expect(AgentTicketDraft.safeParse({ title: 'x', ref: 'bad ref!' }).success).toBe(false);
    expect(AgentTicketDraft.safeParse({ title: 'x', dependsOn: Array.from({ length: 11 }, (_, i) => `r${i}`) }).success).toBe(false);
    expect(AgentTicketDraft.safeParse({ title: 'x', dependsOn: ['a'] }).success).toBe(true);
  });

  it('accepts dependsOn on ticket updates', () => {
    expect(UpdateTicketBody.parse({ dependsOn: ['MPG-1'] }).dependsOn).toEqual(['MPG-1']);
    expect(UpdateTicketBody.safeParse({ dependsOn: Array.from({ length: 21 }, (_, i) => `k${i}`) }).success).toBe(false);
  });
});
