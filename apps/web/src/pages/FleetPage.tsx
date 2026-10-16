import type { GarbageCollectRunsResponse, Project, Run, RunDetail } from '@emberline/protocol';
import {
  Check,
  Circle,
  Eraser,
  EyeOff,
  Hourglass,
  Maximize2,
  Package,
  RotateCw,
  Square,
  Trash,
  TriangleAlert,
  X,
} from 'lucide-react';
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { HandoffMenu } from '../components/QuotaLanes';
import { PersonaBadge } from '../components/PersonaBadge';
import { QuotaPanel } from '../components/QuotaPanel';
import { STAGE_TEMPLATES } from '../components/RunInspector';
import { BuildOutputsList, FinalAnswer, LastScreen } from '../components/RunOutcome';
import { RunStatePill } from '../components/RunStatePill';
import { useApi } from '../hooks/useApi';
import { useRuns } from '../hooks/liveData';
import { useInView } from '../hooks/useInView';
import { toastError, toastInfo } from '../toast';
import { timeAgo } from '../time';

const TerminalView = lazy(() => import('../components/TerminalView').then((m) => ({ default: m.TerminalView })));

type FleetFilter = 'active' | 'attention' | 'queued' | 'completed' | 'all';
type GridLayout = 'grid' | 'cols' | 'single';

function isRunCompleted(r: Run): boolean {
  return Boolean(r.endedAt) || r.state === 'done' || r.state === 'failed';
}

/** A finished run stays in the Active view this long, so its last answer can still be read. */
const FINISHED_GRACE_MS = 15 * 60_000;
const DISMISSED_KEY = 'emberline.fleet.dismissed';

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function finishedAt(r: Run): number {
  return Date.parse(r.endedAt ?? r.stateChangedAt);
}

/** The agent's final answer, last screen and build outputs, for a pane whose session finished. */
function FinishedOutcome({ run }: { run: Run }) {
  const detail = useApi<RunDetail>(`/api/runs/${run.id}`, 10_000);
  return (
    <div className="fleet-outcome">
      {detail.data?.finalMessage && <FinalAnswer text={detail.data.finalMessage} />}
      <BuildOutputsList runId={run.id} refreshKey={run.stateChangedAt} />
      {detail.data?.lastScreen && !run.terminalId && <LastScreen text={detail.data.lastScreen} />}
    </div>
  );
}

export function FleetPage({
  activeProjectId,
  onInspectRun,
}: {
  activeProjectId?: string | null;
  onInspectRun: (runId: string) => void;
}) {
  const { runs } = useRuns();
  const projects = useApi<Project[]>('/api/projects', 15_000);
  const [filter, setFilter] = useState<FleetFilter>('active');
  const [layout, setLayout] = useState<GridLayout>('grid');
  /** live: xterm on panes in view, text thumbnails elsewhere · thumbnails: text everywhere (cheap with many agents). */
  const [view, setView] = useState<'live' | 'thumbnails'>('live');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkPrompt, setBulkPrompt] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [gcBusy, setGcBusy] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const recentlyFinished = useCallback(
    (r: Run) => isRunCompleted(r) && !dismissed.has(r.id) && now - finishedAt(r) < FINISHED_GRACE_MS,
    [dismissed, now],
  );
  const dismiss = (id: string) =>
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-200)));
      } catch {
        // Storage unavailable: the pane is hidden for this visit only.
      }
      return next;
    });

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  const scopedRuns = useMemo(
    () => (runs ?? []).filter((r) => !activeProjectId || r.projectId === activeProjectId),
    [runs, activeProjectId],
  );

  const counts = useMemo(() => {
    const all = scopedRuns;
    const completed = all.filter((r) => isRunCompleted(r)).length;
    const active = all.filter((r) => !isRunCompleted(r) || recentlyFinished(r)).length;
    return {
      active,
      attention: all.filter((r) => r.state === 'waiting_input' || r.state === 'rate_limited' || r.state === 'failed')
        .length,
      queued: all.filter((r) => r.state === 'queued' && !isRunCompleted(r)).length,
      completed,
      total: all.length,
    };
  }, [scopedRuns, recentlyFinished]);

  const visibleRuns = useMemo(() => {
    switch (filter) {
      case 'active':
        return scopedRuns.filter((r) => !isRunCompleted(r) || recentlyFinished(r));
      case 'attention':
        return scopedRuns.filter(
          (r) => r.state === 'waiting_input' || r.state === 'rate_limited' || r.state === 'failed',
        );
      case 'queued':
        return scopedRuns.filter((r) => r.state === 'queued' && !isRunCompleted(r));
      case 'completed':
        return scopedRuns.filter((r) => isRunCompleted(r));
      case 'all':
        return scopedRuns;
    }
  }, [scopedRuns, filter, recentlyFinished]);

  const selectableIds = new Set(visibleRuns.filter((r) => !isRunCompleted(r) && r.state !== 'queued').map((r) => r.id));
  const selectedIds = [...selected].filter((id) => selectableIds.has(id));
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Sends the same follow-up to every selected live run; failures are reported per run. */
  const sendBulkPrompt = async (e: FormEvent) => {
    e.preventDefault();
    const text = bulkPrompt.trim();
    if (!text || selectedIds.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      selectedIds.map((id) => api(`/api/runs/${id}/prompt`, 'POST', { text })),
    );
    setBulkBusy(false);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      toastError(
        `Prompt failed for ${failed.length} of ${results.length} run(s): ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`,
      );
    } else {
      toastInfo(`Prompt sent to ${results.length} run(s).`);
      setBulkPrompt('');
      setSelected(new Set());
    }
  };

  const handleGarbageCollect = async (keepRecent = 0) => {
    setGcBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api<GarbageCollectRunsResponse>('/api/runs/gc', 'POST', {
        projectId: activeProjectId ?? undefined,
        keepRecent,
        includeFailed: true,
        pruneWorktrees: true,
      });
      setNotice(
        `Garbage collection complete: removed ${res.removedRuns} finished session${res.removedRuns === 1 ? '' : 's'}, closed ${res.closedSessions} lingering terminal${res.closedSessions === 1 ? '' : 's'}, and pruned ${res.prunedWorktrees} git worktree${res.prunedWorktrees === 1 ? '' : 's'}.`,
      );
      if (res.keptWorktrees.length > 0) {
        const count = (reason: string) => res.keptWorktrees.filter((k) => k.reason === reason).length;
        const parts = [
          [count('uncommitted_changes'), 'uncommitted changes'],
          [count('unmerged_commits'), 'commits not merged into the default branch'],
          [count('in_review'), 'a ticket still in review'],
        ]
          .filter(([n]) => n)
          .map(([n, why]) => `${n} with ${why}`);
        setNotice(
          (prev) =>
            `${prev ?? ''} Kept ${res.keptWorktrees.length} worktree${res.keptWorktrees.length === 1 ? '' : 's'} so no work is lost: ${parts.join(', ')}.`,
        );
      }
      if (filter === 'completed' && res.removedRuns > 0 && keepRecent === 0) {
        setFilter('active');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGcBusy(false);
    }
  };

  const handleStopAllActive = async () => {
    const activeList = scopedRuns.filter((r) => !isRunCompleted(r));
    if (activeList.length === 0) return;
    setStoppingAll(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await Promise.allSettled(activeList.map((r) => api(`/api/runs/${r.id}/stop`, 'POST')));
      setNotice(`Stopped ${activeList.length} active session${activeList.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStoppingAll(false);
    }
  };

  return (
    <div className="fleet-page">
      <header className="workspace-bar">
        <div className="workspace-bar-title">
          <h1>Fleet Multiplexer</h1>
          <span className="muted small">
            Supervise live agent sessions · Auto-GC closes finished terminals &amp; retains recent history
          </span>
        </div>
        <div className="workspace-bar-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          {counts.active > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              disabled={stoppingAll}
              onClick={() => void handleStopAllActive()}
              title="Stop all currently running or queued sessions in this project"
            >
              {stoppingAll ? (
                'Stopping…'
              ) : (
                <>
                  <Square className="icon" aria-hidden /> Stop All Active ({counts.active})
                </>
              )}
            </button>
          )}

          {counts.completed > 0 && (
            <button
              id="fleet-gc-btn"
              type="button"
              className="btn btn-sm"
              disabled={gcBusy}
              onClick={() => void handleGarbageCollect(0)}
              style={{
                borderColor: 'color-mix(in hsl, var(--ember-1) 45%, var(--border))',
              }}
              title="Purge all finished/failed sessions, dispose exited PTY terminals, and prune their temporary git worktrees"
            >
              {gcBusy ? (
                <>
                  <Eraser className="icon" aria-hidden /> Cleaning…
                </>
              ) : (
                <>
                  <Eraser className="icon" aria-hidden /> Clean Up Finished ({counts.completed})
                </>
              )}
            </button>
          )}

          <div className="segmented" role="tablist" aria-label="Fleet filter">
            <button
              id="fleet-filter-active"
              type="button"
              role="tab"
              aria-selected={filter === 'active'}
              className={filter === 'active' ? 'active' : ''}
              onClick={() => setFilter('active')}
              title="Only live running, waiting, or queued sessions"
            >
              <Circle className="icon" aria-hidden fill="currentColor" style={{ color: 'var(--ok)' }} /> Live ({counts.active})
            </button>
            <button
              id="fleet-filter-attention"
              type="button"
              role="tab"
              aria-selected={filter === 'attention'}
              className={filter === 'attention' ? 'active' : ''}
              onClick={() => setFilter('attention')}
            >
              <TriangleAlert className="icon" aria-hidden /> Attention ({counts.attention})
            </button>
            <button
              id="fleet-filter-queued"
              type="button"
              role="tab"
              aria-selected={filter === 'queued'}
              className={filter === 'queued' ? 'active' : ''}
              onClick={() => setFilter('queued')}
            >
              Queued ({counts.queued})
            </button>
            <button
              id="fleet-filter-completed"
              type="button"
              role="tab"
              aria-selected={filter === 'completed'}
              className={filter === 'completed' ? 'active' : ''}
              onClick={() => setFilter('completed')}
              title="Archived completed & failed runs"
            >
              <Package className="icon" aria-hidden /> History ({counts.completed})
            </button>
            <button
              id="fleet-filter-all"
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={filter === 'all' ? 'active' : ''}
              onClick={() => setFilter('all')}
            >
              All ({counts.total})
            </button>
          </div>

          <div className="segmented hide-sm" role="radiogroup" aria-label="Grid layout">
            <button
              type="button"
              role="radio"
              aria-checked={layout === 'grid'}
              className={layout === 'grid' ? 'active' : ''}
              onClick={() => setLayout('grid')}
              title="2×2 grid"
            >
              2×2
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={layout === 'cols'}
              className={layout === 'cols' ? 'active' : ''}
              onClick={() => setLayout('cols')}
              title="Side-by-side columns"
            >
              2×1
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={layout === 'single'}
              className={layout === 'single' ? 'active' : ''}
              onClick={() => setLayout('single')}
              title="Single stacked column"
            >
              1×1
            </button>
          </div>

          <div className="segmented hide-sm" role="radiogroup" aria-label="Pane content">
            <button
              type="button"
              role="radio"
              aria-checked={view === 'live'}
              className={view === 'live' ? 'active' : ''}
              onClick={() => setView('live')}
              title="Live terminals for panes in view, text thumbnails elsewhere"
            >
              Live
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'thumbnails'}
              className={view === 'thumbnails' ? 'active' : ''}
              onClick={() => setView('thumbnails')}
              title="Text thumbnails only: cheapest view for many agents"
            >
              Thumbnails
            </button>
          </div>
        </div>
      </header>

      {selectedIds.length > 0 && (
        <form className="fleet-bulk-bar" onSubmit={(e) => void sendBulkPrompt(e)}>
          <span className="mono">{selectedIds.length} selected</span>
          <input
            type="text"
            className="input"
            value={bulkPrompt}
            onChange={(e) => setBulkPrompt(e.target.value)}
            placeholder="Prompt to send to every selected agent…"
            aria-label="Prompt for the selected agents"
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={bulkBusy || !bulkPrompt.trim()}>
            {bulkBusy ? 'Sending…' : 'Send to selected'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </form>
      )}

      <QuotaPanel compact />

      {notice && (
        <div
          className="banner"
          style={{
            background: 'color-mix(in srgb, var(--ok) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--ok) 40%, transparent)',
            color: 'var(--ok)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span>{notice}</span>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            aria-label="Close"
            onClick={() => setNotice(undefined)}
          >
            <X className="icon" aria-hidden />
          </button>
        </div>
      )}

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {visibleRuns.length === 0 ? (
        <div className="empty fleet-empty">
          <p>
            {filter === 'active' && counts.completed > 0
              ? `No live agent sessions running right now (${counts.completed} finished session${counts.completed === 1 ? '' : 's'} archived in History).`
              : 'No agent sessions match the selected filter.'}
          </p>
          <p
            className="muted small"
            style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}
          >
            <span>
              Start a ticket from a project board or launch a run from the{' '}
              <Link href="/">Factory Overview</Link>.
            </span>
            {filter === 'active' && counts.completed > 0 && (
              <>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter('completed')}>
                  <Package className="icon" aria-hidden /> View History ({counts.completed})
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={gcBusy}
                  onClick={() => void handleGarbageCollect(0)}
                >
                  <Eraser className="icon" aria-hidden /> Clean Up Finished ({counts.completed})
                </button>
              </>
            )}
          </p>
        </div>
      ) : (
        <div className={`fleet-grid fleet-grid-${layout}`}>
          {visibleRuns.map((run) => (
            <FleetPane
              key={run.id}
              run={run}
              view={view}
              selectable={selectableIds.has(run.id)}
              selected={selected.has(run.id)}
              onToggleSelected={() => toggleSelected(run.id)}
              project={projectById.get(run.projectId)}
              onInspect={() => onInspectRun(run.id)}
              onError={setError}
              onDismiss={filter === 'active' && isRunCompleted(run) ? () => dismiss(run.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Plain-text screen of a run, polled while shown; far cheaper than an attached xterm. */
function TerminalThumbnail({ runId }: { runId: string }) {
  const screen = useApi<{ text: string | null }>(`/api/runs/${runId}/screen-text?lines=18`, 4_000);
  return (
    <pre className="fleet-thumbnail mono" aria-label="Terminal snapshot">
      {screen.data?.text ?? (screen.loading ? 'Loading snapshot…' : 'No terminal output yet.')}
    </pre>
  );
}

function FleetPane({
  run,
  view,
  selectable,
  selected,
  onToggleSelected,
  project,
  onInspect,
  onError,
  onDismiss,
}: {
  run: Run;
  view: 'live' | 'thumbnails';
  selectable: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  project: Project | undefined;
  onInspect: () => void;
  onError: (msg: string | undefined) => void;
  /** Hides a recently finished run from the Active view. */
  onDismiss?: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string>();
  const [showReopenBar, setShowReopenBar] = useState(false);

  const completed = isRunCompleted(run);
  const live = !completed;
  const paneRef = useRef<HTMLElement>(null);
  const inView = useInView(paneRef, '100px');
  const attachTerminal = view === 'live' && inView;
  const showPromptFooter = (live && run.state !== 'queued') || (completed && showReopenBar && run.resumable);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    onError(undefined);
    try {
      await fn();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const submitPrompt = (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    void act('send', async () => {
      await api(`/api/runs/${run.id}/prompt`, 'POST', { text: prompt });
      setPrompt('');
      setShowReopenBar(false);
    });
  };

  return (
    <article ref={paneRef} id={`fleet-pane-${run.id}`} className={`fleet-pane fleet-pane-${run.state}`}>
      <header className="fleet-pane-head">
        {selectable && (
          <input
            type="checkbox"
            className="fleet-select"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Select ${run.title ?? 'run'} for a bulk prompt`}
          />
        )}
        <RunStatePill state={run.state} cancelled={run.cancelled} autoRetry={run.autoRetry} handedOffTo={run.handedOffTo} />
        <PersonaBadge persona={run.persona} />
        <button type="button" className="fleet-pane-title" onClick={onInspect} title="Open run inspector & timeline">
          {run.title ?? project?.name ?? 'Agent Run'}
        </button>
        {project && run.title && (
          <Link href={`/projects/${project.id}/board`} className="badge mono">
            {project.name}
          </Link>
        )}
        {run.branch && <span className="badge badge-soft mono hide-sm">{run.branch}</span>}
        <span className="fleet-pane-meta mono">
          {run.lastEvent ? `${run.lastEvent} · ` : ''}
          {timeAgo(run.stateChangedAt)}
        </span>
        <div className="fleet-pane-actions">
          {run.worktreePath && (
            <Link href={`/runs/${run.id}/review`} className="btn btn-sm btn-ghost" title="Inspect git diff & review">
              Review
            </Link>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onInspect} title="Inspect events & details">
            Timeline
          </button>
          {run.state === 'rate_limited' && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() => void act('resume', () => api(`/api/runs/${run.id}/resume`, 'POST', {}))}
            >
              Resume
            </button>
          )}
          {completed && run.resumable && (
            <button
              type="button"
              className={`btn btn-sm ${showReopenBar ? 'btn-primary' : 'btn-ghost'}`}
              disabled={!!busy}
              onClick={() => setShowReopenBar((v) => !v)}
              title="Re-open this finished session with a follow-up prompt"
            >
              <RotateCw className="icon" aria-hidden /> Re-open
            </button>
          )}
          {live && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              disabled={!!busy}
              onClick={() => void act('stop', () => api(`/api/runs/${run.id}/stop`, 'POST'))}
            >
              {run.state === 'queued' ? 'Cancel' : 'Stop'}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onDismiss}
              title="Hide this finished run from the Active view (it stays under Completed)"
            >
              <EyeOff className="icon" aria-hidden />
            </button>
          )}
          {completed && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              disabled={!!busy}
              onClick={() => void act('remove', () => api(`/api/runs/${run.id}`, 'DELETE'))}
              title="Remove this finished session from history"
            >
              <Trash className="icon" aria-hidden />
            </button>
          )}
          {live && run.terminalId && (
            <Link href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost" title="Full-screen terminal">
              <Maximize2 className="icon" aria-hidden />
            </Link>
          )}
        </div>
      </header>
      <HandoffMenu run={run} />

      <div className="fleet-pane-body">
        {live && run.terminalId && attachTerminal ? (
          <Suspense fallback={<div className="term-shell term-shell-compact" aria-busy="true" />}>
            <TerminalView key={run.terminalId} terminalId={run.terminalId} compact autoFocus={false} />
          </Suspense>
        ) : live && run.terminalId ? (
          <TerminalThumbnail runId={run.id} />
        ) : (
          <div className="fleet-placeholder" style={{ padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <span
                className="badge mono"
                style={{
                  borderColor: placeholderTone(run).border,
                  color: placeholderTone(run).text,
                }}
              >
                {run.state === 'queued' ? (
                  <>
                    <Hourglass className="icon" aria-hidden /> Queued in Scheduler
                  </>
                ) : run.state === 'done' ? (
                  <>
                    <Check className="icon" aria-hidden /> {run.handedOffTo ? 'Handed off to another route' : 'Completed & Terminal Closed'}
                  </>
                ) : (
                  <>
                    <X className="icon" aria-hidden /> Session Ended / Failed
                  </>
                )}
              </span>
              <span className="muted small mono">
                Provider: <strong>{run.agent}</strong>
              </span>
              {run.endedAt && (
                <span className="muted small mono">Ended {timeAgo(run.endedAt)}</span>
              )}
            </div>
            <p className="mono" style={{ margin: '0 0 8px', fontSize: '0.82rem' }}>
              {run.state === 'queued'
                ? 'Waiting in scheduler queue for an execution slot…'
                : run.state === 'done' && run.handedOffTo
                  ? (
                    <>
                      Handed off: run{' '}
                      <Link href={`/runs/${run.handedOffTo}/review`}>{run.handedOffTo.slice(0, 8)}</Link> continues this work in the same worktree. Click Timeline to
                      follow it, or <Trash className="icon" aria-hidden /> to remove.
                    </>
                  )
                : run.state === 'done'
                  ? (
                    <>
                      Task finished and changes synced. Click Review to inspect git changes,{' '}
                      <RotateCw className="icon" aria-hidden /> Re-open to send a follow-up prompt, or{' '}
                      <Trash className="icon" aria-hidden /> to remove.
                    </>
                  ) : (
                    <>
                      Session stopped or exited with an error. Click Timeline to inspect events or{' '}
                      <Trash className="icon" aria-hidden /> to remove.
                    </>
                  )}
            </p>
            {run.prompt && (
              <p className="muted small mono" style={{ margin: 0, opacity: 0.8 }}>
                {run.prompt.slice(0, 260)}
                {run.prompt.length > 260 ? '…' : ''}
              </p>
            )}
            {completed && <FinishedOutcome run={run} />}
          </div>
        )}
      </div>

      {showPromptFooter && (
        <form className="fleet-pane-foot" onSubmit={submitPrompt}>
          <div className="fleet-templates hide-sm">
            {STAGE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className="chip-btn"
                title={tpl.hint}
                onClick={() => setPrompt(tpl.prompt)}
              >
                {tpl.label}
              </button>
            ))}
          </div>
          <input
            className="input fleet-input"
            placeholder={
              run.state === 'waiting_input'
                ? 'Agent is waiting for input — reply here…'
                : completed
                  ? 'Enter follow-up prompt to re-open this session…'
                  : 'Steer this agent…'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!prompt.trim() || !!busy}>
            {busy === 'send' ? '…' : live ? 'Send' : 'Re-open'}
          </button>
        </form>
      )}
    </article>
  );
}

/** Badge colours of a run's placeholder card: handed-off runs read as info, distinct from muted. */
function placeholderTone(run: Run): { border: string; text: string } {
  if (run.state === 'done' && run.handedOffTo) return { border: 'var(--border)', text: 'var(--info)' };
  if (run.state === 'done') return { border: 'color-mix(in srgb, var(--ok) 45%, transparent)', text: 'var(--ok)' };
  if (run.state === 'failed') return { border: 'color-mix(in srgb, var(--bad) 45%, transparent)', text: 'var(--bad)' };
  return { border: 'var(--border)', text: 'var(--muted)' };
}
