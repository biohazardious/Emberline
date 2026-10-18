import { describe, expect, it } from 'vitest';
import { type BatchComment, newRunFeedbackSection, sameRunPrompt } from './batch.js';

const c = (over: Partial<BatchComment>): BatchComment => ({
  filePath: 'src/app.ts',
  line: 10,
  currentLine: 10,
  outdated: false,
  side: 'modified',
  intent: 'fix',
  priority: 'important',
  body: 'Handle the empty list',
  anchorText: 'const x = list[0];',
  kind: 'new',
  ...over,
});

describe('sameRunPrompt', () => {
  it('puts the note first and groups comments by priority with the blocking intro', () => {
    const text = sameRunPrompt('Nearly there', [
      c({ priority: 'suggestion', body: 'Maybe rename', intent: 'change', line: 3, currentLine: 3 }),
      c({ priority: 'blocking', body: 'Null deref' }),
      c({ priority: 'important', filePath: 'README.md', line: null, currentLine: null, anchorText: null, intent: 'question', body: 'Why?' }),
    ]);
    expect(text).toBe(
      [
        'Please address the following code review feedback on this branch:',
        '',
        'Overall note: Nearly there',
        '',
        'Blocking — Must be fixed before this can merge:',
        '- `src/app.ts:10` (fix) Null deref',
        '',
        'Important:',
        '- `README.md` (whole file) (question) Why?',
        '',
        'Suggestions:',
        '- `src/app.ts:3` (change) Maybe rename',
      ].join('\n'),
    );
  });

  it('lists pinned comments from the previous round and reminders under their own headings', () => {
    const text = sameRunPrompt('', [
      c({ kind: 'pinned', body: 'Was this done?', line: 4, currentLine: 4 }),
      c({ kind: 'new', body: 'Fresh one', line: 20, currentLine: 20 }),
      c({ kind: 'reminder', body: 'Still waiting', line: 8, currentLine: 8 }),
    ]);
    expect(text).toBe(
      [
        'Please address the following code review feedback on this branch:',
        '',
        'Important:',
        '- `src/app.ts:20` (fix) Fresh one',
        'From the previous round — not yet addressed:',
        '- `src/app.ts:8` (fix) Still waiting',
        'From the previous round — please check this is done:',
        '- `src/app.ts:4` (fix) Was this done?',
      ].join('\n'),
    );
  });

  it('shows the current line of a moved comment, and the old line and code of an outdated one', () => {
    const text = sameRunPrompt('', [
      c({ line: 10, currentLine: 14, body: 'moved' }),
      c({ line: 30, currentLine: null, outdated: true, anchorText: 'return `x`;', body: 'gone' }),
      c({ line: 5, currentLine: 5, side: 'original', body: 'old code' }),
    ]);
    expect(text).toContain('- `src/app.ts:14` (fix) moved');
    expect(text).toContain('- `src/app.ts` (was at line 30: ``return `x`;``) (fix) gone');
    expect(text).toContain('- `src/app.ts:5` (removed code) (fix) old code');
  });

  it('indents the continuation lines of a multi-line body', () => {
    expect(sameRunPrompt('', [c({ body: 'first\nsecond' })])).toContain('- `src/app.ts:10` (fix) first\n  second');
  });
});

describe('newRunFeedbackSection', () => {
  it('names the previous run, warns its changes are absent and lists every comment by priority', () => {
    const text = newRunFeedbackSection('0123456789abcdef', 'Try again', [
      c({ kind: 'pinned', priority: 'blocking', body: 'Must validate' }),
      c({ kind: 'new', body: 'Rename' }),
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('## Review feedback from the previous attempt (run 01234567)');
    expect(text).toContain('not in this worktree');
    expect(text).toContain('Overall note: Try again');
    expect(text).toContain('Blocking — Must be fixed before this can merge:\n- `src/app.ts:10` (fix) Must validate');
    expect(text).toContain('Important:\n- `src/app.ts:10` (fix) Rename');
    // A fresh run has no previous round of its own to check.
    expect(text).not.toContain('From the previous round');
  });
});
