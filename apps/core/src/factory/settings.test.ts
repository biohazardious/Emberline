import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test-utils.js';
import { getFactorySettings, updateFactorySettings } from './settings.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('conflict self-heal settings', () => {
  it('reads true for both flags from a stored row written before they existed', () => {
    const value = { autoSyncToMain: true, maxParallelTicketsPerProject: 3 };
    t.db
      .insert(settings)
      .values({ key: 'factory.settings', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    const read = getFactorySettings(t.db);
    expect(read.autoResolveAdditiveConflicts).toBe(true);
    expect(read.serializeOverlappingTickets).toBe(true);
    expect(read.maxParallelTicketsPerProject).toBe(3);
  });

  it('updates each flag on its own and keeps the other', () => {
    updateFactorySettings(t.db, { autoResolveAdditiveConflicts: false });
    let read = getFactorySettings(t.db);
    expect(read.autoResolveAdditiveConflicts).toBe(false);
    expect(read.serializeOverlappingTickets).toBe(true);

    updateFactorySettings(t.db, { serializeOverlappingTickets: false });
    read = getFactorySettings(t.db);
    expect(read.autoResolveAdditiveConflicts).toBe(false);
    expect(read.serializeOverlappingTickets).toBe(false);

    updateFactorySettings(t.db, { theme: 'light' });
    read = getFactorySettings(t.db);
    expect(read.autoResolveAdditiveConflicts).toBe(false);
    expect(read.serializeOverlappingTickets).toBe(false);
  });
});
