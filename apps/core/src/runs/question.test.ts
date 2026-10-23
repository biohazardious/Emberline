import type { AskUserQuestionSummary } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import { askUserQuestionOf, buildRunQuestion, openPicker, parseOptions } from './question.js';

const base = { blockers: [], pendingAsk: null, lastMessage: null, notification: null, holdWhy: null };
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('parseOptions', () => {
  it('reads a numbered list after a question', () => {
    expect(parseOptions('Which colour should I use?\n\n1. Red\n2. **Green**\n3. Blue')).toEqual([
      { label: 'Red', detail: null },
      { label: 'Green', detail: null },
      { label: 'Blue', detail: null },
    ]);
  });
  it('reads lettered options before a closing question', () => {
    expect(
      parseOptions('Two ways:\nA) Keep the cache\nB) Drop it\n\nWhich do you prefer?').map((o) => o.label),
    ).toEqual(['Keep the cache', 'Drop it']);
  });
  it('no options in prose without a question', () => {
    expect(parseOptions('I did this:\n1. Added tests\n2. Fixed lint\n\nAll done.')).toEqual([]);
  });
  it('no options when there is no list', () => {
    expect(parseOptions('Should I use green?')).toEqual([]);
  });
  it('a leading question that ends in "?:" still offers the list', () => {
    expect(parseOptions('Which colour should I use?:\n1. Red\n2. Blue').map((o) => o.label)).toEqual([
      'Red',
      'Blue',
    ]);
  });
  it('a "?" in the middle of the message does not make the list an offer', () => {
    expect(parseOptions('Is it done? Here is what changed:\n1. Added tests\n2. Fixed lint')).toEqual([]);
  });
  it('at most six, each clipped to 200 characters', () => {
    const items = Array.from({ length: 8 }, (_, i) => `${i + 1}. ${'x'.repeat(300)}`).join('\n');
    const out = parseOptions(`Pick one?\n${items}`);
    expect(out).toHaveLength(6);
    expect(out[0]!.label.length).toBe(200);
  });
  it('a clip never splits an emoji', () => {
    const [option] = parseOptions(`Pick one?\n1. ${'x'.repeat(199)}\u{1F600} and more`);
    expect(option!.label).toBe('x'.repeat(199));
    expect(option!.label).not.toMatch(loneSurrogate);
  });
});

describe('askUserQuestionOf', () => {
  it('keeps questions, headers and options', () => {
    expect(
      askUserQuestionOf({
        questions: [
          {
            question: 'Which colour?',
            header: 'Colour',
            multiSelect: false,
            options: [
              { label: 'Red', description: 'warm' },
              { label: 'Green', description: '' },
            ],
          },
        ],
      }),
    ).toEqual({
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multiSelect: false,
          options: [
            { label: 'Red', detail: 'warm' },
            { label: 'Green', detail: null },
          ],
        },
      ],
      complete: true,
    });
  });
  it('keeps multiSelect and notes a left-out option or question', () => {
    expect(
      askUserQuestionOf({
        questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
      }),
    ).toMatchObject({ questions: [{ multiSelect: true }], complete: true });
    expect(
      askUserQuestionOf({ questions: [{ question: 'Which?', options: [{ label: '' }, { label: 'B' }] }] }),
    ).toMatchObject({ questions: [{ options: [{ label: 'B' }] }], complete: false });
    expect(
      askUserQuestionOf({ questions: [{ question: '' }, { question: 'Which?', options: [] }] }),
    ).toMatchObject({ questions: [{ question: 'Which?' }], complete: false });
  });
  it('keeps at most six options of a question', () => {
    const options = Array.from({ length: 8 }, (_, i) => ({ label: `Option ${i + 1}` }));
    const ask = askUserQuestionOf({ questions: [{ question: 'Which?', options }] });
    expect(ask!.questions[0]!.options.map((o) => o.label)).toEqual(options.slice(0, 6).map((o) => o.label));
  });
  it('null for anything else', () => {
    expect(askUserQuestionOf({ questions: 'x' })).toBeNull();
    expect(askUserQuestionOf(null)).toBeNull();
  });
  it('skips entries that are not objects, and notes them as left out', () => {
    expect(askUserQuestionOf({ questions: [null] })).toBeNull();
    expect(
      askUserQuestionOf({
        questions: [null, 7, { question: 'Which?', options: [null, 'A', { label: 'B' }] }],
      }),
    ).toEqual({
      questions: [
        { question: 'Which?', header: null, multiSelect: false, options: [{ label: 'B', detail: null }] },
      ],
      complete: false,
    });
  });
});

describe('openPicker', () => {
  const picker = {
    type: 'PreToolUse',
    payload: {
      tool_name: 'AskUserQuestion',
      ask_user_question: {
        questions: [{ question: 'Colour?', header: null, multiSelect: false, options: [] }],
      },
    },
  };
  it('a picker with nothing after it is open', () => {
    expect(openPicker([picker])?.questions[0]!.question).toBe('Colour?');
  });
  it('the end of the session closes it', () => {
    expect(openPicker([{ type: 'SessionEnd', payload: {} }, picker])).toBeNull();
  });
});

const ask = (
  questions: { question: string; multiSelect: boolean }[],
  complete = true,
): AskUserQuestionSummary => ({
  questions: questions.map((q) => ({ ...q, header: null, options: [{ label: 'Red', detail: null }] })),
  complete,
});

describe('buildRunQuestion', () => {
  it('blocked: the blockers, one per line', () => {
    expect(buildRunQuestion({ ...base, reason: 'blocked', blockers: ['no key', 'no access'] })).toEqual({
      kind: 'blocked',
      text: 'no key\nno access',
      source: 'blockers',
      options: [],
      picker: false,
      pickerChips: false,
    });
  });
  it('question: an open picker wins over the last message', () => {
    const q = buildRunQuestion({
      ...base,
      reason: 'question',
      lastMessage: 'Which one?\n1. A\n2. B',
      pendingAsk: ask([{ question: 'Colour?', multiSelect: false }]),
    });
    expect(q).toMatchObject({
      source: 'ask_user_question',
      text: 'Colour?',
      picker: true,
      pickerChips: true,
    });
    expect(q.options).toEqual([{ label: 'Red', detail: null }]);
  });
  it('question: chips pick by number only for one single-choice question with every option listed', () => {
    const chips = (pendingAsk: AskUserQuestionSummary) =>
      buildRunQuestion({ ...base, reason: 'question', pendingAsk }).pickerChips;
    expect(chips(ask([{ question: 'Colour?', multiSelect: false }]))).toBe(true);
    expect(
      chips(
        ask([
          { question: 'Colour?', multiSelect: false },
          { question: 'Size?', multiSelect: false },
        ]),
      ),
    ).toBe(false);
    expect(chips(ask([{ question: 'Colours?', multiSelect: true }]))).toBe(false);
    expect(chips(ask([{ question: 'Colour?', multiSelect: false }], false))).toBe(false);
  });
  it('question: a picker of several questions offers no options (a chip would not say which it answers)', () => {
    const q = buildRunQuestion({
      ...base,
      reason: 'question',
      pendingAsk: ask([
        { question: 'Colour?', multiSelect: false },
        { question: 'Size?', multiSelect: false },
      ]),
    });
    expect(q).toMatchObject({ text: 'Colour?\nSize?', picker: true, pickerChips: false, options: [] });
    expect(
      buildRunQuestion({
        ...base,
        reason: 'question',
        pendingAsk: ask([{ question: 'Colours?', multiSelect: true }]),
      }).options,
    ).toEqual([{ label: 'Red', detail: null }]);
  });
  it('question: the last message with its options, else the notification', () => {
    expect(
      buildRunQuestion({ ...base, reason: 'question', lastMessage: 'Which one?\n1. A\n2. B' }),
    ).toMatchObject({
      source: 'last_message',
      options: [
        { label: 'A', detail: null },
        { label: 'B', detail: null },
      ],
    });
    expect(
      buildRunQuestion({ ...base, reason: 'question', notification: 'Claude is waiting for your input' }),
    ).toMatchObject({ source: 'notification', text: 'Claude is waiting for your input', options: [] });
  });
  it('permission: the notification, no options', () => {
    expect(
      buildRunQuestion({
        ...base,
        reason: 'permission',
        notification: 'Claude needs permission to use Bash',
      }),
    ).toEqual({
      kind: 'permission',
      text: 'Claude needs permission to use Bash',
      source: 'notification',
      options: [],
      picker: false,
      pickerChips: false,
    });
  });
  it('held: the recovery why', () => {
    expect(
      buildRunQuestion({ ...base, reason: 'held', holdWhy: 'the checks failed: 2 tests' }),
    ).toMatchObject({
      kind: 'held',
      source: 'hold',
      text: 'the checks failed: 2 tests',
    });
  });
});
