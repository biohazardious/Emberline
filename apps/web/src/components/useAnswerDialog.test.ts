// @vitest-environment happy-dom
import type { Run, RunQuestion } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '../api';
import type * as ApiModule from '../api';
import { ANSWER_DRAFT_KEY, saveDraft } from '../answerDialog';
import { apiRoutes, cleanup, deferred, renderDom, settle, waitFor } from '../domRender';
import { type AnswerDialogOptions, useAnswerDialog } from './useAnswerDialog';
import { MATERIALS_TOO_LARGE_TEXT } from './wizard/materials';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const run = {
  id: 'r1',
  attention: { reason: 'question', detail: null, since: '2026-10-23T11:00:00.000Z', occurrence: 'r1:q:e1' },
} as unknown as Run;

const question: RunQuestion = {
  kind: 'question',
  text: 'Which colour?',
  source: 'ask_user_question',
  options: [
    { label: 'Red', detail: null },
    { label: 'Green', detail: null },
  ],
  picker: true,
  pickerChips: true,
  suggest: { available: true, reason: null },
};

type Dialog = ReturnType<typeof useAnswerDialog>;
let dialog: Dialog;
function Harness(props: AnswerDialogOptions) {
  dialog = useAnswerDialog(props);
  return null;
}

/** What the person did and what core was asked, in order. */
let calls: string[];
let answer: (body: unknown) => unknown;
let suggestion: () => unknown;

async function open(q: RunQuestion = question, props: Partial<AnswerDialogOptions> = {}) {
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/runs/r1/question': () => q,
      'POST /api/runs/r1/answer': (body) => {
        calls.push(`answer ${JSON.stringify(body)}`);
        return answer(body);
      },
      'POST /api/runs/r1/question/suggest': () => suggestion(),
    }),
  );
  await renderDom(
    createElement(Harness, {
      run,
      onClose: () => calls.push('onClose'),
      onSent: () => calls.push('onSent'),
      ...props,
    }),
  );
  await waitFor(() => expect(dialog.question).toEqual(q));
}

const file = (name: string) => ({ file: new File(['bytes'], name, { type: 'image/png' }), name });

beforeEach(() => {
  calls = [];
  answer = () => ({ delivery: 'picker' });
  suggestion = () => ({ answer: 'Green' });
  localStorage.clear();
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('useAnswerDialog: sending', () => {
  it('posts the answer, clears the draft, then calls onSent before onClose', async () => {
    await open();
    await act(async () => dialog.onText('Blue, please'));
    expect(localStorage.getItem(ANSWER_DRAFT_KEY('r1'))).not.toBeNull();
    await act(async () => dialog.onSend());
    await waitFor(() => expect(calls).toContain('onClose'));
    expect(calls).toEqual(['answer {"text":"Blue, please","attachments":[]}', 'onSent', 'onClose']);
    expect(localStorage.getItem(ANSWER_DRAFT_KEY('r1'))).toBeNull();
  });

  it('a second Send before the first one answered posts nothing more', async () => {
    const pending = deferred<unknown>();
    answer = () => pending.promise;
    await open();
    await act(async () => dialog.onText('Blue'));
    await act(async () => {
      dialog.onSend();
      dialog.onSend();
    });
    expect(dialog.busy).toBe(true);
    expect(calls.filter((c) => c.startsWith('answer'))).toHaveLength(1);
    await act(async () => pending.reject(new ApiRequestError(409, 'run_busy', 'busy')));
    await waitFor(() => expect(dialog.busy).toBe(false));
    // Once that send failed, the next one goes out.
    answer = () => ({ delivery: 'picker' });
    await act(async () => dialog.onSend());
    await waitFor(() => expect(calls.filter((c) => c.startsWith('answer'))).toHaveLength(2));
  });

  it('a chip clicked while its answer goes out sends nothing more and leaves the box alone', async () => {
    const pending = deferred<unknown>();
    answer = () => pending.promise;
    await open();
    await act(async () => {
      dialog.onOption(0);
      dialog.onOption(1);
      dialog.onSend();
    });
    expect(dialog.busy).toBe(true);
    expect(calls).toEqual(['answer {"option":0}']);
    expect(dialog.text).toBe('');
    await act(async () => pending.resolve({ delivery: 'picker' }));
    await waitFor(() => expect(calls).toEqual(['answer {"option":0}', 'onSent', 'onClose']));
  });

  it('a 413 with files attached says the files are too large; without files it is the server text', async () => {
    answer = () => {
      throw new ApiRequestError(413, 'http_error', 'Payload Too Large');
    };
    await open();
    await act(async () => dialog.onFiles([file('shot.png')]));
    expect(dialog.files).toHaveLength(1);
    await act(async () => dialog.onSend());
    await waitFor(() => expect(dialog.error).toBe(MATERIALS_TOO_LARGE_TEXT));
    expect(dialog.busy).toBe(false);
    expect(calls).not.toContain('onClose');

    await act(async () => dialog.onRemoveFile(dialog.files[0]!.id));
    await act(async () => dialog.onText('Blue'));
    await act(async () => dialog.onSend());
    await waitFor(() => expect(dialog.error).toBe('Payload Too Large'));
  });

  it("core's refusal codes are worded for the person", async () => {
    answer = () => {
      throw new ApiRequestError(409, 'no_question', 'run is not waiting');
    };
    await open();
    await act(async () => dialog.onText('Blue'));
    await act(async () => dialog.onSend());
    await waitFor(() =>
      expect(dialog.error).toBe('This run is not waiting for an answer any more. Your draft is kept.'),
    );
  });
});

describe('useAnswerDialog: option chips', () => {
  it("with nothing typed, a chip answers Claude's picker by its number", async () => {
    await open();
    await act(async () => dialog.onOption(1));
    await waitFor(() => expect(calls).toEqual(['answer {"option":1}', 'onSent', 'onClose']));
  });

  it('with an answer typed, a chip goes into the box, and the next chip replaces it', async () => {
    await open();
    await act(async () => dialog.onText('Blue first'));
    await act(async () => dialog.onOption(0));
    expect(dialog.text).toBe('Blue first\nRed');
    await act(async () => dialog.onOption(1));
    expect(dialog.text).toBe('Blue first\nGreen');
    expect(calls).toEqual([]);
  });

  it('with files attached, a chip goes into the box so the files are not dropped', async () => {
    await open();
    await act(async () => dialog.onFiles([file('shot.png')]));
    await act(async () => dialog.onOption(0));
    expect(dialog.text).toBe('Red');
    expect(calls).toEqual([]);
  });

  it('when the numbers may not match, a chip only fills the box', async () => {
    await open({ ...question, pickerChips: false });
    await act(async () => dialog.onOption(0));
    expect(dialog.text).toBe('Red');
    expect(calls).toEqual([]);
  });
});

describe('useAnswerDialog: suggestions', () => {
  it('fills an empty box, and asks before replacing a typed answer', async () => {
    await open();
    await act(async () => dialog.onSuggest());
    await waitFor(() => expect(dialog.text).toBe('Green'));
    expect(dialog.confirmReplace).toBe(false);

    await act(async () => dialog.onText('Blue'));
    await act(async () => dialog.onSuggest());
    await waitFor(() => expect(dialog.confirmReplace).toBe(true));
    expect(dialog.text).toBe('Blue');
    await act(async () => dialog.onReplace());
    expect(dialog.text).toBe('Green');
  });

  it('one that lands after the dialog closed changes nothing and writes no draft', async () => {
    const pending = deferred<unknown>();
    suggestion = () => pending.promise;
    await open();
    await act(async () => dialog.onSuggest());
    expect(dialog.suggesting).toBe(true);
    await act(async () => dialog.onClose());
    expect(calls).toEqual(['onClose']);
    await act(async () => pending.resolve({ answer: 'Green' }));
    await settle();
    expect(dialog.text).toBe('');
    expect(dialog.confirmReplace).toBe(false);
    expect(localStorage.getItem(ANSWER_DRAFT_KEY('r1'))).toBeNull();
  });

  it('one that lands after the answer went out does not write a draft for the next open', async () => {
    const pending = deferred<unknown>();
    suggestion = () => pending.promise;
    await open();
    await act(async () => dialog.onSuggest());
    await act(async () => dialog.onOption(0));
    await waitFor(() => expect(calls).toContain('onClose'));
    await act(async () => pending.resolve({ answer: 'Green' }));
    expect(localStorage.getItem(ANSWER_DRAFT_KEY('r1'))).toBeNull();
  });

  it('opens with the draft kept from last time', async () => {
    saveDraft('r1', 'half typed');
    await open();
    expect(dialog.text).toBe('half typed');
  });
});
