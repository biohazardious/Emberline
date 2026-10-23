import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAnswerFiles,
  ANSWER_DRAFT_KEY,
  answerErrorText,
  canSend,
  clearDraft,
  loadDraft,
  saveDraft,
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
    expect(answerErrorText('not_held', 'x')).toBe(
      'This run is not waiting for an answer any more. Your draft is kept.',
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
