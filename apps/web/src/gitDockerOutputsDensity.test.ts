// @vitest-environment happy-dom
import type {
  DockerOverview,
  GitBranch,
  GitPageStatus,
  Project,
  ProjectBuildOutput,
  ProjectBuildOutputsResponse,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { GitReleaseTab } from './components/git/GitReleaseTab';
import { GitStatusStrip } from './components/git/GitStatusStrip';
import { apiRoutes, cleanup, click, getButton, renderDom, waitFor } from './domRender';
import { BuildOutputsPage } from './pages/BuildOutputsPage';
import { DockerPage } from './pages/DockerPage';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

afterEach(cleanup);

/** 0.9.3 default-view visible word counts measured with `visibleWordCount` on these fixtures. */
export const GIT_STATUS_STRIP_093_WORDS = 24;
export const GIT_RELEASE_TAB_093_WORDS = 71;
export const DOCKER_PAGE_093_WORDS = 149;
export const BUILD_OUTPUTS_HEADER_093_WORDS = 25;
export const BUILD_OUTPUTS_PAGE_093_WORDS = 89;

const BUDGET_RATIO = 0.75;

const gitStatus: GitPageStatus = {
  isGitRepo: true,
  defaultBranch: 'main',
  workingBranch: 'develop',
  checkedOut: 'develop',
  workingMismatch: false,
  mainBehindWorking: 3,
  latestTag: 'v0.8.0',
  hasOrigin: true,
  originUrl: 'https://github.com/o/app.git',
  working: 'up_to_date',
  main: 'up_to_date',
  workingCounts: null,
  mainCounts: null,
  checkedAt: '2026-11-16T02:50:00.000Z',
  autoPull: true,
  sync: { state: 'idle', at: null, branch: null, files: [], message: null },
  forgeRelease: true,
  release: { ok: true, reason: null },
  releaseJob: null,
  releaseDraft: null,
  releaseSummary: {
    head: 'a'.repeat(40),
    commits: 4,
    tickets: 2,
    checks: ['build', 'test'],
    hasChangelog: true,
  },
  backups: [],
  tagsDifferFromOrigin: [],
  tagsNamedLikeBranches: [],
  originRefsUnread: false,
  notOnOrigin: { working: null, main: null },
};

const gitBranches: GitBranch[] = [
  {
    name: 'develop',
    kind: 'working',
    tip: 'a'.repeat(40),
    subject: 'feat: work',
    vsMain: { ahead: 3, behind: 0 },
    vsOrigin: { state: 'up_to_date', ahead: 0, behind: 0 },
    mergedIntoMain: false,
    mergedIntoWorking: true,
    liveRuns: [],
  },
  {
    name: 'main',
    kind: 'main',
    tip: 'b'.repeat(40),
    subject: 'chore: release',
    vsMain: null,
    vsOrigin: { state: 'up_to_date', ahead: 0, behind: 0 },
    mergedIntoMain: true,
    mergedIntoWorking: true,
    liveRuns: [],
  },
];

const dockerOverview: DockerOverview = {
  engine: {
    enabled: true,
    checked: true,
    available: true,
    version: '27.3.1',
  },
  cleanup: {
    lastSweepAt: '2026-11-16T02:40:00.000Z',
    lastSweepRemoved: ['emberline-old'],
    lastPruneAt: '2026-11-16T02:00:00.000Z',
    lastPruneOkAt: '2026-11-16T02:00:00.000Z',
    sweeping: false,
  },
  disk: {
    rows: [
      { type: 'Images', total: '4', active: '2', size: '1.2GB', reclaimable: '400MB (33%)' },
      { type: 'Containers', total: '2', active: '2', size: '64MB', reclaimable: '0B (0%)' },
    ],
  },
  projects: [
    {
      name: 'emberline-abcd1234',
      status: 'running(1)',
      projectId: 'p1',
      stale: false,
      owner: {
        kind: 'agent',
        runId: 'abcd1234-0000-4000-8000-000000000000',
        runTitle: 'SHOP-1 Login',
        ticketId: 't1',
        ticketKey: 'SHOP-1',
        ticketTitle: 'Login',
        projectId: 'p1',
        projectName: 'Shop',
        runState: 'working',
        live: true,
        inReview: false,
      },
      containers: [
        {
          name: 'emberline-abcd1234-web-1',
          service: 'web',
          state: 'running',
          status: 'Up 2 minutes',
          ports: [{ port: 4330, url: 'http://127.0.0.1:4330' }],
          image: 'nginx:alpine',
          createdAt: '2026-11-16 02:50:00 +0000 UTC',
          runningFor: '2 minutes ago',
        },
      ],
    },
    {
      name: 'emberline-abcd1234-preview',
      status: 'running(1)',
      projectId: 'p1',
      stale: false,
      owner: {
        kind: 'preview',
        runId: 'abcd1234-0000-4000-8000-000000000000',
        runTitle: 'SHOP-1 Login',
        ticketId: 't1',
        ticketKey: 'SHOP-1',
        ticketTitle: 'Login',
        projectId: 'p1',
        projectName: 'Shop',
        runState: 'done',
        live: false,
        inReview: true,
      },
      containers: [
        {
          name: 'emberline-abcd1234-preview-app-1',
          service: 'app',
          state: 'running',
          status: 'Up 5 minutes',
          ports: [{ port: 4331, url: 'http://127.0.0.1:4331' }],
          image: 'node:22-alpine',
          createdAt: '2026-11-16 02:45:00 +0000 UTC',
          runningFor: '5 minutes ago',
        },
      ],
    },
  ],
};

const shopProject: Project = {
  id: 'p1',
  name: 'Shop',
  slug: 'shop',
  path: '/workspaces/shop',
  repoUrl: null,
  defaultBranch: 'main',
  appType: 'fullstack',
  description: '',
  techStack: null,
  createdAt: '2026-11-16T00:00:00.000Z',
};

const sampleOutputs: ProjectBuildOutput[] = [
  {
    id: 'o1',
    name: 'app-release.apk',
    sizeBytes: 12 * 1024 * 1024,
    archivedAt: '2026-11-16T02:30:00.000Z',
    sourceMtime: '2026-11-16T02:29:00.000Z',
    pinned: true,
    runId: 'run-1',
    runExists: true,
    ticketId: 't1',
    ticketKey: 'EMB-7',
    ticketTitle: 'Ship the thing',
    persona: 'coder',
    agent: 'claude',
    hostPath: '/srv/x/app-release.apk',
    containerPath: '/workspaces/x/app-release.apk',
  },
  {
    id: 'o2',
    name: 'setup.exe',
    sizeBytes: 28 * 1024 * 1024,
    archivedAt: '2026-11-16T02:15:00.000Z',
    sourceMtime: '2026-11-16T02:14:00.000Z',
    pinned: false,
    runId: 'run-2',
    runExists: true,
    ticketId: 't2',
    ticketKey: 'EMB-9',
    ticketTitle: 'Installer package',
    persona: 'coder',
    agent: 'claude',
    hostPath: '/srv/x/setup.exe',
    containerPath: '/workspaces/x/setup.exe',
  },
];

const buildOutputsResponse: ProjectBuildOutputsResponse = {
  outputs: sampleOutputs,
  usedBytes: 1.2 * 1024 ** 3,
  quotaBytes: 5 * 1024 ** 3,
  archiveDir: '/workspaces/x/.emberline/outputs',
  hostArchiveDir: '/srv/x/outputs',
  collecting: false,
  lastCollect: {
    finishedAt: '2026-11-16T02:30:00.000Z',
    archived: 2,
    skipped: 1,
    failed: 0,
  },
  runChain: null,
};

describe('AC-6.5 word density budgets: Git, Docker and Build outputs', () => {
  it('keeps the Git status strip at or below 75% of its 0.9.3 word count', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects/p1/git/branches': () => gitBranches,
      }),
    );

    const view = await renderDom(
      createElement(GitStatusStrip, { projectId: 'p1', status: gitStatus, onOpenRelease: () => undefined }),
    );
    await waitFor(() => expect(view.container.textContent).toContain('develop'));

    const words = visibleWordCount(view.container);
    expect(words).toBeLessThanOrEqual(Math.floor(GIT_STATUS_STRIP_093_WORDS * BUDGET_RATIO));

    // HelpHint explains auto-pull and Match origin backups on demand.
    await click(view.container.querySelector('button[aria-label="About auto-pull"]')!);
    expect(view.container.textContent).toContain('Match origin');
    expect(view.container.textContent).toContain('Backups');
  });

  it('keeps the Git Release tab at or below 75% of its 0.9.3 word count with What happens collapsed', async () => {
    const view = await renderDom(createElement(GitReleaseTab, { projectId: 'p1', status: gitStatus }));
    const words = visibleWordCount(view.container);
    expect(words).toBeLessThanOrEqual(Math.floor(GIT_RELEASE_TAB_093_WORDS * BUDGET_RATIO));
  });

  it('keeps the Docker page with two projects at or below 75% of its 0.9.3 word count and preserves stop/remove/logs/toggle', async () => {
    const calls: string[] = [];
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/docker': () => dockerOverview,
        'GET /api/docker/projects/emberline-abcd1234/logs': () => ({ logs: 'server ready on :4330' }),
        'POST /api/docker/projects/emberline-abcd1234/stop': () => {
          calls.push('stop');
          return { ok: true };
        },
        'POST /api/docker/projects/emberline-abcd1234-preview/remove': () => {
          calls.push('remove');
          return { ok: true };
        },
      }),
    );

    const view = await renderDom(
      createElement(DockerPage, {
        activeProjectId: 'p1',
        projects: [shopProject],
      }),
    );
    await waitFor(() => expect(view.container.textContent).toContain('emberline-abcd1234'));

    const words = visibleWordCount(view.container);
    expect(words).toBeLessThanOrEqual(Math.floor(DOCKER_PAGE_093_WORDS * BUDGET_RATIO));

    // Disk usage and container details/logs are one click away.
    await click(getButton('Disk usage', view.container));
    expect(view.container.textContent).toContain('400MB (33%)');

    const firstRow = view.container.querySelectorAll('.docker-ux-project')[0]!;
    await click(getButton('Logs', firstRow));
    await waitFor(() => expect(firstRow.textContent).toContain('server ready on :4330'));
    expect(firstRow.textContent).toContain('nginx:alpine');

    // Stop and Remove confirmations still work.
    await click(getButton('Stop', firstRow));
    await click(getButton('Stop it', firstRow));
    await waitFor(() => expect(calls).toEqual(['stop']));

    const secondRow = view.container.querySelectorAll('.docker-ux-project')[1]!;
    await click(getButton('Remove', secondRow));
    await click(getButton('Remove it', secondRow));
    await waitFor(() => expect(calls).toEqual(['stop', 'remove']));
  });

  it('keeps the Build outputs header and page with two outputs at or below 75% of their 0.9.3 word counts and preserves download/pin/delete', async () => {
    const calls: string[] = [];
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects/p1/build-outputs': () => buildOutputsResponse,
        'POST /api/projects/p1/build-outputs/collect': () => {
          calls.push('collect');
          return { collecting: true };
        },
        'PATCH /api/build-outputs/o1': (body) => {
          calls.push(`patch o1 ${JSON.stringify(body)}`);
          return {};
        },
        'DELETE /api/build-outputs/o2': () => {
          calls.push('delete o2');
          return {};
        },
      }),
    );

    const view = await renderDom(createElement(BuildOutputsPage, { projectId: 'p1' }));
    await waitFor(() => expect(view.container.textContent).toContain('app-release.apk'));

    const headerEl = view.container.querySelector('.ui-page-header')!;
    const usageEl = view.container.querySelector('.build-outputs-ux-usage')!;
    const headerWords = visibleWordCount(headerEl) + visibleWordCount(usageEl);
    expect(headerWords).toBeLessThanOrEqual(Math.floor(BUILD_OUTPUTS_HEADER_093_WORDS * BUDGET_RATIO));

    const pageWords = visibleWordCount(view.container);
    expect(pageWords).toBeLessThanOrEqual(Math.floor(BUILD_OUTPUTS_PAGE_093_WORDS * BUDGET_RATIO));

    // Retention rules and archive path are in the HelpHint.
    await click(view.container.querySelector('button[aria-label="About output retention"]')!);
    expect(view.container.textContent).toContain('/srv/x/outputs');
    expect(view.container.textContent).toContain('oldest unpinned files');

    // Download link is the primary row action; Pin/Unpin and Delete are in the row More menu.
    const rows = view.container.querySelectorAll('tbody tr');
    const downloadLink = rows[0]!.querySelector<HTMLAnchorElement>(
      'a[href="/api/build-outputs/o1/download"]',
    );
    expect(downloadLink?.textContent).toContain('Download');

    await click(getButton('More', rows[0]!));
    await click(getButton('Unpin', rows[0]!));
    await waitFor(() => expect(calls).toEqual(['patch o1 {"pinned":false}']));

    await click(getButton('More', rows[1]!));
    await click(getButton('Delete', rows[1]!));
    await waitFor(() => expect(calls).toEqual(['patch o1 {"pinned":false}', 'delete o2']));
  });
});
