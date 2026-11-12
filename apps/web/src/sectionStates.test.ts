// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { BoardColumnsSection } from './components/board/BoardColumnsSection';
import type { BoardCtx } from './components/board/boardMeta';
import { FileTreeSection } from './components/code-explorer/FileTreeSection';
import type { ExplorerCtx } from './components/code-explorer/fileTypes';
import { BrainstormingSection } from './components/roadmap/BrainstormingSection';
import { MilestonesSection } from './components/roadmap/MilestonesSection';
import { RoadmapHeaderSection } from './components/roadmap/RoadmapHeaderSection';
import type { RoadmapStudioCtx } from './components/roadmap/roadmapMeta';
import { AccountSection } from './components/settings/AccountSection';
import { McpPluginsSection } from './components/settings/McpPluginsSection';
import { QuotaSection } from './components/settings/QuotaSection';
import { SshKeySection } from './components/settings/SshKeySection';
import { apiRoutes, cleanup, click, deferred, getButton, renderDom, waitFor } from './domRender';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

afterEach(cleanup);

function makeRoadmapCtx(overrides: Partial<RoadmapStudioCtx> = {}): RoadmapStudioCtx {
  return {
    pid: 'p1',
    base: '/api/projects/p1/roadmap',
    proj: undefined,
    rm: undefined,
    load: false,
    errObj: undefined,
    retry: () => Promise.resolve(),
    provs: ['claude'],
    busy: null,
    working: false,
    setRm: () => undefined,
    onRun: () => undefined,
    route: () => undefined,
    banner: null,
    setBanner: () => undefined,
    err: null,
    task: async (_key, fn) => fn(),
    ...overrides,
  };
}

function makeBoardCtx(overrides: Partial<BoardCtx> = {}): BoardCtx {
  return {
    pid: 'p1',
    proj: undefined,
    tickets: undefined,
    cols: new Map(),
    runs: new Map(),
    auto: false,
    flipAuto: () => undefined,
    demo: false,
    flipDemo: () => undefined,
    openBp: () => undefined,
    openImp: () => undefined,
    back: () => undefined,
    patch: () => undefined,
    err: undefined,
    setErr: () => undefined,
    blocked: undefined,
    missing: undefined,
    clrBlocked: () => undefined,
    clrMissing: () => undefined,
    move: () => Promise.resolve(),
    open: () => undefined,
    ...overrides,
  };
}

function makeExplorerCtx(overrides: Partial<ExplorerCtx> = {}): ExplorerCtx {
  return {
    pid: 'p1',
    fbase: '/api/projects/p1/files',
    proj: undefined,
    tid: 'main',
    setTid: () => undefined,
    runs: [],
    wsPath: undefined,
    entries: undefined,
    tabs: [],
    active: null,
    tab: null,
    saving: false,
    err: null,
    setErr: () => undefined,
    msg: null,
    setMsg: () => undefined,
    refresh: () => Promise.resolve(),
    open: () => Promise.resolve(),
    del: () => Promise.resolve(),
    uploaded: () => Promise.resolve(),
    selTab: () => undefined,
    closeTab: () => undefined,
    editTab: () => undefined,
    save: () => Promise.resolve(),
    ...overrides,
  };
}

describe('Extracted page sections: loading, empty and error states', () => {
  it('renders loading, empty and error+Retry states for Roadmap sections', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const view = await renderDom(
      createElement(RoadmapHeaderSection, {
        ctx: makeRoadmapCtx({ load: true }),
        focus: '',
        sugIds: [],
        itemIds: [],
        clear: () => undefined,
      }),
    );
    expect(document.body.querySelector('[aria-busy="true"]')?.textContent).toContain(
      'Loading Interactive Roadmap',
    );

    await view.rerender(
      createElement(BrainstormingSection, {
        ctx: makeRoadmapCtx({ load: false }),
        run: undefined,
        focus: '',
        setFocus: () => undefined,
        sel: new Set<string>(),
        toggle: () => undefined,
        setSel: () => undefined,
      }),
    );
    expect(document.body.textContent).toContain('No brainstorming suggestions available.');

    await view.rerender(
      createElement(MilestonesSection, {
        ctx: makeRoadmapCtx({ errObj: new Error('gateway timeout'), retry }),
        sel: new Set<string>(),
        toggle: () => undefined,
      }),
    );
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('gateway timeout');
    await click(getButton('Retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders loading, empty and error+Retry states for Settings sections', async () => {
    const pending = deferred<unknown>();
    vi.mocked(api).mockImplementation(
      apiRoutes({
        'GET /api/scheduler': () => pending.promise,
        'GET /api/ssh-key': () => {
          throw new ApiRequestError(503, 'unavailable', 'ssh store offline');
        },
        'GET /api/ssh-host-keys': () => ({ entries: [] }),
      }),
    );

    const quotaView = await renderDom(createElement(QuotaSection));
    expect(quotaView.container.querySelector('[aria-busy="true"]')?.textContent).toContain('Loading quota');

    const sshView = await renderDom(createElement(SshKeySection));
    await waitFor(() => {
      expect(sshView.container.querySelector('[role="alert"]')?.textContent).toContain('ssh store offline');
    });

    const acctView = await renderDom(createElement(AccountSection, { empty: true }));
    expect(acctView.container.textContent).toContain('Account settings are not available.');

    const retryMcp = vi.fn(() => Promise.resolve());
    const mcpView = await renderDom(
      createElement(McpPluginsSection, {
        mcpServers: [],
        skillPlugins: [],
        saving: false,
        loadError: new Error('registry unreachable'),
        onRetry: retryMcp,
        onChangeMcpServers: () => undefined,
        onChangeSkillPlugins: () => undefined,
        onSave: () => undefined,
      }),
    );
    expect(mcpView.container.querySelector('[role="alert"]')?.textContent).toContain('registry unreachable');
    await click(getButton('Retry', mcpView.container));
    expect(retryMcp).toHaveBeenCalledTimes(1);
  });

  it('renders loading, empty and error+Retry states for Board and Code Explorer sections', async () => {
    const retryBoard = vi.fn(() => Promise.resolve());
    const boardView = await renderDom(
      createElement(BoardColumnsSection, { ctx: makeBoardCtx(), loading: true }),
    );
    expect(boardView.container.querySelector('[aria-busy="true"]')?.textContent).toContain(
      'Loading board tickets',
    );

    await boardView.rerender(
      createElement(BoardColumnsSection, {
        ctx: makeBoardCtx(),
        loadError: new Error('tickets 502'),
        onRetry: retryBoard,
      }),
    );
    expect(boardView.container.querySelector('[role="alert"]')?.textContent).toContain('tickets 502');
    await click(getButton('Retry', boardView.container));
    expect(retryBoard).toHaveBeenCalledTimes(1);

    await boardView.rerender(createElement(BoardColumnsSection, { ctx: makeBoardCtx({ tickets: [] }) }));
    expect(boardView.container.textContent).toContain('Ideas and not-yet-ready work');

    const retryFiles = vi.fn(() => Promise.resolve());
    const treeView = await renderDom(
      createElement(FileTreeSection, { ctx: makeExplorerCtx({ refresh: retryFiles }), loading: true }),
    );
    expect(treeView.container.querySelector('[aria-busy="true"]')?.textContent).toContain(
      'Loading workspace files',
    );

    await treeView.rerender(
      createElement(FileTreeSection, {
        ctx: makeExplorerCtx({ refresh: retryFiles }),
        loadError: new Error('disk busy'),
      }),
    );
    expect(treeView.container.querySelector('[role="alert"]')?.textContent).toContain('disk busy');
    await click(getButton('Retry', treeView.container));
    expect(retryFiles).toHaveBeenCalledTimes(1);

    await treeView.rerender(createElement(FileTreeSection, { ctx: makeExplorerCtx({ entries: [] }) }));
    expect(treeView.container.textContent).toContain('No matching files in workspace.');
  });
});
