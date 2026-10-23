import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAnswerFiles,
  ANSWER_DRAFT_KEY,
  answerErrorText,
  answerOffered,
  answerProblems,
  answerTarget,
  canSend,
  chipAnswers,
  chipSends,
  clearDraft,
  handleDialogKey,
  loadDraft,
  optionChoice,
  refreshAfterAnswer,
  saveDraft,
  startText,
  suggestionAction,
  withOption,
} from './answerDialog';
import { droppedFiles } from './components/wizard/materials';
import { questionQuery } from './components/useAnswerDialog';

type Stub = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  key?: (i: number) => string | null;
  readonly length?: number;
};
const g = globalThis as unknown as { localStorage?: Stub };

function memoryStore(): Stub {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

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

  it('drops drafts older than 14 days on load; other keys stay', () => {
    g.localStorage!.setItem('emberline.theme', 'dark');
    saveDraft('old', 'stale', NOW - 15 * DAY);
    saveDraft('recent', 'keep', NOW - 13 * DAY);
    expect(loadDraft('r1', NOW)).toBe('');
    expect(g.localStorage!.getItem(ANSWER_DRAFT_KEY('old'))).toBeNull();
    expect(loadDraft('recent', NOW)).toBe('keep');
    expect(loadDraft('r1', NOW + 2 * DAY)).toBe('');
    expect(g.localStorage!.getItem(ANSWER_DRAFT_KEY('recent'))).toBeNull();
    expect(g.localStorage!.getItem('emberline.theme')).toBe('dark');
  });

  it('a keystroke saves its own draft only: it does not scan the others', () => {
    saveDraft('old', 'stale', NOW - 15 * DAY);
    let scans = 0;
    const s = g.localStorage!;
    g.localStorage = {
      ...s,
      get length() {
        return s.length;
      },
      key: (i) => {
        scans++;
        return s.key!(i);
      },
    };
    saveDraft('r1', 'typing', NOW);
    expect(scans).toBe(0);
    expect(s.getItem(ANSWER_DRAFT_KEY('old'))).not.toBeNull();
  });

  it('reads a draft kept as plain text before 0.6.1, which then expires 14 days on', () => {
    g.localStorage!.setItem(ANSWER_DRAFT_KEY('r1'), 'typed in 0.6.0');
    g.localStorage!.setItem(ANSWER_DRAFT_KEY('r2'), '42');
    expect(loadDraft('r1', NOW)).toBe('typed in 0.6.0');
    expect(loadDraft('r2', NOW)).toBe('42');
    expect(loadDraft('r1', NOW + 13 * DAY)).toBe('typed in 0.6.0');
    expect(loadDraft('r1', NOW + 15 * DAY)).toBe('');
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

describe('chipSends', () => {
  const chips = { picker: true, pickerChips: true };
  const file = {
    id: 'm1',
    file: new Blob(['x']),
    name: 'a.txt',
    sizeBytes: 1,
    mimeType: 'text/plain',
    kind: 'other' as const,
  };
  it('answers the picker by its number only with nothing typed or attached, which it would drop', () => {
    expect(chipSends(chips, '', [])).toBe(true);
    expect(chipSends(chips, '  ', [])).toBe(true);
    expect(chipSends(chips, 'and make it bright', [])).toBe(false);
    expect(chipSends(chips, '', [file])).toBe(false);
    expect(chipSends({ picker: true, pickerChips: false }, '', [])).toBe(false);
  });
});

describe('withOption', () => {
  it('fills an empty box and adds to a typed answer on a line of its own', () => {
    expect(withOption('', 'Red', null)).toBe('Red');
    expect(withOption('make it bright\n', 'Red', null)).toBe('make it bright\nRed');
  });
  it('a second chip swaps the label the first one put on the last line, so one option goes out', () => {
    expect(withOption('Red', 'Green', 'Red')).toBe('Green');
    expect(withOption('make it bright\nRed', 'Green', 'Red')).toBe('make it bright\nGreen');
    expect(withOption('make it bright\nRed \n', 'Green', 'Red')).toBe('make it bright\nGreen');
  });
  it('keeps what the person wrote: a label they typed, or one they wrote on after', () => {
    expect(withOption('I like Red', 'Green', 'Red')).toBe('I like Red\nGreen');
    expect(withOption('Red', 'Green', null)).toBe('Red\nGreen');
    expect(withOption('Red\nbut darker', 'Green', 'Red')).toBe('Red\nbut darker\nGreen');
  });
});

describe('optionChoice', () => {
  const options = [
    { label: 'Red', detail: null },
    { label: 'Green', detail: null },
  ];
  const chips = { picker: true, pickerChips: true, options };
  const file = {
    id: 'm1',
    file: new Blob(['x']),
    name: 'a.txt',
    sizeBytes: 1,
    mimeType: 'text/plain',
    kind: 'other' as const,
  };
  it("sends the number to Claude's picker only with nothing typed or attached", () => {
    expect(optionChoice(chips, 1, '', [], null)).toEqual({ send: true });
    expect(optionChoice(chips, 1, 'and bright', [], null)).toEqual({
      send: false,
      text: 'and bright\nGreen',
      placed: 'Green',
    });
    expect(optionChoice(chips, 1, '', [file], null)).toEqual({ send: false, text: 'Green', placed: 'Green' });
  });
  it('fills the box without a picker that takes numbers, swapping the last chip', () => {
    const plain = { picker: false, pickerChips: false, options };
    expect(optionChoice(plain, 0, '', [], null)).toEqual({ send: false, text: 'Red', placed: 'Red' });
    expect(optionChoice(plain, 1, 'Red', [], 'Red')).toEqual({ send: false, text: 'Green', placed: 'Green' });
  });
  it('an option that is not there does nothing', () => {
    expect(optionChoice(chips, 5, '', [], null)).toBeNull();
  });
});

describe('answerProblems', () => {
  it('the same sentence again gets a new id, so a screen reader hears it again', () => {
    const [a] = answerProblems(['pictures is a folder.']);
    const [b] = answerProblems(['pictures is a folder.']);
    expect(a!.text).toBe(b!.text);
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('questionQuery', () => {
  const run = (occurrence: string) =>
    ({
      id: 'r1',
      attention: { reason: 'question', detail: null, since: '2026-10-23T10:00:00.000Z', occurrence },
    }) as never;
  it('is per question, and kept no longer than the dialog shows it', () => {
    expect(questionQuery(run('r1:question:e1')).queryKey).not.toEqual(
      questionQuery(run('r1:question:e2')).queryKey,
    );
    expect(questionQuery(run('r1:question:e1')).queryKey.slice(0, 2)).toEqual(['run-question', 'r1']);
    expect(questionQuery(run('r1:question:e1')).gcTime).toBe(0);
  });
});

describe('refreshAfterAnswer', () => {
  it("refetches the run's recovery and drops every copy of its question", () => {
    const client = new QueryClient();
    client.setQueryData(['run-recovery', 'r1'], { label: 'Held' });
    client.setQueryData(['run-question', 'r1', 'r1:question:e1'], { text: 'Which?' });
    client.setQueryData(['run-question', 'r2', 'r2:question:e1'], { text: 'Other' });
    refreshAfterAnswer(client, 'r1');
    expect(client.getQueryState(['run-recovery', 'r1'])?.isInvalidated).toBe(true);
    expect(client.getQueryData(['run-question', 'r1', 'r1:question:e1'])).toBeUndefined();
    expect(client.getQueryData(['run-question', 'r2', 'r2:question:e1'])).toEqual({ text: 'Other' });
  });
});

describe('droppedFiles', () => {
  it('marks a dropped folder so it is refused, not sent as an empty file', () => {
    const entry = (isDirectory: boolean) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory }) });
    const data = {
      files: [new File(['x'], 'a.txt'), new File([], 'pictures')],
      items: [{ kind: 'string', webkitGetAsEntry: () => null }, entry(false), entry(true)],
    } as unknown as DataTransfer;
    const candidates = droppedFiles(data);
    expect(candidates.map((c) => [c.name, c.isFolder])).toEqual([
      ['a.txt', false],
      ['pictures', true],
    ]);
    const { added, problems } = addAnswerFiles([], candidates);
    expect(added.map((m) => m.name)).toEqual(['a.txt']);
    expect(problems).toEqual(['pictures is a folder. Add the files inside it instead.']);
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
