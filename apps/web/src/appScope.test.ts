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

  it("the server's choice arriving after the wait replaces the fallback, while no project was picked", async () => {
    vi.useFakeTimers();
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(askedServer()).toBe(true));
    await settle(SERVER_CHOICE_WAIT_MS + 200);
    expect(dashboard()).toBe('dashboard of a');
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(localStorage.getItem('emberline.activeProjectId')).toBe('b');
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
  });

  it('a page stays mounted, with what was typed on it, while its deleted project is resolved again', async () => {
    vi.useFakeTimers();
    localStorage.setItem('emberline.activeProjectId', 'a');
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(dashboard()).toBe('dashboard of a'));
    expect(askedServer()).toBe(false);
    const draft = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]')!;
    await typeInto(draft(), 'half-written note');
    // Project a is deleted: the next list lacks it, and the server's choice is asked.
    projectList = () => [BOTH[1]];
    await settle(10_500);
    await waitFor(() => expect(askedServer()).toBe(true));
    expect(pending()).toBe(false);
    expect(draft().value).toBe('half-written note');
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(draft().value).toBe('half-written note');
  });

  it('a page shown for all projects after the list failed stays mounted once the list loads', async () => {
    vi.useFakeTimers();
    projectList = () => {
      throw new Error('core restarting');
    };
    const choice = deferred<ActiveProjectPreference>();
    serverChoice = choice.promise;
    await renderDom(createElement(App));
    await waitFor(() => expect(dashboard()).toBe('dashboard of all projects'));
    const draft = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]')!;
    await typeInto(draft(), 'half-written note');
    projectList = () => BOTH;
    await settle(10_500);
    await waitFor(() => expect(askedServer()).toBe(true));
    expect(pending()).toBe(false);
    expect(draft().value).toBe('half-written note');
    choice.resolve({ activeProjectId: 'b' });
    await waitFor(() => expect(dashboard()).toBe('dashboard of b'));
    expect(draft().value).toBe('half-written note');
  });
});
