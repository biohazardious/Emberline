// @vitest-environment happy-dom
import { FactorySettings, type Run, type RunDetail } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { RunEventTimeline } from './components/RunInspector';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { SettingsPage } from './pages/SettingsPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

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

function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
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
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('RunEventTimeline M5 conflict events (Spec 3)', () => {
  it('renders conflict_auto_resolved, conflict_heal_failed, and conflict_resolver_started with file lists', async () => {
    const run = makeRun();
    const detail: RunDetail = {
      ...run,
      finalMessage: null,
      lastScreen: null,
      events: [
        {
          id: 1,
          runId: 'r1',
          ts: '2026-11-12T00:02:00.000Z',
          source: 'system',
          type: 'conflict_auto_resolved',
          state: null,
          payload: { files: ['Makefile', 'CHANGELOG.md'], commitSha: 'abcdef123456' },
        },
        {
          id: 2,
          runId: 'r1',
          ts: '2026-11-12T00:03:00.000Z',
          source: 'system',
          type: 'conflict_heal_failed',
          state: null,
          payload: {
            reason: 'non_additive',
            files: ['Makefile', 'apps/core/src/service.ts'],
            unresolved: ['apps/core/src/service.ts'],
            message: '1 of 2 conflicted files had non-additive hunks',
          },
        },
        {
          id: 3,
          runId: 'r1',
          ts: '2026-11-12T00:04:00.000Z',
          source: 'system',
          type: 'conflict_resolver_started',
          state: null,
          payload: {
            runId: 'r-resolver-99',
            conflicts: ['apps/core/src/service.ts', 'ci.yml'],
            mainHead: 'fedcba987654',
          },
        },
      ],
    };

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/runs/r1': () => detail,
        'GET /api/runs/r1/build-outputs': () => ({ worktreePath: run.worktreePath, outputs: [] }),
      }),
    );

    const view = await renderDom(createElement(RunEventTimeline, { run }));
    await waitFor(() =>
      expect(view.container.querySelectorAll('[aria-label="Conflicted files"]')).toHaveLength(3),
    );

    expect(view.container.textContent).toContain('merge conflict auto-resolved');
    expect(view.container.textContent).toContain('Auto-resolved additive conflicts in 2 files (abcdef1)');
    expect(view.container.textContent).toContain('CHANGELOG.md');

    expect(view.container.textContent).toContain('conflict auto-resolve failed');
    expect(view.container.textContent).toContain('1 of 2 conflicted files had non-additive hunks');
    expect(view.container.textContent).toContain('apps/core/src/service.ts (unresolved)');

    expect(view.container.textContent).toContain('conflict resolver run started');
    expect(view.container.textContent).toContain(
      'Started resolver run for 2 conflicted files against fedcba9',
    );
    expect(view.container.textContent).toContain('ci.yml');
    expect(view.container.querySelector('a[href="/runs/r-resolver-99/review"]')?.textContent).toContain(
      'run r-resolv',
    );
  });
});

describe('SettingsPage conflict & overlap toggles (Spec 4)', () => {
  it('hydrates and saves autoResolveAdditiveConflicts and serializeOverlappingTickets', async () => {
    const savedPayloads: Record<string, unknown>[] = [];
    const initial = makeSettings({
      autoResolveAdditiveConflicts: true,
      serializeOverlappingTickets: true,
    });

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => initial,
        'PATCH /api/factory/settings': (body) => {
          const patch = body as Record<string, unknown>;
          savedPayloads.push(patch);
          return makeSettings({
            autoResolveAdditiveConflicts: Boolean(patch.autoResolveAdditiveConflicts),
            serializeOverlappingTickets: Boolean(patch.serializeOverlappingTickets),
          });
        },
      }),
    );

    const view = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      { path: '/settings' },
    );

    await waitFor(() =>
      expect(view.container.textContent).toContain('Auto-resolve additive merge conflicts'),
    );
    expect(view.container.textContent).toContain(
      "Don't run tickets that edit the same files at the same time",
    );

    const labels = [...view.container.querySelectorAll('label')];
    const autoResolveInput = labels
      .find((l) => l.textContent?.includes('Auto-resolve additive merge conflicts'))
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
    const serializeInput = labels
      .find((l) => l.textContent?.includes("Don't run tickets that edit the same files at the same time"))
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;

    expect(autoResolveInput?.checked).toBe(true);
    expect(serializeInput?.checked).toBe(true);

    await click(autoResolveInput!);
    await click(serializeInput!);
    expect(autoResolveInput?.checked).toBe(false);
    expect(serializeInput?.checked).toBe(false);

    await click(getButton(/Save Auto-Pilot & Theme Settings/, view.container));
    await waitFor(() => expect(savedPayloads).toHaveLength(1));
    expect(savedPayloads[0]).toMatchObject({
      autoResolveAdditiveConflicts: false,
      serializeOverlappingTickets: false,
    });
  });
});
