import type { RunRecovery, RecoverySuggestion } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  deliveryNote,
  recoverErrorText,
  recoveryApplies,
  sentenceCase,
  visibleSuggestions,
} from './holdRecovery';

const sug = (kind: RecoverySuggestion['kind'], prompt: string | null = null): RecoverySuggestion => ({
  id: kind,
  kind,
  label: kind,
  detail: null,
  prompt,
  files: [],
  commands: [],
});
const rec = (kinds: RecoverySuggestion['kind'][], delivery: RunRecovery['delivery'] = 'session'): RunRecovery => ({
  hold: 'merge_failed',
  label: 'Merge failed',
  why: 'main moved',
  delivery,
  suggestions: kinds.map((k) => sug(k, k === 'prompt' ? 'fix it' : null)),
});

describe('deliveryNote', () => {
  it('says where the prompt went', () => {
    expect(deliveryNote('session')).toBe('Sent to the agent');
    expect(deliveryNote('successor')).toBe('Continuing in a new run on the same branch');
  });
});

describe('recoverErrorText', () => {
  it('has plain copy for each refusal', () => {
    expect(recoverErrorText('not_held', 'x')).toBe('This ticket is no longer held.');
    expect(recoverErrorText('run_busy', 'x')).toBe('The agent is working; try again when it stops.');
    expect(recoverErrorText('worktree_missing', 'x')).toBe("This run's worktree was removed; start a new run.");
    expect(recoverErrorText('run_stopped_by_you', 'x')).toBe(
      "This run was stopped, so it can't take a prompt. Start a new run or discard the ticket.",
    );
  });
  it('maps no_session and unknown codes to the delivery-none copy', () => {
    expect(recoverErrorText('no_session', 'x')).toBe(recoverErrorText('run_stopped_by_you', 'x'));
    expect(recoverErrorText('weird', 'x')).toBe(recoverErrorText('run_stopped_by_you', 'x'));
  });
  it("keeps the server's message for route checks", () => {
    expect(recoverErrorText('lane_exhausted', 'Lane is out of quota')).toBe('Lane is out of quota');
  });
});

describe('visibleSuggestions', () => {
  it('drops discard and merge without callbacks', () => {
    const r = rec(['prompt', 'discard', 'merge', 'manual']);
    expect(visibleSuggestions(r, {}).map((s) => s.kind)).toEqual(['prompt', 'manual']);
    expect(visibleSuggestions(r, { onDiscard: true }).map((s) => s.kind)).toEqual(['prompt', 'discard', 'manual']);
    expect(visibleSuggestions(r, { onDiscard: true, onMerge: true }).map((s) => s.kind)).toEqual([
      'prompt',
      'discard',
      'merge',
      'manual',
    ]);
  });
  it('is empty for a null recovery', () => {
    expect(visibleSuggestions(null, {})).toEqual([]);
  });
});

describe('sentenceCase', () => {
  it('capitalises and ends with a period', () => {
    expect(sentenceCase('main moved on')).toBe('Main moved on.');
    expect(sentenceCase('Already done.')).toBe('Already done.');
    expect(sentenceCase('could not compare?')).toBe('Could not compare?');
  });
});

describe('recoveryApplies', () => {
  it('holds and blocked runs only', () => {
    expect(recoveryApplies({ attention: { reason: 'held' } } as never)).toBe(true);
    expect(recoveryApplies({ attention: { reason: 'blocked' } } as never)).toBe(true);
    expect(recoveryApplies({ attention: { reason: 'question' } } as never)).toBe(false);
    expect(recoveryApplies({ attention: null } as never)).toBe(false);
  });
});
