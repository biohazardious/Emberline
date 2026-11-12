// @vitest-environment happy-dom
import type { Project, Run, RunDetail, RunRecovery, SyncWorktreeResponse, Ticket } from '@emberline/protocol';
import { FactorySettings } from '@emberline/protocol';
import { act, createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { TicketCard } from './components/BoardCard';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { BoardPage } from './pages/BoardPage';
import { Toasts } from './toast';

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

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    projectId: 'p1',
    key: 'EMB-36',
    title: 'Conflict self-heal UX',
    body: '## Target Files\n- Makefile\n- ci.yml',
    persona: 'ui_ux',
    status: 'review',
    priority: 2,
    position: 1024,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    projectId: 'p1',
    ticketId: 't1',
    title: 'EMB-36 Conflict self-heal UX',
    agent: 'claude',
    persona: 'ui_ux',
    state: 'done',
    prompt: 'Implement conflict UX',
    permissionMode: 'default',
    branch: 'emberline/emb-36',
    worktreePath: '/workspaces/emberline/.worktrees/r1',
    terminalId: null,
    agentSessionId: 'sess-1',
    lastEvent: 'ticket_complete',
    stateChangedAt: '2026-11-12T00:05:00.000Z',
    createdAt: '2026-11-12T00:01:00.000Z',
    endedAt: '2026-11-12T00:05:00.000Z',
    resumable: true,
    cancelled: false,
    model: 'opus',
    credential: 'login',
    routes: [{ agent: 'claude', model: 'opus', credential: 'login' }],
    routeIndex: 0,
    predecessorRunId: null,
    handedOffTo: null,
    attention: null,
    reviewReady: true,
    ...overrides,
  };
}

function makeSettings(): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  return FactorySettings.parse({
    personaAgents: {},
    personaRoutes: {
      product_owner: defaultChain,
      architect: defaultChain,
      ui_ux: defaultChain,
      coder: defaultChain,
      dba: defaultChain,
      qa: defaultChain,
      security: defaultChain,
    },
  });
}

function baseBoardRoutes(ticket: Ticket, run: Run) {
  return {
    'GET /api/projects': () => [project],
    'GET /api/runs': () => [run],
    'GET /api/factory/claude-usage': () => ({ authenticated: false }),
    'GET /api/factory/settings': () => makeSettings(),
    'GET /api/projects/p1/worktree-config': () => ({ configured: false, entries: [] }),
    'GET /api/projects/p1/tickets': () => [ticket],
    'GET /api/runs/r1/build-outputs': () => ({ worktreePath: run.worktreePath, outputs: [] }),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('BoardCard overlap waitingOn line (Spec 2)', () => {
  it('renders a keyboard-focusable compact line with full path tooltip on ready tickets only', async () => {
    const waitingTicket = makeTicket({
      status: 'ready',
      waitingOn: {
        ticketId: 't-12',
        key: 'EMB-12',
        paths: ['Makefile', '.github/workflows/ci.yml'],
      },
    });
    const view = await renderDom(
      createElement(
        'ul',
        null,
        createElement(TicketCard, {
          ticket: waitingTicket,
          run: undefined,
          dragging: false,
          dropBefore: false,
          onOpen: () => undefined,
          onDragStart: () => undefined,
          onDragOver: () => undefined,
        }),
      ),
    );

    const badge = view.container.querySelector<HTMLElement>('.card-overlap-wait');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('Waits for EMB-12 · Makefile +1');
    expect(badge?.tabIndex).toBe(0);
    expect(badge?.getAttribute('title')).toBe('Waits for EMB-12:\nMakefile\n.github/workflows/ci.yml');

    const singlePathTicket = makeTicket({
      status: 'ready',
      waitingOn: { ticketId: 't-12', key: 'EMB-12', paths: ['Makefile'] },
    });
    await view.rerender(
      createElement(
        'ul',
        null,
        createElement(TicketCard, {
          ticket: singlePathTicket,
          run: undefined,
          dragging: false,
          dropBefore: false,
          onOpen: () => undefined,
          onDragStart: () => undefined,
          onDragOver: () => undefined,
        }),
      ),
    );
    expect(view.container.querySelector('.card-overlap-wait')?.textContent).toBe(
      'Waits for EMB-12 · Makefile',
    );

    await view.rerender(
      createElement(
        'ul',
        null,
        createElement(TicketCard, {
          ticket: { ...singlePathTicket, status: 'in_progress' },
          run: undefined,
          dragging: false,
          dropBefore: false,
          onOpen: () => undefined,
          onDragStart: () => undefined,
          onDragOver: () => undefined,
        }),
      ),
    );
    expect(view.container.querySelector('.card-overlap-wait')).toBeNull();
  });
});

describe('BoardPage & TicketDrawer sync-worktree conflict resolutions (Spec 1)', () => {
  it('shows auto_resolved toast and moves ticket to Done when additive conflicts self-heal', async () => {
    const patchBodies: unknown[] = [];
    const reviewTicket = makeTicket({ status: 'review' });
    const run = makeRun();

    vi.mocked(api).mockImplementation(
      apiRoutes({
        ...baseBoardRoutes(reviewTicket, run),
        'POST /api/projects/p1/sync-worktree': (): SyncWorktreeResponse => ({
          ok: true,
          runId: 'r1',
          filesSynced: 2,
          commitSha: '1a2b3c4',
          alreadyMerged: false,
          summary: 'Merged into main.',
          conflicts: [],
          resolution: 'auto_resolved',
          resolverRunId: null,
          autoResolved: ['Makefile', 'ci.yml'],
        }),
        'PATCH /api/tickets/t1': (body) => {
          patchBodies.push(body);
          return { ...reviewTicket, status: 'done' };
        },
      }),
    );

    await renderDom(
      createElement(Fragment, null, createElement(Toasts), createElement(BoardPage, { projectId: 'p1' })),
      { path: '/projects/p1/board?ticket=t1' },
    );

    await waitFor(() => expect(getButton('Mark done ✓')).toBeTruthy());
    await click(getButton('Mark done ✓'));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ status: 'done' });
    expect(document.body.textContent).toContain(
      'Merged; auto-resolved additive conflicts in Makefile, ci.yml',
    );
  });

  it('keeps ticket in Review and shows run link when resolution is agent_resolving or resolver_started', async () => {
    let resolutionMode: 'agent_resolving' | 'resolver_started' = 'agent_resolving';
    const patchBodies: unknown[] = [];
    const reviewTicket = makeTicket({ status: 'review' });
    const run = makeRun();

    vi.mocked(api).mockImplementation(
      apiRoutes({
        ...baseBoardRoutes(reviewTicket, run),
        'GET /api/runs/r1': (): RunDetail => ({
          ...run,
          // The board takes the resolver from the response, not from the held run's detail.
          handedOffTo: null,
          events: [],
          finalMessage: null,
          lastScreen: null,
        }),
        'POST /api/projects/p1/sync-worktree': (): SyncWorktreeResponse => ({
          ok: false,
          runId: 'r1',
          filesSynced: 0,
          commitSha: null,
          alreadyMerged: false,
          summary: 'Could not merge EMB-36 into the main workspace',
          conflicts: ['Makefile', 'ci.yml'],
          resolution: resolutionMode,
          resolverRunId: resolutionMode === 'resolver_started' ? 'r-resolver-99' : null,
          autoResolved: [],
        }),
        'PATCH /api/tickets/t1': (body) => {
          patchBodies.push(body);
          return reviewTicket;
        },
      }),
    );

    await renderDom(createElement(BoardPage, { projectId: 'p1' }), {
      path: '/projects/p1/board?ticket=t1',
    });

    await waitFor(() => expect(getButton('Mark done ✓')).toBeTruthy());
    await click(getButton('Mark done ✓'));

    await waitFor(() => {
      const banner = document.querySelector('.sync-resolution-banner');
      expect(banner?.textContent).toContain(
        'The agent is merging main and resolving 2 conflicts; the ticket merges when it finishes',
      );
    });
    expect(document.querySelector('.sync-resolution-banner a')?.getAttribute('href')).toBe('/runs/r1/review');
    expect(patchBodies).toHaveLength(0);

    resolutionMode = 'resolver_started';
    await click(getButton('Mark done ✓'));

    await waitFor(() => {
      expect(document.querySelector('.sync-resolution-banner a')?.getAttribute('href')).toBe(
        '/runs/r-resolver-99/review',
      );
    });
    expect(document.querySelector('.sync-resolution-banner')?.textContent).toContain('Open resolver run →');
    expect(patchBodies).toHaveLength(0);
  });

  it('keeps ticket in Review and surfaces Hold Recovery suggestions when resolution is manual', async () => {
    const patchBodies: unknown[] = [];
    const reviewTicket = makeTicket({ status: 'review' });
    const run = makeRun({
      attention: {
        reason: 'held',
        detail: 'merge_failed',
        since: '2026-11-12T00:06:00.000Z',
        occurrence: 'r1:held:1',
      },
    });
    const recovery: RunRecovery = {
      hold: 'merge_failed',
      label: 'Merge failed',
      why: '2 files conflict with main',
      delivery: 'session',
      suggestions: [
        {
          id: 'resolve_conflicts',
          kind: 'prompt',
          label: 'Ask agent to resolve conflicts',
          detail: 'Merges main into the branch and fixes Makefile, ci.yml.',
          prompt: 'Merge main and resolve conflicts',
          files: ['Makefile', 'ci.yml'],
          commands: [],
        },
      ],
    };

    vi.mocked(api).mockImplementation(
      apiRoutes({
        ...baseBoardRoutes(reviewTicket, run),
        'GET /api/runs/r1/recovery': () => recovery,
        'POST /api/projects/p1/sync-worktree': (): SyncWorktreeResponse => ({
          ok: false,
          runId: 'r1',
          filesSynced: 0,
          commitSha: null,
          alreadyMerged: false,
          summary: 'Could not merge EMB-36 into main (conflicts in Makefile, ci.yml)',
          conflicts: ['Makefile', 'ci.yml'],
          resolution: 'manual',
          resolverRunId: null,
          autoResolved: [],
        }),
        'PATCH /api/tickets/t1': (body) => {
          patchBodies.push(body);
          return reviewTicket;
        },
      }),
    );

    await renderDom(createElement(BoardPage, { projectId: 'p1' }), {
      path: '/projects/p1/board?ticket=t1',
    });

    await waitFor(() => expect(getButton('Mark done ✓')).toBeTruthy());
    await click(getButton('Mark done ✓'));

    await waitFor(() => {
      const held = document.querySelector('[aria-label="Held run"]');
      expect(held?.textContent).toContain('Ask agent to resolve conflicts');
    });
    expect(document.querySelector('.form-error')).toBeNull();
    expect(patchBodies).toHaveLength(0);
  });

  it('handles drag-to-Done without optimistic move when conflicts escalate or need manual recovery', async () => {
    let resolutionMode: 'agent_resolving' | 'manual' = 'agent_resolving';
    const patchBodies: unknown[] = [];
    const reviewTicket = makeTicket({ status: 'review' });
    const run = makeRun();

    vi.mocked(api).mockImplementation(
      apiRoutes({
        ...baseBoardRoutes(reviewTicket, run),
        'POST /api/projects/p1/sync-worktree': (): SyncWorktreeResponse => ({
          ok: false,
          runId: 'r1',
          filesSynced: 0,
          commitSha: null,
          alreadyMerged: false,
          summary: 'Could not merge EMB-36 into main',
          conflicts: ['Makefile'],
          resolution: resolutionMode,
          resolverRunId: null,
          autoResolved: [],
        }),
        'PATCH /api/tickets/t1': (body) => {
          patchBodies.push(body);
          return reviewTicket;
        },
      }),
    );

    await renderDom(createElement(BoardPage, { projectId: 'p1' }), { path: '/projects/p1/board' });
    await waitFor(() => expect(document.querySelector('#ticket-EMB-36')).not.toBeNull());

    const dragCardToDone = async () => {
      const card = document.querySelector<HTMLElement>('#ticket-EMB-36')!;
      const doneCol = document.querySelector<HTMLElement>('#col-done')!;
      const dt = { effectAllowed: 'all', setData: () => undefined };
      await act(async () => {
        const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(dragStart, 'dataTransfer', { value: dt });
        card.dispatchEvent(dragStart);
      });
      await act(async () => {
        doneCol.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        doneCol.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      });
    };

    await dragCardToDone();
    await waitFor(() => {
      expect(document.querySelector('.sync-resolution-banner')?.textContent).toContain(
        'The agent is merging main and resolving 1 conflict; the ticket merges when it finishes',
      );
    });
    expect(document.querySelector('#col-review #ticket-EMB-36')).not.toBeNull();
    expect(document.querySelector('#col-done #ticket-EMB-36')).toBeNull();
    expect(patchBodies).toHaveLength(0);

    resolutionMode = 'manual';
    await dragCardToDone();
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Held run"]')?.textContent).toContain('Makefile');
    });
    expect(document.querySelector('#col-review #ticket-EMB-36')).not.toBeNull();
    expect(patchBodies).toHaveLength(0);
  });
});
