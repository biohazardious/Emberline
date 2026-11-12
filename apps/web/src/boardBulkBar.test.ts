// @vitest-environment happy-dom
import type { BulkTicketBody, BulkTicketResult } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { BOARD_COLUMNS } from './components/BoardCard';
import { BoardBulkBar } from './components/BoardBulkBar';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const URL = 'POST /api/projects/p1/tickets/bulk';
const sent: BulkTicketBody[] = [];

const empty = (action: BulkTicketResult['action']): BulkTicketResult => ({
  action,
  updated: [],
  removed: [],
  unchanged: [],
  failed: [],
});

function answer(result: (body: BulkTicketBody) => BulkTicketResult): void {
  vi.mocked(api).mockImplementation(
    apiRoutes({
      [URL]: (body) => {
        const parsed = body as BulkTicketBody;
        sent.push(parsed);
        return result(parsed);
      },
    }),
  );
}

async function pick(label: string, value: string): Promise<void> {
  const field = [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
  const select = field?.querySelector('select');
  if (!select) throw new Error(`no ${label} select`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function mount(selection: string[], onApplied = vi.fn(), onExit = vi.fn()) {
  await renderDom(
    createElement(BoardBulkBar, { projectId: 'p1', columns: BOARD_COLUMNS, selection, onApplied, onExit }),
  );
  return { onApplied, onExit };
}

beforeEach(() => {
  sent.length = 0;
});

afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});

describe('BoardBulkBar', () => {
  it('moves, reprioritises and reassigns the picked tickets in one request each', async () => {
    answer((body) => empty(body.action));
    const { onApplied } = await mount(['a', 'b']);
    expect(document.body.textContent).toContain('2 selected');
    await pick('Move to', 'review');
    await pick('Priority', 'Urgent');
    await pick('Persona', 'qa');
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(3));
    expect(sent).toEqual([
      { action: 'move', ids: ['a', 'b'], status: 'review' },
      { action: 'priority', ids: ['a', 'b'], priority: 3 },
      { action: 'persona', ids: ['a', 'b'], persona: 'qa' },
    ]);
  });

  it('asks before deleting and lists the tickets the server left alone', async () => {
    answer(() => ({
      ...empty('delete'),
      removed: ['a'],
      failed: [{ id: 'b', key: 'EL-2', code: 'run_active', message: 'an agent is still working on EL-2' }],
    }));
    const { onApplied } = await mount(['a', 'b']);
    await click(getButton('Delete'));
    expect(sent).toEqual([]);
    expect(document.body.textContent).toContain('Delete 2 tickets?');
    await click(getButton('Delete'));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(sent).toEqual([{ action: 'delete', ids: ['a', 'b'] }]);
    const alert = document.querySelector('.bulk-bar-skipped');
    expect(alert?.textContent).toContain('EL-2 an agent is still working on EL-2');
  });

  it('shows a failed request without calling back', async () => {
    vi.mocked(api).mockImplementation(apiRoutes({}));
    const { onApplied } = await mount(['a']);
    await pick('Move to', 'done');
    await waitFor(() => expect(document.querySelector('.bulk-bar-error')).not.toBeNull());
    expect(document.querySelector('.bulk-bar-error')?.textContent).toMatch(/^Nothing changed:/);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('disables the actions with nothing picked, and Escape leaves selection mode', async () => {
    const { onExit } = await mount([]);
    expect(getButton('Delete').disabled).toBe(true);
    expect([...document.querySelectorAll('select')].every((s) => s.disabled)).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onExit).toHaveBeenCalledOnce();
  });
});
