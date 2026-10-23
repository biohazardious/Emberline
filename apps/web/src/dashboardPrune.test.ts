// @vitest-environment happy-dom
import type { PruneWorktreeResponse, Run } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, settle, waitFor } from './domRender';
import { PRUNE_PENDING_TEXT } from './gcSummary';
import { Dashboard } from './pages/Dashboard';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: null,
  title: 'Fix it',
  agent: 'claude',
  state: 'done',
  prompt: 'fix it',
  worktreePath: '/workspaces/shop/.worktrees/r1',
  endedAt: '2026-10-23T11:00:00.000Z',
  stateChangedAt: '2026-10-23T11:00:00.000Z',
  lastEvent: 'stop',
  resumable: false,
  attention: null,
} as unknown as Run;

let prune: PruneWorktreeResponse;
let prunes: number;

beforeEach(() => {
  prunes = 0;
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => [{ id: 'p1', name: 'Shop' }],
      'GET /api/terminals': () => [],
      'GET /api/runs': () => [run],
      'POST /api/runs/r1/worktree/prune': () => {
        prunes++;
        return prune;
      },
    }),
  );
});
afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

async function pruneRun() {
  await renderDom(createElement(Dashboard, { system: undefined, activeProjectId: 'p1' }), {
    path: '/?section=runs',
  });
  await waitFor(() => getButton('Prune worktree'));
  await click(getButton('Prune worktree'));
  await waitFor(() => expect(prunes).toBe(1));
}

describe('Dashboard Prune worktree (W-4)', () => {
  it('says the teardown is running when the prune goes on in the background', async () => {
    prune = { runId: 'r1', worktreePath: run.worktreePath, removed: false, pending: true };
    await pruneRun();
    await waitFor(() => expect(document.body.textContent).toContain(PRUNE_PENDING_TEXT));
  });

  it('says nothing more when the worktree is gone already', async () => {
    prune = { runId: 'r1', worktreePath: run.worktreePath, removed: true };
    await pruneRun();
    await settle();
    expect(document.body.textContent).not.toContain(PRUNE_PENDING_TEXT);
  });
});
