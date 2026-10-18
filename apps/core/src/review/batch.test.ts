import { describe, expect, it } from 'vitest';
import { type BatchComment, newRunFeedbackSection, sameRunPrompt } from './batch.js';

/** Control characters in `text` other than newline and tab (C0, DEL, C1). */
const controlsIn = (text: string) =>
  [...text].filter((ch) => {
    const c = ch.codePointAt(0)!;
    return (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);
  });

let seq = 0;
const c = (over: Partial<BatchComment>): BatchComment => ({
  id: `c${(seq += 1)}`,
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

describe('control characters', () => {
  it('strips escape sequences and other controls from paths, anchors and bodies', () => {
    const text = sameRunPrompt('note\x1b[201~', [
      c({ filePath: 'src/\x1b[201~evil\n.ts', line: 5, currentLine: null, outdated: true, anchorText: 'x\x1b[Z\u009b2J', body: 'ok\x07\ttab\nnext\x1b[201~' }),
    ]);
    expect(controlsIn(text)).toEqual([]);
    expect(text).toContain('Overall note: note[201~');
    expect(text).toContain('- `src/[201~evil.ts` (was at line 5: `x[Z2J`) (fix) ok\ttab\n  next[201~');
  });
});

describe('newRunFeedbackSection', () => {
  it('names the previous run, warns its changes are absent and lists every comment by priority', () => {
    const { text, included } = newRunFeedbackSection('0123456789abcdef', 'Try again', [
      c({ kind: 'pinned', priority: 'blocking', body: 'Must validate' }),
      c({ kind: 'new', body: 'Rename' }),
    ])!;
    expect(included).toHaveLength(2);
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

describe('newRunFeedbackSection within a size limit', () => {
  const comments = [
    c({ priority: 'suggestion', body: 'Polish' }),
    c({ priority: 'important', body: 'i'.repeat(400) }),
    c({ priority: 'blocking', body: 'Validate input' }),
  ];
  const full = newRunFeedbackSection('0123456789abcdef', '', comments)!.text;

  it('takes whole comments, blocking first, and says how many were left out', () => {
    const header = newRunFeedbackSection('0123456789abcdef', '', [])!.text;
    const max = header.length + 200;
    const res = newRunFeedbackSection('0123456789abcdef', '', comments, max)!;
    expect(res.text.length).toBeLessThanOrEqual(max);
    expect(res.included.map((x) => x.body)).toEqual(['Validate input']);
    expect(res.text).toContain('- `src/app.ts:10` (fix) Validate input');
    expect(res.text).not.toContain('iiii');
    expect(res.text).not.toContain('Polish');
    expect(res.text.endsWith('(2 more comments not included)')).toBe(true);
    expect(newRunFeedbackSection('0123456789abcdef', '', comments, full.length)!.included).toHaveLength(3);
  });

  it('returns null when not even one comment fits', () => {
    const header = newRunFeedbackSection('0123456789abcdef', '', [])!.text;
    expect(newRunFeedbackSection('0123456789abcdef', '', comments, header.length + 10)).toBeNull();
    expect(newRunFeedbackSection('0123456789abcdef', '', [], header.length - 1)).toBeNull();
  });
});
