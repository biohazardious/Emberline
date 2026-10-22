import type { RunRecovery, RecoverySuggestion } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  deliveryNote,
  recoverErrorText,
  recoveryHeading,
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
const rec = (
  kinds: RecoverySuggestion['kind'][],
  delivery: RunRecovery['delivery'] = 'session',
): RunRecovery => ({
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
    expect(recoverErrorText('worktree_missing', 'x')).toBe(
      "This run's worktree was removed; start a new run.",
    );
    expect(recoverErrorText('run_stopped_by_you', 'x')).toBe(
      "This run was stopped, so it can't take a prompt. Start a new run or discard the ticket.",
    );
  });
  it('maps no_session and unknown codes to the neutral delivery-none copy', () => {
    const none = "This run can't take a prompt any more. Start a new run or discard the ticket.";
    expect(recoverErrorText('no_session', 'x')).toBe(none);
    expect(recoverErrorText('weird', 'x')).toBe(none);
    expect(recoverErrorText('no_session', '')).not.toContain('stopped');
  });
  it("keeps the server's message for route checks", () => {
    expect(recoverErrorText('lane_exhausted', 'Lane is out of quota')).toBe('Lane is out of quota');
  });
  it("keeps the server's message when the successor's agent needs Autonomous mode", () => {
    const message = 'Gemini runs without a terminal to answer in, so in Ask mode it would refuse every command without telling anyone. Start it in Autonomous mode, or pick another agent.';
    expect(recoverErrorText('headless_needs_auto', message)).toBe(message);
  });
  it("keeps the server's message for a prompt too long for the successor and a closing session", () => {
    const tooLong = "The prompt is too long to send with the run's handoff context. Keep it under 17998 characters.";
    expect(recoverErrorText('prompt_too_long', tooLong)).toBe(tooLong);
    const closing = 'The agent is finishing its turn; try again in a moment.';
    expect(recoverErrorText('session_closing', closing)).toBe(closing);
  });
});

describe('visibleSuggestions', () => {
  const shown = (r: RunRecovery, have: Parameters<typeof visibleSuggestions>[1]) =>
    visibleSuggestions(r, have).map((s) => `${s.kind}${s.onTicket ? '@ticket' : ''}`);

  it('drops discard and merge without callbacks or a ticket', () => {
    const r = rec(['prompt', 'discard', 'merge', 'manual']);
    expect(shown(r, {})).toEqual(['prompt', 'manual']);
    expect(shown(r, { onDiscard: true })).toEqual(['prompt', 'discard', 'manual']);
    expect(shown(r, { onDiscard: true, onMerge: true })).toEqual(['prompt', 'discard', 'merge', 'manual']);
  });
  it('without callbacks, offers discard and merge on the ticket, keeping label and detail', () => {
    const r = rec(['discard', 'prompt', 'merge']);
    r.suggestions[0]!.detail = 'EL-10 already added these files (3 of 3 conflicts)';
    expect(shown(r, { ticket: true })).toEqual(['discard@ticket', 'prompt', 'merge@ticket']);
    expect(visibleSuggestions(r, { ticket: true })[0]).toMatchObject({
      label: 'discard',
      detail: 'EL-10 already added these files (3 of 3 conflicts)',
    });
    expect(shown(r, { ticket: true, onDiscard: true, onMerge: true })).toEqual([
      'discard',
      'prompt',
      'merge',
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

describe('recoveryHeading', () => {
  it('drops the hold label in the compact Inbox row and keeps it elsewhere', () => {
    expect(recoveryHeading(rec(['prompt']), true).label).toBeNull();
    expect(recoveryHeading(rec(['prompt']), false).label).toBe('Merge failed');
    expect(recoveryHeading(rec(['prompt']), true).why).toBe('Main moved.');
  });
});
