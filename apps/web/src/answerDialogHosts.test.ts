// @vitest-environment happy-dom
import type { Run, RunQuestion, RunRecovery } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { HoldRecovery } from './components/HoldRecovery';
import { apiRoutes, cleanup, click, getButton, pickFiles, renderDom, waitFor } from './domRender';
import { InboxPage } from './pages/InboxPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const held = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  agent: 'claude',
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

/** The recovery core answers with now; a refetch picks up a change. */
let recovery: RunRecovery | null;
let recoveryReads: number;
let answers: unknown[];

beforeEach(() => {
  recovery = rec;
  recoveryReads = 0;
  answers = [];
  localStorage.clear();
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/runs/r1/recovery': () => {
        recoveryReads++;
        return recovery;
      },
      'GET /api/runs/r1/question': () => question,
      'POST /api/runs/r1/answer': (body) => {
        answers.push(body);
        return { delivery: 'session' };
      },
      'GET /api/projects': () => [],
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const holdBlock = () => document.body.querySelector('section[aria-label="Held run"]');

/** Opens the dialog from the hold block's suggestion and attaches a file to it. */
async function answerFromBlock() {
  await waitFor(() => expect(holdBlock()).not.toBeNull());
  await click(getButton('Resolve the conflicts'));
  await waitFor(() => expect(dialog()).not.toBeNull());
  expect(dialog()!.querySelector('textarea')!.value).toBe('Merge main and resolve the conflicts.');
  await pickFiles(dialog()!.querySelector('input[type="file"]')!, [
    new File(['png'], 'shot.png', { type: 'image/png' }),
  ]);
  expect(dialog()!.textContent).toContain('shot.png');
}

describe("HoldRecovery's own Answer dialog (the ticket drawer's)", () => {
  it('outlives the block: a refetch that ends the hold keeps the dialog and its files', async () => {
    const view = await renderDom(createElement(HoldRecovery, { run: held }));
    await answerFromBlock();
    recovery = null;
    await view.client.invalidateQueries({ queryKey: ['run-recovery', 'r1'] });
    await waitFor(() => expect(holdBlock()).toBeNull());
    expect(dialog()!.textContent).toContain('shot.png');
  });

  it('outlives the block when the run stops waiting', async () => {
    const view = await renderDom(createElement(HoldRecovery, { run: held }));
    await answerFromBlock();
    await view.rerender(createElement(HoldRecovery, { run: { ...held, attention: null } }));
    expect(holdBlock()).toBeNull();
    expect(dialog()!.textContent).toContain('shot.png');
  });

  it('once sent, closes and refetches the recovery', async () => {
    await renderDom(createElement(HoldRecovery, { run: held }));
    await answerFromBlock();
    const reads = recoveryReads;
    await click(getButton('Send', dialog()!));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(answers).toHaveLength(1);
    await waitFor(() => expect(recoveryReads).toBe(reads + 1));
  });
});

describe('Inbox Answer dialog', () => {
  const inbox = (runs: Run[]) =>
    createElement(InboxPage, {
      runs,
      seen: {},
      activeProjectId: null,
      onOpenRun: () => undefined,
      onDismiss: () => undefined,
    });

  it("opened from the item's hold block, it stays with its files when the run leaves the list", async () => {
    const view = await renderDom(inbox([held]), { path: '/inbox' });
    await answerFromBlock();
    await view.rerender(inbox([]));
    expect(document.body.textContent).toContain('Nothing needs you right now.');
    expect(dialog()!.textContent).toContain('shot.png');
  });

  it('opened by Answer, it stays when the run waits again (the item remounts)', async () => {
    const view = await renderDom(inbox([held]), { path: '/inbox' });
    await click(getButton('Answer'));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await pickFiles(dialog()!.querySelector('input[type="file"]')!, [new File(['%PDF'], 'spec.pdf')]);
    const again = { ...held, attention: { ...held.attention!, occurrence: 'r1:held:e2' } } as Run;
    await view.rerender(inbox([again]));
    expect(dialog()!.textContent).toContain('spec.pdf');
  });

  it('once sent, closes and refetches the recovery', async () => {
    await renderDom(inbox([held]), { path: '/inbox' });
    await answerFromBlock();
    const reads = recoveryReads;
    await click(getButton('Send', dialog()!));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(answers).toHaveLength(1);
    await waitFor(() => expect(recoveryReads).toBe(reads + 1));
  });
});
