import type { Project, Run, RunBuildOutputsResponse, RunDetail } from '@emberline/protocol';
import { useQuery } from '@tanstack/react-query';
import { Check, EyeOff, Hourglass, Maximize2, Package, RotateCw, Trash, X } from 'lucide-react';
import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { isRunCompleted } from '../attention';
import { outputsBadge } from '../buildOutputs';
import { latestCompletionBlockers } from '../completionSignal';
import { clearPresenceRun, setPresenceRun } from '../hooks/eventHub';
import { useApi } from '../hooks/useApi';
import { useInView } from '../hooks/useInView';
import { timeAgo } from '../time';
import { ErrorBoundary } from './ErrorBoundary';
import { PersonaBadge } from './PersonaBadge';
import { HandoffMenu } from './QuotaLanes';
import { STAGE_TEMPLATES } from './RunInspector';
import { FinalAnswer, LastScreen } from './RunOutcome';
import { RunStatePill } from './RunStatePill';

const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

/**
 * Compact link to the Build Outputs page, filtered to this run; nothing when the run has none. A
 * finished run's outputs do not change on their own: fetched once per state change, never polled.
 */
function BuildOutputsBadge({ run }: { run: Run }) {
  const res = useQuery({
    queryKey: ['run-build-outputs-badge', run.id, run.stateChangedAt],
    queryFn: () => api<RunBuildOutputsResponse>(`/api/runs/${run.id}/build-outputs`),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const badge = outputsBadge(run.projectId, run.id, {
    live: res.data?.outputs.length ?? 0,
    archived: res.data?.archivedCount ?? 0,
  });
  if (!badge) return null;
  return (
    <Link href={badge.href} className="fleet-outputs-badge">
      <Package className="icon" aria-hidden /> {badge.label}
    </Link>
  );
}

/** The agent's final answer, last screen and build outputs, for a pane whose session finished. */
function FinishedOutcome({ run }: { run: Run }) {
  const detail = useApi<RunDetail>(`/api/runs/${run.id}`, 10_000);
  const blockers = latestCompletionBlockers(detail.data?.events ?? []);
  return (
    <div className="fleet-outcome">
      {detail.data?.finalMessage && <FinalAnswer text={detail.data.finalMessage} />}
      {blockers.length > 0 && (
        <span
          className="badge mono"
          title={blockers.join('\n')}
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          blocked
        </span>
      )}
      <BuildOutputsBadge run={run} />
      {detail.data?.lastScreen && !run.terminalId && <LastScreen text={detail.data.lastScreen} />}
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

/** Badge colours of a run's placeholder card: handed-off runs read as info, distinct from muted. */
function placeholderTone(run: Run): { border: string; text: string } {
  if (run.state === 'done' && run.handedOffTo) return { border: 'var(--border)', text: 'var(--info)' };
  if (run.state === 'done')
    return { border: 'color-mix(in srgb, var(--ok) 45%, transparent)', text: 'var(--ok)' };
  if (run.state === 'failed')
    return { border: 'color-mix(in srgb, var(--bad) 45%, transparent)', text: 'var(--bad)' };
  return { border: 'var(--border)', text: 'var(--muted)' };
}

export function FleetPane({
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
  useEffect(() => () => clearPresenceRun(run.id, 'fleet'), [run.id]);
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
    <article
      ref={paneRef}
      id={`fleet-pane-${run.id}`}
      className={`fleet-pane fleet-pane-${run.state}`}
      onFocus={() => setPresenceRun(run.id, 'fleet')}
      onBlur={() => clearPresenceRun(run.id, 'fleet')}
    >
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
        <RunStatePill
          state={run.state}
          cancelled={run.cancelled}
          autoRetry={run.autoRetry}
          handedOffTo={run.handedOffTo}
        />
        <PersonaBadge persona={run.persona} />
        <button
          type="button"
          className="fleet-pane-title"
          onClick={onInspect}
          title="Open run inspector & timeline"
        >
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
            <Link
              href={`/runs/${run.id}/review`}
              className="btn btn-sm btn-ghost"
              title="Inspect git diff & review"
            >
              Review
            </Link>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onInspect}
            title="Inspect events & details"
          >
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
            <Link
              href={`/terminals/${run.terminalId}`}
              className="btn btn-sm btn-ghost"
              title="Full-screen terminal"
            >
              <Maximize2 className="icon" aria-hidden />
            </Link>
          )}
        </div>
      </header>
      <HandoffMenu run={run} />

      <div className="fleet-pane-body">
        {live && run.terminalId && attachTerminal ? (
          <ErrorBoundary resetKey={run.terminalId} compact>
            <Suspense fallback={<div className="term-shell term-shell-compact" aria-busy="true" />}>
              <TerminalView key={run.terminalId} terminalId={run.terminalId} compact autoFocus={false} />
            </Suspense>
          </ErrorBoundary>
        ) : live && run.terminalId ? (
          <TerminalThumbnail runId={run.id} />
        ) : (
          <div className="fleet-placeholder" style={{ padding: '18px 20px' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}
            >
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
                    <Check className="icon" aria-hidden />{' '}
                    {run.handedOffTo ? 'Handed off to another route' : 'Completed & Terminal Closed'}
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
              {run.endedAt && <span className="muted small mono">Ended {timeAgo(run.endedAt)}</span>}
            </div>
            <p className="mono" style={{ margin: '0 0 8px', fontSize: '0.82rem' }}>
              {run.state === 'queued' ? (
                'Waiting in scheduler queue for an execution slot…'
              ) : run.state === 'done' && run.handedOffTo ? (
                <>
                  Handed off: run{' '}
                  <Link href={`/runs/${run.handedOffTo}/review`}>{run.handedOffTo.slice(0, 8)}</Link>{' '}
                  continues this work in the same worktree. Click Timeline to follow it, or{' '}
                  <Trash className="icon" aria-hidden /> to remove.
                </>
              ) : run.state === 'done' ? (
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
