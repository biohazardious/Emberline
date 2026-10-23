import { describe, expect, it } from 'vitest';
import { ANSWER_LIMITS, AnswerRequest, RunQuestion } from './answers.js';

describe('AnswerRequest', () => {
  it('takes text, attachments, or both', () => {
    expect(AnswerRequest.safeParse({ text: 'use green' }).success).toBe(true);
    expect(
      AnswerRequest.safeParse({
        attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'iVBORw0K' }],
      }).success,
    ).toBe(true);
  });
  it('refuses an empty answer without files', () => {
    const r = AnswerRequest.safeParse({ text: '   ' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Write an answer or attach a file.');
  });
  it('refuses more than ten files', () => {
    const file = { name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' };
    const r = AnswerRequest.safeParse({ text: 'x', attachments: Array(11).fill(file) });
    expect(r.success).toBe(false);
  });
  it('an option index is a small non-negative integer', () => {
    expect(AnswerRequest.safeParse({ option: 2 }).success).toBe(true);
    expect(AnswerRequest.safeParse({ option: -1 }).success).toBe(false);
  });
});

describe('limits', () => {
  it('10 files, 10 MB each, 25 MB in all', () => {
    expect(ANSWER_LIMITS).toEqual({
      maxFiles: 10,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
    });
  });
});

describe('RunQuestion', () => {
  it('parses a blocked question with no options', () => {
    const q = RunQuestion.parse({
      kind: 'blocked',
      text: 'no API key',
      source: 'blockers',
      options: [],
      picker: false,
      pickerChips: false,
      suggest: { available: true, reason: null },
    });
    expect(q.kind).toBe('blocked');
  });
  it('requires pickerChips', () => {
    expect(
      RunQuestion.safeParse({
        kind: 'question',
        text: 'Colour?',
        source: 'ask_user_question',
        options: [],
        picker: true,
        suggest: { available: true, reason: null },
      }).success,
    ).toBe(false);
  });
});
