import type { Run } from '@emberline/protocol';
import type * as React from 'react';
import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RunInspector } from './components/RunInspector';
import { renderStatic } from './staticRender';

// The static render cannot click a tab: the dock's tab state, the only one that starts as 'split',
// starts on the Terminal tab instead, which leaves the Events pane (and the hold block) out.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return {
    ...react,
    useState: vi.fn((init: unknown) => react.useState(init === 'split' ? 'terminal' : init)),
  };
});
// The hold block and its dialog as markers: the dialog is open.
vi.mock('./components/HoldRecovery', () => ({
  HoldRecovery: () => 'HOLD-BLOCK',
  useHoldAnswer: () => ({ open: () => undefined, dialog: 'ANSWER-DIALOG' }),
}));
vi.mock('./components/TerminalView', () => ({ TerminalView: () => null }));

const run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  agent: 'claude',
  state: 'done',
  terminalId: 't1',
  worktreePath: '',
  endedAt: '2026-10-18T12:00:00.000Z',
  resumable: false,
  lastEvent: null,
  attention: { reason: 'held', detail: null, since: '2026-10-18T11:59:00.000Z', occurrence: 'r1:held:e1' },
} as unknown as Run;

describe('RunInspector', () => {
  it("keeps the hold block's Answer dialog on the Terminal tab, where the block itself is gone", () => {
    expect(vi.isMockFunction(useState)).toBe(true);
    const html = renderStatic(
      createElement(RunInspector, { run, projectName: 'Shop', onClose: () => undefined }),
    );
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('HOLD-BLOCK');
    expect(html).toContain('ANSWER-DIALOG');
  });
});
