import type { Ticket } from '@emberline/protocol';
import { ListChecks, Play, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../../api';
import { BOARD_COLUMNS, QuickAdd } from '../BoardCard';
import { BoardExportMenu } from '../BoardExportMenu';
import { ico, SectionState } from '../SectionState';
import type { BoardCtx } from './boardMeta';

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
    canSeed,
    bulkSelection,
    autoStart,
    toggleAutoStart,
    demoPanelOpen,
    toggleDemoPanel,
    openBlueprint,
    openImport,
    goBack,
    patchTicket,
    setError,
  } = ctx;
  const [seeding, setSeeding] = useState(false);

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

  return (
    <header className="board-head">
      <div className="board-title">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Back to the previous page"
          onClick={goBack}
        >
          ←
        </button>
        <div>
          <p className="eyebrow">{project?.name ?? 'Project'} · Pipeline Board</p>
          <h1>{project?.name ?? 'Board'}</h1>
        </div>
      </div>
      <div className="board-controls">
        {project && (
          <>
            <Link href={`/projects/${project.id}/settings`} className="btn btn-sm">
              Project settings
            </Link>
            <button
              type="button"
              className={`btn btn-sm${demoPanelOpen ? ' btn-primary' : ''}`}
              onClick={toggleDemoPanel}
              title="View Project Status, Sync Worktrees & Play Live Demo"
            >
              {ico(Play)} Live Demo &amp; Status
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={openBlueprint}
              title="Open PROJECT.md Blueprint"
            >
              PROJECT.md
            </button>
          </>
        )}
        {canSeed && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={seeding}
            onClick={() => void seedTickets()}
            title="Seed 4 starter tickets across PO, Architect, Coder, and QA personas"
          >
            {seeding ? 'Seeding…' : <>{ico(Sparkles)} Seed Starter Backlog</>}
          </button>
        )}
        <button
          id="pipeline-auto-start"
          type="button"
          className={`chip-toggle${autoStart ? ' active' : ''}`}
          aria-pressed={autoStart}
          title="When enabled, dragging a card into In progress automatically starts a Claude run"
          onClick={toggleAutoStart}
        >
          <span className="dot" />
          Auto-dispatch on In progress
        </button>
        {(tickets?.length ?? 0) > 0 && (
          <button
            id="board-select-mode"
            type="button"
            className={`chip-toggle${bulkSelection.active ? ' active' : ''}`}
            aria-pressed={bulkSelection.active}
            title="Pick several tickets to move, reprioritise, reassign or delete them at once"
            onClick={() => bulkSelection.setActive(!bulkSelection.active)}
          >
            {ico(ListChecks)} Select
          </button>
        )}
        {project && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={openImport}
            title="Import issues from the project's GitHub, GitLab or Gitea remote"
          >
            Import issues
          </button>
        )}
        {project && <BoardExportMenu projectId={project.id} columns={BOARD_COLUMNS} tickets={tickets} />}
        <QuickAdd projectId={projectId} onCreated={patchTicket} onError={setError} />
      </div>
    </header>
  );
}
