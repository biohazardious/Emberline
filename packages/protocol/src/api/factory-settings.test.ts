import { describe, expect, it } from 'vitest';
import { FactorySettings, UpdateFactorySettingsBody } from './factory-settings.js';

const SelfHealFlags = FactorySettings.pick({ autoResolveAdditiveConflicts: true, serializeOverlappingTickets: true });

describe('FactorySettings conflict self-heal flags', () => {
  it('defaults autoResolveAdditiveConflicts and serializeOverlappingTickets to true when absent', () => {
    const parsed = SelfHealFlags.parse({});
    expect(parsed.autoResolveAdditiveConflicts).toBe(true);
    expect(parsed.serializeOverlappingTickets).toBe(true);
  });

  it('keeps explicit false values', () => {
    const parsed = SelfHealFlags.parse({ autoResolveAdditiveConflicts: false, serializeOverlappingTickets: false });
    expect(parsed.autoResolveAdditiveConflicts).toBe(false);
    expect(parsed.serializeOverlappingTickets).toBe(false);
  });

  it('accepts the flags in an update body and rejects non-boolean values', () => {
    expect(UpdateFactorySettingsBody.parse({ autoResolveAdditiveConflicts: false })).toEqual({
      autoResolveAdditiveConflicts: false,
    });
    expect(UpdateFactorySettingsBody.safeParse({ serializeOverlappingTickets: 'yes' }).success).toBe(false);
    expect(UpdateFactorySettingsBody.parse({})).toEqual({});
  });
});
