import { describe, expect, it } from 'vitest';
import { PRUNE_PROTECTED_EVENT_TYPES } from './service.js';
import { HOLD_EVENTS } from './hold-events.js';
import { currentHold, decidePipelineOutcome, withoutUnblocked } from './hold-outcome.js';

describe('review_unblocked ordering', () => {
  it('lifts only an earlier review_blocked, never another hold', () => {
    expect(decidePipelineOutcome(['review_blocked', 'review_unblocked'])).toBeNull();
    expect(decidePipelineOutcome(['merge_failed', 'review_unblocked'])).toBe('held');
    expect(decidePipelineOutcome(['review_blocked', 'merge_failed', 'review_unblocked'])).toBe('held');
  });

  it('a later review_blocked holds again; several unblocks lift every earlier block', () => {
    expect(decidePipelineOutcome(['review_blocked', 'review_unblocked', 'review_blocked'])).toBe('held');
    expect(decidePipelineOutcome(['review_blocked', 'review_unblocked', 'review_blocked', 'review_unblocked'])).toBeNull();
    expect(decidePipelineOutcome(['review_blocked', 'review_blocked', 'review_unblocked'])).toBeNull();
    expect(withoutUnblocked(['review_blocked', 'review_unblocked', 'review_blocked'])).toEqual(['review_unblocked', 'review_blocked']);
  });

  it('currentHold follows the same rule', () => {
    const e = (type: string, id: number) => ({ type, id });
    expect(currentHold([e('merge_failed', 1), e('review_blocked', 2), e('review_unblocked', 3)])?.type).toBe('merge_failed');
    expect(currentHold([e('review_blocked', 1), e('review_unblocked', 2)])).toBeNull();
  });
});

describe('pruning', () => {
  it('keeps the override note', () => {
    expect(PRUNE_PROTECTED_EVENT_TYPES).toContain('review_blocking_overridden');
  });

  it('no_changes is a hold, and pruning keeps it', () => {
    expect(HOLD_EVENTS).toContain('no_changes');
    expect(PRUNE_PROTECTED_EVENT_TYPES).toContain('no_changes');
    expect(decidePipelineOutcome(['no_changes'])).toBe('held');
    expect(currentHold([{ type: 'no_changes', payload: { autoFix: false } }])?.type).toBe('no_changes');
  });

  it('keeps the tickets_imported note the no_changes check reads on a later pass', () => {
    expect(PRUNE_PROTECTED_EVENT_TYPES).toContain('tickets_imported');
  });
});
