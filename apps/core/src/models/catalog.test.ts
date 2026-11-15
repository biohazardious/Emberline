import { getModelsForProvider, setModelCatalog } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDb, openDb } from '../db/index.js';
import {
  addManualModel,
  ModelAlreadyListedError,
  mergeDiscovery,
  publishCatalog,
  readCatalog,
  recordReadFailure,
  removeManualModel,
} from './catalog.js';

let opened: OpenedDb;
beforeEach(() => {
  opened = openDb(':memory:');
});
afterEach(() => {
  setModelCatalog(null);
  opened.close();
});

const t1 = new Date('2026-11-15T10:00:00.000Z');
const t2 = new Date('2026-11-16T10:00:00.000Z');
const t3 = new Date('2026-11-17T10:00:00.000Z');
const found = (ids: string[]) => ({
  models: ids.map((id) => ({ id, label: id })),
  source: 'cli' as const,
  cliVersion: '1.2.3',
});
const stored = (id: string) => readCatalog(opened.db).antigravity.models.find((m) => m.id === id);

describe('mergeDiscovery', () => {
  it('reports a new id once and stamps lastSeen on the next merge', () => {
    const first = mergeDiscovery(opened.db, 'antigravity', found(['gemini-4-hydrogen-xhigh']), t1);
    expect(first.added.map((m) => m.id)).toEqual(['gemini-4-hydrogen-xhigh']);
    expect(stored('gemini-4-hydrogen-xhigh')).toMatchObject({ rank: 5, tier: 'high', source: 'cli' });
    const second = mergeDiscovery(opened.db, 'antigravity', found(['gemini-4-hydrogen-xhigh']), t2);
    expect(second.added).toEqual([]);
    expect(stored('gemini-4-hydrogen-xhigh')).toMatchObject({
      firstSeen: t1.toISOString(),
      lastSeen: t2.toISOString(),
    });
    expect(readCatalog(opened.db).antigravity.read).toMatchObject({
      at: t2.toISOString(),
      ok: true,
      error: null,
    });
  });

  it('keeps an id that disappears and marks it missing', () => {
    mergeDiscovery(opened.db, 'antigravity', found(['gemini-4-hydrogen-xhigh']), t1);
    const r = mergeDiscovery(opened.db, 'antigravity', found(['other-high']), t2);
    expect(stored('gemini-4-hydrogen-xhigh')?.missingSince).toBe(t2.toISOString());
    expect(r.added.map((m) => m.id)).toEqual(['other-high']);
    mergeDiscovery(opened.db, 'antigravity', found(['other-high']), t3);
    expect(stored('gemini-4-hydrogen-xhigh')?.missingSince).toBe(t2.toISOString());
    mergeDiscovery(opened.db, 'antigravity', found(['gemini-4-hydrogen-xhigh']), t3);
    expect(stored('gemini-4-hydrogen-xhigh')?.missingSince).toBeNull();
  });

  it('stores a known-at-release id without reporting it', () => {
    const r = mergeDiscovery(opened.db, 'antigravity', found(['gemini-4-argon-high']), t1);
    expect(r.added).toEqual([]);
    expect(stored('gemini-4-argon-high')).toBeDefined();
  });

  it('drops ids that are not safe shell words', () => {
    const r = mergeDiscovery(opened.db, 'antigravity', found(['bad id', 'good-high']), t1);
    expect(r.added.map((m) => m.id)).toEqual(['good-high']);
    expect(stored('bad id')).toBeUndefined();
  });

  it("follows the CLI's label and description of an id it lists again", () => {
    mergeDiscovery(
      opened.db,
      'claude',
      {
        models: [{ id: 'opus', label: 'Opus 5.5', description: 'Best for everyday work' }],
        source: 'picker',
        cliVersion: '2.1.325',
      },
      t1,
    );
    mergeDiscovery(
      opened.db,
      'claude',
      {
        models: [{ id: 'opus', label: 'Opus 6', description: 'Most capable' }],
        source: 'picker',
        cliVersion: '2.2.0',
      },
      t2,
    );
    const opus = readCatalog(opened.db).claude.models.find((m) => m.id === 'opus');
    expect(opus).toMatchObject({
      label: 'Opus 6',
      description: 'Most capable',
      source: 'picker',
      firstSeen: t1.toISOString(),
    });
    expect(getModelsForProvider('claude').find((m) => m.id === 'opus')?.label).toBe('Opus 6');
  });

  it("makes an id a person typed in the CLI's once the CLI lists it, without announcing it", () => {
    addManualModel(opened.db, 'antigravity', 'mine-low', 'Mine', t1);
    const r = mergeDiscovery(opened.db, 'antigravity', found(['mine-low']), t2);
    expect(r.added).toEqual([]);
    expect(stored('mine-low')).toMatchObject({
      source: 'cli',
      label: 'mine-low',
      badge: 'discovered',
      firstSeen: t1.toISOString(),
      lastSeen: t2.toISOString(),
      missingSince: null,
    });
    // It is no longer the person's to remove, so the next read neither loses nor announces it.
    removeManualModel(opened.db, 'antigravity', 'mine-low');
    expect(mergeDiscovery(opened.db, 'antigravity', found(['mine-low']), t3).added).toEqual([]);
    expect(stored('mine-low')).toMatchObject({ source: 'cli' });
  });
});

describe('recordReadFailure', () => {
  it('is a first failure until a read succeeds again', () => {
    expect(recordReadFailure(opened.db, 'gemini', '1.0', 'boom', t1).firstFailure).toBe(true);
    expect(recordReadFailure(opened.db, 'gemini', '1.0', 'boom', t2).firstFailure).toBe(false);
    expect(readCatalog(opened.db).gemini.read).toMatchObject({ ok: false, error: 'boom' });
    mergeDiscovery(opened.db, 'gemini', found(['gemini-x-high']), t2);
    expect(recordReadFailure(opened.db, 'gemini', '1.0', 'boom', t3).firstFailure).toBe(true);
  });
});

describe('manual models', () => {
  it('adds, publishes and removes only manual entries', () => {
    addManualModel(opened.db, 'antigravity', 'typed-medium');
    expect(stored('typed-medium')).toMatchObject({ source: 'manual', label: 'typed-medium', tier: 'medium' });
    expect(getModelsForProvider('antigravity').some((m) => m.id === 'typed-medium')).toBe(true);
    mergeDiscovery(opened.db, 'antigravity', found(['found-high']), t1);
    removeManualModel(opened.db, 'antigravity', 'found-high');
    expect(stored('found-high')).toBeDefined();
    removeManualModel(opened.db, 'antigravity', 'typed-medium');
    expect(stored('typed-medium')).toBeUndefined();
    expect(getModelsForProvider('antigravity').some((m) => m.id === 'typed-medium')).toBe(false);
  });

  it('rejects an unsafe id', () => {
    expect(() => addManualModel(opened.db, 'antigravity', 'bad id')).toThrow();
  });

  it('refuses an id the CLI lists or Emberline ships, leaving the entry as the CLI reported it', () => {
    mergeDiscovery(opened.db, 'antigravity', found(['found-high']), t1);
    mergeDiscovery(opened.db, 'antigravity', found(['other-high']), t2);
    expect(stored('found-high')?.missingSince).toBe(t2.toISOString());
    expect(() => addManualModel(opened.db, 'antigravity', 'found-high', 'Mine')).toThrow(
      ModelAlreadyListedError,
    );
    expect(() => addManualModel(opened.db, 'antigravity', 'argon')).toThrow('argon is already in the list.');
    expect(stored('found-high')).toMatchObject({
      source: 'cli',
      label: 'found-high',
      missingSince: t2.toISOString(),
    });
    expect(stored('argon')).toBeUndefined();
  });

  it('stamps a typed-in id with the given time; typing it again only relabels it', () => {
    addManualModel(opened.db, 'antigravity', 'typed-medium', undefined, t1);
    addManualModel(opened.db, 'antigravity', 'typed-medium', 'Typed', t2);
    expect(stored('typed-medium')).toMatchObject({
      label: 'Typed',
      source: 'manual',
      firstSeen: t1.toISOString(),
      lastSeen: t1.toISOString(),
      missingSince: null,
    });
  });
});

describe('publishCatalog', () => {
  it('makes stored ids visible through getModelsForProvider', () => {
    mergeDiscovery(opened.db, 'antigravity', found(['gemini-4-hydrogen-xhigh']), t1);
    setModelCatalog(null);
    expect(getModelsForProvider('antigravity').some((m) => m.id === 'gemini-4-hydrogen-xhigh')).toBe(false);
    publishCatalog(opened.db);
    expect(getModelsForProvider('antigravity').some((m) => m.id === 'gemini-4-hydrogen-xhigh')).toBe(true);
  });
});
