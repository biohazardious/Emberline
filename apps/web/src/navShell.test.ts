// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActiveProjectPreference,
  Project,
  Run,
  SchedulerState,
  SystemStatus,
} from '@emberline/protocol';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { App } from './App';
import { AppSidebar } from './components/AppSidebar';
import { CommandPalette } from './components/CommandPalette';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, typeInto, waitFor } from './domRender';
import type * as LiveData from './hooks/liveData';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./auth', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ logout: () => Promise.resolve() }),
}));
vi.mock('./hooks/liveData', async (importOriginal) => ({
  ...(await importOriginal<typeof LiveData>()),
  LiveEvents: () => null,
}));
vi.mock('./pages/Dashboard', () => ({
  Dashboard: () => createElement('div', { className: 'test-dashboard' }, 'Overview content'),
}));
vi.mock('./components/MonacoEditor', () => ({ MonacoEditor: () => null }));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const HERE = dirname(fileURLToPath(import.meta.url));

const alpha: Project = {
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

const systemWithDocker: SystemStatus = {
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

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    projectId: 'p1',
    ticketId: 't1',
    title: 'EMB-44 Shell Polish',
    agent: 'claude',
    persona: 'ui_ux',
    state: 'waiting_input',
    prompt: 'Simplify sidebar and command palette',
    permissionMode: 'default',
    branch: 'emberline/emb-44',
    worktreePath: '/workspaces/alpha/.worktrees/r1',
    terminalId: 'term-1',
    agentSessionId: 'sess-1',
    lastEvent: 'question',
    stateChangedAt: '2026-11-16T04:00:00.000Z',
    createdAt: '2026-11-16T03:50:00.000Z',
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
      detail: 'Ready?',
      since: '2026-11-16T04:00:00.000Z',
      occurrence: `${id}:q:1`,
    },
    reviewReady: false,
    ...overrides,
  };
}

const schedulerWithWindow: SchedulerState = {
  maxConcurrentRuns: 2,
  busy: 1,
  queued: 0,
  rateLimited: 1,
  window: {
    id: 'w1',
    agent: 'claude',
    credential: 'login',
    pool: '*',
    exhaustedAt: '2026-11-16T04:00:00.000Z',
    resetsAt: '2026-11-16T06:00:00.000Z',
    resumeAt: '2026-11-16T06:00:00.000Z',
    resetSource: 'hook',
    message: null,
    resumedAt: null,
  },
  windows: [],
};

beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('AppSidebar navigation, groups, switcher MoreMenu and badges', () => {
  const noop = () => undefined;
  function renderSidebar(
    overrides: Partial<Parameters<typeof AppSidebar>[0]> = {},
    path = '/projects/p1/board',
  ) {
    const props: Parameters<typeof AppSidebar>[0] = {
      sidebarCollapsed: false,
      onToggleCollapse: noop,
      mobileNavOpen: false,
      onCloseMobileNav: noop,
      location: path,
      system: systemWithDocker,
      updatesAvailable: 0,
      projects: [alpha],
      activeProject: alpha,
      onSwitchProject: noop,
      onOpenWizard: noop,
      onCleanupWorktrees: noop,
      onProjectDeleted: () => Promise.resolve(),
      onOpenCommandPalette: noop,
      attentionCount: 3,
      activeRuns: [makeRun('r1')],
      projectById: new Map([[alpha.id, alpha]]),
      inspectRunId: undefined,
      onToggleInspectRun: noop,
      scheduler: undefined,
      claudeUsage: undefined,
      factorySettings: undefined,
      allRuns: [],
      theme: 'dark',
      onToggleTheme: noop,
      onLogout: noop,
      ...overrides,
    };
    return renderDom(createElement(AppSidebar, props), { path });
  }

  it('renders the eleven plain labels in two labelled groups, sets aria-current="page" and title=label, and labels attention badges', async () => {
    const { container } = await renderSidebar();
    const groups = [...container.querySelectorAll<HTMLElement>('.sidebar-nav [role="group"]')];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Project', 'Workspace']);

    const projectLinks = [...groups[0]!.querySelectorAll<HTMLAnchorElement>('a.nav-item')];
    const workspaceLinks = [...groups[1]!.querySelectorAll<HTMLAnchorElement>('a.nav-item')];
    expect(projectLinks.map((a) => a.querySelector('.nav-label')?.textContent)).toEqual([
      'Overview',
      'Roadmap',
      'Board',
      'Code',
      'Git',
      'Build outputs',
      'Live browser',
    ]);
    expect(workspaceLinks.map((a) => a.querySelector('.nav-label')?.textContent)).toEqual([
      'Inbox',
      'Fleet',
      'Docker',
      'Settings',
    ]);

    const allLinks = [...projectLinks, ...workspaceLinks];
    expect(allLinks).toHaveLength(11);
    for (const link of allLinks) {
      const label = link.querySelector('.nav-label')?.textContent ?? '';
      expect(link.getAttribute('title')).toBe(label);
      expect(label).not.toContain('&');
      expect(label.split(/\s+/).length).toBeLessThanOrEqual(3);
    }

    const activeLinks = allLinks.filter((a) => a.getAttribute('aria-current') === 'page');
    expect(activeLinks).toHaveLength(1);
    expect(activeLinks[0]?.querySelector('.nav-label')?.textContent).toBe('Board');

    for (const sel of ['#nav-inbox .nav-badge', '#nav-fleet .nav-badge']) {
      const badge = container.querySelector(sel);
      expect(badge?.textContent).toBe('3');
      expect(badge?.getAttribute('aria-label')).toBe('3 runs need you');
    }

    expect(container.textContent).not.toContain('Active Project');
    expect(container.textContent).not.toContain('Active Fleet');
    expect(container.querySelector('[role="region"][aria-label="Running"]')?.textContent).toContain(
      'Running',
    );
  });

  it('hides the Project group when there is no active project', async () => {
    const { container } = await renderSidebar({ activeProject: undefined, projects: [] }, '/');
    expect(container.querySelector('.sidebar-nav [role="group"][aria-label="Project"]')).toBeNull();
    const workspaceGroup = container.querySelector('.sidebar-nav [role="group"][aria-label="Workspace"]')!;
    const labels = [...workspaceGroup.querySelectorAll('.nav-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Inbox', 'Fleet', 'Docker', 'Settings']);
  });

  it('reaches prune and remove project through the switcher More menu and asks for confirmation before removing', async () => {
    const onCleanupWorktrees = vi.fn();
    const onProjectDeleted = vi.fn().mockResolvedValue(undefined);
    const deleteCalls: string[] = [];
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'DELETE /api/projects/p1?deleteFiles=0': () => {
          deleteCalls.push('keep');
          return { ok: true, deletedProjectId: 'p1', nextActiveProjectId: null };
        },
      }),
    );

    const { container } = await renderSidebar({ onCleanupWorktrees, onProjectDeleted });
    const newButtons = [...container.querySelectorAll('button')].filter((b) =>
      /New/.test(b.textContent ?? ''),
    );
    expect(newButtons[0]?.id).toBe('sidebar-new-project');
    expect(newButtons[0]?.textContent?.trim()).toBe('New project');

    const moreTrigger = getButton('More', container);
    await click(moreTrigger);
    await click(getButton('Prune worktrees', container));
    expect(onCleanupWorktrees).toHaveBeenCalledTimes(1);

    await click(moreTrigger);
    const removeItem = getButton('Remove project', container);
    expect(removeItem.className).toContain('danger');
    await click(removeItem);

    const confirmSel = '[role="group"][aria-label="Remove project Alpha"]';
    const confirmBox = container.querySelector(confirmSel)!;
    expect(confirmBox.textContent).toContain('Remove “Alpha”?');
    await click(getButton('Cancel', confirmBox));
    expect(container.querySelector(confirmSel)).toBeNull();
    expect(deleteCalls).toEqual([]);

    await click(moreTrigger);
    await click(getButton('Remove project', container));
    await click(getButton('Remove from Emberline', container.querySelector(confirmSel)!));
    await waitFor(() => expect(deleteCalls).toEqual(['keep']));
    expect(onProjectDeleted).toHaveBeenCalledWith({
      ok: true,
      deletedProjectId: 'p1',
      nextActiveProjectId: null,
    });
  });
});

describe('CommandPalette plain labels and keyword search', () => {
  it('renders plain labels without "&" and finds "Board" via "kanban" and "Fleet" via "multiplexer"', async () => {
    const { container } = await renderDom(
      createElement(CommandPalette, {
        open: true,
        onClose: () => undefined,
        projects: [alpha],
        runs: [makeRun('r1')],
        scheduler: schedulerWithWindow,
        dockerEnabled: true,
        onInspectRun: () => undefined,
        onLogout: () => undefined,
      }),
    );

    const getLabels = () =>
      [...container.querySelectorAll('.cmd-item .cmd-label')].map((el) => el.textContent ?? '');

    const allLabels = getLabels();
    expect(allLabels).toEqual([
      'Overview',
      'Inbox',
      'Fleet',
      'Docker',
      'Settings',
      'Board · Alpha',
      'Roadmap · Alpha',
      'Code · Alpha',
      'Build outputs · Alpha',
      'Live browser · Alpha',
      'Project settings · Alpha',
      'Inspect · EMB-44 Shell Polish',
      'Terminal · EMB-44 Shell Polish',
      'New Claude terminal',
      'New shell terminal',
      'Resume quota window',
      'Set parallel runs to 1',
      'Set parallel runs to 2',
      'Set parallel runs to 3',
      'Set parallel runs to 4',
      'Sign out',
    ]);

    for (const label of allLabels) {
      expect(label).not.toContain('&');
      const base = label.split(' · ')[0]!.replace(/\s+to\s+\d+$/, '');
      expect(base.split(/\s+/).length).toBeLessThanOrEqual(3);
    }

    const input = container.querySelector<HTMLInputElement>('#cmd-input')!;
    await typeInto(input, 'kanban');
    expect(getLabels()).toEqual(['Board · Alpha']);

    await typeInto(input, 'multiplexer');
    expect(getLabels()).toEqual(['Fleet']);

    await typeInto(input, 'factory');
    expect(getLabels()).toEqual(['Overview', 'Settings']);
  });
});

describe('Collapsed sidebar, phone drawer focus trap & Esc, and keyboard shortcuts', () => {
  it('toggles collapsed sidebar, traps focus and closes on Esc in the phone drawer, and handles ⌘K and Alt+N', async () => {
    const r1 = makeRun('r1', { title: 'EMB-44 Needs Input' });
    localStorage.setItem('emberline.activeProjectId', 'p1');

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [alpha],
        'GET /api/projects/active': (): ActiveProjectPreference => ({ activeProjectId: 'p1' }),
        'PUT /api/projects/active': (b) => b,
        'GET /api/runs': () => [r1],
        'GET /api/runs/r1': () => ({ ...r1, events: [], finalMessage: null, lastScreen: '' }),
        'GET /api/runs/r1/build-outputs': () => ({ worktreePath: r1.worktreePath, outputs: [] }),
        'GET /api/system': () => systemWithDocker,
        'GET /api/updates': () => ({ status: { available: 0 } }),
        'GET /api/factory/claude-usage': () => ({ authenticated: true }),
        'GET /api/factory/settings': () => ({ enabledProviders: ['claude', 'codex'] }),
        'GET /api/scheduler': () => schedulerWithWindow,
        'GET /api/models': () => ({ catalog: {} }),
      }),
    );

    const { container } = await renderDom(createElement(App), { path: '/' });
    await waitFor(() => expect(container.querySelector('.test-dashboard')).not.toBeNull());

    expect(getButton(/New/, container).id).toBe('sidebar-new-project');

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')!);
    expect(container.querySelector('.workbench.sidebar-collapsed')).not.toBeNull();
    expect(container.querySelector('#project-switcher')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Expand sidebar"]')!);
    expect(container.querySelector('.workbench.sidebar-collapsed')).toBeNull();
    expect(container.querySelector('#project-switcher')).not.toBeNull();

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle navigation"]')!);
    const sidebar = container.querySelector<HTMLElement>('#workspace-sidebar')!;
    expect(sidebar.classList.contains('sidebar-open')).toBe(true);
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('button[aria-label="Close navigation menu"]'),
    );

    const fireKey = (init: KeyboardEventInit) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
      });

    await fireKey({ key: 'Tab', shiftKey: true });
    expect(sidebar.contains(document.activeElement)).toBe(true);

    await fireKey({ key: 'Escape' });
    expect(sidebar.classList.contains('sidebar-open')).toBe(false);

    const cmdDialog = container.querySelector<HTMLDialogElement>('#command-palette')!;
    expect(cmdDialog.hasAttribute('open')).toBe(false);
    await fireKey({ key: 'k', ctrlKey: true });
    expect(cmdDialog.hasAttribute('open')).toBe(true);
    await fireKey({ key: 'k', ctrlKey: true });
    expect(cmdDialog.hasAttribute('open')).toBe(false);

    expect(queryButton('Close inspector', container)).toBeNull();
    await fireKey({ key: 'n', code: 'KeyN', altKey: true });
    await waitFor(() => expect(container.textContent).toContain('EMB-44 Needs Input'));
  });

  it('enforces token-only colours, >= 0.8rem font sizes, zero inline styles, and < 450 lines across target files', () => {
    const css = readFileSync(resolve(HERE, 'components/sidebar/sidebar.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);
    const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const rem of fontSizes) {
      expect(rem).toBeGreaterThanOrEqual(0.8);
    }

    const componentFiles = [
      'components/AppSidebar.tsx',
      'components/sidebar/SidebarProjectSwitcher.tsx',
      'components/sidebar/SidebarNav.tsx',
      'components/sidebar/SidebarRunningList.tsx',
      'components/sidebar/SidebarProviderTelemetry.tsx',
      'components/sidebar/shellHelpers.ts',
      'components/AppTopbar.tsx',
      'components/CommandPalette.tsx',
      'App.tsx',
    ];
    for (const rel of [
      ...componentFiles,
      'components/sidebar/sidebar.css',
      'responsive.css',
      'appScope.test.ts',
      'navShell.test.ts',
    ]) {
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      if (componentFiles.includes(rel)) {
        expect(src, `${rel} must not contain inline styles`).not.toContain('style={{');
      }
      expect(src.split('\n').length, `${rel} must stay under 450 lines`).toBeLessThanOrEqual(450);
    }
  });
});
