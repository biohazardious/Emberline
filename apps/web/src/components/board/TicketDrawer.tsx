import type { AgentPersona, PermissionMode, Run, Ticket, TicketStatus } from '@emberline/protocol';
import { X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { ConflictHoldFallback } from '../../holdRecovery';
import { useQueryParam } from '../../hooks/navigation';
import {
  drawerFailure,
  drawerMergeStep,
  mergeStepRetired,
  type PendingMergeStep,
} from '../../reviewComments';
import type { SyncResolvingNotice } from '../../syncResolution';
import { timeAgo } from '../../time';
import { ErrorBoundary } from '../ErrorBoundary';
import { SyncResolutionBanner } from '../HoldRecovery';
import { PersonaBadge } from '../PersonaBadge';
import { RunEventTimeline, RunFailureBanner } from '../RunInspector';
import { RunStatePill } from '../RunStatePill';
import { ico } from '../SectionState';
import { DRAWER_VIEWS, type DrawerCtx, type DrawerView } from './boardMeta';
import { DrawerAgentSection } from './DrawerAgentSection';
import { DrawerDetailsSection } from './DrawerDetailsSection';

const TerminalView = lazy(() => import('../TerminalView').then((m) => ({ default: m.TerminalView })));
const ReviewView = lazy(() => import('../ReviewView').then((m) => ({ default: m.ReviewView })));

export function TicketDrawer({
  ticket,
  allTickets,
  run,
  resolvingNotice,
  onDismissResolving,
  conflictFallback,
  onClose,
  onChanged,
  armStart,
  onMove,
  onDiscard,
  onAccept,
}: {
  ticket: Ticket;
  allTickets: Ticket[];
  run: Run | undefined;
  resolvingNotice?: SyncResolvingNotice | null;
  onDismissResolving?: () => void;
  conflictFallback?: ConflictHoldFallback | null;
  onClose: () => void;
  onChanged: (ticket: Ticket) => void;
  /** Changes (non-zero) when a drop asks this drawer to confirm starting a blocked ticket. */
  armStart: number;
  onMove: (status: TicketStatus) => void;
  /** Moves the ticket to Done without merging its branch. */
  onDiscard: () => Promise<void>;
  /**
   * Accepts the ticket: merges its run's branch into main, then moves it to Done (dependents start).
   * `force`: merge past open blocking comments (Merge anyway).
   */
  onAccept: (opts?: { force?: boolean }) => Promise<void>;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [priority, setPriority] = useState(ticket.priority);
  const [persona, setPersona] = useState<AgentPersona>(ticket.persona ?? 'coder');
  const [mode, setMode] = useState<PermissionMode>(armStart > 0 ? 'auto' : 'default');
  const [followUp, setFollowUp] = useState('');
  const defaultView: DrawerView = ticket.status === 'review' && run?.worktreePath ? 'review' : 'details';
  const [viewParam, setViewParam] = useQueryParam('view');
  const viewTab: DrawerView = DRAWER_VIEWS.includes(viewParam as DrawerView)
    ? (viewParam as DrawerView)
    : defaultView;
  const setViewTab = (view: DrawerView) => setViewParam(view === defaultView ? null : view);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [mergeNext, setMergeNext] = useState<PendingMergeStep | null>(null);

  useEffect(() => {
    if (!mergeStepRetired(mergeNext, ticket.status)) return;
    setMergeNext(null);
    setError(undefined);
  }, [mergeNext, ticket.status]);

  const markDone = async (opts?: { force?: boolean }) => {
    setBusy('done');
    setError(undefined);
    setMergeNext(null);
    try {
      await onAccept(opts);
    } catch (e) {
      const failure = drawerFailure(e);
      setError(failure.text);
      setMergeNext(failure.next ? { next: failure.next, status: ticket.status } : null);
    } finally {
      setBusy(undefined);
    }
  };
  const mergeStep = drawerMergeStep(mergeNext, ticket.status, error);

  const [confirmStart, setConfirmStart] = useState(armStart > 0);
  useEffect(() => {
    if (armStart > 0) {
      setConfirmStart(true);
      setMode('auto');
    }
  }, [armStart]);

  const blockerKey = ticket.blockedBy.map((b) => b.id).join(',');
  const seenBlockers = useRef(blockerKey);
  useEffect(() => {
    if (seenBlockers.current === blockerKey) return;
    seenBlockers.current = blockerKey;
    setConfirmStart(false);
  }, [blockerKey]);

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
    setMergeNext(null);
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

  const start = () => {
    if (ticket.blockedBy.length > 0 && !confirmStart) {
      setConfirmStart(true);
      return;
    }
    setConfirmStart(false);
    void act('start', async () => {
      if (dirty) await api<Ticket>(`/api/tickets/${ticket.id}`, 'PATCH', { title, body, priority, persona });
      const res = await api<{ ticket: Ticket; run: Run }>(`/api/tickets/${ticket.id}/start`, 'POST', {
        permissionMode: mode,
        persona,
      });
      onChanged(res.ticket);
    });
  };

  const send = () =>
    act('send', async () => {
      const res = await api<{ ticket: Ticket; run: Run }>(`/api/tickets/${ticket.id}/prompt`, 'POST', {
        text: followUp,
      });
      setFollowUp('');
      onChanged(res.ticket);
    });

  const runLive =
    run !== undefined &&
    (run.state === 'rate_limited' ||
      (run.endedAt === null && run.state !== 'done' && run.state !== 'failed'));
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

  const ctx: DrawerCtx = {
    t: ticket,
    all: allTickets,
    run,
    conflictFallback: conflictFallback ?? null,
    title,
    setTitle,
    body,
    setBody,
    prio: priority,
    setPrio: setPriority,
    persona,
    setPersona,
    mode,
    setMode,
    follow: followUp,
    setFollow: setFollowUp,
    view: viewTab,
    setView: setViewTab,
    dirty,
    busy,
    setBusy,
    confirm: confirmStart,
    save,
    start,
    send,
    runAct: runAction,
    changed: onChanged,
    move: onMove,
    discard: onDiscard,
    accept: onAccept,
  };

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
          {run && (
            <RunStatePill
              state={run.state}
              cancelled={run.cancelled}
              autoRetry={run.autoRetry}
              handedOffTo={run.handedOffTo}
            />
          )}
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
                Spec &amp; Agent
              </button>
              {run.worktreePath && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewTab === 'review'}
                  className={viewTab === 'review' ? 'active' : ''}
                  onClick={() => setViewTab('review')}
                >
                  Review &amp; Diff
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
            {ico(X)}
          </button>
        </header>

        {viewTab === 'review' && run && (
          <div className="drawer-review-pane">
            <ErrorBoundary resetKey={`${run.id}:review`} compact>
              <Suspense
                fallback={
                  <div className="empty" aria-busy="true">
                    Loading diff &amp; review…
                  </div>
                }
              >
                <ReviewView run={run} />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}

        {viewTab === 'terminal' && run?.terminalId && (
          <div className="drawer-terminal-pane">
            <ErrorBoundary resetKey={`${run.terminalId}:terminal`} compact>
              <Suspense fallback={<div className="term-shell term-shell-compact" aria-busy="true" />}>
                <TerminalView key={run.terminalId} terminalId={run.terminalId} compact />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}

        {viewTab === 'events' && run && (
          <div className="drawer-events-pane">
            <RunFailureBanner run={run} />
            <RunEventTimeline run={run} />
          </div>
        )}

        {viewTab === 'details' && <DrawerDetailsSection ctx={ctx} />}

        <DrawerAgentSection ctx={ctx} />

        {resolvingNotice && <SyncResolutionBanner notice={resolvingNotice} onDismiss={onDismissResolving} />}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {mergeStep && (
          <div className="actions">
            {mergeStep === 'merge_anyway' ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!!busy}
                onClick={() => void markDone({ force: true })}
              >
                Merge anyway
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!!busy}
                onClick={() => void act('done', onDiscard)}
              >
                Move to Done without merging
              </button>
            )}
          </div>
        )}

        <footer className="drawer-foot">
          <button
            id="drawer-delete"
            className="btn btn-sm btn-ghost danger"
            disabled={!!busy || runLive}
            title={runLive ? 'An agent is still working on this ticket: stop its run first' : undefined}
            onClick={() => void remove()}
          >
            Delete
          </button>
          {ticket.status !== 'done' && (
            <button id="drawer-done" className="btn btn-sm" disabled={!!busy} onClick={() => void markDone()}>
              Mark done ✓
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}
