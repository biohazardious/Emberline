import type { Ticket, TicketExportFormat } from '@emberline/protocol';
import { Download, FileText, FolderGit2, Play, Settings, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../../api';
import { BOARD_COLUMNS, QuickAdd } from '../BoardCard';
import { BoardExportMenu } from '../BoardExportMenu';
import { BoardFilterBar } from '../BoardFilterBar';
import { SectionState } from '../SectionState';
import { HelpHint } from '../ui/HelpHint';
import { MoreMenu, type MoreMenuItem } from '../ui/MoreMenu';
import { PageHeader } from '../ui/PageHeader';
import { Switch } from '../ui/Switch';
import type { BoardCtx } from './boardMeta';
import './board-ux.css';

export function BoardHeaderSection({
  ctx,
  standaloneLoading,
  standaloneError,
  onRetry,
}: {
  ctx: BoardCtx;
  standaloneLoading?: boolean;
  standaloneError?: unknown;
  onRetry?: () => void | Promise<void>;
}) {
  const {
    projectId,
    project,
    tickets,
    latestRun,
    canSeed,
    bulkSelection,
    autoStart,
    toggleAutoStart,
    demoPanelOpen,
    toggleDemoPanel,
    filter,
    filterActive,
    filteredCount,
    updateFilter,
    openBlueprint,
    openImport,
    patchTicket,
    setError,
  } = ctx;
  const [, navigate] = useLocation();
  const [seeding, setSeeding] = useState(false);
  const [exportFormat, setExportFormat] = useState<TicketExportFormat | null>(null);

  if (standaloneLoading || standaloneError !== undefined) {
    return (
      <SectionState
        loading={standaloneLoading}
        error={standaloneError}
        onRetry={onRetry}
        loadingText="Loading board header…"
        errorPrefix="Could not load project details"
      />
    );
  }

  const seedTickets = async () => {
    setSeeding(true);
    setError(undefined);
    try {
      const res = await api<{ created: Ticket[] }>(`/api/projects/${projectId}/seed-tickets`, 'POST');
      for (const t of res.created) patchTicket(t);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  };

  const moreItems: MoreMenuItem[] = [];
  if (project) {
    moreItems.push(
      {
        id: 'project-settings',
        label: 'Project settings',
        icon: <Settings className="icon" aria-hidden />,
        onSelect: () => navigate(`/projects/${project.id}/settings`),
      },
      {
        id: 'demo-status',
        label: 'Demo and status',
        description: demoPanelOpen ? 'Hide status and live demo panel' : 'Open status and live demo panel',
        icon: <Play className="icon" aria-hidden />,
        onSelect: toggleDemoPanel,
      },
      {
        id: 'open-project-md',
        label: 'Open PROJECT.md',
        icon: <FileText className="icon" aria-hidden />,
        onSelect: openBlueprint,
      },
      {
        id: 'import-issues',
        label: 'Import issues',
        icon: <FolderGit2 className="icon" aria-hidden />,
        onSelect: openImport,
      },
      {
        id: 'export-csv',
        label: 'Export CSV',
        icon: <Download className="icon" aria-hidden />,
        onSelect: () => setExportFormat('csv'),
      },
      {
        id: 'export-json',
        label: 'Export JSON',
        icon: <Download className="icon" aria-hidden />,
        onSelect: () => setExportFormat('json'),
      },
    );
  }
  if (canSeed) {
    moreItems.push({
      id: 'seed-backlog',
      label: seeding ? 'Seeding…' : 'Seed starter backlog',
      icon: <Sparkles className="icon" aria-hidden />,
      disabled: seeding,
      onSelect: () => void seedTickets(),
    });
  }

  const totalCount = tickets?.length ?? 0;

  return (
    <PageHeader
      className="board-header"
      title={project?.name ?? 'Board'}
      meta={
        <span className="badge mono board-count-badge">
          {totalCount} {totalCount === 1 ? 'ticket' : 'tickets'}
        </span>
      }
      actions={
        <div className="board-header-actions">
          <QuickAdd projectId={projectId} onCreated={patchTicket} onError={setError} />
          <div className="board-auto-start">
            <Switch
              id="pipeline-auto-start"
              checked={autoStart}
              onChange={() => toggleAutoStart()}
              label="Auto-start"
            />
            <HelpHint topic="auto-start">
              When enabled, dragging a ticket into In progress automatically starts an agent run.
            </HelpHint>
          </div>
          {totalCount > 0 && (
            <button
              id="board-select-mode"
              type="button"
              className={`btn btn-sm board-select-btn${bulkSelection.active ? ' active' : ''}`}
              aria-pressed={bulkSelection.active}
              onClick={() => bulkSelection.setActive(!bulkSelection.active)}
            >
              Select
            </button>
          )}
          {moreItems.length > 0 && <MoreMenu items={moreItems} ariaLabel="Board actions" />}
        </div>
      }
    >
      {(totalCount > 0 || filterActive) && (
        <BoardFilterBar
          tickets={tickets ?? []}
          latestRunByTicket={latestRun}
          filter={filter}
          shown={filteredCount}
          onChange={updateFilter}
        />
      )}
      {project && (
        <BoardExportMenu
          projectId={project.id}
          columns={BOARD_COLUMNS}
          tickets={tickets}
          openFormat={exportFormat}
          onClose={() => setExportFormat(null)}
          hideTrigger
        />
      )}
    </PageHeader>
  );
}
