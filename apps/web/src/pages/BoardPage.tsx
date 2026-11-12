import type { BulkTicketResult, Run, SyncWorktreeResponse, Ticket, TicketStatus } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import {
  type BoardFilter,
  EMPTY_BOARD_FILTER,
  filterBoardTickets,
  isBoardFilterActive,
  parseBoardFilter,
} from '../boardFilter';
import { bulkResultSummary, selectionAfter } from '../boardSelection';
import { BlueprintModal } from '../components/BlueprintModal';
import { BOARD_COLUMNS } from '../components/BoardCard';
import { BoardColumnsSection } from '../components/board/BoardColumnsSection';
import { BoardHeaderSection } from '../components/board/BoardHeaderSection';
import { type BoardCtx, byPosition, type DropTarget, slotPosition } from '../components/board/boardMeta';
import { TicketDrawer } from '../components/board/TicketDrawer';
import { IssueImportDialog } from '../components/IssueImportDialog';
import { WorktreeConfigBanner } from '../components/ProjectSettingsPanel';
import { ProjectStatusAndDemoPanel } from '../components/ProjectStatusAndDemoPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import { useRuns, useTickets } from '../hooks/liveData';
import { useGoBack, useQueryParam, useUpdateQuery } from '../hooks/navigation';
import { useBoardSelection } from '../hooks/useBoardSelection';
import { useProject } from '../hooks/useProjects';
import {
  DrawerMergeError,
  mergeNowFailure,
  mergeNowNext,
  reviewBlockedCount,
  worktreeMissing,
} from '../reviewComments';
import { type ManualConflictState, type SyncResolvingNotice, syncWorktreeOutcome } from '../syncResolution';
import { dropIntoInProgress } from '../ticketDeps';
import { toastError, toastInfo } from '../toast';

export { TicketDrawer } from '../components/board/TicketDrawer';

function boardFilterKey(projectId: string): string {
  return `emberline.board.filter.${projectId}`;
}

export function BoardPage({ projectId }: { projectId: string }) {
  const { project, error: projectError, refresh: refreshProject } = useProject(projectId, 30_000);
  const {
    tickets,
    loading: ticketsLoading,
    error: ticketsError,
    patchLocal,
    refresh: refreshTickets,
  } = useTickets(projectId);
  const queryClient = useQueryClient();
  const { runs, refresh: refreshRuns } = useRuns();

  // The open ticket lives in the address, so coming back from its terminal or review reopens it.
  const [openParam] = useQueryParam('ticket');
  const updateQuery = useUpdateQuery();
  const openId = openParam ?? undefined;
  const setOpenId = (id: string | undefined) => updateQuery({ ticket: id ?? null, view: null });
  const goBack = useGoBack();

  const [autoStart, setAutoStart] = useState(true);
  const [armedStart, setArmedStart] = useState<{ id: string; nonce: number }>();
  useEffect(() => {
    setArmedStart((prev) => (prev && prev.id !== openId ? undefined : prev));
  }, [openId]);

  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [demoPanelOpen, setDemoPanelOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [blockedDrop, setBlockedDrop] = useState<{ ticket: Ticket; target: DropTarget; count: number }>();
  const [missingDrop, setMissingDrop] = useState<{ ticket: Ticket; target: DropTarget }>();
  const [resolvingNotice, setResolvingNotice] = useState<SyncResolvingNotice>();
  const [manualConflict, setManualConflict] = useState<ManualConflictState>();

  useEffect(() => {
    if (!tickets) return;
    if (resolvingNotice) {
      const target = tickets.find((t) => t.id === resolvingNotice.ticketId);
      if (target?.status === 'done') setResolvingNotice(undefined);
    }
    if (manualConflict) {
      const target = tickets.find((t) => t.id === manualConflict.ticketId);
      if (target && target.status !== 'review') setManualConflict(undefined);
    }
  }, [tickets, resolvingNotice, manualConflict]);

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

  const orderedVisible = useMemo(
    () => BOARD_COLUMNS.flatMap((c) => (visibleColumns.get(c.status) ?? []).map((t) => t.id)),
    [visibleColumns],
  );
  const bulk = useBoardSelection(tickets, orderedVisible);

  const onBulkApplied = (result: BulkTicketResult) => {
    for (const ticket of result.updated) patchLocal(ticket);
    if (result.removed.length > 0) void refreshTickets();
    (result.failed.length > 0 ? toastError : toastInfo)(bulkResultSummary(result));
    bulk.replace(selectionAfter(result));
  };

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
    setResolvingNotice(undefined);
    setManualConflict(undefined);

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

      if (!sync.ok && (sync.resolution === 'resolver_started' || sync.resolution === 'agent_resolving')) {
        void refreshRuns();
      }

      const outcome = syncWorktreeOutcome(sync);
      if (outcome.kind === 'resolving') {
        void queryClient.invalidateQueries({ queryKey: ['run-recovery', currentRun.id] });
        setResolvingNotice({
          ticketId: ticket.id,
          resolution: outcome.resolution,
          text: outcome.text,
          runId: outcome.runId,
          href: outcome.href,
          linkLabel: outcome.linkLabel,
        });
        return;
      }
      if (outcome.kind === 'manual_conflict') {
        void queryClient.invalidateQueries({ queryKey: ['run-recovery', currentRun.id] });
        setManualConflict({
          ticketId: ticket.id,
          runId: currentRun.id,
          conflicts: outcome.conflicts,
        });
        if (!inDrawer) setOpenId(ticket.id);
        return;
      }
      if (outcome.kind === 'error') {
        if (inDrawer) throw new DrawerMergeError(outcome.text, null);
        setError(outcome.text);
        return;
      }
      toastInfo(outcome.toast);
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

  const canSeed = !ticketsLoading && !ticketsError && (tickets?.length ?? 0) === 0;
  const open = tickets?.find((t) => t.id === openId);

  const ctx: BoardCtx = {
    projectId,
    project,
    tickets,
    allColumns,
    visibleColumns,
    columnCounts,
    latestRun,
    autoStart,
    toggleAutoStart: () => setAutoStart((v) => !v),
    demoPanelOpen,
    toggleDemoPanel: () => setDemoPanelOpen((v) => !v),
    canSeed,
    bulkSelection: bulk,
    onBulkApplied,
    filter,
    filterActive,
    filteredCount: filteredBoard.shown,
    updateFilter,
    openBlueprint: () => setBlueprintOpen(true),
    openImport: () => setImportOpen(true),
    goBack,
    patchTicket: patchLocal,
    error,
    setError,
    blockedDrop,
    missingDrop,
    resolvingNotice: openId === resolvingNotice?.ticketId ? undefined : resolvingNotice,
    clearBlockedDrop: () => setBlockedDrop(undefined),
    clearMissingDrop: () => setMissingDrop(undefined),
    clearResolvingNotice: () => setResolvingNotice(undefined),
    moveTicket: (ticket, target, opts) => move(ticket, target, opts),
    openTicket: (id) => setOpenId(id),
  };

  return (
    <div className="board-page">
      <BoardHeaderSection ctx={ctx} />

      <QuotaPanel compact />

      {project && <WorktreeConfigBanner key={project.id} project={project} />}

      {demoPanelOpen && project && <ProjectStatusAndDemoPanel project={project} />}

      <BoardColumnsSection
        ctx={ctx}
        loading={ticketsLoading}
        loadError={ticketsError}
        onRetry={refreshTickets}
        projectError={projectError}
        onRetryProject={refreshProject}
      />

      {open && (
        <TicketDrawer
          key={open.id}
          ticket={open}
          allTickets={tickets ?? []}
          run={latestRun.get(open.id)}
          resolvingNotice={open.id === resolvingNotice?.ticketId ? resolvingNotice : null}
          onDismissResolving={() => setResolvingNotice(undefined)}
          conflictFallback={
            manualConflict?.ticketId === open.id && manualConflict.runId === latestRun.get(open.id)?.id
              ? {
                  conflicts: manualConflict.conflicts,
                  mainBranch: project?.defaultBranch,
                  ticketKey: open.key,
                }
              : null
          }
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
