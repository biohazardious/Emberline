import { describe, expect, it } from 'vitest';
import { answerAttachmentPaths, answerPrompt } from './answer.js';

const R = '\n\nWhen finished, call `ticket_complete`.';
const png = {
  path: '.emberline/attachments/answers/20261023-101500-1-shot.png',
  mimeType: 'image/png',
  sizeBytes: 320 * 1024,
};
const block =
  'Attached files (in your worktree):\n- .emberline/attachments/answers/20261023-101500-1-shot.png (image/png, 320 KB)';

describe('answerPrompt', () => {
  it('blocked: the template around the answer', () => {
    expect(answerPrompt({ kind: 'blocked', text: 'no key\nno access' }, 'use the test key', [], R)).toBe(
      "You reported that you are blocked:\n\n> no key\n> no access\n\nMy answer:\n\nuse the test key\n\nContinue the work with this answer, run the project's checks, commit, and finish." +
        R,
    );
  });
  it('blocked, files only: the answer section holds just the files block', () => {
    expect(answerPrompt({ kind: 'blocked', text: 'no key' }, '', [png], '')).toBe(
      `You reported that you are blocked:\n\n> no key\n\nMy answer:\n\n${block}\n\nContinue the work with this answer, run the project's checks, commit, and finish.`,
    );
  });
  it('a question: the answer as written, then the files', () => {
    expect(answerPrompt({ kind: 'question', text: 'Which?' }, 'green', [png], '')).toBe(`green\n\n${block}`);
  });
  it('files only', () => {
    expect(answerPrompt({ kind: 'question', text: 'Which?' }, '  ', [png], '')).toBe(block);
  });
  it('held: the edited prompt as written, no reminder added twice', () => {
    expect(answerPrompt({ kind: 'held', text: 'the checks failed' }, 'Fix the checks.' + R, [], R)).toBe(
      'Fix the checks.' + R,
    );
  });
});

describe('answerAttachmentPaths', () => {
  it('time, index and a safe name under the answers folder', () => {
    const at = new Date('2026-10-23T10:15:00Z');
    expect(answerAttachmentPaths(['Screen Shot 1.PNG', '../../etc/passwd'], at)).toEqual([
      '.emberline/attachments/answers/20261023-101500-1-Screen-Shot-1.png',
      '.emberline/attachments/answers/20261023-101500-2-passwd',
    ]);
  });
});
