import { describe, expect, it } from 'vitest';
import { clearSlotIfOwner, presentRunId, type PresenceSource } from './presenceSlots';

describe('presence slots', () => {
  it('reports by priority', () => {
    const slots = new Map<PresenceSource, string>([['fleet', 'f'], ['inbox', 'i']]);
    expect(presentRunId(slots)).toBe('i');
    slots.set('inspector', 'x');
    expect(presentRunId(slots)).toBe('x');
    expect(presentRunId(new Map())).toBeNull();
  });
  it('clears only for the owner', () => {
    const slots = new Map<PresenceSource, string>([['inbox', 'b']]);
    expect(clearSlotIfOwner(slots, 'a', 'inbox')).toBe(false);
    expect(slots.get('inbox')).toBe('b');
    expect(clearSlotIfOwner(slots, 'b', 'inbox')).toBe(true);
    expect(slots.has('inbox')).toBe(false);
  });
});
