// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, Run, Ticket } from '@emberline/protocol';
import { FactorySettings } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { TicketDrawer } from './components/board/TicketDrawer';
import { IssueImportDialog } from './components/IssueImportDialog';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { BoardPage } from './pages/BoardPage';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 0.9.3 default-view word counts measured with `visibleWordCount` before the M6 redesign (AC-6.5: <= 75% budget).
 */
export const BOARD_HEADER_093_BASELINE_WORDS = 26;
export const BOARD_HEADER_WORD_BUDGET = Math.floor(BOARD_HEADER_093_BASELINE_WORDS * 0.75);

export const TICKET_DRAWER_REVIEW_093_BASELINE_WORDS = 116;
export const TICKET_DRAWER_REVIEW_WORD_BUDGET = Math.floor(TICKET_DRAWER_REVIEW_093_BASELINE_WORDS * 0.75);

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

const tReview: Ticket = {
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
};

const tReady: Ticket = {
  ...tReview,
  id: 't2',
  key: 'EMB-37',
  title: 'SQLite WAL Checkpoint',
  body: '',
  persona: 'dba',
  status: 'ready',
  priority: 1,
};

const runReview: Run = {
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
  terminalId: 'term-1',
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
};

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

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  vi.restoreAllMocks();
});

describe('AC-6.5 word density budgets for BoardHeaderSection and TicketDrawer', () => {
  it('keeps the board header (a project with tickets) at or under 75% of its 0.9.3 word count', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/runs': () => [runReview],
        'GET /api/factory/claude-usage': () => ({ authenticated: false }),
        'GET /api/factory/settings': () => makeSettings(),
        'GET /api/projects/p1/worktree-config': () => ({ configured: false, entries: [] }),
        'GET /api/projects/p1/tickets': () => [tReview, tReady],
      }),
    );

    const { container } = await renderDom(createElement(BoardPage, { projectId: 'p1' }), {
      path: '/projects/p1/board',
    });
    await waitFor(() => expect(container.querySelector('#ticket-EMB-36')).not.toBeNull());

    const header = container.querySelector('header.ui-page-header')!;
    expect(header).not.toBeNull();
    const headerWords = visibleWordCount(header);
    expect(headerWords).toBeGreaterThan(0);
    expect(headerWords).toBeLessThanOrEqual(BOARD_HEADER_WORD_BUDGET);

    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Emberline');
    expect(header.textContent).toContain('2 tickets');

    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe('ticket-add');

    const autoStartSwitch = header.querySelector<HTMLButtonElement>('#pipeline-auto-start');
    expect(autoStartSwitch?.getAttribute('role')).toBe('switch');
    expect(autoStartSwitch?.getAttribute('aria-checked')).toBe('true');

    await click(header.querySelector<HTMLButtonElement>('button[aria-label="About auto-start"]')!);
    expect(header.querySelector('[role="dialog"]')?.textContent).toContain(
      'dragging a ticket into In progress automatically starts an agent run',
    );
  });

  it('keeps an opened drawer for a ticket in review at or under 75% of its 0.9.3 word count', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/runs': () => [runReview],
        'GET /api/factory/settings': () => makeSettings(),
        'GET /api/runs/r1/build-outputs': () => ({ worktreePath: runReview.worktreePath, outputs: [] }),
        'GET /api/factory/templates': () => [],
      }),
    );

    const { container } = await renderDom(
      createElement(TicketDrawer, {
        ticket: tReview,
        allTickets: [tReview, tReady],
        run: runReview,
        onClose: () => undefined,
        onChanged: () => undefined,
        armStart: 0,
        onMove: () => undefined,
        onDiscard: () => Promise.resolve(),
        onAccept: () => Promise.resolve(),
      }),
      { path: '/projects/p1/board?ticket=t1' },
    );

    const drawerWords = visibleWordCount(container);
    expect(drawerWords).toBeGreaterThan(0);
    expect(drawerWords).toBeLessThanOrEqual(TICKET_DRAWER_REVIEW_WORD_BUDGET);

    expect(container.querySelector('[aria-label="Details"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Agent"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="History"]')).not.toBeNull();

    // Exactly one primary button: Accept and merge (#drawer-done) for a ticket in review.
    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe('drawer-done');
    expect(primaries[0]?.textContent?.trim()).toBe('Accept and merge');
  });
});

describe('Board header MoreMenu, export dialog, and drawer disclosures', () => {
  it('exposes Project settings, Demo and status, Open PROJECT.md, Import issues, Export CSV/JSON, and Seed starter backlog in MoreMenu', async () => {
    let seeded = 0;
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/runs': () => [],
        'GET /api/factory/claude-usage': () => ({ authenticated: false }),
        'GET /api/factory/settings': () => makeSettings(),
        'GET /api/projects/p1/worktree-config': () => ({ configured: false, entries: [] }),
        'GET /api/projects/p1/tickets': () => [],
        'POST /api/projects/p1/seed-tickets': () => {
          seeded += 1;
          return { created: [tReady] };
        },
      }),
    );

    const { container } = await renderDom(createElement(BoardPage, { projectId: 'p1' }), {
      path: '/projects/p1/board',
    });
    await waitFor(() => {
      expect(container.querySelector('h1')?.textContent).toBe('Emberline');
      expect(container.querySelector('button[aria-label="Board actions"]')).not.toBeNull();
      expect(container.textContent).toContain('Ideas and not-yet-ready work');
    });

    const moreTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Board actions"]')!;
    await click(moreTrigger);

    const menuItems = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (el) => el.textContent ?? '',
    );
    expect(menuItems.some((t) => t.includes('Project settings'))).toBe(true);
    expect(menuItems.some((t) => t.includes('Demo and status'))).toBe(true);
    expect(menuItems.some((t) => t.includes('Open PROJECT.md'))).toBe(true);
    expect(menuItems.some((t) => t.includes('Import issues'))).toBe(true);
    expect(menuItems.some((t) => t.includes('Export CSV'))).toBe(true);
    expect(menuItems.some((t) => t.includes('Export JSON'))).toBe(true);
    expect(menuItems.some((t) => t.includes('Seed starter backlog'))).toBe(true);

    // Click Export JSON to open the export dialog pre-set to JSON
    const exportJsonBtn = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Export JSON'),
    )!;
    await click(exportJsonBtn);

    const exportDialog = container.querySelector('[role="dialog"][aria-label="Export tickets"]');
    expect(exportDialog).not.toBeNull();
    const jsonRadio = exportDialog?.querySelector<HTMLInputElement>('input[type="radio"][value="json"]');
    expect(jsonRadio?.checked).toBe(true);

    await click(exportDialog!.querySelector<HTMLButtonElement>('button[aria-label="Close export"]')!);
    expect(container.querySelector('[role="dialog"][aria-label="Export tickets"]')).toBeNull();

    // Seed starter backlog
    await click(moreTrigger);
    const seedBtn = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Seed starter backlog'),
    )!;
    await click(seedBtn);
    await waitFor(() => expect(seeded).toBe(1));
  });

  it('reveals Advanced overrides, History timeline, and MoreMenu actions in TicketDrawer', async () => {
    let discarded = 0;
    const liveRun: Run = { ...runReview, state: 'working', endedAt: null };

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/runs': () => [liveRun],
        'GET /api/runs/r1': () => ({
          ...liveRun,
          events: [
            {
              id: 1,
              runId: 'r1',
              ts: '2026-11-12T00:02:00.000Z',
              source: 'hook',
              type: 'tool_use',
              state: 'working',
              payload: { message: 'Running tests' },
            },
          ],
          finalMessage: null,
          lastScreen: null,
        }),
        'GET /api/factory/settings': () => makeSettings(),
        'GET /api/runs/r1/build-outputs': () => ({ worktreePath: liveRun.worktreePath, outputs: [] }),
        'GET /api/factory/templates': () => [],
      }),
    );

    const view = await renderDom(
      createElement(TicketDrawer, {
        ticket: { ...tReview, status: 'in_progress' },
        allTickets: [tReview, tReady],
        run: liveRun,
        onClose: () => undefined,
        onChanged: () => undefined,
        armStart: 0,
        onMove: () => undefined,
        onDiscard: async () => {
          discarded += 1;
        },
        onAccept: () => Promise.resolve(),
      }),
    );

    // While live with a worktree, Open review is the single primary action
    const primaries = view.container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('Open review');

    // Expand Advanced disclosure
    await click(getButton('Advanced', view.container));
    expect(view.container.querySelector('[role="radiogroup"][aria-label="Agent Persona"]')).not.toBeNull();

    // Expand History disclosure
    await click(getButton('History', view.container));
    await waitFor(() => expect(view.container.textContent).toContain('Running tests'));

    // Open Ticket actions MoreMenu: Delete is disabled while run is live; Move to Done without merging works
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Ticket actions"]')!);
    const deleteItem = [...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.includes('Delete'),
    )!;
    expect(deleteItem.disabled).toBe(true);

    const discardItem = [...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.includes('Move to Done without merging'),
    )!;
    await click(discardItem);
    await waitFor(() => expect(discarded).toBe(1));
  });

  it('renders IssueImportDialog tabs and imports selected issues', async () => {
    const imported: Ticket[] = [];
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects/p1/issues?state=open&page=1': () => ({
          items: [
            {
              externalId: 'gh-10',
              number: 10,
              title: 'Declutter board header',
              labels: ['ux'],
              url: 'https://github.com/acme/repo/issues/10',
              author: 'alice',
              updatedAt: '2026-11-12T00:00:00.000Z',
              state: 'open',
              linkedTicketKey: null,
            },
          ],
          nextPage: null,
        }),
        'POST /api/projects/p1/issues/import': () => ({
          created: [tReady],
          existing: [],
          skipped: [],
        }),
        'GET /api/projects/p1/issue-sync': () => ({
          enabled: false,
          label: 'emberline',
          status: 'backlog',
          trustedAuthors: ['alice'],
          closeOnDone: true,
          commentOnProgress: false,
          syncStatus: { lastSyncAt: null, lastError: null, pausedUntil: null },
        }),
      }),
    );

    const { container } = await renderDom(
      createElement(IssueImportDialog, {
        projectId: 'p1',
        projectName: 'Emberline',
        onClose: () => undefined,
        onImported: (created) => imported.push(...created),
      }),
    );
    await waitFor(() => expect(container.textContent).toContain('Declutter board header'));

    const issueCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select #10 Declutter board header"]',
    )!;
    await click(issueCheckbox);
    await click(getButton('Import 1', container));
    await waitFor(() => expect(imported).toHaveLength(1));

    // Switch to Sync tab
    await click(getButton('Sync', container));
    await waitFor(() => expect(container.textContent).toContain('Syncs labelled issues every 10 minutes.'));
    const labelInput = container.querySelector<HTMLInputElement>('input[maxlength="100"]')!;
    await typeInto(labelInput, 'ready-for-agent');
    expect(labelInput.value).toBe('ready-for-agent');
  });

  it('enforces token-only colours, >= 0.8rem font sizes, < 450 lines, and zero inline styles in target files', () => {
    for (const rel of ['components/board/board-ux.css', 'board-bulk.css']) {
      const css = readFileSync(resolve(HERE, rel), 'utf8');
      expect(css, `${rel} must not contain hardcoded hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, `${rel} must not contain px font-size`).not.toMatch(/font-size:\s*[0-9.]+px/);
      const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
      expect(fontSizes.length).toBeGreaterThan(0);
      for (const rem of fontSizes) {
        expect(rem).toBeGreaterThanOrEqual(0.8);
      }
    }

    const targetFiles = [
      'pages/BoardPage.tsx',
      'components/board/BoardHeaderSection.tsx',
      'components/board/BoardColumnsSection.tsx',
      'components/board/TicketDrawer.tsx',
      'components/board/DrawerDetailsSection.tsx',
      'components/board/DrawerAgentSection.tsx',
      'components/board/boardMeta.tsx',
      'components/BoardCard.tsx',
      'components/BoardFilterBar.tsx',
      'components/BoardBulkBar.tsx',
      'components/BoardExportMenu.tsx',
      'components/IssueImportDialog.tsx',
      'components/issueImport/IssueImportTab.tsx',
      'components/issueImport/IssueSyncTab.tsx',
    ];
    for (const rel of targetFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});
