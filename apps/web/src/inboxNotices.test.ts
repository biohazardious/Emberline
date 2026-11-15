// @vitest-environment happy-dom
import type { Notice } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { InboxPage } from './pages/InboxPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

const notice = (over: Partial<Notice> = {}): Notice => ({
  id: 'n1',
  kind: 'new_models',
  title: 'AGY has 2 new models',
  text: 'Gemini 4 Hydrogen (High), Gemini 4 Carbon (High)',
  link: '/settings?tab=providers',
  createdAt: new Date().toISOString(),
  dismissedAt: null,
  key: 'k1',
  ...over,
});

let list: Notice[];
let dismissed: string[];

beforeEach(() => {
  list = [notice()];
  dismissed = [];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => [],
      'GET /api/notices': () => list,
      'POST /api/notices/n1/dismiss': () => {
        dismissed.push('n1');
        list = list.map((n) => ({ ...n, dismissedAt: new Date().toISOString() }));
        return { ok: true };
      },
    }),
  );
});
afterEach(cleanup);

const page = () =>
  createElement(InboxPage, {
    runs: [],
    seen: {},
    activeProjectId: null,
    onOpenRun: () => undefined,
    onDismiss: () => undefined,
  });

describe('Inbox notices', () => {
  it('lists a notice with its link above the runs, and Dismiss calls the route', async () => {
    const { container } = await renderDom(page());
    await waitFor(() => expect(container.textContent).toContain('AGY has 2 new models'));
    expect(container.textContent).toContain('Gemini 4 Hydrogen (High), Gemini 4 Carbon (High)');
    const link = container.querySelector('a[href="/settings?tab=providers"]');
    expect(link).not.toBeNull();

    await click(getButton('Dismiss', container.querySelector('[data-kind="new_models"]')!));
    await waitFor(() => expect(container.textContent).not.toContain('AGY has 2 new models'));
    expect(dismissed).toEqual(['n1']);
  });

  it('shows nothing for dismissed notices and does not change the runs empty state', async () => {
    list = [notice({ dismissedAt: new Date().toISOString() })];
    const { container } = await renderDom(page());
    await waitFor(() => expect(container.textContent).toContain('Nothing needs you right now.'));
    expect(container.querySelector('[aria-label="Notices"]')).toBeNull();
  });
});
