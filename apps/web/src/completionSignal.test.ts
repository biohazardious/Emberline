import type { RunEvent } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { completionEventText, latestCompletionBlockers } from './completionSignal';

const ev = (type: string, payload: unknown, id = 1): RunEvent =>
  ({ id, runId: 'r', ts: '2026-10-17T00:00:00Z', source: 'system', type, state: null, payload }) as RunEvent;

describe('completionEventText', () => {
  it('shows the summary of a completion', () => {
    expect(completionEventText('ticket_complete', { summary: 'Done it', handoff: 'x', blockers: [] })).toBe('Done it');
  });
  it('lists blockers after the summary', () => {
    expect(completionEventText('ticket_complete', { summary: 'Half', blockers: ['no key', 'no db'] })).toBe(
      'Half\nBlockers:\n- no key\n- no db',
    );
  });
  it('lists the blockers of a blocked hold', () => {
    expect(completionEventText('completion_blocked', { blockers: ['no key'] })).toBe('Blockers:\n- no key');
  });
  it('has no text for nudges and other events', () => {
    expect(completionEventText('completion_nudged', {})).toBeUndefined();
    expect(completionEventText('completion_missing', null)).toBeUndefined();
    expect(completionEventText('stall_detected', { summary: 'x' })).toBeUndefined();
  });
});

describe('latestCompletionBlockers', () => {
  it('is empty without a completion', () => expect(latestCompletionBlockers([ev('stall_detected', {})])).toEqual([]));
  it('reads the latest completion only', () => {
    const events = [
      ev('ticket_complete', { summary: 'a', blockers: ['old'] }, 1),
      ev('ticket_complete', { summary: 'b', blockers: [] }, 2),
    ];
    expect(latestCompletionBlockers(events)).toEqual([]);
    expect(latestCompletionBlockers([events[1]!, events[0]!])).toEqual([]);
  });
  it('returns the blockers of the latest completion', () => {
    expect(latestCompletionBlockers([ev('ticket_complete', { summary: 'a', blockers: ['x'] })])).toEqual(['x']);
  });
});
