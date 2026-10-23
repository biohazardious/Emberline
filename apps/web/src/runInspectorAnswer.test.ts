// @vitest-environment happy-dom
import type { Run, RunQuestion, RunRecovery } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { RunInspector } from './components/RunInspector';
import { apiRoutes, cleanup, click, getButton, pickFiles, renderDom, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/TerminalView', () => ({
  TerminalView: () => createElement('div', { className: 'test-terminal' }),
}));

const run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  agent: 'claude',
  state: 'done',
  permissionMode: 'default',
  terminalId: 't1',
  worktreePath: '',
  endedAt: '2026-10-18T12:00:00.000Z',
  stateChangedAt: '2026-10-18T12:00:00.000Z',
  resumable: false,
  lastEvent: null,
  attention: { reason: 'held', detail: null, since: '2026-10-18T11:59:00.000Z', occurrence: 'r1:held:e1' },
} as unknown as Run;

const rec: RunRecovery = {
  hold: 'merge_failed',
  label: 'Merge failed',
  why: 'main moved',
  delivery: 'session',
  suggestions: [
    {
      id: 'resolve_conflicts',
      kind: 'prompt',
      label: 'Resolve the conflicts',
      detail: null,
      prompt: 'Merge main and resolve the conflicts.',
      files: [],
      commands: [],
    },
  ],
};

const question: RunQuestion = {
  kind: 'held',
  text: 'main moved',
  source: 'hold',
  options: [],
  picker: false,
  pickerChips: false,
  suggest: { available: false, reason: 'Not for a held run.' },
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/runs/r1/recovery': () => rec,
      'GET /api/runs/r1/question': () => question,
      'GET /api/runs/r1': () => ({ events: [] }),
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const holdBlock = () => document.body.querySelector('section[aria-label="Held run"]');
const tab = (name: string) => getButton(name, document.body.querySelector('[role="tablist"]')!);

describe("RunInspector: the hold block's Answer dialog", () => {
  it('stays with its files on the Terminal tab, where the block is gone, and after switching back', async () => {
    await renderDom(createElement(RunInspector, { run, projectName: 'Shop', onClose: () => undefined }));
    await waitFor(() => expect(holdBlock()).not.toBeNull());
    await click(getButton('Resolve the conflicts'));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await pickFiles(dialog()!.querySelector('input[type="file"]')!, [
      new File(['png'], 'shot.png', { type: 'image/png' }),
    ]);

    await click(tab('Terminal'));
    await waitFor(() => expect(document.body.querySelector('.test-terminal')).not.toBeNull());
    expect(holdBlock()).toBeNull();
    expect(dialog()!.textContent).toContain('shot.png');
    expect(dialog()!.querySelector('textarea')!.value).toBe('Merge main and resolve the conflicts.');

    await click(tab('Split'));
    await waitFor(() => expect(holdBlock()).not.toBeNull());
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain('shot.png');
  });
});
