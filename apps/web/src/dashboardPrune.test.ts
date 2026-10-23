// @vitest-environment happy-dom
import type { PruneWorktreeResponse, Run } from '@emberline/protocol';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, renderDom, settle, waitFor } from './domRender';
import { PRUNE_FAILED_TEXT, PRUNE_PENDING_TEXT } from './gcSummary';
import { liveKeys } from './hooks/liveData';
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
/** The run's events as `GET /api/runs/r1` answers them. */
let events: { id: number; type: string }[];

beforeEach(() => {
  prunes = 0;
  events = [{ id: 7, type: 'stop_requested' }];
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => [{ id: 'p1', name: 'Shop' }],
      'GET /api/terminals': () => [],
      'GET /api/runs': () => [run],
      'GET /api/runs/r1': () => ({ ...run, events }),
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
  const rendered = await renderDom(createElement(Dashboard, { system: undefined, activeProjectId: 'p1' }), {
    path: '/?section=runs',
  });
  await waitFor(() => getButton('Prune worktree'));
  await click(getButton('Prune worktree'));
  await waitFor(() => expect(prunes).toBe(1));
  return rendered;
}

describe('Dashboard Prune worktree (W-4)', () => {
  it('says the teardown is running when the prune goes on in the background', async () => {
    prune = { runId: 'r1', worktreePath: run.worktreePath, removed: false, pending: true };
    await pruneRun();
    await waitFor(() => expect(document.body.textContent).toContain(PRUNE_PENDING_TEXT));
  });

  it('says the prune failed once the teardown ended without removing the worktree, also after later events (F-10)', async () => {
    prune = { runId: 'r1', worktreePath: run.worktreePath, removed: false, pending: true, since: 7 };
    const { client } = await pruneRun();
    await waitFor(() => expect(document.body.textContent).toContain(PRUNE_PENDING_TEXT));
    // The background prune could not remove it; the live socket delivers the run's update.
    events = [...events, { id: 8, type: 'worktree_prune_failed' }];
    await act(async () =>
      client.setQueryData(liveKeys.runs, [{ ...run, lastEvent: 'worktree_prune_failed' }]),
    );
    await waitFor(() => expect(document.body.textContent).toContain(PRUNE_FAILED_TEXT));
    expect(document.body.textContent).not.toContain(PRUNE_PENDING_TEXT);
    // Another event on the run afterwards does not bring the running note back.
    events = [...events, { id: 9, type: 'resume_failed' }];
    await act(async () => client.setQueryData(liveKeys.runs, [{ ...run, lastEvent: 'resume_failed' }]));
    await settle(50);
    expect(document.body.textContent).toContain(PRUNE_FAILED_TEXT);
    expect(document.body.textContent).not.toContain(PRUNE_PENDING_TEXT);
  });

  it('drops the note once a later prune removes the worktree right away', async () => {
    prune = { runId: 'r1', worktreePath: run.worktreePath, removed: false, pending: true };
    await pruneRun();
    await waitFor(() => expect(document.body.textContent).toContain(PRUNE_PENDING_TEXT));
    prune = { runId: 'r1', worktreePath: run.worktreePath, removed: true };
    await click(getButton('Prune worktree'));
    await waitFor(() => expect(prunes).toBe(2));
    await waitFor(() => expect(document.body.textContent).not.toContain(PRUNE_PENDING_TEXT));
  });
});
