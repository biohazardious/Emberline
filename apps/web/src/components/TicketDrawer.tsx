import type { AgentPersona, PermissionMode, Run, Ticket, TicketStatus } from '@emberline/protocol';
import { X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { useQueryParam } from '../hooks/navigation';
import { drawerFailure, drawerMergeStep, mergeStepRetired, type PendingMergeStep } from '../reviewComments';
import { dependencyCandidates } from '../ticketDeps';
import { timeAgo } from '../time';
import { BOARD_COLUMNS, BOARD_PRIORITIES, IssueChips } from './BoardCard';
import { DrawerAgentSection } from './DrawerAgentSection';
import { ErrorBoundary } from './ErrorBoundary';
import { PersonaBadge, PersonaPicker, TaskTemplateBar } from './PersonaBadge';
import { RunEventTimeline, RunFailureBanner } from './RunInspector';
import { RunStatePill } from './RunStatePill';

const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));
const ReviewView = lazy(() => import('./ReviewView').then((m) => ({ default: m.ReviewView })));

const DRAWER_VIEWS = ['details', 'review', 'terminal', 'events'] as const;
type DrawerView = (typeof DRAWER_VIEWS)[number];

export function TicketDrawer({
  ticket,
  allTickets,
  run,
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
  const [depError, setDepError] = useState<string>();
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
            <ErrorBoundary resetKey={`${run.id}:review`} compact>
              <Suspense
                fallback={
                  <div className="empty" aria-busy="true">
                    Loading diff & review…
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
                    <span
                      className="badge mono"
                      style={{ marginLeft: 8, borderColor: 'var(--warn)', color: 'var(--warn)' }}
                    >
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
                  <Link href={`/runs/${ticket.completion.runId}/review`}>
                    run {ticket.completion.runId.slice(0, 8)}
                  </Link>
                  {' · '}
                  {timeAgo(ticket.completion.at)}
                </div>
              </section>
            )}
            <label className="drawer-label">Specialist Persona</label>
            <PersonaPicker value={persona} onChange={setPersona} />
            <div className="drawer-row">
              <div className="segmented" role="radiogroup" aria-label="Priority">
                {BOARD_PRIORITIES.map((label, value) => (
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
              <button
                id="drawer-save"
                className="btn btn-sm"
                disabled={!dirty || !!busy || !title.trim()}
                onClick={() => void save()}
              >
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
                          <Link
                            href={`/projects/${ticket.projectId}/board?ticket=${dep.id}`}
                            className="mono dep-key"
                          >
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
                <option value="">
                  {candidates.length === 0 ? 'No tickets to add' : 'Add a dependency…'}
                </option>
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
            <div
              id="drawer-status"
              className="segmented segmented-wrap"
              role="radiogroup"
              aria-label="Column"
            >
              {BOARD_COLUMNS.map((c) => (
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

        <DrawerAgentSection
          ticket={ticket}
          run={run}
          title={title}
          busy={busy}
          mode={mode}
          onModeChange={setMode}
          followUp={followUp}
          onFollowUpChange={setFollowUp}
          confirmStart={confirmStart}
          showOutputs={viewTab !== 'events'}
          showingTerminal={viewTab === 'terminal'}
          onToggleTerminal={() => setViewTab(viewTab === 'terminal' ? 'details' : 'terminal')}
          onStart={start}
          onSend={send}
          onRunAction={runAction}
          onDiscard={onDiscard}
          onAccept={onAccept}
        />

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
            disabled={!!busy}
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
