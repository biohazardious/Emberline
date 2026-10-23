import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AnswerDialogView } from './components/AnswerDialog';
import { renderStatic } from './staticRender';

const q = {
  kind: 'question' as const,
  text: 'Which colour?',
  source: 'last_message' as const,
  options: [
    { label: 'Red', detail: null },
    { label: 'Green', detail: 'cooler' },
  ],
  picker: false,
  suggest: { available: false, reason: 'Claude Code is not signed in.' },
};
const view = (over: object = {}) =>
  renderStatic(
    createElement(AnswerDialogView, {
      heading: { key: 'EL-1', title: 'Pick a colour' },
      question: q,
      text: '',
      files: [],
      problems: [],
      busy: false,
      suggesting: false,
      error: null,
      onText: () => {},
      onOption: () => {},
      onSuggest: () => {},
      onFiles: () => {},
      onRemoveFile: () => {},
      onSend: () => {},
      onCancel: () => {},
      ...over,
    }),
  );

describe('AnswerDialogView', () => {
  it('shows the question, the chips and why Suggest is off', () => {
    const html = view();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('EL-1');
    expect(html).toContain('Which colour?');
    expect(html).toContain('>Red<');
    expect(html).toContain('Claude Code is not signed in.');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Suggest an answer/);
  });
  it('Send is off without text or files', () => {
    expect(view()).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(view({ text: 'green' })).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
  it('a permission prompt offers the terminal, no chips', () => {
    const html = view({
      question: { ...q, kind: 'permission', options: [], text: 'Claude needs permission to use Bash' },
    });
    expect(html).toContain('Open terminal');
    expect(html).not.toContain('>Red<');
    expect(html).not.toContain('Suggest an answer');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<input type="file"[^>]*disabled/);
  });
  it('a permission prompt keeps Send off even with text', () => {
    const html = view({ text: 'yes', question: { ...q, kind: 'permission', options: [] } });
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
  it('while sending, chips and Attach files are off', () => {
    const html = view({ text: 'green', busy: true });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Red</);
    expect(html).toMatch(/<input type="file"[^>]*disabled/);
  });
  it('the Replace / Keep bar does not take focus', () => {
    expect(view({ text: 'blue', confirmReplace: true })).not.toMatch(/autofocus[^>]*>Keep</i);
  });
  it('lists the attached files with the cap line', () => {
    const file = {
      id: 'm1',
      file: new Blob(['x']),
      name: 'shot.png',
      sizeBytes: 1,
      mimeType: 'image/png',
      kind: 'image' as const,
    };
    expect(view({ files: [file] })).toContain('shot.png');
    expect(view({ files: [file] })).toContain('1 of 10 files');
  });
  it('shows the error', () => {
    expect(view({ error: 'This run is not waiting for an answer any more. Your draft is kept.' })).toContain(
      'role="alert"',
    );
  });
  it('asks before a suggestion replaces a typed answer', () => {
    const html = view({ text: 'blue', confirmReplace: true });
    expect(html).toContain('Replace your answer?');
    expect(html).toMatch(/>Replace</);
    expect(html).toMatch(/>Keep</);
    expect(view({ text: 'blue' })).not.toContain('Replace your answer?');
  });
  it('closing with files says they are not kept', () => {
    const file = {
      id: 'm1',
      file: new Blob(['x']),
      name: 'a.pdf',
      sizeBytes: 1,
      mimeType: 'application/pdf',
      kind: 'pdf' as const,
    };
    expect(view({ text: 'blue', confirmClose: true })).toContain('Your answer stays as a draft.');
    expect(view({ files: [file], confirmClose: true })).toContain('the attached files are not kept');
  });
});
