// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BuildDemoResponse,
  FactoryRequestResponse,
  GarbageCollectRunsResponse,
  Project,
  ProjectBlueprintResponse,
  ProjectCheckpoint,
  ProjectRecommendation,
  ProjectStatusSummary,
  ProjectUsageResponse,
  Run,
  ScheduledJob,
  SyncWorktreeResponse,
  SystemStatus,
  TerminalInfo,
  Ticket,
  WorkspaceDemoTarget,
} from '@emberline/protocol';
import { API_VERSION } from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api } from './api';
import type * as ApiModule from './api';
import { BlueprintModal } from './components/BlueprintModal';
import { BudgetPanel } from './components/BudgetPanel';
import { ProjectAdvisorPanel } from './components/ProjectAdvisorPanel';
import { ProjectStatusAndDemoPanel } from './components/ProjectStatusAndDemoPanel';
import { ScheduledJobsPanel } from './components/ScheduledJobsPanel';
import { apiRoutes, cleanup, click, getButton, renderDom, typeInto, waitFor } from './domRender';
import { Dashboard } from './pages/Dashboard';
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
export const OVERVIEW_PROJECT_093_BASELINE_WORDS = 304;
export const OVERVIEW_PROJECT_WORD_BUDGET = Math.floor(OVERVIEW_PROJECT_093_BASELINE_WORDS * 0.75);

export const PROJECT_STATUS_093_BASELINE_WORDS = 174;
export const PROJECT_STATUS_WORD_BUDGET = Math.floor(PROJECT_STATUS_093_BASELINE_WORDS * 0.75);

export const PROJECT_ADVISOR_093_BASELINE_WORDS = 86;
export const PROJECT_ADVISOR_WORD_BUDGET = Math.floor(PROJECT_ADVISOR_093_BASELINE_WORDS * 0.75);

export const OVERVIEW_RUNS_093_BASELINE_WORDS = 138;
export const OVERVIEW_RUNS_WORD_BUDGET = Math.floor(OVERVIEW_RUNS_093_BASELINE_WORDS * 0.75);

export const SCHEDULED_JOBS_093_BASELINE_WORDS = 44;
export const SCHEDULED_JOBS_WORD_BUDGET = Math.floor(SCHEDULED_JOBS_093_BASELINE_WORDS * 0.75);

export const BUDGET_PANEL_093_BASELINE_WORDS = 29;
export const BUDGET_PANEL_WORD_BUDGET = Math.floor(BUDGET_PANEL_093_BASELINE_WORDS * 0.75);

export const BLUEPRINT_MODAL_093_BASELINE_WORDS = 45;
export const BLUEPRINT_MODAL_WORD_BUDGET = Math.floor(BLUEPRINT_MODAL_093_BASELINE_WORDS * 0.75);

const project: Project = {
  id: 'p1',
  name: 'Emberline',
  slug: 'emberline',
  path: '/workspaces/emberline',
  repoUrl: 'https://github.com/acme/emberline.git',
  defaultBranch: 'main',
  appType: 'fullstack',
  description: 'Multi-agent coding factory',
  techStack: {
    language: 'TypeScript',
    frontend: 'React',
    backend: 'Fastify',
    database: 'SQLite',
    styling: 'CSS',
    testing: 'Vitest',
  },
  createdAt: '2026-11-12T00:00:00.000Z',
};

const demoTarget: WorkspaceDemoTarget = {
  id: 'main',
  kind: 'main',
  label: 'Main Workspace (main)',
  ticketKey: null,
  ticketTitle: null,
  persona: null,
  runStatus: null,
  branch: 'main',
  workspacePath: '/workspaces/emberline',
  exists: true,
  fileCount: 42,
  topFiles: ['PROJECT.md', 'package.json', 'src/index.ts'],
  hasPackageJson: true,
  hasBuildScript: true,
  detectedStack: 'TypeScript / Node',
  buildCommand: 'pnpm run build',
  detectedLayers: ['Frontend UI', 'Backend API'],
  demoEntryRelPath: 'dist/index.html',
  demoUrl: '/api/projects/p1/demo/main/',
  updatedAt: '2026-11-12T00:00:00.000Z',
  demoBuild: {
    commit: '0123456789abcdef0123456789abcdef01234567',
    builtAt: '2026-11-12T00:00:00.000Z',
    ok: true,
  },
  demoStale: false,
  rebuilding: false,
};

const worktreeTarget: WorkspaceDemoTarget = {
  ...demoTarget,
  id: 'r1',
  kind: 'worktree',
  label: 'Worktree · EMB-2',
  ticketKey: 'EMB-2',
  ticketTitle: 'Add auth endpoints',
  persona: 'coder',
  runStatus: 'working',
  branch: 'emberline/emb-2',
  workspacePath: '/workspaces/emberline/.worktrees/r1',
  demoEntryRelPath: null,
  demoUrl: null,
};

const statusSummary: ProjectStatusSummary = {
  projectId: 'p1',
  workspaceRoot: '/workspaces/emberline',
  hostBindHint: './workspaces/emberline',
  ticketCounts: { total: 4, backlog: 1, ready: 1, in_progress: 0, review: 0, done: 2 },
  completionPercent: 50,
  activeRunCount: 0,
  autoChainActive: false,
  targets: [demoTarget],
};

const tickets: Ticket[] = [
  {
    id: 't1',
    projectId: 'p1',
    key: 'EMB-1',
    title: 'Setup database',
    body: '',
    persona: 'dba',
    status: 'done',
    priority: 1,
    position: 1024,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  },
  {
    id: 't2',
    projectId: 'p1',
    key: 'EMB-2',
    title: 'Add auth endpoints',
    body: '',
    persona: 'coder',
    status: 'ready',
    priority: 2,
    position: 2048,
    depth: 0,
    dependsOn: [],
    blockedBy: [],
    completion: null,
    external: null,
    waitingOn: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  },
];

const checkpoints: ProjectCheckpoint[] = [
  {
    sha: '0123456789abcdef0123456789abcdef01234567',
    shortSha: '0123456',
    subject: 'Initial commit',
    author: 'Emberline',
    createdAt: '2026-11-12T00:00:00.000Z',
  },
  {
    sha: 'abcdef0123456789abcdef0123456789abcdef01',
    shortSha: 'abcdef0',
    subject: 'Bootstrap workspace',
    author: 'Emberline',
    createdAt: '2026-11-11T00:00:00.000Z',
  },
];

const recommendations: ProjectRecommendation[] = [
  {
    id: 'rec-1',
    priority: 'high',
    category: 'execution',
    title: 'Add auth endpoints',
    description: 'EMB-2 is ready to start with the Coder persona.',
    persona: 'coder',
    actionLabel: 'Start Coder run',
    actionType: 'start_run',
    prompt: 'Implement EMB-2',
  },
  {
    id: 'rec-2',
    priority: 'medium',
    category: 'qa',
    title: 'Run regression tests',
    description: 'Verify the API endpoints and UI flows.',
    persona: 'qa',
    actionLabel: 'Start QA run',
    actionType: 'start_run',
    prompt: 'Run QA checks',
  },
];

const sampleRun: Run = {
  id: 'r1',
  projectId: 'p1',
  ticketId: 't1',
  title: 'EMB-1 Setup database',
  agent: 'claude',
  persona: 'dba',
  state: 'done',
  prompt: 'Setup SQLite schema',
  permissionMode: 'default',
  branch: 'emberline/emb-1',
  worktreePath: '/workspaces/emberline/.worktrees/r1',
  terminalId: null,
  agentSessionId: null,
  lastEvent: 'stop',
  stateChangedAt: '2026-11-12T00:05:00.000Z',
  createdAt: '2026-11-12T00:01:00.000Z',
  endedAt: '2026-11-12T00:05:00.000Z',
  resumable: false,
  cancelled: false,
  attention: null,
  reviewReady: true,
} as unknown as Run;

const sampleJob: ScheduledJob = {
  id: 'j1',
  projectId: 'p1',
  name: 'Nightly Test & Lint',
  cronExpr: '0 2 * * *',
  timeZone: 'UTC',
  prompt: 'Run test suite and linter',
  permissionMode: 'auto',
  overlapPolicy: 'skip',
  enabled: true,
  pausedReason: null,
  lastRunAt: null,
  lastRunId: null,
  nextRunAt: '2026-11-17T02:00:00.000Z',
  createdAt: '2026-11-12T00:00:00.000Z',
};

const sampleUsage: ProjectUsageResponse = {
  projectId: 'p1',
  days: [
    {
      date: '2026-11-15',
      runs: 3,
      inputTokens: 12000,
      outputTokens: 4000,
      cachedTokens: 20000,
      toolCalls: 15,
      durationSec: 420,
      estimatedRuns: 0,
    },
  ],
  runsLast24h: 3,
  maxAutoRunsPerProjectPerDay: 20,
  budgetExhausted: false,
  maxTicketDepth: 3,
};

const connectedSystem: SystemStatus = {
  version: '0.9.3',
  apiVersion: API_VERSION,
  ptyd: 'connected',
  runnerOutdated: false,
  runnerUpdateAvailable: false,
  runnerNotSecured: false,
  runnerProblem: null,
  opsMissing: false,
  sshKeyMissing: [],
  docker: {
    enabled: true,
    checked: true,
    available: true,
    version: '27.3.1',
  },
};

function installOverviewRoutes(overrides: Record<string, (body?: unknown) => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    apiRoutes({
      'GET /api/projects': () => [project],
      'GET /api/terminals': () => [],
      'GET /api/runs': () => [],
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
      'GET /api/projects/p1/status': () => statusSummary,
      'GET /api/projects/p1/tickets': () => tickets,
      'GET /api/projects/p1/checkpoints': () => checkpoints,
      'GET /api/projects/p1/recommendations': () => recommendations,
      'GET /api/projects/p1/usage?days=7': () => sampleUsage,
      'GET /api/projects/p1/blueprint': (): ProjectBlueprintResponse => ({
        projectId: 'p1',
        path: '/workspaces/emberline/PROJECT.md',
        exists: true,
        content: '# Emberline\n',
      }),
      'GET /api/cron': () => [],
      'POST /api/cron/preview': () => ({ nextRuns: ['2026-11-17T04:00:00.000Z'] }),
      'GET /api/system': () => connectedSystem,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  installOverviewRoutes();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
  vi.restoreAllMocks();
});

describe('AC-6.5 word density budgets for Overview and its sub-panels', () => {
  it('keeps the Overview project tab (active project with demo target and no run in progress) at or under 75% of its 0.9.3 word count', async () => {
    const { container } = await renderDom(
      createElement(Dashboard, { system: connectedSystem, activeProjectId: 'p1' }),
      { path: '/' },
    );
    await waitFor(() => expect(container.textContent).toContain('Add auth endpoints'));
    await waitFor(() => expect(container.textContent).toContain('dist/index.html'));

    const words = visibleWordCount(container);
    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThanOrEqual(OVERVIEW_PROJECT_WORD_BUDGET);

    // Single h1 ("Overview") and two overview tabs ("Project", "Runs")
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Overview');

    const tabs = [...container.querySelectorAll('[aria-label="Overview sections"] [role="tab"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(tabs).toEqual(['Project', 'Runs']);

    // Single primary button ("Send to factory") in the default view
    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('Send to factory');
  });

  it('keeps ProjectStatusAndDemoPanel and ProjectAdvisorPanel at or under 75% of 0.9.3 words', async () => {
    const statusView = await renderDom(createElement(ProjectStatusAndDemoPanel, { project }));
    await waitFor(() => expect(statusView.container.textContent).toContain('dist/index.html'));
    expect(visibleWordCount(statusView.container)).toBeLessThanOrEqual(PROJECT_STATUS_WORD_BUDGET);
    await cleanup();

    const advisorView = await renderDom(
      createElement(ProjectAdvisorPanel, {
        project,
        onOpenBlueprint: () => undefined,
        onStartPersonaRun: () => undefined,
      }),
    );
    await waitFor(() => expect(advisorView.container.textContent).toContain('Add auth endpoints'));
    expect(visibleWordCount(advisorView.container)).toBeLessThanOrEqual(PROJECT_ADVISOR_WORD_BUDGET);
  });

  it('keeps the Overview Runs tab at or under 75% of its 0.9.3 word count', async () => {
    installOverviewRoutes({
      'GET /api/runs': () => [sampleRun],
      'GET /api/terminals': () =>
        [
          {
            id: 'term-1',
            title: 'shell #1',
            kind: 'shell',
            status: 'running',
            exitCode: null,
            projectId: 'p1',
            runId: null,
            createdAt: '2026-11-12T00:00:00.000Z',
          },
        ] satisfies TerminalInfo[],
    });
    const runsView = await renderDom(
      createElement(Dashboard, { system: connectedSystem, activeProjectId: 'p1' }),
      { path: '/?section=runs' },
    );
    await waitFor(() => {
      expect(runsView.container.textContent).toContain('EMB-1 Setup database');
      expect(runsView.container.textContent).toContain('Usage and budget');
    });
    expect(visibleWordCount(runsView.container)).toBeLessThanOrEqual(OVERVIEW_RUNS_WORD_BUDGET);
    expect(runsView.container.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('keeps ScheduledJobsPanel, BudgetPanel and BlueprintModal at or under 75% of 0.9.3 words', async () => {
    installOverviewRoutes({
      'GET /api/cron': () => [sampleJob],
    });
    const cronView = await renderDom(createElement(ScheduledJobsPanel, { projects: [project] }));
    await waitFor(() => expect(cronView.container.textContent).toContain('Nightly Test & Lint'));
    expect(visibleWordCount(cronView.container)).toBeLessThanOrEqual(SCHEDULED_JOBS_WORD_BUDGET);
    await cleanup();

    const budgetView = await renderDom(createElement(BudgetPanel, { project }));
    await waitFor(() => expect(budgetView.container.textContent).toContain('Usage and budget'));
    expect(visibleWordCount(budgetView.container)).toBeLessThanOrEqual(BUDGET_PANEL_WORD_BUDGET);
    await cleanup();

    const modalView = await renderDom(
      createElement(BlueprintModal, { project, open: true, onClose: () => undefined }),
    );
    await waitFor(() => expect(modalView.container.querySelector('#blueprint-editor')).not.toBeNull());
    expect(visibleWordCount(modalView.container)).toBeLessThanOrEqual(BLUEPRINT_MODAL_WORD_BUDGET);
    expect(modalView.container.querySelectorAll('.btn-primary')).toHaveLength(1);
  });
});

describe('Overview Project tab: factory request, disclosures, sync, live demo and advisor', () => {
  it('submits factory requests with example prompts, reveals disclosures, and runs pipeline via MoreMenu', async () => {
    const factoryRequests: unknown[] = [];
    let pipelineStarted = 0;

    installOverviewRoutes({
      'POST /api/projects/p1/factory-request': (body): FactoryRequestResponse => {
        factoryRequests.push(body);
        return {
          ticket: { ...tickets[1]!, key: 'EMB-9' },
          run: sampleRun,
        };
      },
      'POST /api/projects/p1/run-pipeline': () => {
        pipelineStarted += 1;
        return { ok: true };
      },
    });

    const { container } = await renderDom(createElement(ProjectStatusAndDemoPanel, { project }));
    await waitFor(() => expect(container.textContent).toContain('dist/index.html'));

    // Example prompts and attachment rules are hidden behind disclosures by default
    expect(container.textContent).not.toContain('Build a multi-step workflow form');
    await click(getButton('Example prompts', container));
    expect(container.textContent).toContain('Build a multi-step workflow form');

    // Click an example prompt to prefill the composer
    const exampleChip = [...container.querySelectorAll<HTMLButtonElement>('.factory-example-chip')][0]!;
    await click(exampleChip);

    await click(getButton('Attachment rules', container));
    expect(container.textContent).toContain('15 MB each');

    await click(getButton('Sync details', container));
    expect(container.textContent).toContain('./workspaces/emberline');
    expect(container.textContent).toContain('Backlog: 1');

    // Toggle Auto-dispatch switch off and submit
    const autoDispatchSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(autoDispatchSwitch.getAttribute('aria-checked')).toBe('true');
    await click(autoDispatchSwitch);
    expect(autoDispatchSwitch.getAttribute('aria-checked')).toBe('false');

    await click(getButton('Send to factory', container));
    await waitFor(() => expect(factoryRequests).toHaveLength(1));
    expect(factoryRequests[0]).toMatchObject({
      leadPersona: 'product_owner',
      autoDispatch: false,
    });

    // Run pipeline from MoreMenu
    await click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Project workspace actions"]')!,
    );
    const runPipelineItem = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Run pipeline'),
    )!;
    await click(runPipelineItem);
    await waitFor(() => expect(pipelineStarted).toBe(1));
  });

  it('handles worktree sync, blocked-sync override, build logs disclosure, and checkpoint rollback', async () => {
    const syncCalls: unknown[] = [];
    let shouldBlockSync = true;
    let rolledBackSha: string | null = null;

    installOverviewRoutes({
      'GET /api/projects/p1/status': () => ({
        ...statusSummary,
        targets: [{ ...demoTarget, demoUrl: null, demoEntryRelPath: null }, worktreeTarget],
      }),
      'GET /api/projects/p1/preview': () => ({
        kind: 'command',
        status: 'stopped',
        url: null,
        port: null,
        command: null,
        detectedCommand: null,
        logs: '',
        error: null,
        note: null,
      }),
      'GET /api/projects/p1/container-preview': () => ({
        available: false,
        reason: null,
        file: null,
        services: [],
        commandPreview: true,
      }),
      'POST /api/projects/p1/build-demo': (): BuildDemoResponse => ({
        ok: true,
        targetId: 'main',
        demoUrl: null,
        demoEntryRelPath: null,
        output: 'Build finished in 1.2s\nAll checks green.',
      }),
      'POST /api/projects/p1/sync-worktree': (body): SyncWorktreeResponse => {
        syncCalls.push(body);
        if (shouldBlockSync) {
          throw new ApiRequestError(409, 'review_blocked', '2 open blocking review comments', {
            blocking: 2,
          });
        }
        return {
          ok: true,
          runId: 'r1',
          filesSynced: 3,
          commitSha: '1234567',
          conflicts: [],
          alreadyMerged: false,
          summary: 'Merged into main.',
          resolution: 'manual',
          resolverRunId: null,
          autoResolved: [],
        };
      },
      'POST /api/projects/p1/rollback': (body) => {
        rolledBackSha = (body as { sha: string }).sha;
        return { ok: true };
      },
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container } = await renderDom(createElement(ProjectStatusAndDemoPanel, { project }));
    await waitFor(() => expect(container.textContent).toContain('Build: pnpm run build'));

    // Build preview and check Build logs disclosure
    await click(getButton('Build preview', container));
    await waitFor(() => expect(container.textContent).toContain('Build and verify'));
    expect(container.textContent).not.toContain('All checks green.');
    await click(getButton('Build logs', container));
    expect(container.textContent).toContain('All checks green.');
    await click(getButton('Clear log', container));
    expect(container.textContent).not.toContain('All checks green.');

    // Switch to Worktrees tab and trigger blocked sync, then Merge anyway
    await click(getButton(/Worktrees/, container));
    await click(getButton('Sync to main', container));
    await waitFor(() => expect(container.querySelector('.panel-blocked-sync')).not.toBeNull());
    expect(container.textContent).toContain('Nothing was merged.');

    shouldBlockSync = false;
    await click(getButton('Merge anyway', container));
    await waitFor(() => expect(syncCalls).toEqual([{ runId: 'r1' }, { runId: 'r1', force: true }]));

    // Switch to Checkpoints tab and roll back
    await click(getButton(/Checkpoints/, container));
    await click(getButton('Roll back', container));
    await waitFor(() => expect(rolledBackSha).toBe('abcdef0123456789abcdef0123456789abcdef01'));
  });

  it('prefills the run form from Next steps persona chips and opens BlueprintModal', async () => {
    const savedBlueprints: unknown[] = [];
    installOverviewRoutes({
      'PUT /api/projects/p1/blueprint': (body): ProjectBlueprintResponse => {
        savedBlueprints.push(body);
        return {
          projectId: 'p1',
          path: '/workspaces/emberline/PROJECT.md',
          exists: true,
          content: (body as { content: string }).content,
        };
      },
    });

    const { container } = await renderDom(
      createElement(Dashboard, { system: connectedSystem, activeProjectId: 'p1' }),
      { path: '/' },
    );
    await waitFor(() => expect(container.textContent).toContain('Next steps'));

    // Open PROJECT.md modal and save
    await click(container.querySelector<HTMLButtonElement>('#open-blueprint-btn')!);
    await waitFor(() => expect(container.querySelector('#blueprint-editor')).not.toBeNull());
    expect(container.querySelector('#blueprint-modal-title')?.textContent).toBe('PROJECT.md');

    const editor = container.querySelector<HTMLTextAreaElement>('#blueprint-editor')!;
    await typeInto(editor, '# Emberline Updated\n');
    await click(container.querySelector<HTMLButtonElement>('#blueprint-save')!);
    await waitFor(() => expect(savedBlueprints).toEqual([{ content: '# Emberline Updated\n' }]));
    await click(getButton('Close', container.querySelector('[role="dialog"]')!));

    // Clicking a persona chip in Next steps jumps to Runs tab and opens StartRunForm with that persona
    await click(getButton('Security', container));
    await waitFor(() => expect(container.querySelector('#run-prompt')).not.toBeNull());
  });
});

describe('Overview Runs tab: workspace MoreMenu, StartRunForm Advanced overrides, scheduled jobs, budget and empty state', () => {
  it('cleans worktrees via MoreMenu, starts a run with Advanced overrides, and manages scheduled jobs', async () => {
    let cleanedWorktrees = 0;
    const startedRuns: unknown[] = [];
    const createdJobs: unknown[] = [];
    const toggledJobs: unknown[] = [];
    let deletedJobId: string | null = null;

    installOverviewRoutes({
      'GET /api/runs': () => [sampleRun],
      'GET /api/cron': () => [sampleJob],
      'POST /api/projects/p1/cleanup-worktrees': (): GarbageCollectRunsResponse => {
        cleanedWorktrees += 1;
        return {
          removedRuns: 0,
          closedSessions: 0,
          prunedWorktrees: 2,
          keptWorktrees: [],
          remainingRuns: 1,
        };
      },
      'POST /api/runs': (body) => {
        startedRuns.push(body);
        return sampleRun;
      },
      'POST /api/cron': (body): ScheduledJob => {
        createdJobs.push(body);
        return {
          ...sampleJob,
          id: 'j2',
          name: (body as { name: string }).name,
          cronExpr: (body as { cronExpr: string }).cronExpr,
        };
      },
      'PATCH /api/cron/j1': (body): ScheduledJob => {
        toggledJobs.push(body);
        return { ...sampleJob, enabled: false };
      },
      'DELETE /api/cron/j1': () => {
        deletedJobId = 'j1';
        return undefined;
      },
    });

    const { container } = await renderDom(
      createElement(Dashboard, { system: connectedSystem, activeProjectId: 'p1' }),
      { path: '/?section=runs' },
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Nightly Test & Lint');
      expect(container.textContent).toContain('Usage and budget');
    });

    // Workspace MoreMenu -> Clean worktrees
    await click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Workspace actions for Emberline"]')!,
    );
    const cleanItem = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Clean worktrees'),
    )!;
    await click(cleanItem);
    await waitFor(() => expect(cleanedWorktrees).toBe(1));

    // Open StartRunForm, expand Advanced disclosure, change agent, and submit
    await click(container.querySelector<HTMLButtonElement>('#start-run-emberline')!);
    const promptInput = container.querySelector<HTMLTextAreaElement>('#run-prompt')!;
    await typeInto(promptInput, 'Audit API validation');

    await click(getButton('Advanced', container));
    const codexRadio = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="CLI Agent"] [role="radio"]',
      ),
    ].find((b) => b.textContent?.trim() === 'Codex')!;
    await click(codexRadio);

    await click(container.querySelector<HTMLButtonElement>('#run-start')!);
    await waitFor(() => expect(startedRuns).toHaveLength(1));
    expect(startedRuns[0]).toMatchObject({
      projectId: 'p1',
      agent: 'codex',
      prompt: 'Audit API validation',
    });

    // Scheduled jobs: toggle switch, add job, delete job
    const jobSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Enable Nightly Test & Lint"]',
    )!;
    expect(jobSwitch.getAttribute('aria-checked')).toBe('true');
    await click(jobSwitch);
    await waitFor(() => expect(toggledJobs).toEqual([{ enabled: false }]));

    await click(getButton('Add job', container));
    await click(getButton('Use weekly audit', container));
    await click(getButton('Create job', container));
    await waitFor(() => expect(createdJobs).toHaveLength(1));
    expect(createdJobs[0]).toMatchObject({
      name: 'Weekly security and dependency audit',
      cronExpr: '0 4 * * 1',
    });

    await click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete Nightly Test & Lint"]')!,
    );
    await waitFor(() => expect(deletedJobId).toBe('j1'));
  });

  it('renders empty state "Create your first project" with a single primary button that opens the wizard', async () => {
    let wizardOpened = 0;
    installOverviewRoutes({
      'GET /api/projects': () => [],
    });

    const { container } = await renderDom(
      createElement(Dashboard, {
        system: connectedSystem,
        activeProjectId: null,
        onOpenWizard: () => {
          wizardOpened += 1;
        },
      }),
      { path: '/' },
    );
    await waitFor(() => expect(container.textContent).toContain('Create your first project'));

    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('Create project');

    await click(primaries[0] as HTMLButtonElement);
    expect(wizardOpened).toBe(1);
  });

  it('enforces token-only colours, >= 0.8rem font sizes, zero inline styles, and < 450 lines in all target files', () => {
    for (const cssRel of ['pages/dashboard-ux.css', 'components/projectStatus/project-status.css']) {
      const css = readFileSync(resolve(HERE, cssRel), 'utf8');
      expect(css, `${cssRel} must not contain hardcoded hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, `${cssRel} must not contain px font-size`).not.toMatch(/font-size:\s*[0-9.]+px/);
      const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
      expect(fontSizes.length).toBeGreaterThan(0);
      for (const rem of fontSizes) {
        expect(rem).toBeGreaterThanOrEqual(0.8);
      }
    }

    const projectStatusFiles = readdirSync(resolve(HERE, 'components/projectStatus'))
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map((f) => `components/projectStatus/${f}`);

    const targetFiles = [
      'pages/Dashboard.tsx',
      'components/ProjectStatusAndDemoPanel.tsx',
      ...projectStatusFiles,
      'components/PreviewAndBuildView.tsx',
      'components/ProjectAdvisorPanel.tsx',
      'components/DashboardWorkspaceGrid.tsx',
      'components/DashboardRunsSection.tsx',
      'components/ScheduledJobsPanel.tsx',
      'components/BudgetPanel.tsx',
      'components/BlueprintModal.tsx',
    ];

    for (const rel of targetFiles) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      expect(src, `${rel} must not contain style= props`).not.toContain('style={');
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThan(450);
    }
  });
});
