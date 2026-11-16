// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, Run, Ticket } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { AnswerDialogView } from './components/AnswerDialog';
import { RunInspector } from './components/RunInspector';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { FleetPage } from './pages/FleetPage';
import { InboxPage } from './pages/InboxPage';
import { TerminalPage } from './pages/TerminalPage';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/TerminalView', () => ({
  TerminalView: () => createElement('div', { className: 'test-terminal' }),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 0.9.3 default-view word counts measured with `visibleWordCount` before the M6 redesign (AC-6.5: <= 75% budget).
 */
export const INBOX_HEADER_093_BASELINE_WORDS = 17;
export const INBOX_HEADER_WORD_BUDGET = Math.floor(INBOX_HEADER_093_BASELINE_WORDS * 0.75);

export const INBOX_TWO_ITEMS_CHROME_093_BASELINE_WORDS = 49;
export const INBOX_TWO_ITEMS_CHROME_WORD_BUDGET = Math.floor(
  INBOX_TWO_ITEMS_CHROME_093_BASELINE_WORDS * 0.75,
);

export const FLEET_HEADER_093_BASELINE_WORDS = 50;
export const FLEET_HEADER_WORD_BUDGET = Math.floor(FLEET_HEADER_093_BASELINE_WORDS * 0.75);

export const FLEET_DEFAULT_093_BASELINE_WORDS = 140;
export const FLEET_DEFAULT_WORD_BUDGET = Math.floor(FLEET_DEFAULT_093_BASELINE_WORDS * 0.75);

export const RUN_INSPECTOR_HEADER_093_BASELINE_WORDS = 13;
export const RUN_INSPECTOR_HEADER_WORD_BUDGET = Math.floor(RUN_INSPECTOR_HEADER_093_BASELINE_WORDS * 0.75);

export const RUN_INSPECTOR_FINISHED_093_BASELINE_WORDS = 47;
export const RUN_INSPECTOR_FINISHED_WORD_BUDGET = Math.floor(
  RUN_INSPECTOR_FINISHED_093_BASELINE_WORDS * 0.75,
);

export const ANSWER_DIALOG_093_BASELINE_WORDS = 47;
export const ANSWER_DIALOG_WORD_BUDGET = Math.floor(ANSWER_DIALOG_093_BASELINE_WORDS * 0.75);

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  path: '/workspaces/alpha',
  repoUrl: null,
  defaultBranch: 'main',
  appType: 'fullstack',
  description: 'Alpha project',
  techStack: null,
  createdAt: '2026-10-18T10:00:00.000Z',
};

const tickets: Ticket[] = [
  {
    id: 't1',
    projectId: 'p1',
    key: 'EL-1',
    title: 'Fix login redirect',
    body: '',
    persona: 'coder',
    status: 'in_progress',
    priority: 1,
    position: 1024,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  },
  {
    id: 't2',
    projectId: 'p1',
    key: 'EL-2',
    title: 'Add audit log',
    body: '',
    persona: 'security',
    status: 'review',
    priority: 2,
    position: 2048,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  },
];

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    projectId: 'p1',
    ticketId: 't1',
    title: 'EL-1 Fix login redirect',
    agent: 'claude',
    persona: 'coder',
    state: 'waiting_input',
    prompt: 'Fix the login redirect loop.',
    permissionMode: 'default',
    branch: 'emberline/el-1',
    worktreePath: '/workspaces/alpha/.worktrees/r1',
    terminalId: 'term-1',
    agentSessionId: 'sess-1',
    lastEvent: 'question',
    stateChangedAt: '2026-10-18T12:00:00.000Z',
    createdAt: '2026-10-18T11:00:00.000Z',
    endedAt: null,
    resumable: true,
    cancelled: false,
    model: 'opus',
    credential: 'login',
    routes: [{ agent: 'claude', model: 'opus', credential: 'login' }],
    routeIndex: 0,
    predecessorRunId: null,
    handedOffTo: null,
    attention: {
      reason: 'question',
      detail: null,
      since: '2026-10-18T11:59:00.000Z',
      occurrence: `${id}:question:e1`,
    },
    reviewReady: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('AC-6.5 word density budgets for Inbox, Fleet, RunInspector, and AnswerDialog', () => {
  it('keeps the Inbox header and two items chrome at or under 75% of the 0.9.3 baseline', async () => {
    const r1 = makeRun('r1', { ticketId: 't1', title: 'EL-1 Fix login redirect' });
    const r2 = makeRun('r2', {
      ticketId: 't2',
      title: 'EL-2 Add audit log',
      persona: 'security',
      state: 'done',
      endedAt: '2026-10-18T12:00:00.000Z',
      terminalId: null,
      reviewReady: true,
      attention: {
        reason: 'failed',
        detail: null,
        since: '2026-10-18T11:58:00.000Z',
        occurrence: 'r2:failed:e1',
      },
    });

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/projects/p1/tickets': () => tickets,
        'GET /api/notices': () => [],
      }),
    );

    const { container } = await renderDom(
      createElement(InboxPage, {
        runs: [r1, r2],
        seen: {},
        activeProjectId: 'p1',
        projectName: 'Alpha',
        onOpenRun: () => undefined,
        onDismiss: () => undefined,
      }),
    );
    await waitFor(() => expect(container.textContent).toContain('Alpha'));

    const header = container.querySelector('header')!;
    expect(visibleWordCount(header)).toBeLessThanOrEqual(INBOX_HEADER_WORD_BUDGET);
    expect(visibleWordCount(container)).toBeLessThanOrEqual(INBOX_TWO_ITEMS_CHROME_WORD_BUDGET);

    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Inbox');
    expect(container.querySelectorAll('.btn-primary').length).toBeLessThanOrEqual(1);
  });

  it('keeps the Fleet header and default view at or under 75% of the 0.9.3 baseline', async () => {
    const r1 = makeRun('r1', { ticketId: 't1', title: 'EL-1 Fix login redirect' });
    const r2 = makeRun('r2', {
      ticketId: 't2',
      title: 'EL-2 Add audit log',
      persona: 'security',
      state: 'done',
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      stateChangedAt: new Date(Date.now() - 60_000).toISOString(),
      terminalId: null,
      reviewReady: true,
      attention: null,
    });

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/runs': () => [r1, r2],
        'GET /api/runs/r2': () => ({
          ...r2,
          events: [],
          finalMessage: 'Implemented audit log.',
          lastScreen: '$ pnpm test\nPASS',
        }),
        'GET /api/runs/r2/build-outputs': () => ({ worktreePath: r2.worktreePath, outputs: [] }),
        'GET /api/scheduler': () => ({
          maxConcurrentRuns: 2,
          busy: 1,
          queued: 0,
          rateLimited: 0,
          window: null,
          windows: [],
        }),
        'GET /api/factory/claude-usage': () => ({ available: false, authenticated: false }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude'], personaRoutes: {} }),
      }),
    );

    const { container } = await renderDom(
      createElement(FleetPage, {
        activeProjectId: 'p1',
        seen: {},
        onInspectRun: () => undefined,
      }),
    );
    await waitFor(() => expect(container.textContent).toContain('EL-1 Fix login redirect'));

    const header = container.querySelector('header')!;
    expect(visibleWordCount(header)).toBeLessThanOrEqual(FLEET_HEADER_WORD_BUDGET);
    expect(visibleWordCount(container)).toBeLessThanOrEqual(FLEET_DEFAULT_WORD_BUDGET);

    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Fleet');
    expect(container.querySelector('[aria-label="Needs you"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Running"]')).not.toBeNull();
  });

  it('keeps the RunInspector header and finished run view at or under 75% of the 0.9.3 baseline', async () => {
    const finishedRun = makeRun('r2', {
      ticketId: 't2',
      title: 'EL-2 Add audit log',
      state: 'done',
      endedAt: '2026-10-18T12:00:00.000Z',
      terminalId: null,
      attention: null,
      reviewReady: true,
      lastEvent: 'ticket_complete',
    });

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/runs/r2': () => ({
          ...finishedRun,
          events: [
            {
              id: 1,
              runId: 'r2',
              ts: '2026-10-18T11:59:00.000Z',
              source: 'hook',
              type: 'stop',
              state: 'done',
              payload: { message: 'All checks passed.' },
            },
          ],
          finalMessage: 'Implemented audit log.',
          lastScreen: '$ pnpm test\nPASS',
        }),
        'GET /api/runs/r2/build-outputs': () => ({ worktreePath: finishedRun.worktreePath, outputs: [] }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude'], personaRoutes: {} }),
        'GET /api/scheduler': () => ({
          maxConcurrentRuns: 2,
          busy: 0,
          queued: 0,
          rateLimited: 0,
          window: null,
          windows: [],
        }),
      }),
    );

    const { container } = await renderDom(
      createElement(RunInspector, {
        run: finishedRun,
        projectName: 'Alpha',
        onClose: () => undefined,
      }),
    );
    await waitFor(() => expect(container.textContent).toContain('All checks passed.'));

    const header = container.querySelector('header')!;
    expect(visibleWordCount(header)).toBeLessThanOrEqual(RUN_INSPECTOR_HEADER_WORD_BUDGET);
    expect(visibleWordCount(container)).toBeLessThanOrEqual(RUN_INSPECTOR_FINISHED_WORD_BUDGET);

    expect(container.querySelector('[aria-label="Outcome"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Activity"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Handoff"]')).not.toBeNull();

    // Raw event payloads and last terminal screen are behind disclosures
    expect(container.textContent).not.toContain('$ pnpm test');
    await click(getButton('Last terminal screen', container));
    expect(container.textContent).toContain('$ pnpm test');

    await click(getButton('Payload', container));
    expect(container.textContent).toContain('"message": "All checks passed."');
  });

  it('keeps the AnswerDialogView default view at or under 75% of the 0.9.3 baseline', async () => {
    const { container } = await renderDom(
      createElement(AnswerDialogView, {
        heading: { key: 'EL-1', title: 'Pick a colour' },
        agent: 'claude',
        waited: '5m',
        question: {
          kind: 'question',
          text: 'Which colour?',
          source: 'last_message',
          options: [
            { label: 'Red', detail: null },
            { label: 'Green', detail: 'cooler' },
          ],
          picker: false,
          pickerChips: false,
          suggest: { available: false, reason: 'Claude Code is not signed in.' },
        },
        text: '',
        files: [],
        problems: [],
        busy: false,
        suggesting: false,
        error: null,
        onText: () => undefined,
        onOption: () => undefined,
        onSuggest: () => undefined,
        onFiles: () => undefined,
        onRemoveFile: () => undefined,
        onSend: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(visibleWordCount(container)).toBeLessThanOrEqual(ANSWER_DIALOG_WORD_BUDGET);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('renders TerminalPage with title and state in one line and icon buttons with aria-labels', async () => {
    const r1 = makeRun('r1');
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/terminals': () => [{ id: 'term-1', title: 'EL-1 Fix login redirect', runId: 'r1' }],
        'GET /api/runs': () => [r1],
      }),
    );

    const { container } = await renderDom(createElement(TerminalPage, { id: 'term-1' }), {
      path: '/terminals/term-1',
    });
    await waitFor(() => expect(container.textContent).toContain('EL-1 Fix login redirect'));

    expect(container.querySelector('button[aria-label="Back to the previous page"]')).not.toBeNull();
    expect(container.querySelector('a[aria-label="Open review"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Refresh terminal metadata"]')).not.toBeNull();
  });

  it('supports resuming, opening review/terminal, and dismissing from Inbox and Fleet More menus', async () => {
    const resumed: string[] = [];
    const dismissed: string[] = [];
    let gcCalls = 0;

    const rQuestion = makeRun('r1', {
      ticketId: 't1',
      title: 'EL-1 Fix login redirect',
      attention: {
        reason: 'question',
        detail: 'Which database should we use for the full integration test suite?',
        since: '2026-10-18T11:59:00.000Z',
        occurrence: 'r1:question:e1',
      },
    });
    const rRateLimited = makeRun('r2', {
      ticketId: 't2',
      title: 'EL-2 Add audit log',
      state: 'rate_limited',
      worktreePath: '',
      reviewReady: false,
      attention: {
        reason: 'rate_limited',
        detail: null,
        since: '2026-10-18T11:58:00.000Z',
        occurrence: 'r2:rate_limited:e1',
      },
    });
    const rFinished = makeRun('r3', {
      ticketId: 't2',
      title: 'EL-3 Old run',
      state: 'done',
      endedAt: '2026-10-18T10:00:00.000Z',
      attention: null,
    });

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/projects/p1/tickets': () => tickets,
        'GET /api/notices': () => [],
        'GET /api/runs': () => [rQuestion, rRateLimited, rFinished],
        'POST /api/runs/r2/resume': () => {
          resumed.push('r2');
          return { ok: true };
        },
        'POST /api/runs/gc': () => {
          gcCalls += 1;
          return { removedRuns: 1, closedSessions: 1, prunedWorktrees: 1, keptWorktrees: [] };
        },
        'GET /api/scheduler': () => ({
          maxConcurrentRuns: 2,
          busy: 1,
          queued: 0,
          rateLimited: 1,
          window: null,
          windows: [],
        }),
        'GET /api/factory/claude-usage': () => ({ available: false, authenticated: false }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude'], personaRoutes: {} }),
      }),
    );

    const inboxView = await renderDom(
      createElement(InboxPage, {
        runs: [rQuestion, rRateLimited],
        seen: {},
        activeProjectId: 'p1',
        projectName: 'Alpha',
        onOpenRun: () => undefined,
        onDismiss: (r) => dismissed.push(r.id),
      }),
    );
    await waitFor(() =>
      expect(inboxView.container.textContent).toContain(
        'Which database should we use for the full integration test suite?',
      ),
    );

    // Rate-limited item has Resume as its primary action, and Dismiss in MoreMenu
    const rlItem = inboxView.container.querySelector('.inbox-item[data-reason="rate_limited"]')!;
    await click(getButton('Resume', rlItem));
    await waitFor(() => expect(resumed).toEqual(['r2']));

    await click(rlItem.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!);
    const dismissMenuItem = [...rlItem.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Dismiss'),
    )!;
    await click(dismissMenuItem);
    expect(dismissed).toEqual(['r2']);

    // Question item has Open review and Open terminal in MoreMenu
    const qItem = inboxView.container.querySelector('.inbox-item[data-reason="question"]')!;
    await click(qItem.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!);
    expect(qItem.querySelector('a[href="/runs/r1/review"]')).not.toBeNull();
    expect(qItem.querySelector('a[href="/terminals/term-1"]')).not.toBeNull();

    // Fleet More menu triggers Clean up finished
    const fleetView = await renderDom(
      createElement(FleetPage, {
        activeProjectId: 'p1',
        seen: {},
        onInspectRun: () => undefined,
      }),
    );
    await waitFor(() => expect(fleetView.container.textContent).toContain('EL-1 Fix login redirect'));
    await click(fleetView.container.querySelector<HTMLButtonElement>('button[aria-label="Fleet actions"]')!);
    const gcMenuItem = [...fleetView.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.includes('Clean up finished'),
    )!;
    await click(gcMenuItem);
    await waitFor(() => expect(gcCalls).toBe(1));
  });

  it('enforces token-only colours, >= 0.8rem font sizes, and zero inline styles in target files', () => {
    for (const rel of [
      'pages/inbox-ux.css',
      'components/fleet/fleet-ux.css',
      'components/runInspector/run-inspector.css',
    ]) {
      const css = readFileSync(resolve(HERE, rel), 'utf8');
      expect(css, `${rel} must not contain hardcoded hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, `${rel} must not contain px font-size`).not.toMatch(/font-size:\s*[0-9.]+px/);
      const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
      expect(fontSizes.length).toBeGreaterThan(0);
      for (const rem of fontSizes) {
        expect(rem).toBeGreaterThanOrEqual(0.8);
      }
    }

    const targetComponentFiles = [
      'pages/InboxPage.tsx',
      'components/InboxNotices.tsx',
      'pages/FleetPage.tsx',
      'components/FleetPane.tsx',
      'components/fleet/FleetToolbar.tsx',
      'components/fleet/FleetEmptyState.tsx',
      'components/RunInspector.tsx',
      'components/runInspector/runInspectorMeta.ts',
      'components/runInspector/RunFailureBanner.tsx',
      'components/runInspector/RunEventTimeline.tsx',
      'components/RunOutcome.tsx',
      'components/HoldRecovery.tsx',
      'components/AnswerDialog.tsx',
      'pages/TerminalPage.tsx',
    ];
    for (const rel of targetComponentFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});
