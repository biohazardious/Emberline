// @vitest-environment happy-dom
import type { Ticket, TicketStatus } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom } from './domRender';
import { TicketDrawer } from './pages/BoardPage';
import { DrawerMergeError } from './reviewComments';

// Nothing the drawer reads on its own matters here; every read fails as a 404.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
// Monaco needs a browser build; the drawer's details tab never opens an editor.
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const ticket = (status: TicketStatus): Ticket => ({
  id: 't1',
  projectId: 'p1',
  key: 'EL-1',
  title: 'Checkout',
  body: '',
  persona: 'coder',
  status,
  priority: 1,
  position: 1024,
  depth: 0,
  dependsOn: [],
  blockedBy: [],
  completion: null,
  external: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
});

const BLOCKED = '1 blocking comment is open.';
const onAccept = vi.fn(() => Promise.reject(new DrawerMergeError(BLOCKED, 'merge_anyway')));
const drawer = (status: TicketStatus) =>
  createElement(TicketDrawer, {
    ticket: ticket(status),
    allTickets: [ticket(status)],
    run: undefined,
    onClose: () => undefined,
    onChanged: () => undefined,
    armStart: 0,
    onMove: () => undefined,
    onDiscard: () => Promise.resolve(),
    onAccept,
  });

beforeEach(() => {
  vi.mocked(api).mockImplementation(apiRoutes({}));
});
afterEach(cleanup);

const shown = () => ({
  error: document.body.querySelector('.form-error')?.textContent ?? null,
  mergeAnyway: queryButton('Merge anyway') !== null,
});

describe('TicketDrawer: a failed Mark done (L-13)', () => {
  it('offers its step while the ticket stays put', async () => {
    const view = await renderDom(drawer('review'));
    await click(getButton('Mark done ✓'));
    expect(onAccept).toHaveBeenCalled();
    expect(shown()).toEqual({ error: BLOCKED, mergeAnyway: true });
    await view.rerender(drawer('review'));
    expect(shown()).toEqual({ error: BLOCKED, mergeAnyway: true });
  });

  it('retires the step and its sentence on a move, and they do not come back with the ticket', async () => {
    const view = await renderDom(drawer('review'));
    await click(getButton('Mark done ✓'));
    expect(shown()).toEqual({ error: BLOCKED, mergeAnyway: true });
    await view.rerender(drawer('in_progress'));
    expect(shown()).toEqual({ error: null, mergeAnyway: false });
    await view.rerender(drawer('review'));
    expect(shown()).toEqual({ error: null, mergeAnyway: false });
  });
});
