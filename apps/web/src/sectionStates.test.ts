// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import type * as ApiModule from './api';
import { EMPTY_BOARD_FILTER } from './boardFilter';
import { EMPTY_SELECTION } from './boardSelection';
import { BoardColumnsSection } from './components/board/BoardColumnsSection';
import type { BoardCtx } from './components/board/boardMeta';
import { CodeExplorerTree } from './components/codeExplorer/CodeExplorerTree';
import { BrainstormingColumn } from './components/roadmap/BrainstormingColumn';
import { MilestonesColumn } from './components/roadmap/MilestonesColumn';
import { RoadmapHeaderPanel } from './components/roadmap/RoadmapHeaderPanel';
import { AccountSection } from './components/settings/AccountSection';
import { McpPluginsSection } from './components/settings/McpPluginsSection';
import { QuotaSection } from './components/settings/QuotaSection';
import { SshKeySection } from './components/settings/SshKeySection';
import { apiRoutes, cleanup, click, deferred, getButton, renderDom, waitFor } from './domRender';
import { EMPTY_ROADMAP_FILTER } from './roadmapFilter';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

afterEach(cleanup);

function makeBoardCtx(overrides: Partial<BoardCtx> = {}): BoardCtx {
  return {
    pid: 'p1',
    proj: undefined,
    tickets: undefined,
    allCols: new Map(),
    visCols: new Map(),
    colCounts: new Map(),
    runs: new Map(),
    auto: false,
    flipAuto: () => undefined,
    demo: false,
    flipDemo: () => undefined,
    canSeed: false,
    bulk: {
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
    filteredShown: 0,
    updateFilter: () => undefined,
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

describe('Extracted page sections: loading, empty and error states', () => {
  it('renders loading, empty and error+Retry states for Roadmap sections', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const view = await renderDom(
      createElement(RoadmapHeaderPanel, {
        projectName: 'Emberline',
        roadmap: undefined,
        loading: true,
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
    expect(document.body.querySelector('[aria-busy="true"]')?.textContent).toContain(
      'Loading Interactive Roadmap',
    );

    await view.rerender(
      createElement(BrainstormingColumn, {
        projectName: 'Emberline',
        filteredSuggestions: [],
        selectedSuggestions: new Set<string>(),
        onToggleSuggestion: () => undefined,
        onToggleSelectAllSuggestions: () => undefined,
        onClearAllSuggestions: () => undefined,
        onBuildAllSuggestions: () => undefined,
        brainstormFocus: '',
        onBrainstormFocusChange: () => undefined,
        categoryFilter: 'all',
        onCategoryFilterChange: () => undefined,
        onBrainstorm: () => undefined,
        busy: null,
        isAgentBrainstorming: false,
        activeBrainstormRun: undefined,
        enabledProviders: ['claude'],
        onChangeRoute: () => undefined,
        onQuickPromoteSuggestion: () => undefined,
        onDismissSuggestion: () => undefined,
      }),
    );
    expect(document.body.textContent).toContain('Brainstorming list is empty.');

    await view.rerender(
      createElement(MilestonesColumn, {
        projectId: 'p1',
        totalMilestoneCount: 0,
        filteredRoadmap: { milestones: [], shown: 0, total: 0 },
        loadError: new Error('gateway timeout'),
        onRetry: retry,
        itemFilter: EMPTY_ROADMAP_FILTER,
        onItemFilterChange: () => undefined,
        filterActive: false,
        statusCounts: { idea: 0, planned: 0, in_progress: 0, done: 0 },
        categoryCounts: { feature: 0, ui_ux: 0, architecture: 0, performance: 0, qa_security: 0 },
        selectedItems: new Set<string>(),
        onToggleItem: () => undefined,
        onToggleItemDone: () => undefined,
        onDeleteItem: () => undefined,
        onDispatchSingleItem: () => undefined,
        onDispatchMilestone: () => undefined,
        onDeleteMilestone: () => undefined,
        inlineMsInputs: {},
        onInlineMsInputChange: () => undefined,
        onInlineMilestoneAdd: () => undefined,
        enabledProviders: ['claude'],
        onChangeRoute: () => undefined,
        busy: null,
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
      'Loading project tickets',
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

    const retryFiles = vi.fn();
    const treeView = await renderDom(
      createElement(CodeExplorerTree, {
        projectId: 'p1',
        targetId: 'main',
        allEntries: [],
        visibleEntries: [],
        loading: true,
        hasData: false,
        hasError: false,
        filterText: '',
        onFilterTextChange: () => undefined,
        collapsedDirs: new Set<string>(),
        onToggleDir: () => undefined,
        activePath: null,
        onOpenFile: () => undefined,
        onDeleteFile: () => undefined,
        onRefresh: retryFiles,
        uploading: false,
        uploadTargetDir: '',
        onUploadTargetDirChange: () => undefined,
        onUploadFiles: () => Promise.resolve(),
        onCreateFile: () => Promise.resolve(false),
      }),
    );
    expect(treeView.container.querySelector('[aria-busy="true"]')?.textContent).toContain(
      'Loading workspace files',
    );

    await treeView.rerender(
      createElement(CodeExplorerTree, {
        projectId: 'p1',
        targetId: 'main',
        allEntries: [],
        visibleEntries: [],
        loading: false,
        hasData: false,
        hasError: true,
        loadError: new Error('disk busy'),
        filterText: '',
        onFilterTextChange: () => undefined,
        collapsedDirs: new Set<string>(),
        onToggleDir: () => undefined,
        activePath: null,
        onOpenFile: () => undefined,
        onDeleteFile: () => undefined,
        onRefresh: retryFiles,
        uploading: false,
        uploadTargetDir: '',
        onUploadTargetDirChange: () => undefined,
        onUploadFiles: () => Promise.resolve(),
        onCreateFile: () => Promise.resolve(false),
      }),
    );
    expect(treeView.container.querySelector('[role="alert"]')?.textContent).toContain('disk busy');
    await click(getButton('Retry', treeView.container));
    expect(retryFiles).toHaveBeenCalledTimes(1);

    await treeView.rerender(
      createElement(CodeExplorerTree, {
        projectId: 'p1',
        targetId: 'main',
        allEntries: [],
        visibleEntries: [],
        loading: false,
        hasData: true,
        hasError: false,
        filterText: '',
        onFilterTextChange: () => undefined,
        collapsedDirs: new Set<string>(),
        onToggleDir: () => undefined,
        activePath: null,
        onOpenFile: () => undefined,
        onDeleteFile: () => undefined,
        onRefresh: retryFiles,
        uploading: false,
        uploadTargetDir: '',
        onUploadTargetDirChange: () => undefined,
        onUploadFiles: () => Promise.resolve(),
        onCreateFile: () => Promise.resolve(false),
      }),
    );
    expect(treeView.container.textContent).toContain('No matching files in workspace.');
  });
});
