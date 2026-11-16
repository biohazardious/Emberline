// @vitest-environment happy-dom
import type {
  ActiveProjectPreference,
  GitBranch,
  GitCommitsPage,
  GitPageStatus,
  Project,
  SystemStatus,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { EMPTY_BOARD_FILTER } from './boardFilter';
import { EMPTY_SELECTION } from './boardSelection';
import { BoardHeaderSection } from './components/board/BoardHeaderSection';
import type { BoardCtx } from './components/board/boardMeta';
import { RoadmapHeaderPanel } from './components/roadmap/RoadmapHeaderPanel';
import { AppSidebar } from './components/AppSidebar';
import { apiRoutes, cleanup, renderDom, waitFor } from './domRender';
import { BuildOutputsPage } from './pages/BuildOutputsPage';
import { CodeExplorerPage } from './pages/CodeExplorerPage';
import { Dashboard } from './pages/Dashboard';
import { DockerPage } from './pages/DockerPage';
import { FleetPage } from './pages/FleetPage';
import { GitPage } from './pages/GitPage';
import { InboxPage } from './pages/InboxPage';
import { LiveBrowserPage } from './pages/LiveBrowserPage';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { SettingsPage } from './pages/SettingsPage';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

afterEach(cleanup);

const BANNED_WORDS = ['Studio', 'Hub', 'Matrix', 'Multiplexer', 'Control Center'] as const;
const ACRONYMS = new Set(['MCP', 'SSH', 'CLI', 'SDK', 'UI', 'PR', 'API', 'URL', 'AI']);

function assertLabelRules(label: string, context: string, { allowProperNoun = false } = {}) {
  const trimmed = label.trim();
  expect(trimmed.length, `${context}: label must not be empty`).toBeGreaterThan(0);
  const words = trimmed.split(/\s+/);
  expect(words.length, `${context}: "${trimmed}" exceeds 3 words`).toBeLessThanOrEqual(3);
  expect(trimmed, `${context}: "${trimmed}" must not contain &`).not.toContain('&');
  expect(trimmed, `${context}: "${trimmed}" must not contain +`).not.toContain('+');

  for (const banned of BANNED_WORDS) {
    const re = new RegExp(`\\b${banned.replace(/\s+/g, '\\s+')}\\b`, 'i');
    expect(re.test(trimmed), `${context}: "${trimmed}" contains banned word "${banned}"`).toBe(false);
  }

  if (!allowProperNoun) {
    const first = words[0] ?? '';
    expect(/^[A-Z]/.test(first), `${context}: "${trimmed}" must start with an uppercase letter`).toBe(true);
    for (const word of words.slice(1)) {
      if (ACRONYMS.has(word)) continue;
      expect(
        /^[a-z0-9]/.test(word),
        `${context}: "${trimmed}" must be sentence case (unexpected uppercase in "${word}")`,
      ).toBe(true);
    }
  }
}

function assertPageChrome(container: HTMLElement, pageName: string, { allowProperNounH1 = false } = {}) {
  const h1s = Array.from(container.querySelectorAll('h1'));
  expect(h1s.length, `${pageName} must render exactly one <h1>`).toBe(1);
  const h1Text = h1s[0]?.textContent?.trim() ?? '';
  assertLabelRules(h1Text, `${pageName} h1`, { allowProperNoun: allowProperNounH1 });

  const primaryButtons = Array.from(container.querySelectorAll('button.btn-primary, a.btn-primary')).filter(
    (el) => !el.hasAttribute('hidden') && el.closest('[hidden]') === null,
  );
  expect(primaryButtons.length, `${pageName} must have at most one .btn-primary`).toBeLessThanOrEqual(1);

  for (const actions of Array.from(container.querySelectorAll('.ui-page-actions'))) {
    const directCount = Array.from(actions.children).filter(
      (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
    ).length;
    expect(directCount, `${pageName} toolbar must have at most 5 direct actions`).toBeLessThanOrEqual(5);
  }
}

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  slug: 'alpha',
  path: '/workspaces/alpha',
  repoUrl: 'https://github.com/org/alpha.git',
  defaultBranch: 'main',
  appType: 'fullstack',
  description: 'Alpha project',
  techStack: null,
  createdAt: '2026-11-16T00:00:00.000Z',
};

const system: SystemStatus = {
  version: '0.9.3',
  apiVersion: 2,
  ptyd: 'connected',
  runnerOutdated: false,
  runnerUpdateAvailable: false,
  runnerNotSecured: false,
  runnerProblem: null,
  opsMissing: false,
  sshKeyMissing: [],
  docker: { enabled: true, checked: true, available: true, version: '27.0' },
};

const activePref: ActiveProjectPreference = { activeProjectId: 'p1' };

const gitStatus: GitPageStatus = {
  isGitRepo: true,
  defaultBranch: 'main',
  workingBranch: 'develop',
  checkedOut: 'develop',
  workingMismatch: false,
  mainBehindWorking: 0,
  latestTag: null,
  hasOrigin: true,
  originUrl: 'https://github.com/org/alpha.git',
  working: 'up_to_date',
  main: 'up_to_date',
  workingCounts: null,
  mainCounts: null,
  checkedAt: null,
  autoPull: true,
  sync: { state: 'idle', at: null, branch: null, files: [], message: null },
  forgeRelease: false,
  release: { ok: true, reason: null },
  releaseJob: null,
  releaseDraft: null,
  releaseSummary: { head: null, commits: 0, tickets: 0, checks: [], hasChangelog: false },
  backups: [],
  tagsDifferFromOrigin: [],
  tagsNamedLikeBranches: [],
  originRefsUnread: false,
  notOnOrigin: { working: null, main: null },
};

const gitCommits: GitCommitsPage = {
  ref: 'develop',
  commits: [],
  nextCursor: null,
};

const gitBranches: GitBranch[] = [
  {
    name: 'main',
    kind: 'main',
    tip: '0000000',
    subject: 'init',
    vsMain: null,
    vsOrigin: null,
    mergedIntoMain: true,
    mergedIntoWorking: true,
    liveRuns: [],
  },
];

const dockerStatus = {
  enabled: true,
  available: true,
  checked: true,
  version: '27.0',
  containers: [],
  images: [],
  composeStacks: [],
};

const projectSettings = {
  defaultAgent: 'claude',
  defaultPersona: 'coder',
  defaultPermissionMode: 'default',
  autoStart: true,
  autoMerge: false,
  mergeStrategy: 'squash',
  maxConcurrentRuns: 2,
  worktreeBaseDir: null,
  demoCommand: null,
  demoPort: null,
  demoHealthUrl: null,
  demoReadyTimeoutSec: null,
  workingBranch: 'develop',
  autoPull: true,
  serializeOverlappingTickets: true,
  autoResolveAdditiveConflicts: true,
};

const pathStatus = {
  exists: true,
  isGitRepo: true,
  currentBranch: 'develop',
  dirty: false,
};

const previewInfo = {
  supported: false,
  reason: 'No compose file',
  environments: [],
};

describe('AC-6.6 rendered UX copy & chrome guards', () => {
  it('checks AppSidebar nav labels for sentence case, <= 3 words, no &/+ and no banned words', async () => {
    const view = await renderDom(
      createElement(AppSidebar, {
        sidebarCollapsed: false,
        onToggleCollapse: () => undefined,
        mobileNavOpen: false,
        onCloseMobileNav: () => undefined,
        location: '/',
        system,
        updatesAvailable: 0,
        projects: [project],
        activeProject: project,
        onSwitchProject: () => undefined,
        onOpenWizard: () => undefined,
        onCleanupWorktrees: () => undefined,
        onProjectDeleted: () => Promise.resolve(),
        onOpenCommandPalette: () => undefined,
        attentionCount: 0,
        activeRuns: [],
        projectById: new Map([[project.id, project]]),
        inspectRunId: undefined,
        onToggleInspectRun: () => undefined,
        scheduler: undefined,
        claudeUsage: undefined,
        factorySettings: undefined,
        allRuns: [],
        theme: 'dark',
        onToggleTheme: () => undefined,
        onLogout: () => undefined,
      }),
      { path: '/' },
    );

    const navLinks = Array.from(view.container.querySelectorAll('.sidebar-nav a.nav-item'));
    expect(navLinks.length).toBe(11);
    for (const link of navLinks) {
      const label = link.querySelector('.nav-label')?.textContent?.trim() ?? '';
      assertLabelRules(label, 'AppSidebar nav');
    }
  });

  it('checks SettingsPage tab labels, h1, primary button and toolbar actions', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/factory/settings': () => ({}),
        'GET /api/setup/providers': () => ({ providers: [] }),
        'GET /api/usage': () => ({ lanes: [], summary: {} }),
        'GET /api/mcp/servers': () => ({ servers: [] }),
        'GET /api/skills': () => ({ skills: [] }),
        'GET /api/projects': () => [project],
        'GET /api/system/status': () => system,
      }),
    );

    const view = await renderDom(
      createElement(SettingsPage, { theme: 'dark', onChangeTheme: () => undefined }),
      {
        path: '/settings?tab=providers',
      },
    );

    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'SettingsPage');

    const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
    expect(tabs.length).toBe(8);
    for (const tab of tabs) {
      assertLabelRules(tab.textContent ?? '', 'SettingsPage tab');
    }
  });

  it('checks Overview (Dashboard) chrome', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/projects/p1/tickets': () => [],
        'GET /api/runs': () => [],
        'GET /api/projects/p1/cron': () => [],
        'GET /api/projects/p1/usage': () => ({ todayUsd: 0, monthUsd: 0, runs: [] }),
        'GET /api/projects/p1/settings': () => projectSettings,
        'GET /api/projects/p1/path-status': () => pathStatus,
        'GET /api/projects/p1/container-preview': () => previewInfo,
      }),
    );

    const view = await renderDom(createElement(Dashboard, { system, activeProjectId: 'p1' }), { path: '/' });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'Dashboard');
  });

  it('checks BoardHeaderSection chrome', async () => {
    const boardCtx: BoardCtx = {
      projectId: 'p1',
      project,
      tickets: [],
      allColumns: new Map(),
      visibleColumns: new Map(),
      columnCounts: new Map(),
      latestRun: new Map(),
      autoStart: true,
      toggleAutoStart: () => undefined,
      demoPanelOpen: false,
      toggleDemoPanel: () => undefined,
      canSeed: false,
      bulkSelection: {
        active: false,
        selection: EMPTY_SELECTION,
        isSelected: () => false,
        toggle: () => undefined,
        toggleColumn: () => undefined,
        columnSelected: () => false,
        replace: () => undefined,
        setActive: () => undefined,
      },
      onBulkApplied: () => undefined,
      filter: EMPTY_BOARD_FILTER,
      filterActive: false,
      filteredCount: 0,
      updateFilter: () => undefined,
      openBlueprint: () => undefined,
      openImport: () => undefined,
      goBack: () => undefined,
      patchTicket: () => undefined,
      error: undefined,
      setError: () => undefined,
      blockedDrop: undefined,
      missingDrop: undefined,
      resolvingNotice: undefined,
      clearBlockedDrop: () => undefined,
      clearMissingDrop: () => undefined,
      clearResolvingNotice: () => undefined,
      moveTicket: () => Promise.resolve(),
      openTicket: () => undefined,
    };

    const view = await renderDom(
      createElement(BoardHeaderSection, {
        ctx: boardCtx,
      }),
    );
    assertPageChrome(view.container, 'BoardHeaderSection', { allowProperNounH1: true });
  });

  it('checks RoadmapHeaderPanel chrome', async () => {
    const view = await renderDom(
      createElement(RoadmapHeaderPanel, {
        projectName: 'Alpha',
        roadmap: {
          projectId: 'p1',
          visionSummary: 'Build Alpha cleanly.',
          totalItems: 0,
          completedItems: 0,
          completionPercent: 0,
          milestones: [],
          suggestions: [],
          updatedAt: '2026-11-16T00:00:00.000Z',
        },
        busy: null,
        isAgentBrainstorming: false,
        onAutoGenerate: () => undefined,
        onOpenBoard: () => undefined,
        quickAddTarget: 'auto',
        onQuickAddTargetChange: () => undefined,
        quickAddText: '',
        onQuickAddTextChange: () => undefined,
        onSmartQuickAdd: () => undefined,
        selectedSuggestionsCount: 0,
        selectedItemsCount: 0,
        onClearSelection: () => undefined,
        onDispatchSelected: () => undefined,
        banner: null,
        error: null,
      }),
    );
    assertPageChrome(view.container, 'RoadmapHeaderPanel');
  });

  function mockDefaultApi() {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/preferences/active-project': () => activePref,
        'GET /api/projects/p1': () => project,
        'GET /api/projects/p1/git': () => gitStatus,
        'GET /api/projects/p1/git/commits': () => gitCommits,
        'GET /api/projects/p1/git/branches': () => gitBranches,
        'GET /api/docker': () => dockerStatus,
        'GET /api/projects/p1/build-outputs': () => ({
          outputs: [],
          usedBytes: 0,
          quotaBytes: 1024,
          archiveDir: '/workspaces/alpha/.emberline/outputs',
          hostArchiveDir: '/srv/alpha/outputs',
          collecting: false,
          lastCollect: null,
        }),
        'GET /api/projects/p1/settings': () => projectSettings,
        'GET /api/projects/p1/path-status': () => pathStatus,
        'GET /api/projects/p1/container-preview': () => previewInfo,
        'GET /api/projects/p1/status': () => ({
          project,
          counts: {},
          totalTickets: 0,
          activeRuns: 0,
          git: null,
        }),
        'GET /api/system': () => ({ apiVersion: '1', ptyd: 'connected', docker: { available: true } }),
        'GET /api/projects/p1/browser-viewport?targetId=main': () => ({
          targetId: 'main',
          active: false,
          url: null,
          title: null,
          width: 1280,
          height: 800,
          screenshotBase64: null,
          updatedAt: null,
          targets: [],
        }),
        'GET /api/projects/p1/files?targetId=main': () => ({
          targetId: 'main',
          workspacePath: '/workspaces/alpha',
          entries: [],
        }),
        'GET /api/scheduler': () => ({
          maxConcurrentRuns: 2,
          busy: 0,
          queued: 0,
          rateLimited: 0,
          window: null,
          windows: [],
        }),
        'GET /api/factory/claude-usage': () => ({ available: false, authenticated: false }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude'], personaRoutes: {} }),
        'GET /api/runs': () => [],
        'GET /api/projects/p1/notices': () => [],
      }),
    );
  }

  it('checks GitPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(createElement(GitPage, { projectId: 'p1' }), { path: '/projects/p1/git' });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'GitPage');
  });

  it('checks DockerPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(createElement(DockerPage, { activeProjectId: 'p1', projects: [project] }), {
      path: '/docker',
    });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'DockerPage');
  });

  it('checks BuildOutputsPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(createElement(BuildOutputsPage, { projectId: 'p1' }), {
      path: '/projects/p1/outputs',
    });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'BuildOutputsPage');
  });

  it('checks CodeExplorerPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(createElement(CodeExplorerPage, { projectId: 'p1' }), {
      path: '/projects/p1/code',
    });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'CodeExplorerPage');
  });

  it('checks LiveBrowserPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(createElement(LiveBrowserPage, { projectId: 'p1' }), {
      path: '/projects/p1/browser',
    });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'LiveBrowserPage');
  });

  it('checks ProjectSettingsPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(createElement(ProjectSettingsPage, { projectId: 'p1' }), {
      path: '/projects/p1/settings',
    });
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'ProjectSettingsPage');
  });

  it('checks InboxPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(
      createElement(InboxPage, {
        runs: [],
        seen: {},
        activeProjectId: 'p1',
        projectName: 'Alpha',
        onOpenRun: () => undefined,
        onDismiss: () => undefined,
      }),
      { path: '/inbox' },
    );
    assertPageChrome(view.container, 'InboxPage');
  });

  it('checks FleetPage chrome', async () => {
    mockDefaultApi();
    const view = await renderDom(
      createElement(FleetPage, {
        activeProjectId: 'p1',
        seen: {},
        onInspectRun: () => undefined,
      }),
      { path: '/fleet' },
    );
    await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull());
    assertPageChrome(view.container, 'FleetPage');
  });
});
