// @vitest-environment happy-dom
import type { ActiveProjectPreference } from '@emberline/protocol';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { App } from './App';
import { apiRoutes, cleanup, deferred, renderDom, settle, waitFor } from './domRender';
import type * as LiveData from './hooks/liveData';
import { SERVER_CHOICE_WAIT_MS } from './projectPaths';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
// Signed in already; the live event socket stays closed.
vi.mock('./auth', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ logout: () => Promise.resolve() }),
}));
vi.mock('./hooks/liveData', async (importOriginal) => ({
  ...(await importOriginal<typeof LiveData>()),
  LiveEvents: () => null,
}));
// The dashboard as a marker of the project it was mounted with.
vi.mock('./pages/Dashboard', () => ({
  Dashboard: ({ activeProjectId }: { activeProjectId?: string | null }) =>
    createElement('p', { className: 'test-dashboard' }, `dashboard of ${activeProjectId ?? 'all projects'}`),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

/** The server's stored choice: answered when the test says so, or never. */
let serverChoice: Promise<ActiveProjectPreference>;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ],
      'GET /api/projects/active': () => serverChoice,
      'PUT /api/projects/active': (body) => body,
      'GET /api/runs': () => [],
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.mocked(api).mockReset();
});

const dashboard = () => document.body.querySelector('.test-dashboard')?.textContent ?? null;
const pending = () => document.body.querySelector('.dashboard[aria-busy="true"]') !== null;
const askedServer = () =>
  vi
    .mocked(api)
    .mock.calls.some(([path, method]) => path === '/api/projects/active' && (method ?? 'GET') === 'GET');

describe('App: pages scoped to the active project (ScopedPage)', () => {
  it("wait for the server's choice, then mount with it", async () => {
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(askedServer()).toBe(true));
    expect(pending()).toBe(true);
    expect(dashboard()).toBeNull();
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(pending()).toBe(false);
  });

  it(`mount with the first project once the server has not answered in ${SERVER_CHOICE_WAIT_MS / 1000} s`, async () => {
    vi.useFakeTimers();
    serverChoice = new Promise(() => undefined);
    await renderDom(createElement(App));
    await waitFor(() => expect(askedServer()).toBe(true));
    await settle(SERVER_CHOICE_WAIT_MS - 200);
    expect(pending()).toBe(true);
    expect(dashboard()).toBeNull();
    await settle(400);
    expect(dashboard()).toBe('dashboard of a');
  });
});
