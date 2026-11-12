// @vitest-environment happy-dom
import type { Project, ProjectStatusSummary, Run, Ticket } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, deferred, getButton, renderDom, typeInto, waitFor } from './domRender';
import { BoardPage } from './pages/BoardPage';
import { Dashboard } from './pages/Dashboard';
import { LiveBrowserPage } from './pages/LiveBrowserPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const project: Project = {
  id: 'p1',
  name: 'Emberline',
  slug: 'emberline',
  path: '/workspaces/emberline',
  repoUrl: null,
  defaultBranch: 'main',
  appType: 'fullstack',
  description: 'Multi-agent coding factory',
  techStack: null,
  createdAt: '2026-11-12T00:00:00.000Z',
};

function makeTicket(overrides: Partial<Ticket>): Ticket {
  return {
    id: 't1',
    projectId: 'p1',
    key: 'EMB-1',
    title: 'Ticket',
    body: '',
    persona: 'coder',
    status: 'ready',
    priority: 1,
    position: 1024,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: 'r1',
    projectId: 'p1',
    ticketId: null,
    title: 'EMB-19 UX Polish',
    agent: 'claude',
    persona: 'ui_ux',
    state: 'working',
    prompt: 'Responsive filters',
    permissionMode: 'default',
    branch: 'emberline/emb-19',
    worktreePath: '/workspaces/emberline/.worktrees/r1',
    terminalId: null,
    agentSessionId: null,
    lastEvent: 'tool_use',
    stateChangedAt: '2026-11-12T00:05:00.000Z',
    createdAt: '2026-11-12T00:01:00.000Z',
    endedAt: null,
    resumable: false,
    cancelled: false,
    attention: null,
    reviewReady: false,
    ...overrides,
  } as Run;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('BoardPage filtering, loading, and error recovery', () => {
  it('shows loading state, recovers from a failed ticket read via Retry without offering Seed Starter Backlog on error, and filters cards', async () => {
    const ticketsGate = deferred<Ticket[]>();
    let shouldFailTickets = true;
    const tickets = [
      makeTicket({
        id: 't1',
        key: 'EMB-19',
        title: 'Responsive Kanban Filter',
        persona: 'ui_ux',
        priority: 3,
      }),
      makeTicket({ id: 't2', key: 'EMB-20', title: 'SQLite WAL Checkpoint', persona: 'dba', priority: 1 }),
    ];

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/runs': () => [],
        'GET /api/factory/claude-usage': () => ({ authenticated: false }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude'] }),
        'GET /api/projects/p1/worktree-config': () => ({ configured: false, entries: [] }),
        'GET /api/projects/p1/tickets': () => {
          if (shouldFailTickets) return ticketsGate.promise;
          return tickets;
        },
      }),
    );

    await renderDom(createElement(BoardPage, { projectId: 'p1' }), { path: '/projects/p1/board' });
    expect(document.body.textContent).toContain('Loading project tickets…');

    ticketsGate.reject(new Error('Database connection busy'));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not load board tickets: Database connection busy',
      ),
    );
    expect(document.body.textContent).not.toContain('Seed Starter Backlog');

    shouldFailTickets = false;
    await click(getButton(/Retry/));
    await waitFor(() => expect(document.body.textContent).toContain('Responsive Kanban Filter'));
    expect(document.body.textContent).toContain('SQLite WAL Checkpoint');

    const search = document.querySelector<HTMLInputElement>('#board-search');
    expect(search).not.toBeNull();
    await typeInto(search!, 'sqlite');
    await waitFor(() => expect(document.body.textContent).not.toContain('Responsive Kanban Filter'));
    expect(document.body.textContent).toContain('SQLite WAL Checkpoint');
    expect(document.body.textContent).toContain('1 of 2');

    await click(getButton('Clear'));
    await waitFor(() => expect(document.body.textContent).toContain('Responsive Kanban Filter'));
  });
});

describe('Dashboard interactive stat cards and run search', () => {
  it('jumps to Runs tab and filters by category when clicking a telemetry stat card, and filters by search query', async () => {
    const runs = [
      makeRun({
        id: 'r-input',
        title: 'EMB-21 Needs Answer',
        state: 'waiting_input',
        attention: {
          reason: 'question',
          detail: 'Which port?',
          since: '2026-11-12T00:05:00.000Z',
          occurrence: 'r-input:q:1',
        },
      }),
      makeRun({
        id: 'r-done',
        title: 'EMB-22 Shipped Feature',
        state: 'done',
        endedAt: '2026-11-12T01:00:00.000Z',
      }),
    ];

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/terminals': () => [],
        'GET /api/runs': () => runs,
        'GET /api/factory/claude-usage': () => ({ authenticated: false }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude'] }),
        'GET /api/projects/p1/status': (): ProjectStatusSummary => ({
          projectId: 'p1',
          workspaceRoot: '/workspaces/emberline',
          hostBindHint: './workspaces/emberline',
          ticketCounts: { total: 0, backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 },
          completionPercent: 0,
          activeRunCount: 1,
          autoChainActive: false,
          targets: [],
        }),
        'GET /api/projects/p1/tickets': () => [],
        'GET /api/projects/p1/checkpoints': () => [],
        'GET /api/projects/p1/recommendations': () => [],
        'GET /api/system': () => ({ apiVersion: '1', ptyd: 'connected' }),
      }),
    );

    await renderDom(createElement(Dashboard, { system: undefined, activeProjectId: 'p1' }), { path: '/' });
    await waitFor(() => expect(getButton(/Needs Your Input/)).toBeTruthy());

    await click(getButton(/Needs Your Input/));
    await waitFor(() => expect(document.body.textContent).toContain('EMB-21 Needs Answer'));
    expect(document.body.textContent).not.toContain('EMB-22 Shipped Feature');

    await click(getButton(/Needs Your Input/));
    await waitFor(() => expect(document.body.textContent).toContain('EMB-22 Shipped Feature'));

    const runSearch = document.querySelector<HTMLInputElement>('#dashboard-run-search');
    expect(runSearch).not.toBeNull();
    await typeInto(runSearch!, 'shipped');
    await waitFor(() => expect(document.body.textContent).not.toContain('EMB-21 Needs Answer'));
    expect(document.body.textContent).toContain('EMB-22 Shipped Feature');
  });
});

describe('LiveBrowserPage missing-project and error states', () => {
  it('renders an actionable empty state instead of hanging when the project is missing', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [],
        'GET /api/projects/missing/status': () => ({ projectId: 'missing', targets: [] }),
      }),
    );

    await renderDom(createElement(LiveBrowserPage, { projectId: 'missing' }), {
      path: '/projects/missing/browser',
    });

    await waitFor(() => expect(document.body.textContent).toContain('Project not found.'));
  });
});
