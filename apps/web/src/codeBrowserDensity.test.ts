// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BrowserActionBody,
  BrowserViewportSnapshot,
  Project,
  ProjectStatusSummary,
  WorkspaceDemoTarget,
  WorkspaceFileContentResponse,
  WorkspaceFileListResponse,
} from '@emberline/protocol';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import type * as ApiModule from './api';
import { apiRoutes, cleanup, click, getButton, queryButton, renderDom, typeInto, waitFor } from './domRender';
import { CodeExplorerPage } from './pages/CodeExplorerPage';
import { LiveBrowserPage } from './pages/LiveBrowserPage';
import { visibleWordCount } from './uxDensity';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));
vi.mock('./components/MonacoEditor', () => ({
  MonacoEditor: ({
    value,
    readOnly,
    onChange,
  }: {
    value: string;
    readOnly?: boolean;
    onChange: (next: string) => void;
  }) =>
    createElement('textarea', {
      'aria-label': 'Code editor',
      readOnly,
      value,
      onChange: (e: Event) => onChange((e.target as HTMLTextAreaElement).value),
    }),
}));
vi.mock('./monaco', () => ({ monacoTheme: () => 'vs' }));

const HERE = dirname(fileURLToPath(import.meta.url));

/** 0.9.3 default-view word counts measured before the M6 redesign (AC-6.5: <= 75% budget). */
export const LIVE_BROWSER_093_BASELINE_WORDS = 136;
export const LIVE_BROWSER_WORD_BUDGET = Math.floor(LIVE_BROWSER_093_BASELINE_WORDS * 0.75);

export const CODE_EXPLORER_093_BASELINE_WORDS = 53;
export const CODE_EXPLORER_WORD_BUDGET = Math.floor(CODE_EXPLORER_093_BASELINE_WORDS * 0.75);

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

const idleSnapshot: BrowserViewportSnapshot = {
  available: true,
  source: 'cdp_live',
  targetUrl: 'http://localhost:5173',
  pageTitle: 'Emberline',
  activeTabId: 'tab-1',
  tabs: [{ id: 'tab-1', title: 'Emberline', url: 'http://localhost:5173', active: true }],
  consoleLogs: [],
  agentActions: [],
  agentActive: false,
  playtestActive: false,
  imageDataUrl: null,
  capturedAt: '2026-11-12T00:00:00.000Z',
  message: null,
};

function makeDemoTarget(overrides: Partial<WorkspaceDemoTarget>): WorkspaceDemoTarget {
  return {
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
    fileCount: 10,
    topFiles: ['PROJECT.md'],
    hasPackageJson: true,
    hasBuildScript: true,
    demoEntryRelPath: null,
    demoUrl: null,
    updatedAt: '2026-11-12T00:00:00.000Z',
    demoBuild: null,
    demoStale: false,
    rebuilding: false,
    ...overrides,
  };
}

const statusSummary: ProjectStatusSummary = {
  projectId: 'p1',
  workspaceRoot: '/workspaces/emberline',
  hostBindHint: './workspaces/emberline',
  ticketCounts: { total: 0, backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 },
  completionPercent: 0,
  activeRunCount: 0,
  autoChainActive: false,
  targets: [
    makeDemoTarget({ id: 'main', kind: 'main', label: 'Main Workspace (main)' }),
    makeDemoTarget({ id: 'r1', kind: 'worktree', label: 'Worktree · EMB-49' }),
  ],
};

const emptyFileList: WorkspaceFileListResponse = {
  targetId: 'main',
  workspacePath: '/workspaces/emberline',
  entries: [],
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await cleanup();
  vi.mocked(api).mockReset();
});

describe('AC-6.5 word density budgets for Live browser and Code explorer', () => {
  it('keeps the Live browser idle session at or under 75% of its 0.9.3 word count', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/projects/p1/status': () => statusSummary,
        'GET /api/system': () => ({ apiVersion: '1', ptyd: 'connected', docker: { available: true } }),
        'GET /api/projects/p1/browser-viewport?targetId=main': () => idleSnapshot,
      }),
    );

    const { container } = await renderDom(createElement(LiveBrowserPage, { projectId: 'p1' }), {
      path: '/projects/p1/browser',
    });
    await waitFor(() => expect(container.textContent).toContain('No browser frame available yet.'));

    const words = visibleWordCount(container);
    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThanOrEqual(LIVE_BROWSER_WORD_BUDGET);

    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Live browser');
    expect(container.textContent).toContain('Emberline');
    expect(container.textContent).toContain('A Chromium in the runner that agents and you share');

    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('Go');

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="About live browser"]')!);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Playwright MCP');
  });

  it('keeps the Code explorer (no file open) at or under 75% of its 0.9.3 word count', async () => {
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/runs': () => [],
        'GET /api/projects/p1/files?targetId=main': () => emptyFileList,
      }),
    );

    const { container } = await renderDom(createElement(CodeExplorerPage, { projectId: 'p1' }), {
      path: '/projects/p1/code',
    });
    await waitFor(() => expect(container.textContent).toContain('No matching files in workspace.'));

    const words = visibleWordCount(container);
    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThanOrEqual(CODE_EXPLORER_WORD_BUDGET);

    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Code');
    expect(container.textContent).toContain('Files (0)');
    expect(container.textContent).toContain('Select a file from the tree to view or edit.');

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="About workspace"]')!);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('/workspaces/emberline');
  });
});

describe('LiveBrowserStudio interactions and progressive disclosure', () => {
  it('supports navigation, following the agent, device resize, console error auto-open, and key input', async () => {
    const actions: BrowserActionBody[] = [];
    const dispatched: unknown[] = [];

    const activeSnapshot: BrowserViewportSnapshot = {
      ...idleSnapshot,
      canFollow: true,
      following: false,
      tabs: [
        { id: 'tab-1', title: 'Emberline', url: 'http://localhost:5173', active: true },
        { id: 'tab-2', title: 'Docs', url: 'http://localhost:5173/docs', active: false },
      ],
      consoleLogs: [
        { level: 'error', text: 'Uncaught TypeError: boom', timestamp: '2026-11-12T00:01:00.000Z' },
      ],
    };

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/projects/p1/status': () => statusSummary,
        'GET /api/system': () => ({ apiVersion: '1', ptyd: 'connected', docker: { available: true } }),
        'GET /api/projects/p1/browser-viewport?targetId=main': () => activeSnapshot,
        'POST /api/projects/p1/browser-action': (body) => {
          const act = body as BrowserActionBody;
          actions.push(act);
          return {
            ...activeSnapshot,
            targetUrl: act.url ?? activeSnapshot.targetUrl,
            following: act.action === 'follow_agent' ? true : activeSnapshot.following,
          };
        },
        'POST /api/projects/p1/factory-request': (body) => {
          dispatched.push(body);
          return {
            ticket: { id: 't9', key: 'EMB-99' },
            run: { id: 'r9' },
          };
        },
      }),
    );

    const { container } = await renderDom(createElement(LiveBrowserPage, { projectId: 'p1' }), {
      path: '/projects/p1/browser',
    });

    // Console error auto-opens the Console panel so errors are never hidden.
    await waitFor(() => expect(container.textContent).toContain('Uncaught TypeError: boom'));
    await click(getButton('Fix error', container));
    await waitFor(() => expect(dispatched).toHaveLength(1));

    // FollowingNote is visible and triggers follow_agent.
    await click(getButton('Follow it', container));
    expect(actions.some((a) => a.action === 'follow_agent')).toBe(true);

    // Toolbar navigation buttons.
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Forward"]')!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Reload current tab"]')!);
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['follow_agent', 'back', 'forward', 'reload']),
    );

    const addressInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Address as the runner\'s browser sees it"]',
    )!;
    await typeInto(addressInput, 'http://localhost:5173/settings');
    await click(getButton('Go', container));
    expect(actions).toContainEqual(
      expect.objectContaining({ action: 'navigate', url: 'http://localhost:5173/settings' }),
    );

    // More menu: device resize & screenshot.
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Browser tools"]')!);
    const phoneItem = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Resize phone'),
    )!;
    await click(phoneItem);

    // Send keys disclosure.
    await click(getButton('Send keys', container));
    const typeInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Text to type into browser"]',
    )!;
    await typeInto(typeInput, 'hello');
    await click(getButton('Send text', container));
    expect(actions).toContainEqual(expect.objectContaining({ action: 'type', text: 'hello', submit: false }));

    await click(getButton('Press Esc', container));
    expect(actions).toContainEqual(expect.objectContaining({ action: 'key', key: 'Escape' }));
  });
});

describe('CodeExplorerPage editing, saving and unsaved-change handling', () => {
  it('opens preferred file, tracks unsaved changes with Discard and Save, and dispatches Ask agent', async () => {
    const savedBodies: unknown[] = [];
    const agentRequests: unknown[] = [];

    const fileList: WorkspaceFileListResponse = {
      targetId: 'main',
      workspacePath: '/workspaces/emberline',
      entries: [
        { name: 'src', path: 'src', kind: 'directory', sizeBytes: 0, mtime: '2026-11-12T00:00:00.000Z' },
        {
          name: 'App.tsx',
          path: 'src/App.tsx',
          kind: 'file',
          sizeBytes: 42,
          mtime: '2026-11-12T00:00:00.000Z',
        },
        {
          name: 'logo.png',
          path: 'src/logo.png',
          kind: 'file',
          sizeBytes: 2048,
          mtime: '2026-11-12T00:00:00.000Z',
        },
      ],
    };

    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/projects': () => [project],
        'GET /api/runs': () => [],
        'GET /api/projects/p1/files?targetId=main': () => fileList,
        'GET /api/projects/p1/files/content?targetId=main&path=src%2FApp.tsx':
          (): WorkspaceFileContentResponse => ({
            targetId: 'main',
            path: 'src/App.tsx',
            content: 'export const x = 1;\n',
            binary: false,
            sizeBytes: 20,
          }),
        'PUT /api/projects/p1/files/content': (body): WorkspaceFileContentResponse => {
          savedBodies.push(body);
          const payload = body as { path: string; content: string };
          return {
            targetId: 'main',
            path: payload.path,
            content: payload.content,
            binary: false,
            sizeBytes: payload.content.length,
          };
        },
        'POST /api/projects/p1/factory-request': (body) => {
          agentRequests.push(body);
          return {
            ticket: { id: 't10', key: 'EMB-100' },
            run: { id: 'r10' },
          };
        },
      }),
    );

    const { container } = await renderDom(createElement(CodeExplorerPage, { projectId: 'p1' }), {
      path: '/projects/p1/code',
    });

    await waitFor(() => expect(container.querySelector('textarea[aria-label="Code editor"]')).not.toBeNull());
    expect(container.textContent).toContain('Files (2)');

    // Save is the single primary button on the view.
    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('Save');
    expect((primaries[0] as HTMLButtonElement).disabled).toBe(true);

    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code editor"]')!;
    await typeInto(editor, 'export const x = 2;\n');
    expect(container.textContent).toContain('Unsaved changes');
    expect((getButton('Save', container) as HTMLButtonElement).disabled).toBe(false);

    const beforeUnloadDirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadDirty);
    expect(beforeUnloadDirty.defaultPrevented).toBe(true);

    // Discard reverts to saved content.
    await click(getButton('Discard', container));
    expect(editor.value).toBe('export const x = 1;\n');
    expect(queryButton('Discard', container)).toBeNull();

    // Edit again and Save.
    await typeInto(editor, 'export const x = 3;\n');
    await click(getButton('Save', container));
    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toEqual({
      targetId: 'main',
      path: 'src/App.tsx',
      content: 'export const x = 3;\n',
    });
    await waitFor(() => expect(container.textContent).toContain('Saved src/App.tsx'));

    // Ask agent disclosure.
    await click(getButton('Ask agent', container));
    const taskInput = container.querySelector<HTMLInputElement>('input[aria-label="Task for src/App.tsx"]')!;
    await typeInto(taskInput, 'Add unit tests');
    const askSubmit = [...container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((b) =>
      b.textContent?.includes('Ask agent'),
    )!;
    await click(askSubmit);
    await waitFor(() => expect(agentRequests).toHaveLength(1));
  });

  it('enforces token-only colours and >= 0.8rem font sizes in live-browser.css and code-explorer.css', () => {
    for (const rel of [
      'components/liveBrowser/live-browser.css',
      'components/codeExplorer/code-explorer.css',
    ]) {
      const css = readFileSync(resolve(HERE, rel), 'utf8');
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      const fontSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
      expect(fontSizes.length).toBeGreaterThan(0);
      for (const rem of fontSizes) {
        expect(rem).toBeGreaterThanOrEqual(0.8);
      }
      expect(css).not.toMatch(/font-size:\s*[0-9.]+px/);
    }
  });
});
