import type {
  AgentPersona,
  PermissionMode,
  Project,
  Run,
  SyncWorktreeResponse,
  Ticket,
  TicketStatus,
} from '@emberline/protocol';
import { Coins, Play, Sparkles, Wrench, X } from 'lucide-react';
import { type DragEvent, type FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { blockingMessage, reviewBlockedCount, worktreeMissing } from '../reviewComments';
import { BlueprintModal } from '../components/BlueprintModal';
import { IssueImportDialog } from '../components/IssueImportDialog';
import { issueHref } from '../issueImport';
import { modeHint, PermissionModePicker } from '../components/PermissionModePicker';
import { PERSONA_LIST, PersonaBadge, PersonaPicker, TaskTemplateBar } from '../components/PersonaBadge';
import { ProjectStatusAndDemoPanel } from '../components/ProjectStatusAndDemoPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import {
  formatAgentDisplayName,
  formatAgentResumePlaceholder,
  RunEventTimeline,
  RunFailureBanner,
  STAGE_TEMPLATES,
} from '../components/RunInspector';
import { HandoffMenu } from '../components/QuotaLanes';
import { RunStatePill } from '../components/RunStatePill';
import { useApi } from '../hooks/useApi';
import { BuildOutputsList } from '../components/RunOutcome';
import { useRuns, useTickets } from '../hooks/liveData';
import { useGoBack, useQueryParam, useUpdateQuery } from '../hooks/navigation';
import { timeAgo } from '../time';
import { dependencyCandidates, dropIntoInProgress, waitingLabel, waitingTitle } from '../ticketDeps';
import { toastInfo } from '../toast';

const TerminalView = lazy(() => import('../components/TerminalView').then((m) => ({ default: m.TerminalView })));
const ReviewView = lazy(() => import('../components/ReviewView').then((m) => ({ default: m.ReviewView })));

const COLUMNS: { status: TicketStatus; label: string; hint: string }[] = [
  { status: 'backlog', label: 'Backlog', hint: 'Ideas and not-yet-ready work' },
  { status: 'ready', label: 'Ready', hint: 'Specified and ready to hand to an agent' },
  { status: 'in_progress', label: 'In progress', hint: 'Drop here to dispatch agent (or monitor active run)' },
  { status: 'review', label: 'Review', hint: 'Agent finished its turn; review or send a follow-up' },
  { status: 'done', label: 'Done', hint: 'Accepted; runs never move tickets out of here' },
];

const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;

const POSITION_STEP = 1024;

const byPosition = (a: Ticket, b: Ticket) => a.position - b.position;

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

/** The runs that came before `run` in its handoff chain (oldest first); the same attempt continued on other routes. */
function AttemptChain({ run }: { run: Run }) {
  const { runs } = useRuns();
  const chain: { id: string; run?: Run }[] = [];
  const seen = new Set([run.id]);
  for (let id = run.predecessorRunId; id && !seen.has(id); ) {
    seen.add(id);
    const found = (runs ?? []).find((r) => r.id === id);
    chain.unshift({ id, run: found });
    id = found?.predecessorRunId ?? null;
  }
  if (chain.length === 0) return null;
  return (
    <div className="attempt-chain muted small">
      <span>Earlier on this attempt</span>
      <ol>
        {chain.map(({ id, run: p }) => (
          <li key={id}>
            {p ? (
              <>
                <span className="mono">{formatAgentDisplayName(p.agent)}{p.model ? ` · ${p.model}` : ''}</span>{' '}
                <RunStatePill state={p.state} cancelled={p.cancelled} autoRetry={p.autoRetry} handedOffTo={p.handedOffTo} />{' '}
                <Link href={`/runs/${id}/review`} className="mono">{id.slice(0, 8)}</Link>
              </>
            ) : (
              <span className="mono" title="This run is no longer listed">{id.slice(0, 8)}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BoardPage({ projectId }: { projectId: string }) {
  const projects = useApi<Project[]>('/api/projects', 30_000);
  const project = projects.data?.find((p) => p.id === projectId);
  const { tickets, patchLocal } = useTickets(projectId);
  const { runs } = useRuns();
  // The open ticket lives in the address, so coming back from its terminal or review reopens it.
  const [openParam] = useQueryParam('ticket');
  const updateQuery = useUpdateQuery();
  const openId = openParam ?? undefined;
  // Opening or closing a ticket starts its drawer on its default tab.
  const setOpenId = (id: string | undefined) => updateQuery({ ticket: id ?? null, view: null });
  const goBack = useGoBack();
  const [dragId, setDragId] = useState<string>();
  const [drop, setDrop] = useState<DropTarget>();
  const [autoStart, setAutoStart] = useState(true);
  // A blocked ticket dropped into In progress: its drawer opens asking "Start anyway" (`nonce` re-arms it).
  const [armedStart, setArmedStart] = useState<{ id: string; nonce: number }>();
  // The armed state belongs to one ticket's drawer: opening another ticket (or none) drops it.
  useEffect(() => {
    setArmedStart((prev) => (prev && prev.id !== openId ? undefined : prev));
  }, [openId]);
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [demoPanelOpen, setDemoPanelOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string>();
  // A drag to Done the merge gate refused: the ticket stays put until the person overrides or cancels.
  const [blockedDrop, setBlockedDrop] = useState<{ ticket: Ticket; target: DropTarget; count: number }>();
  // A drag to Done whose run worktree is gone with work that is not in main: moved only if the person says so.
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

  /** `force` merges past open blocking feedback; `skipMerge` moves to Done without a merge. */
  const move = async (ticket: Ticket, target: DropTarget, { force = false, skipMerge = false } = {}) => {
    const column = (columns.get(target.status) ?? []).filter((t) => t.id !== ticket.id);
    const position = slotPosition(column, target.beforeId);
    if (ticket.status === target.status && ticket.position === position) return;
    const currentRun = latestRun.get(ticket.id);
    const hasLiveRun = Boolean(currentRun && !currentRun.endedAt);
    const dropAction = target.status === 'in_progress' ? dropIntoInProgress(ticket, { autoStart, hasLiveRun }) : 'move';
    setError(undefined);
    setBlockedDrop(undefined);
    setMissingDrop(undefined);

    // A blocked ticket stays where it is: its drawer opens asking "Start anyway". Moving it first would
    // leave it in In progress without a run when the drawer is closed.
    if (dropAction === 'confirm') {
      setArmedStart((prev) => ({ id: ticket.id, nonce: (prev?.nonce ?? 0) + 1 }));
      setOpenId(ticket.id);
      return;
    }

    // Accepting a ticket brings its run's branch into the main workspace first; a conflict keeps the
    // ticket where it is so nothing is marked done that is not actually in main.
    if (target.status === 'done' && ticket.status !== 'done' && currentRun?.branch && !skipMerge) {
      try {
        const sync = await api<SyncWorktreeResponse>(`/api/projects/${ticket.projectId}/sync-worktree`, 'POST', {
          runId: currentRun.id,
          ...(force ? { force: true } : {}),
        });
        if (!sync.ok) {
          setError(sync.summary);
          return;
        }
        toastInfo(sync.summary);
      } catch (e) {
        // Never mark a ticket done after a merge that did not happen.
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
    }

    patchLocal({ ...ticket, status: target.status, position });
    try {
      const updated = await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { status: target.status, position });
      patchLocal(updated);
      // Pipeline column behavior (herdr-board): dropping into In progress dispatches an agent when idle.
      if (dropAction === 'start') {
        const started = await api<{ ticket: Ticket; run: Run }>(`/api/tickets/${ticket.id}/start`, 'POST', {
          permissionMode: 'auto',
        });
        patchLocal(started.ticket);
      }
    } catch (e) {
      patchLocal(ticket);
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

  return (
    <div className="board-page">
      <header className="board-head">
        <div className="board-title">
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Back to the previous page" onClick={goBack}>
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
          {(tickets?.length ?? 0) === 0 && (
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
          <QuickAdd projectId={projectId} onCreated={patchLocal} onError={setError} />
        </div>
      </header>

      <QuotaPanel compact />

      {demoPanelOpen && project && <ProjectStatusAndDemoPanel project={project} />}

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
            The worktree of {missingDrop.ticket.key}&apos;s run is gone and its work isn&apos;t in main. Nothing was
            merged.
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

      <div
        className="board"
        onDragEnd={() => {
          setDragId(undefined);
          setDrop(undefined);
        }}
      >
        {COLUMNS.map((col) => {
          const list = columns.get(col.status) ?? [];
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
                // Over the column background (not a card): drop at the end.
                if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('board-cards')) {
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
                <span className="board-count">{list.length}</span>
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
              {list.length === 0 && !isTarget && <p className="board-empty">{col.hint}</p>}
            </section>
          );
        })}
      </div>

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
        <BlueprintModal
          project={project}
          open={blueprintOpen}
          onClose={() => setBlueprintOpen(false)}
        />
      )}
    </div>
  );
}

function QuickAdd({
  projectId,
  onCreated,
  onError,
}: {
  projectId: string;
  onCreated: (ticket: Ticket) => void;
  onError: (message: string | undefined) => void;
}) {
  const [title, setTitle] = useState('');
  const [persona, setPersona] = useState<AgentPersona>('coder');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    onError(undefined);
    try {
      onCreated(await api<Ticket>(`/api/projects/${projectId}/tickets`, 'POST', { title, persona }));
      setTitle('');
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="quick-add" onSubmit={(e) => void submit(e)}>
      <select
        className="input"
        aria-label="Ticket persona"
        style={{ width: 'auto', maxWidth: 'min(320px, 100%)', padding: '6px 8px', fontSize: '0.82rem' }}
        value={persona}
        onChange={(e) => setPersona(e.target.value as AgentPersona)}
        title="Assign specialist persona for this ticket"
      >
        {PERSONA_LIST.map((p) => (
          <option key={p.id} value={p.id}>
            [{p.shortLabel}] {p.label}
          </option>
        ))}
      </select>
      <input
        id="ticket-title"
        className="input"
        placeholder="New ticket title…"
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button id="ticket-add" className="btn btn-primary" disabled={busy || !title.trim()}>
        Add
      </button>
    </form>
  );
}

/** The issue a ticket was imported from: `#123` linking to it, its labels, whether it is closed or needs triage. */
function IssueChips({ external }: { external: Ticket['external'] }) {
  if (!external) return null;
  const href = issueHref(external.url);
  return (
    <div className="card-issue">
      {href ? (
        <a
          className="badge badge-soft mono issue-chip"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the issue"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          #{external.number}
        </a>
      ) : (
        <span className="badge badge-soft mono">#{external.number}</span>
      )}
      {external.triage && (
        <span
          className="badge badge-warn"
          title="Label sync imported this from an author who is not in Trusted authors. Automatic dispatch skips it until you move or edit it."
        >
          needs triage
        </span>
      )}
      {external.state === 'closed' && <span className="badge badge-soft">closed</span>}
      {external.labels.map((l) => (
        <span key={l} className="badge badge-soft card-issue-label">
          {l}
        </span>
      ))}
    </div>
  );
}

function TicketCard({
  ticket,
  run,
  dragging,
  dropBefore,
  onOpen,
  onDragStart,
  onDragOver,
}: {
  ticket: Ticket;
  run: Run | undefined;
  dragging: boolean;
  dropBefore: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
}) {
  const live = run && !run.endedAt;
  const shortBranch = run?.branch?.replace(/^emberline\//, '');
  return (
    <>
      {dropBefore && <li className="drop-marker" aria-hidden="true" />}
      <li
        id={`ticket-${ticket.key}`}
        className={`card prio-${ticket.priority}${dragging ? ' dragging' : ''}${live ? ` card-live card-${run.state}` : ''}`}
        draggable
        tabIndex={0}
        aria-label={`${ticket.key} ${ticket.title}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
      >
        <div className="card-top">
          <span className="card-key mono">{ticket.key}</span>
          <PersonaBadge persona={ticket.persona} />
          {shortBranch && <span className="card-branch mono">{shortBranch}</span>}
          <span className="prio-dot" title={`${PRIORITIES[ticket.priority]} priority`} />
        </div>
        <p className="card-title">{ticket.title}</p>
        <IssueChips external={ticket.external} />
        {waitingLabel(ticket.blockedBy) && (
          <span className="card-waiting mono" title={waitingTitle(ticket.blockedBy)}>
            {waitingLabel(ticket.blockedBy)}
          </span>
        )}
        {run && (
          <div className="card-foot">
            <RunStatePill state={run.state} cancelled={run.cancelled} autoRetry={run.autoRetry} handedOffTo={run.handedOffTo} />
            {run.telemetry && run.telemetry.totalTokens > 0 && (
              <span
                className="card-event mono"
                style={{ fontVariantNumeric: 'tabular-nums' }}
                title={`Input: ${run.telemetry.inputTokens.toLocaleString()} tok · Output: ${run.telemetry.outputTokens.toLocaleString()} tok · Tools: ${run.telemetry.toolCalls}`}
              >
                <Coins className="icon" aria-hidden /> {(run.telemetry.totalTokens / 1000).toFixed(1)}k
                {run.telemetry.toolCalls > 0 ? (
                  <>
                    {' · '}
                    <Wrench className="icon" aria-hidden />
                    {run.telemetry.toolCalls}
                  </>
                ) : (
                  ''
                )}
              </span>
            )}
            {run.lastEvent && <span className="card-event mono">{run.lastEvent}</span>}
            <span className="card-meta mono">{timeAgo(run.stateChangedAt)}</span>
          </div>
        )}
      </li>
    </>
  );
}


const DRAWER_VIEWS = ['details', 'review', 'terminal', 'events'] as const;
type DrawerView = (typeof DRAWER_VIEWS)[number];
function TicketDrawer({
  ticket,
  allTickets,
  run,
  onClose,
  onChanged,
  armStart,
  onMove,
}: {
  ticket: Ticket;
  allTickets: Ticket[];
  run: Run | undefined;
  onClose: () => void;
  onChanged: (ticket: Ticket) => void;
  /** Changes (non-zero) when a drop asks this drawer to confirm starting a blocked ticket. */
  armStart: number;
  onMove: (status: TicketStatus) => void;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [priority, setPriority] = useState(ticket.priority);
  const [persona, setPersona] = useState<AgentPersona>(ticket.persona ?? 'coder');
  // A drop that armed the start uses the permission mode a normal drop does.
  const [mode, setMode] = useState<PermissionMode>(armStart > 0 ? 'auto' : 'default');
  const [followUp, setFollowUp] = useState('');
  // The drawer tab lives in the address too (`?view=events`), next to the open ticket.
  const defaultView: DrawerView = ticket.status === 'review' && run?.worktreePath ? 'review' : 'details';
  const [viewParam, setViewParam] = useQueryParam('view');
  const viewTab: DrawerView = DRAWER_VIEWS.includes(viewParam as DrawerView) ? (viewParam as DrawerView) : defaultView;
  const setViewTab = (view: DrawerView) => setViewParam(view === defaultView ? null : view);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [depError, setDepError] = useState<string>();
  const [confirmStart, setConfirmStart] = useState(armStart > 0);
  useEffect(() => {
    if (armStart > 0) {
      setConfirmStart(true);
      setMode('auto');
    }
  }, [armStart]);
  // The question is about the blockers it was asked for: when they change, it is asked afresh.
  const blockerKey = ticket.blockedBy.map((b) => b.id).join(',');
  const seenBlockers = useRef(blockerKey);
  useEffect(() => {
    if (seenBlockers.current === blockerKey) return;
    seenBlockers.current = blockerKey;
    setConfirmStart(false);
  }, [blockerKey]);
  const live = run && !run.endedAt;
  const queued = run?.state === 'queued';
  const canFollowUp = (live && !queued) || run?.resumable === true;
  const dirty =
    title.trim() !== ticket.title ||
    body !== ticket.body ||
    priority !== ticket.priority ||
    persona !== (ticket.persona ?? 'coder');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const save = () =>
    act('save', async () => {
      onChanged(await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { title, body, priority, persona }));
    });

  const setDependsOn = async (next: string[]) => {
    setBusy('deps');
    setDepError(undefined);
    try {
      onChanged(await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { dependsOn: next }));
    } catch (e) {
      setDepError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };
  const byId = new Map(allTickets.map((t) => [t.id, t]));
  const candidates = dependencyCandidates(ticket, allTickets);

  // A blocked ticket needs a second click: the first one only asks.
  const start = () => {
    if (ticket.blockedBy.length > 0 && !confirmStart) {
      setConfirmStart(true);
      return;
    }
    setConfirmStart(false);
    void startNow();
  };

  const startNow = () =>
    act('start', async () => {
      if (dirty) await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { title, body, priority, persona });
      const res = await api<{ ticket: Ticket; run: Run }>(`/api/tickets/${ticket.id}/start`, 'POST', {
        permissionMode: mode,
        persona,
      });
      onChanged(res.ticket);
    });

  const send = () =>
    act('send', async () => {
      const res = await api<{ ticket: Ticket; run: Run }>(`/api/tickets/${ticket.id}/prompt`, 'POST', {
        text: followUp,
      });
      setFollowUp('');
      onChanged(res.ticket);
    });

  const remove = () =>
    act('delete', async () => {
      if (!confirm(`Delete ${ticket.key}? Its runs, branch and worktree are kept.`)) return;
      await api(`/api/tickets/${ticket.id}`, 'DELETE');
      onClose();
    });

  const runAction = (name: 'resume' | 'stop') =>
    act(name, async () => {
      if (!run) return;
      await api(`/api/runs/${run.id}/${name}`, 'POST', name === 'resume' ? {} : undefined);
    });

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className={`drawer${run ? ' drawer-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-key"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <span id="drawer-key" className="card-key mono">
            {ticket.key}
          </span>
          <PersonaBadge persona={persona} showFull />
          {run && <RunStatePill state={run.state} cancelled={run.cancelled} autoRetry={run.autoRetry} handedOffTo={run.handedOffTo} />}
          {run?.branch && <span className="badge badge-soft mono hide-sm">{run.branch}</span>}
          <span className="muted small mono">updated {timeAgo(ticket.updatedAt)}</span>
          {run && (
            <div className="segmented" role="tablist" aria-label="Ticket inspector view">
              <button
                type="button"
                role="tab"
                aria-selected={viewTab === 'details'}
                className={viewTab === 'details' ? 'active' : ''}
                onClick={() => setViewTab('details')}
              >
                Spec & Agent
              </button>
              {run.worktreePath && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewTab === 'review'}
                  className={viewTab === 'review' ? 'active' : ''}
                  onClick={() => setViewTab('review')}
                >
                  Review & Diff
                </button>
              )}
              {run.terminalId && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewTab === 'terminal'}
                  className={viewTab === 'terminal' ? 'active' : ''}
                  onClick={() => setViewTab('terminal')}
                >
                  Live Terminal
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={viewTab === 'events'}
                className={viewTab === 'events' ? 'active' : ''}
                onClick={() => setViewTab('events')}
              >
                Events
              </button>
            </div>
          )}
          <button id="drawer-close" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X className="icon" aria-hidden />
          </button>
        </header>

        {viewTab === 'review' && run && (
          <div className="drawer-review-pane">
            <Suspense fallback={<div className="empty" aria-busy="true">Loading diff & review…</div>}>
              <ReviewView run={run} />
            </Suspense>
          </div>
        )}

        {viewTab === 'terminal' && run?.terminalId && (
          <div className="drawer-terminal-pane">
            <Suspense fallback={<div className="term-shell term-shell-compact" aria-busy="true" />}>
              <TerminalView key={run.terminalId} terminalId={run.terminalId} compact />
            </Suspense>
          </div>
        )}

        {viewTab === 'events' && run && (
          <div className="drawer-events-pane">
            <RunFailureBanner run={run} />
            <RunEventTimeline run={run} />
          </div>
        )}

        {viewTab === 'details' && (
          <>
            <TaskTemplateBar
              onSelect={(tpl) => {
                setPersona(tpl.persona);
                setMode(tpl.permissionMode);
                if (!title.trim()) setTitle(tpl.titlePlaceholder);
                setBody(tpl.promptTemplate);
              }}
            />
            <input
              id="drawer-title"
              className="input drawer-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
            <IssueChips external={ticket.external} />
            <textarea
              id="drawer-body"
              className="input drawer-body"
              rows={5}
              placeholder="Details, acceptance criteria, files to look at… (sent to the assigned agent with the title)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {ticket.completion && (
              <section className="drawer-completion" aria-label="Completion">
                <label className="drawer-label">
                  Completion
                  {ticket.completion.blockers.length > 0 && (
                    <span className="badge mono" style={{ marginLeft: 8, borderColor: 'var(--warn)', color: 'var(--warn)' }}>
                      blocked
                    </span>
                  )}
                </label>
                <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{ticket.completion.summary}</p>
                {ticket.completion.blockers.length > 0 && (
                  <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
                    {ticket.completion.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                {ticket.completion.handoff && (
                  <>
                    <div className="muted small">Handoff for dependent tickets</div>
                    <p className="small" style={{ margin: '2px 0', whiteSpace: 'pre-wrap' }}>
                      {ticket.completion.handoff}
                    </p>
                  </>
                )}
                <div className="muted small mono">
                  <Link href={`/runs/${ticket.completion.runId}/review`}>run {ticket.completion.runId.slice(0, 8)}</Link>
                  {' · '}
                  {timeAgo(ticket.completion.at)}
                </div>
              </section>
            )}
            <label className="drawer-label">Specialist Persona</label>
            <PersonaPicker value={persona} onChange={setPersona} />
            <div className="drawer-row">
              <div className="segmented" role="radiogroup" aria-label="Priority">
                {PRIORITIES.map((label, value) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={priority === value}
                    className={priority === value ? 'active' : ''}
                    onClick={() => setPriority(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button id="drawer-save" className="btn btn-sm" disabled={!dirty || !!busy || !title.trim()} onClick={save}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </div>

            <label className="drawer-label" htmlFor="drawer-dep-add">
              Depends on
            </label>
            <div className="dep-editor">
              {ticket.dependsOn.length === 0 && <p className="muted small">No dependencies.</p>}
              <ul className="dep-list">
                {ticket.dependsOn.map((id) => {
                  const dep = byId.get(id);
                  return (
                    <li key={id} className="dep-item">
                      {dep ? (
                        <>
                          <Link href={`/projects/${ticket.projectId}/board?ticket=${dep.id}`} className="mono dep-key">
                            {dep.key}
                          </Link>
                          <span className="dep-title">{dep.title}</span>
                          <span className="badge badge-soft">{dep.status.replace('_', ' ')}</span>
                        </>
                      ) : (
                        <span className="mono muted dep-title">{id}</span>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Remove dependency ${dep?.key ?? id}`}
                        disabled={!!busy}
                        onClick={() => void setDependsOn(ticket.dependsOn.filter((d) => d !== id))}
                      >
                        <X className="icon" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <select
                id="drawer-dep-add"
                className="input"
                value=""
                disabled={!!busy || candidates.length === 0}
                onChange={(e) => e.target.value && void setDependsOn([...ticket.dependsOn, e.target.value])}
              >
                <option value="">{candidates.length === 0 ? 'No tickets to add' : 'Add a dependency…'}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.key} {c.title}
                  </option>
                ))}
              </select>
              {depError && (
                <p className="form-error" role="alert">
                  {depError}
                </p>
              )}
            </div>

            <label className="drawer-label" htmlFor="drawer-status">
              Column
            </label>
            <div id="drawer-status" className="segmented segmented-wrap" role="radiogroup" aria-label="Column">
              {COLUMNS.map((c) => (
                <button
                  key={c.status}
                  type="button"
                  role="radio"
                  aria-checked={ticket.status === c.status}
                  className={ticket.status === c.status ? 'active' : ''}
                  onClick={() => onMove(c.status)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </>
        )}

        <section className="drawer-agent" aria-label="Agent">
          <div className="drawer-agent-head">
            <h2>Agent Execution</h2>
            {run && (
              <div className="agent-run">
                <RunStatePill state={run.state} cancelled={run.cancelled} autoRetry={run.autoRetry} handedOffTo={run.handedOffTo} />
                <span className="badge badge-soft mono">{formatAgentDisplayName(run.agent)}</span>
                {run.branch && <span className="badge badge-soft mono">{run.branch}</span>}
                {run.terminalId && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setViewTab(viewTab === 'terminal' ? 'details' : 'terminal')}
                    >
                      {viewTab === 'terminal' ? 'Show spec' : 'Docked terminal'}
                    </button>
                    <Link id="drawer-terminal" href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost">
                      Open terminal →
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
          {run && <HandoffMenu run={run} />}
          {run && <AttemptChain run={run} />}
          {run && <RunFailureBanner run={run} />}
          {/* The Events tab shows these itself, next to the final answer. */}
          {run && viewTab !== 'events' && <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />}
          {queued && (
            <div className="agent-note">
              <span>Queued: starts as soon as a slot and quota are free.</span>
              <button
                id="drawer-cancel"
                className="btn btn-sm btn-ghost"
                disabled={!!busy}
                onClick={() => void runAction('stop')}
              >
                Cancel
              </button>
            </div>
          )}
          {run?.state === 'rate_limited' && (
            <div className="agent-note agent-note-limit">
              <span>
                {run.autoRetry
                  ? `A temporary provider error stopped the turn. ${formatAgentDisplayName(run.agent)} retries automatically at ${new Date(run.autoRetry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (attempt ${run.autoRetry.attempt} of ${run.autoRetry.max}).`
                  : `Paused by the usage limit. ${formatAgentDisplayName(run.agent)} continues automatically when the window resets.`}
              </span>
              <button
                id="drawer-resume"
                className="btn btn-sm"
                disabled={!!busy}
                onClick={() => void runAction('resume')}
              >
                Resume now
              </button>
            </div>
          )}
          {canFollowUp && (
            <div className="run-form drawer-form">
              <div className="template-bar" aria-label="Stage prompt templates">
                <span className="template-label mono">Stage:</span>
                {STAGE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="chip-btn"
                    title={tpl.hint}
                    onClick={() => setFollowUp(tpl.prompt)}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
              <textarea
                id="drawer-followup"
                className="input"
                rows={3}
                placeholder={
                  !live
                    ? formatAgentResumePlaceholder(run?.agent)
                    : run.state === 'waiting_input'
                      ? `${formatAgentDisplayName(run.agent)} is waiting for you…`
                      : `Follow-up for ${formatAgentDisplayName(run.agent)} (sent to the live session)`
                }
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && followUp.trim()) void send();
                }}
              />
              <div className="run-form-foot">
                <span className="muted small">
                  {live ? 'Permission prompts are answered in the terminal.' : 'Resumes the same branch and conversation.'}
                </span>
                <button
                  id="drawer-send"
                  className="btn btn-sm btn-primary"
                  disabled={!followUp.trim() || !!busy}
                  onClick={() => void send()}
                >
                  {busy === 'send' ? 'Sending…' : live ? 'Send' : 'Continue'}
                </button>
              </div>
            </div>
          )}
          {!live && (
            <div className="run-form drawer-form">
              <PermissionModePicker value={mode} onChange={setMode} />
              <p className="muted small">
                {modeHint(mode)}. Works on its own branch and worktree; queued if all slots are busy or the quota is
                exhausted.
              </p>
              <div className="run-form-foot">
                {ticket.blockedBy.length > 0 ? (
                  <span className="muted small" role={confirmStart ? 'alert' : undefined}>
                    {confirmStart ? 'Still waiting for ' : 'Waiting for '}
                    {ticket.blockedBy.map((b) => b.key).join(', ')}. Starting now skips the wait.
                  </span>
                ) : (
                  <span />
                )}
                <button
                  id="drawer-start"
                  className={`btn btn-sm ${run?.resumable && run.state !== 'failed' ? '' : 'btn-primary'}`}
                  disabled={!!busy || !title.trim()}
                  onClick={start}
                >
                  {busy === 'start'
                    ? 'Starting…'
                    : confirmStart && ticket.blockedBy.length > 0
                      ? 'Start anyway'
                      : run
                        ? 'Start new run'
                        : 'Start Agent Run'}
                </button>
              </div>
            </div>
          )}
        </section>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <footer className="drawer-foot">
          <button id="drawer-delete" className="btn btn-sm btn-ghost danger" disabled={!!busy} onClick={() => void remove()}>
            Delete
          </button>
          {ticket.status !== 'done' && (
            <button id="drawer-done" className="btn btn-sm" disabled={!!busy} onClick={() => onMove('done')}>
              Mark done ✓
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}
