import type { Project, Run } from '@emberline/protocol';
import { type FormEvent, lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { PersonaBadge } from '../components/PersonaBadge';
import { QuotaPanel } from '../components/QuotaPanel';
import { STAGE_TEMPLATES } from '../components/RunInspector';
import { RunStatePill } from '../components/RunStatePill';
import { usePoll } from '../hooks/usePoll';
import { useRuns } from '../hooks/useRuns';
import { timeAgo } from '../time';

const TerminalView = lazy(() => import('../components/TerminalView').then((m) => ({ default: m.TerminalView })));

type FleetFilter = 'all' | 'active' | 'attention' | 'queued' | 'completed';
type GridLayout = 'grid' | 'cols' | 'single';

const HIDE_COMPLETED_STORAGE_KEY = 'emberline.fleet.hideCompleted';

function isRunCompleted(r: Run): boolean {
  return Boolean(r.endedAt) || r.state === 'done' || r.state === 'failed';
}

export function FleetPage({
  activeProjectId,
  onInspectRun,
}: {
  activeProjectId?: string | null;
  onInspectRun: (runId: string) => void;
}) {
  const { runs } = useRuns();
  const projects = usePoll(() => api<Project[]>('/api/projects'), 15_000);
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [hideCompleted, setHideCompleted] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(HIDE_COMPLETED_STORAGE_KEY);
      if (saved === 'false') return false;
      if (saved === 'true') return true;
    } catch {
      // ignore storage errors
    }
    return true;
  });
  const [layout, setLayout] = useState<GridLayout>('grid');
  const [error, setError] = useState<string>();

  const toggleHideCompleted = () => {
    setHideCompleted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HIDE_COMPLETED_STORAGE_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  const scopedRuns = useMemo(
    () => (runs ?? []).filter((r) => !activeProjectId || r.projectId === activeProjectId),
    [runs, activeProjectId],
  );

  const counts = useMemo(() => {
    const all = scopedRuns;
    const completed = all.filter((r) => isRunCompleted(r)).length;
    const nonCompleted = all.length - completed;
    return {
      active: all.filter((r) => !isRunCompleted(r) && r.state !== 'queued').length,
      attention: all.filter((r) => r.state === 'waiting_input' || r.state === 'rate_limited' || r.state === 'failed')
        .length,
      queued: all.filter((r) => r.state === 'queued').length,
      completed,
      all: hideCompleted ? nonCompleted : all.length,
      total: all.length,
    };
  }, [scopedRuns, hideCompleted]);

  const visibleRuns = useMemo(() => {
    let list = scopedRuns;
    if (hideCompleted && filter !== 'completed') {
      list = list.filter((r) => !isRunCompleted(r));
    }
    switch (filter) {
      case 'active':
        return list.filter((r) => !isRunCompleted(r) && r.state !== 'queued');
      case 'attention':
        return list.filter((r) => r.state === 'waiting_input' || r.state === 'rate_limited' || r.state === 'failed');
      case 'queued':
        return list.filter((r) => r.state === 'queued');
      case 'completed':
        return scopedRuns.filter((r) => isRunCompleted(r));
      case 'all':
        return list;
    }
  }, [scopedRuns, filter, hideCompleted]);

  return (
    <div className="fleet-page">
      <header className="workspace-bar">
        <div className="workspace-bar-title">
          <h1>Fleet Multiplexer</h1>
          <span className="muted small">
            Supervise and steer parallel agent sessions side-by-side
          </span>
        </div>
        <div className="workspace-bar-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              borderRadius: 'var(--radius-sm)',
              background: hideCompleted
                ? 'color-mix(in hsl, var(--ember-1) 14%, var(--surface))'
                : 'var(--surface)',
              border: hideCompleted
                ? '1px solid color-mix(in hsl, var(--ember-1) 45%, var(--border))'
                : '1px solid var(--border)',
              fontSize: '0.78rem',
              fontWeight: 500,
              cursor: 'pointer',
              userSelect: 'none',
            }}
            title="Hide finished or exited runs so only live and queued sessions appear in the multiplexer"
          >
            <input
              id="fleet-hide-completed"
              type="checkbox"
              checked={hideCompleted}
              onChange={toggleHideCompleted}
              style={{ margin: 0 }}
            />
            <span>Hide Completed ({counts.completed})</span>
          </label>

          <div className="segmented" role="tablist" aria-label="Fleet filter">
            <button
              id="fleet-filter-all"
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={filter === 'all' ? 'active' : ''}
              onClick={() => setFilter('all')}
            >
              All ({counts.all})
            </button>
            <button
              id="fleet-filter-active"
              type="button"
              role="tab"
              aria-selected={filter === 'active'}
              className={filter === 'active' ? 'active' : ''}
              onClick={() => setFilter('active')}
            >
              Active ({counts.active})
            </button>
            <button
              id="fleet-filter-attention"
              type="button"
              role="tab"
              aria-selected={filter === 'attention'}
              className={filter === 'attention' ? 'active' : ''}
              onClick={() => setFilter('attention')}
            >
              Needs Attention ({counts.attention})
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
            {!hideCompleted && (
              <button
                id="fleet-filter-completed"
                type="button"
                role="tab"
                aria-selected={filter === 'completed'}
                className={filter === 'completed' ? 'active' : ''}
                onClick={() => setFilter('completed')}
              >
                Completed ({counts.completed})
              </button>
            )}
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
        </div>
      </header>

      <QuotaPanel compact />

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {visibleRuns.length === 0 ? (
        <div className="empty fleet-empty">
          <p>
            {hideCompleted && counts.completed > 0
              ? `No active agent sessions right now (${counts.completed} completed run${counts.completed === 1 ? '' : 's'} hidden).`
              : 'No agent sessions match the selected filter.'}
          </p>
          <p className="muted small" style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              Start a ticket from a project board or launch a run from the{' '}
              <Link href="/">Factory Overview</Link>.
            </span>
            {hideCompleted && counts.completed > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={toggleHideCompleted}
              >
                Show Completed Runs ({counts.completed})
              </button>
            )}
          </p>
        </div>
      ) : (
        <div className={`fleet-grid fleet-grid-${layout}`}>
          {visibleRuns.map((run) => (
            <FleetPane
              key={run.id}
              run={run}
              project={projectById.get(run.projectId)}
              onInspect={() => onInspectRun(run.id)}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FleetPane({
  run,
  project,
  onInspect,
  onError,
}: {
  run: Run;
  project: Project | undefined;
  onInspect: () => void;
  onError: (msg: string | undefined) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string>();
  const live = !run.endedAt && run.state !== 'done' && run.state !== 'failed';
  const canPrompt = (live && run.state !== 'queued') || run.resumable;

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
    });
  };

  return (
    <article id={`fleet-pane-${run.id}`} className={`fleet-pane fleet-pane-${run.state}`}>
      <header className="fleet-pane-head">
        <RunStatePill state={run.state} />
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
          {(run.state === 'rate_limited' || run.resumable) && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() => void act('resume', () => api(`/api/runs/${run.id}/resume`, 'POST', {}))}
            >
              Resume
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
          {run.terminalId && (
            <Link href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost" title="Full-screen terminal">
              ↗
            </Link>
          )}
        </div>
      </header>

      <div className="fleet-pane-body">
        {run.terminalId ? (
          <Suspense fallback={<div className="term-shell term-shell-compact" aria-busy="true" />}>
            <TerminalView key={run.terminalId} terminalId={run.terminalId} compact autoFocus={false} />
          </Suspense>
        ) : (
          <div className="fleet-placeholder">
            <p className="mono">
              {run.state === 'queued'
                ? 'Waiting in scheduler queue…'
                : run.state === 'done'
                  ? '✓ Session completed and archived. Use Review to inspect git changes or Resume below to continue.'
                  : 'Terminal session ended. Use Resume below to continue.'}
            </p>
            {run.prompt && <p className="muted small mono">{run.prompt.slice(0, 320)}</p>}
          </div>
        )}
      </div>

      {canPrompt && (
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
                : !live
                  ? 'Resume session with prompt…'
                  : 'Steer this agent…'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!prompt.trim() || !!busy}>
            {busy === 'send' ? '…' : live ? 'Send' : 'Resume'}
          </button>
        </form>
      )}
    </article>
  );
}
