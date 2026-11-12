import type { Project, Run, SyncWorktreeResponse, Ticket, TicketStatus } from '@emberline/protocol';
import { Play, Sparkles } from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import {
  type BoardFilter,
  EMPTY_BOARD_FILTER,
  filterBoardTickets,
  isBoardFilterActive,
  parseBoardFilter,
} from '../boardFilter';
import { BlueprintModal } from '../components/BlueprintModal';
import { BOARD_COLUMNS, QuickAdd, TicketCard } from '../components/BoardCard';
import { BoardExportMenu } from '../components/BoardExportMenu';
import { BoardFilterBar, MobileColumnNav } from '../components/BoardFilterBar';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { IssueImportDialog } from '../components/IssueImportDialog';
import { WorktreeConfigBanner } from '../components/ProjectSettingsPanel';
import { ProjectStatusAndDemoPanel } from '../components/ProjectStatusAndDemoPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import { TicketDrawer } from '../components/TicketDrawer';
import { useRuns, useTickets } from '../hooks/liveData';
import { useGoBack, useQueryParam, useUpdateQuery } from '../hooks/navigation';
import { useApi } from '../hooks/useApi';
import {
  blockingMessage,
  DrawerMergeError,
  mergeNowFailure,
  mergeNowNext,
  reviewBlockedCount,
  worktreeMissing,
} from '../reviewComments';
import { dropIntoInProgress } from '../ticketDeps';
import { toastInfo } from '../toast';

export { TicketDrawer } from '../components/TicketDrawer';

const POSITION_STEP = 1024;
const byPosition = (a: Ticket, b: Ticket) => a.position - b.position;

function boardFilterKey(projectId: string): string {
  return `emberline.board.filter.${projectId}`;
}

/** Position that slots a ticket in front of `beforeId` (or at the end) of an ordered column. */
function slotPosition(column: Ticket[], beforeId: string | null): number {
  const index = beforeId ? column.findIndex((t) => t.id === beforeId) : -1;
  const next = index === -1 ? undefined : column[index];
  const prev = index === -1 ? column.at(-1) : column[index - 1];
  if (prev && next) return (prev.position + next.position) / 2;
  if (next) return next.position - POSITION_STEP;
  if (prev) return prev.position + POSITION_STEP;
  return POSITION_STEP;
}

interface DropTarget {
  status: TicketStatus;
  beforeId: string | null;
}

export function BoardPage({ projectId }: { projectId: string }) {
  const projects = useApi<Project[]>('/api/projects', 30_000);
  const project = projects.data?.find((p) => p.id === projectId);
  const {
    tickets,
    loading: ticketsLoading,
    error: ticketsError,
    patchLocal,
    refresh: refreshTickets,
  } = useTickets(projectId);
  const { runs } = useRuns();
  const [openParam] = useQueryParam('ticket');
  const updateQuery = useUpdateQuery();
  const openId = openParam ?? undefined;
  const setOpenId = (id: string | undefined) => updateQuery({ ticket: id ?? null, view: null });
  const goBack = useGoBack();
  const [dragId, setDragId] = useState<string>();
  const [drop, setDrop] = useState<DropTarget>();
  const [autoStart, setAutoStart] = useState(true);
  const [armedStart, setArmedStart] = useState<{ id: string; nonce: number }>();
  useEffect(() => {
    setArmedStart((prev) => (prev && prev.id !== openId ? undefined : prev));
  }, [openId]);
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [demoPanelOpen, setDemoPanelOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string>();
  const [blockedDrop, setBlockedDrop] = useState<{ ticket: Ticket; target: DropTarget; count: number }>();
  const [missingDrop, setMissingDrop] = useState<{ ticket: Ticket; target: DropTarget }>();

  const [filter, setFilter] = useState<BoardFilter>(() => {
    try {
      return parseBoardFilter(localStorage.getItem(boardFilterKey(projectId)));
    } catch {
      return EMPTY_BOARD_FILTER;
    }
  });

  const updateFilter = (next: BoardFilter) => {
    setFilter(next);
    try {
      if (isBoardFilterActive(next)) {
        localStorage.setItem(boardFilterKey(projectId), JSON.stringify(next));
      } else {
        localStorage.removeItem(boardFilterKey(projectId));
      }
    } catch {
      // ignore storage errors
    }
  };

  /** Newest run per ticket (runs arrive newest-first). */
  const latestRun = useMemo(() => {
    const map = new Map<string, Run>();
    for (const run of runs ?? []) {
      if (!run.ticketId) continue;
      const seen = map.get(run.ticketId);
      if (!seen || Date.parse(run.createdAt) > Date.parse(seen.createdAt)) map.set(run.ticketId, run);
    }
    return map;
  }, [runs]);

  const allColumns = useMemo(() => {
    const grouped = new Map<TicketStatus, Ticket[]>(BOARD_COLUMNS.map((c) => [c.status, []]));
    for (const ticket of tickets ?? []) grouped.get(ticket.status)?.push(ticket);
    for (const list of grouped.values()) list.sort(byPosition);
    return grouped;
  }, [tickets]);

  const filteredBoard = useMemo(
    () => filterBoardTickets(tickets ?? [], latestRun, filter),
    [tickets, latestRun, filter],
  );
  const filterActive = isBoardFilterActive(filter);

  const visibleColumns = useMemo(() => {
    if (!filterActive) return allColumns;
    const grouped = new Map<TicketStatus, Ticket[]>(BOARD_COLUMNS.map((c) => [c.status, []]));
    for (const ticket of filteredBoard.tickets) grouped.get(ticket.status)?.push(ticket);
    for (const list of grouped.values()) list.sort(byPosition);
    return grouped;
  }, [allColumns, filterActive, filteredBoard.tickets]);

  const columnCounts = useMemo(
    () => new Map(BOARD_COLUMNS.map((c) => [c.status, (visibleColumns.get(c.status) ?? []).length])),
    [visibleColumns],
  );

  const move = async (
    ticket: Ticket,
    target: DropTarget,
    { force = false, skipMerge = false, inDrawer = false } = {},
  ) => {
    const column = (allColumns.get(target.status) ?? []).filter((t) => t.id !== ticket.id);
    const position = slotPosition(column, target.beforeId);
    if (ticket.status === target.status && ticket.position === position) return;
    const currentRun = latestRun.get(ticket.id);
    const hasLiveRun = Boolean(currentRun && !currentRun.endedAt);
    const dropAction =
      target.status === 'in_progress' ? dropIntoInProgress(ticket, { autoStart, hasLiveRun }) : 'move';
    setError(undefined);
    setBlockedDrop(undefined);
    setMissingDrop(undefined);

    if (dropAction === 'confirm') {
      setArmedStart((prev) => ({ id: ticket.id, nonce: (prev?.nonce ?? 0) + 1 }));
      setOpenId(ticket.id);
      return;
    }

    if (target.status === 'done' && ticket.status !== 'done' && currentRun?.branch && !skipMerge) {
      let sync: SyncWorktreeResponse;
      try {
        sync = await api<SyncWorktreeResponse>(`/api/projects/${ticket.projectId}/sync-worktree`, 'POST', {
          runId: currentRun.id,
          ...(force ? { force: true } : {}),
        });
      } catch (e) {
        if (inDrawer) throw new DrawerMergeError(mergeNowFailure(e, ticket.key), mergeNowNext(e));
        const blocking = reviewBlockedCount(e);
        if (blocking !== null) {
          setBlockedDrop({ ticket, target, count: blocking });
          return;
        }
        if (worktreeMissing(e)) {
          setMissingDrop({ ticket, target });
          return;
        }
        setError(`Not merged: ${errorMessage(e)}`);
        return;
      }
      if (!sync.ok) {
        if (inDrawer) throw new DrawerMergeError(sync.summary, null);
        setError(sync.summary);
        return;
      }
      toastInfo(sync.summary);
    }

    patchLocal({ ...ticket, status: target.status, position });
    try {
      const updated = await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', {
        status: target.status,
        position,
      });
      patchLocal(updated);
      if (dropAction === 'start') {
        const started = await api<{ ticket: Ticket; run: Run }>(`/api/tickets/${ticket.id}/start`, 'POST', {
          permissionMode: 'auto',
        });
        patchLocal(started.ticket);
      }
    } catch (e) {
      patchLocal(ticket);
      if (inDrawer) throw e;
      setError(errorMessage(e));
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const ticket = tickets?.find((t) => t.id === dragId);
    if (ticket && drop) void move(ticket, drop);
    setDragId(undefined);
    setDrop(undefined);
  };

  const seedTickets = async () => {
    setSeeding(true);
    setError(undefined);
    try {
      const seeded = await api<Ticket[]>(`/api/projects/${projectId}/seed-tickets`, 'POST', {});
      for (const t of seeded) patchLocal(t);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSeeding(false);
    }
  };

  const open = tickets?.find((t) => t.id === openId);
  const canSeed = !ticketsLoading && !ticketsError && (tickets?.length ?? 0) === 0;

  return (
    <div className="board-page">
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
                onClick={() => setDemoPanelOpen((v) => !v)}
                title="View Project Status, Sync Worktrees & Play Live Demo"
              >
                <Play className="icon" aria-hidden /> Live Demo & Status
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setBlueprintOpen(true)}
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
              {seeding ? (
                'Seeding…'
              ) : (
                <>
                  <Sparkles className="icon" aria-hidden /> Seed Starter Backlog
                </>
              )}
            </button>
          )}
          <button
            id="pipeline-auto-start"
            type="button"
            className={`chip-toggle${autoStart ? ' active' : ''}`}
            aria-pressed={autoStart}
            title="When enabled, dragging a card into In progress automatically starts a Claude run"
            onClick={() => setAutoStart((v) => !v)}
          >
            <span className="dot" />
            Auto-dispatch on In progress
          </button>
          {project && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setImportOpen(true)}
              title="Import issues from the project's GitHub, GitLab or Gitea remote"
            >
              Import issues
            </button>
          )}
          {project && <BoardExportMenu projectId={project.id} columns={BOARD_COLUMNS} tickets={tickets} />}
          <QuickAdd projectId={projectId} onCreated={patchLocal} onError={setError} />
        </div>
      </header>

      <QuotaPanel compact />

      {project && <WorktreeConfigBanner key={project.id} project={project} />}

      {demoPanelOpen && project && <ProjectStatusAndDemoPanel project={project} />}

      {Boolean(projects.error && !projects.data) && (
        <ViewErrorBanner
          label="Could not load project details"
          error={projects.error}
          onRetry={projects.refresh}
        />
      )}
      {Boolean(ticketsError) && (
        <ViewErrorBanner label="Could not load board tickets" error={ticketsError} onRetry={refreshTickets} />
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {blockedDrop && (
        <div className="banner banner-warn board-blocked-drop" role="alert">
          <span>
            {blockingMessage(blockedDrop.count)} on {blockedDrop.ticket.key}. It was not moved to Done.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void move(blockedDrop.ticket, blockedDrop.target, { force: true })}
          >
            Merge anyway
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBlockedDrop(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {missingDrop && (
        <div className="banner banner-warn board-blocked-drop" role="alert">
          <span>
            The worktree of {missingDrop.ticket.key}&apos;s run is gone and its work isn&apos;t in main.
            Nothing was merged.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void move(missingDrop.ticket, missingDrop.target, { skipMerge: true })}
          >
            Move to Done without merging
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMissingDrop(undefined)}>
            Cancel
          </button>
        </div>
      )}

      {((tickets?.length ?? 0) > 0 || filterActive) && (
        <BoardFilterBar
          tickets={tickets ?? []}
          latestRunByTicket={latestRun}
          filter={filter}
          shown={filteredBoard.shown}
          onChange={updateFilter}
        />
      )}

      {ticketsLoading && !tickets ? (
        <ViewLoadingState label="Loading project tickets…" />
      ) : (
        <>
          <MobileColumnNav columns={BOARD_COLUMNS} counts={columnCounts} />
          {filterActive && filteredBoard.shown === 0 && (tickets?.length ?? 0) > 0 && (
            <div className="empty board-filter-empty">
              <p>No tickets match the current search or filters.</p>
              <button type="button" className="btn btn-sm" onClick={() => updateFilter(EMPTY_BOARD_FILTER)}>
                Clear filters
              </button>
            </div>
          )}
          <div
            className="board"
            onDragEnd={() => {
              setDragId(undefined);
              setDrop(undefined);
            }}
          >
            {BOARD_COLUMNS.map((col) => {
              const list = visibleColumns.get(col.status) ?? [];
              const totalInCol = (allColumns.get(col.status) ?? []).length;
              const isTarget = drop?.status === col.status;
              return (
                <section
                  key={col.status}
                  id={`col-${col.status}`}
                  className={`board-col board-col-${col.status}${isTarget ? ' drop-target' : ''}`}
                  aria-label={col.label}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    if (
                      e.target === e.currentTarget ||
                      (e.target as HTMLElement).classList.contains('board-cards')
                    ) {
                      setDrop({ status: col.status, beforeId: null });
                    }
                  }}
                  onDrop={onDrop}
                >
                  <header className="board-col-head" title={col.hint}>
                    <span className="board-col-dot" aria-hidden="true" />
                    <h2>{col.label}</h2>
                    {col.status === 'in_progress' && autoStart && (
                      <span className="badge mono" title="Drop a card here to auto-start Claude">
                        auto
                      </span>
                    )}
                    <span className="board-count mono">
                      {filterActive && list.length !== totalInCol
                        ? `${list.length}/${totalInCol}`
                        : list.length}
                    </span>
                  </header>
                  <ol className="board-cards">
                    {list.map((ticket) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        run={latestRun.get(ticket.id)}
                        dragging={dragId === ticket.id}
                        dropBefore={drop?.beforeId === ticket.id && dragId !== ticket.id}
                        onOpen={() => setOpenId(ticket.id)}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', ticket.key);
                          setDragId(ticket.id);
                        }}
                        onDragOver={(e) => {
                          if (!dragId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const after = e.clientY > rect.top + rect.height / 2;
                          const beforeId = after ? (list[list.indexOf(ticket) + 1]?.id ?? null) : ticket.id;
                          setDrop({ status: col.status, beforeId });
                        }}
                      />
                    ))}
                    {isTarget && drop?.beforeId === null && <li className="drop-marker" aria-hidden="true" />}
                  </ol>
                  {list.length === 0 && !isTarget && (
                    <p className="board-empty">
                      {filterActive && totalInCol > 0 ? 'No matching tickets' : col.hint}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      {open && (
        <TicketDrawer
          key={open.id}
          ticket={open}
          allTickets={tickets ?? []}
          run={latestRun.get(open.id)}
          onClose={() => {
            setArmedStart(undefined);
            setOpenId(undefined);
          }}
          onChanged={patchLocal}
          armStart={armedStart?.id === open.id ? armedStart.nonce : 0}
          onMove={(status) => {
            if (status !== open.status) void move(open, { status, beforeId: null });
          }}
          onDiscard={() =>
            move(open, { status: 'done', beforeId: null }, { skipMerge: true, inDrawer: true })
          }
          onAccept={(opts) =>
            move(open, { status: 'done', beforeId: null }, { inDrawer: true, force: opts?.force ?? false })
          }
        />
      )}

      {project && importOpen && (
        <IssueImportDialog
          projectId={project.id}
          projectName={project.name}
          onClose={() => setImportOpen(false)}
          onImported={(created) => created.forEach(patchLocal)}
        />
      )}

      {project && (
        <BlueprintModal project={project} open={blueprintOpen} onClose={() => setBlueprintOpen(false)} />
      )}
    </div>
  );
}
