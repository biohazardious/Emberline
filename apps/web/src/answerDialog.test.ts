import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAnswerFiles,
  ANSWER_DRAFT_KEY,
  answerErrorText,
  answerOffered,
  answerTarget,
  canSend,
  chipAnswers,
  clearDraft,
  handleDialogKey,
  loadDraft,
  saveDraft,
  startText,
  suggestionAction,
} from './answerDialog';

type Stub = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
};
const g = globalThis as unknown as { localStorage?: Stub };

function memoryStore(): Stub {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

beforeEach(() => {
  g.localStorage = memoryStore();
});
afterEach(() => {
  delete g.localStorage;
});

describe('drafts', () => {
  it('round-trips per run', () => {
    saveDraft('r1', 'hello');
    saveDraft('r2', 'other');
    expect(loadDraft('r1')).toBe('hello');
    expect(loadDraft('r2')).toBe('other');
    clearDraft('r1');
    expect(loadDraft('r1')).toBe('');
    expect(loadDraft('r2')).toBe('other');
  });

  it('does not keep a blank draft', () => {
    saveDraft('r1', 'hello');
    saveDraft('r1', '   ');
    expect(g.localStorage?.getItem(ANSWER_DRAFT_KEY('r1'))).toBeNull();
    expect(loadDraft('r1')).toBe('');
  });

  it('survives a throwing storage', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDraft('r1')).toBe('');
    expect(() => saveDraft('r1', 'x')).not.toThrow();
    expect(() => clearDraft('r1')).not.toThrow();
  });

  it('works without any storage', () => {
    delete g.localStorage;
    expect(loadDraft('r1')).toBe('');
    expect(() => saveDraft('r1', 'x')).not.toThrow();
  });
});

describe('canSend', () => {
  it('needs text or a file, and not busy', () => {
    expect(canSend(' ', [], false)).toBe(false);
    expect(canSend('x', [], false)).toBe(true);
    expect(canSend('x', [], true)).toBe(false);
  });
});

describe('addAnswerFiles', () => {
  it('stops at ten files', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ file: new Blob(['x']), name: `f${i}.txt` }));
    const { added, problems } = addAnswerFiles([], files);
    expect(added).toHaveLength(10);
    expect(problems).toEqual(['f10.txt was not added: at most 10 files.']);
  });
});

describe('answerErrorText', () => {
  it('says the run moved on', () => {
    expect(answerErrorText('no_question', 'x')).toBe(
      'This run is not waiting for an answer any more. Your draft is kept.',
    );
  });
  it("words recovery's refusals as the hold block does, never the server's text", () => {
    expect(answerErrorText('not_held', 'nothing holds this run any more')).toBe(
      'This ticket is no longer held.',
    );
    expect(answerErrorText('no_session', 'this run has no agent session to continue')).toBe(
      "This run can't take a prompt any more. Start a new run or discard the ticket.",
    );
    expect(answerErrorText('worktree_missing', "this run's worktree was removed")).toBe(
      "This run's worktree was removed; start a new run.",
    );
    expect(answerErrorText('run_stopped_by_you', 'this run was stopped')).toBe(
      "This run was stopped, so it can't take a prompt. Start a new run or discard the ticket.",
    );
  });
  it('says the agent is working', () => {
    expect(answerErrorText('run_busy', 'x')).toBe(
      'The agent is working right now. Send your answer once it waits.',
    );
  });
  it('passes other messages through', () => {
    expect(answerErrorText('answer_busy', 'An answer is already being sent.')).toBe(
      'An answer is already being sent.',
    );
  });
});

describe('suggestionAction', () => {
  it('drops a suggestion that lands after the dialog closed or the answer was sent', () => {
    expect(suggestionAction(true, '')).toBe('ignore');
    expect(suggestionAction(true, 'blue')).toBe('ignore');
  });
  it('fills an empty box and asks before replacing a typed answer', () => {
    expect(suggestionAction(false, '  ')).toBe('fill');
    expect(suggestionAction(false, 'blue')).toBe('ask');
  });
});

describe('startText', () => {
  it("opens with the run's draft when the caller gives no prompt or an empty one", () => {
    saveDraft('r1', 'my draft');
    expect(startText('', 'r1')).toBe('my draft');
    expect(startText(undefined, 'r1')).toBe('my draft');
  });
  it("a suggestion's prompt wins over the draft", () => {
    saveDraft('r1', 'my draft');
    expect(startText('Fix the checks.', 'r1')).toBe('Fix the checks.');
  });
});

describe('answerTarget', () => {
  it('follows the latest copy of the run, and keeps the opened one once it leaves the list', () => {
    const opened = { id: 'r1', v: 1 };
    expect(
      answerTarget(
        [
          { id: 'r2', v: 1 },
          { id: 'r1', v: 2 },
        ],
        opened,
      ),
    ).toEqual({ id: 'r1', v: 2 });
    expect(answerTarget([{ id: 'r2', v: 1 }], opened)).toBe(opened);
    expect(answerTarget(undefined, opened)).toBe(opened);
  });
});

describe('answerOffered', () => {
  const run = (reason: string) =>
    ({
      attention: { reason, detail: null, since: '2026-10-23T10:00:00.000Z', occurrence: 'o' },
    }) as never;
  it('offers Answer on a run that waits on a person, unless its recovery cannot deliver', () => {
    expect(answerOffered(run('question'), undefined)).toBe(true);
    expect(answerOffered(run('held'), undefined)).toBe(true);
    expect(answerOffered(run('held'), { delivery: 'session' })).toBe(true);
    expect(answerOffered(run('blocked'), { delivery: 'successor' })).toBe(true);
    expect(answerOffered(run('blocked'), { delivery: 'none' })).toBe(false);
    expect(answerOffered(run('stalled'), undefined)).toBe(false);
    expect(answerOffered({ attention: null } as never, undefined)).toBe(false);
  });
});

describe('chipAnswers', () => {
  it('sends the option only when core says the picker takes its number', () => {
    expect(chipAnswers({ picker: true, pickerChips: true })).toBe(true);
    expect(chipAnswers({ picker: true, pickerChips: false })).toBe(false);
    expect(chipAnswers({ picker: false, pickerChips: false })).toBe(false);
  });
});

describe('handleDialogKey', () => {
  const key = (k: string) => {
    const calls: string[] = [];
    return {
      calls,
      event: {
        key: k,
        shiftKey: false,
        preventDefault: () => calls.push('prevent'),
        stopPropagation: () => calls.push('stop'),
      },
    };
  };
  it('Escape dismisses the dialog and goes no further (the ticket drawer stays open)', () => {
    const { calls, event } = key('Escape');
    let dismissed = 0;
    handleDialogKey(event, null, () => dismissed++);
    expect(dismissed).toBe(1);
    expect(calls).toEqual(['prevent', 'stop']);
  });
  it('Tab stays with the dialog; other keys pass through', () => {
    const tab = key('Tab');
    handleDialogKey(tab.event, null, () => undefined);
    expect(tab.calls).toEqual(['stop']);
    const other = key('a');
    handleDialogKey(other.event, null, () => undefined);
    expect(other.calls).toEqual([]);
  });
});
