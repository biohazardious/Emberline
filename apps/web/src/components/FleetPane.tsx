import type { Project, Run, RunBuildOutputsResponse, RunDetail } from '@emberline/protocol';
import { useQuery } from '@tanstack/react-query';
import { Check, Hourglass, Package, X } from 'lucide-react';
import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { formatAgentDisplayName } from '../agentLabel';
import { api, errorMessage } from '../api';
import { isRunCompleted } from '../attention';
import { outputsBadge } from '../buildOutputs';
import { latestCompletionBlockers } from '../completionSignal';
import { HANDOFF_STATES } from '../handoffCandidates';
import { clearPresenceRun, setPresenceRun } from '../hooks/eventHub';
import { useApi } from '../hooks/useApi';
import { useInView } from '../hooks/useInView';
import { timeAgo } from '../time';
import { ErrorBoundary } from './ErrorBoundary';
import { HandoffMenu } from './QuotaLanes';
import { FinalAnswer, LastScreen } from './RunOutcome';
import { RunStatePill } from './RunStatePill';
import { Disclosure } from './ui/Disclosure';
import { MoreMenu, type MoreMenuItem } from './ui/MoreMenu';
import './fleet/fleet-ux.css';

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
        <span className="badge mono fleet-blocker-badge">blocked: {blockers.join(', ')}</span>
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

function placeholderBadgeClass(run: Run): string {
  if (run.state === 'done' && run.handedOffTo) return 'badge mono fleet-placeholder-badge-info';
  if (run.state === 'done') return 'badge mono fleet-placeholder-badge-ok';
  if (run.state === 'failed') return 'badge mono fleet-placeholder-badge-bad';
  return 'badge mono fleet-placeholder-badge-muted';
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
  const canHandoff =
    !run.handedOffTo &&
    !run.cancelled &&
    HANDOFF_STATES.has(run.state) &&
    (run.state === 'waiting_input' || run.state === 'rate_limited');

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

  const moreItems: MoreMenuItem[] = [
    {
      id: 'inspect',
      label: 'Inspect run',
      description: run.branch ? `Branch: ${run.branch}` : undefined,
      onSelect: onInspect,
    },
  ];
  if (run.worktreePath) {
    moreItems.push({
      id: 'review',
      label: 'Open review',
      href: `/runs/${run.id}/review`,
    });
  }
  if (live && run.terminalId) {
    moreItems.push({
      id: 'terminal',
      label: 'Open terminal',
      href: `/terminals/${run.terminalId}`,
    });
  }
  if (project) {
    moreItems.push({
      id: 'board',
      label: 'Open board',
      description: project.name,
      href: `/projects/${project.id}/board`,
    });
  }
  if (completed && run.resumable) {
    moreItems.push({
      id: 'reopen',
      label: showReopenBar ? 'Hide prompt' : 'Reopen session',
      disabled: !!busy,
      onSelect: () => setShowReopenBar((v) => !v),
    });
  }
  if (onDismiss) {
    moreItems.push({
      id: 'dismiss',
      label: 'Hide pane',
      onSelect: onDismiss,
    });
  }
  if (completed) {
    moreItems.push({
      id: 'remove',
      label: 'Remove run',
      danger: true,
      disabled: !!busy,
      onSelect: () => void act('remove', () => api(`/api/runs/${run.id}`, 'DELETE')),
    });
  }

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
        <button type="button" className="fleet-pane-title" onClick={onInspect}>
          {run.title ?? project?.name ?? 'Agent run'}
        </button>
        <div className="fleet-pane-actions">
          {run.state === 'rate_limited' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!!busy}
              onClick={() => void act('resume', () => api(`/api/runs/${run.id}/resume`, 'POST', {}))}
            >
              Resume
            </button>
          ) : live ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              disabled={!!busy}
              onClick={() => void act('stop', () => api(`/api/runs/${run.id}/stop`, 'POST'))}
            >
              {run.state === 'queued' ? 'Cancel' : 'Stop'}
            </button>
          ) : run.worktreePath ? (
            <Link href={`/runs/${run.id}/review`} className="btn btn-sm btn-ghost">
              Open review
            </Link>
          ) : completed && run.resumable ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={!!busy}
              onClick={() => setShowReopenBar((v) => !v)}
            >
              Resume
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onInspect}>
              Inspect
            </button>
          )}
          <MoreMenu items={moreItems} ariaLabel={`More actions for ${run.title ?? project?.name ?? 'run'}`} />
        </div>
      </header>

      {canHandoff && (
        <div className="fleet-pane-handoff">
          <Disclosure label="Hand off">
            <HandoffMenu run={run} />
          </Disclosure>
        </div>
      )}

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
          <div className="fleet-placeholder">
            <div className="fleet-placeholder-head">
              <span className={placeholderBadgeClass(run)}>
                {run.state === 'queued' ? (
                  <>
                    <Hourglass className="icon" aria-hidden /> Queued
                  </>
                ) : run.state === 'done' ? (
                  <>
                    <Check className="icon" aria-hidden /> {run.handedOffTo ? 'Handed off' : 'Completed'}
                  </>
                ) : (
                  <>
                    <X className="icon" aria-hidden /> Session ended
                  </>
                )}
              </span>
              <span className="muted small mono">{formatAgentDisplayName(run.agent)}</span>
              {run.endedAt && <span className="muted small mono">{timeAgo(run.endedAt)}</span>}
            </div>
            {run.state === 'queued' && (
              <p className="mono fleet-placeholder-summary">Waiting for a free execution slot.</p>
            )}
            {run.state === 'done' && run.handedOffTo && (
              <p className="mono fleet-placeholder-summary">
                Continued in{' '}
                <Link href={`/runs/${run.handedOffTo}/review`}>{run.handedOffTo.slice(0, 8)}</Link>.
              </p>
            )}
            {completed && <FinishedOutcome run={run} />}
          </div>
        )}
      </div>

      {showPromptFooter && (
        <form className="fleet-pane-foot" onSubmit={submitPrompt}>
          <input
            className="input fleet-input"
            placeholder={
              run.state === 'waiting_input'
                ? 'Reply to agent…'
                : completed
                  ? 'Enter follow-up prompt to resume…'
                  : 'Steer this agent…'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={!prompt.trim() || !!busy}>
            {busy === 'send' ? 'Sending…' : live ? 'Send' : 'Resume'}
          </button>
        </form>
      )}
    </article>
  );
}
