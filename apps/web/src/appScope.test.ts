// @vitest-environment happy-dom
import type { ActiveProjectPreference } from '@emberline/protocol';
import { createElement, type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { App } from './App';
import {
  apiRoutes,
  cleanup,
  click,
  deferred,
  getButton,
  renderDom,
  settle,
  typeInto,
  waitFor,
} from './domRender';
import type * as LiveData from './hooks/liveData';
import { SERVER_CHOICE_WAIT_MS } from './projectPaths';
import { toastInfo } from './toast';
import type * as ToastModule from './toast';

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
// The dashboard as a marker of the project it was mounted with, with a draft of its own (local
// state, lost if it unmounts) and a way to pick a project.
vi.mock('./pages/Dashboard', () => ({
  Dashboard: ({
    activeProjectId,
    onSelectProject,
  }: {
    activeProjectId?: string | null;
    onSelectProject: (id: string | null) => void;
  }) => {
    const [draft, setDraft] = useState('');
    return createElement(
      'div',
      null,
      createElement(
        'p',
        { className: 'test-dashboard' },
        `dashboard of ${activeProjectId ?? 'all projects'}`,
      ),
      createElement('textarea', {
        'aria-label': 'Draft',
        value: draft,
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      }),
      createElement('button', { type: 'button', onClick: () => onSelectProject('a') }, 'Pick Alpha'),
    );
  },
}));
vi.mock('./toast', async (importOriginal) => ({
  ...(await importOriginal<typeof ToastModule>()),
  toastInfo: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

/** The server's stored choice: answered when the test says so, or never. */
let serverChoice: Promise<ActiveProjectPreference>;
/** What GET /api/projects answers (a function may throw: the list failed). */
let projectList: () => unknown;
const BOTH = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

beforeEach(() => {
  localStorage.clear();
  projectList = () => BOTH;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => projectList(),
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
  vi.mocked(toastInfo).mockReset();
});

const dashboard = () => document.body.querySelector('.test-dashboard')?.textContent ?? null;
const draft = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]')!;
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

  it("the server's choice arriving after the wait replaces the fallback, with a fresh page and a notice", async () => {
    vi.useFakeTimers();
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(askedServer()).toBe(true));
    await settle(SERVER_CHOICE_WAIT_MS + 200);
    expect(dashboard()).toBe('dashboard of a');
    await typeInto(draft(), 'note for Alpha');
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(localStorage.getItem('emberline.activeProjectId')).toBe('b');
    // Nothing typed for Alpha is left on Beta's page, and the person is told why it changed.
    expect(draft().value).toBe('');
    expect(vi.mocked(toastInfo).mock.calls).toEqual([
      ['Switched to Beta, the active project saved on the server.'],
    ]);
  });

  it("the server's choice arriving after the wait keeps a project the person picked since", async () => {
    vi.useFakeTimers();
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(askedServer()).toBe(true));
    await settle(SERVER_CHOICE_WAIT_MS + 200);
    expect(dashboard()).toBe('dashboard of a');
    await click(getButton('Pick Alpha'));
    choice.resolve({ activeProjectId: 'b' });
    await settle(100);
    expect(dashboard()).toBe('dashboard of a');
    expect(localStorage.getItem('emberline.activeProjectId')).toBe('a');
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('a page whose project was deleted waits again (never asking for that project), then starts afresh on the next', async () => {
    vi.useFakeTimers();
    localStorage.setItem('emberline.activeProjectId', 'a');
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(dashboard()).toBe('dashboard of a'));
    expect(askedServer()).toBe(false);
    await typeInto(draft(), 'half-written note');
    // Project a is deleted: the next list lacks it, and the server's choice is asked.
    projectList = () => [BOTH[1]];
    await settle(10_500);
    await waitFor(() => expect(askedServer()).toBe(true));
    expect(pending()).toBe(true);
    expect(dashboard()).toBeNull();
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(draft().value).toBe('');
  });

  it('a page shown for all projects after the list failed stays mounted while the list loads, then starts afresh for the project', async () => {
    vi.useFakeTimers();
    projectList = () => {
      throw new Error('core restarting');
    };
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(dashboard()).toBe('dashboard of all projects'));
    await typeInto(draft(), 'half-written note');
    projectList = () => BOTH;
    await settle(10_500);
    await waitFor(() => expect(askedServer()).toBe(true));
    expect(pending()).toBe(false);
    expect(draft().value).toBe('half-written note');
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(draft().value).toBe('');
  });
});
