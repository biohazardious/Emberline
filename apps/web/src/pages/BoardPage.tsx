import type { Run, SyncWorktreeResponse, Ticket, TicketStatus } from '@emberline/protocol';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { BlueprintModal } from '../components/BlueprintModal';
import { BoardColumnsSection } from '../components/board/BoardColumnsSection';
import { BoardHeaderSection } from '../components/board/BoardHeaderSection';
import {
  type BoardCtx,
  byPosition,
  COLUMNS,
  type DropTarget,
  slotPosition,
} from '../components/board/boardMeta';
import { TicketDrawer } from '../components/board/TicketDrawer';
import { IssueImportDialog } from '../components/IssueImportDialog';
import { WorktreeConfigBanner } from '../components/ProjectSettingsPanel';
import { ProjectStatusAndDemoPanel } from '../components/ProjectStatusAndDemoPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import { useRuns, useTickets } from '../hooks/liveData';
import { useGoBack, useQueryParam, useUpdateQuery } from '../hooks/navigation';
import { useProject } from '../hooks/useProjects';
import {
  DrawerMergeError,
  mergeNowFailure,
  mergeNowNext,
  reviewBlockedCount,
  worktreeMissing,
} from '../reviewComments';
import { dropIntoInProgress } from '../ticketDeps';
import { toastInfo } from '../toast';

export function BoardPage({ projectId }: { projectId: string }) {
  const {
    project,
    loading: projectLoading,
    error: projectError,
    refresh: refreshProject,
  } = useProject(projectId, 30_000);
  const {
    tickets,
    loading: ticketsLoading,
    error: ticketsError,
    refresh: refreshTickets,
    patchLocal,
  } = useTickets(projectId);
  const { runs } = useRuns();

  // The open ticket lives in the address, so coming back from its terminal or review reopens it.
  const [openParam] = useQueryParam('ticket');
  const updateQuery = useUpdateQuery();
  const openId = openParam ?? undefined;
  const setOpenId = (id: string | undefined) => updateQuery({ ticket: id ?? null, view: null });
  const goBack = useGoBack();

  const [autoStart, setAutoStart] = useState(true);
  // A blocked ticket dropped into In progress: its drawer opens asking "Start anyway" (`nonce` re-arms it).
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

  const columns = useMemo(() => {
    const grouped = new Map<TicketStatus, Ticket[]>(COLUMNS.map((c) => [c.status, []]));
    for (const ticket of tickets ?? []) grouped.get(ticket.status)?.push(ticket);
    for (const list of grouped.values()) list.sort(byPosition);
    return grouped;
  }, [tickets]);

  const move = async (
    ticket: Ticket,
    target: DropTarget,
    { force = false, skipMerge = false, inDrawer = false } = {},
  ) => {
    const column = (columns.get(target.status) ?? []).filter((t) => t.id !== ticket.id);
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

  const ctx: BoardCtx = {
    pid: projectId,
    proj: project,
    tickets,
    cols: columns,
    runs: latestRun,
    auto: autoStart,
    flipAuto: () => setAutoStart((v) => !v),
    demo: demoPanelOpen,
    flipDemo: () => setDemoPanelOpen((v) => !v),
    openBp: () => setBlueprintOpen(true),
    openImp: () => setImportOpen(true),
    back: goBack,
    patch: patchLocal,
    err: error,
    setErr: setError,
    blocked: blockedDrop,
    missing: missingDrop,
    clrBlocked: () => setBlockedDrop(undefined),
    clrMissing: () => setMissingDrop(undefined),
    move: (t, d, opts) => move(t, d, opts),
    open: (id) => setOpenId(id),
  };

  const open = tickets?.find((t) => t.id === openId);

  return (
    <div className="board-page">
      <BoardHeaderSection ctx={ctx} loading={projectLoading} error={projectError} onRetry={refreshProject} />

      <QuotaPanel compact />

      {project && <WorktreeConfigBanner key={project.id} project={project} />}

      {demoPanelOpen && project && <ProjectStatusAndDemoPanel project={project} />}

      <BoardColumnsSection
        ctx={ctx}
        loading={ticketsLoading}
        loadError={ticketsError}
        onRetry={refreshTickets}
      />

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
