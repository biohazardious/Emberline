import type { Run, RunDetail, RunDiffSummary, RunReviewState } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, Keyboard } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { ErrorBoundary, ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { ReviewView } from '../components/ReviewView';
import { RunStatePill } from '../components/RunStatePill';

export function ReviewPage({ id, onInspectRun }: { id: string; onInspectRun?: (runId: string) => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const queryClient = useQueryClient();

  const loadRun = useCallback(async () => {
    setError(null);
    void queryClient.prefetchQuery({
      queryKey: ['review', id],
      queryFn: () => api<RunReviewState>(`/api/runs/${id}/review`),
    });
    void queryClient.prefetchQuery({
      queryKey: ['diff-summary', id, 'branch'],
      queryFn: () => api<RunDiffSummary>(`/api/runs/${id}/diff?scope=branch`),
    });
    try {
      const r = await api<RunDetail>(`/api/runs/${id}`);
      setRun(r);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, queryClient]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  if (error) {
    return (
      <div className="board-page">
        <div className="board-head">
          <Link href="/" className="btn btn-sm btn-ghost">
            ← Overview
          </Link>
        </div>
        <ViewErrorBanner label="Could not load run review" error={error} onRetry={loadRun} />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="board-page">
        <ViewLoadingState label="Loading run review…" />
      </div>
    );
  }

  return (
    <div className="review-page-shell">
      <div className="review-page-header">
        <div className="review-toolbar-group">
          <Link href="/" className="btn btn-sm btn-ghost">
            ← Overview
          </Link>
          {run.projectId && (
            <Link href={`/projects/${run.projectId}/board`} className="btn btn-sm btn-ghost">
              ← Board
            </Link>
          )}
          <RunStatePill
            state={run.state}
            cancelled={run.cancelled}
            autoRetry={run.autoRetry}
            handedOffTo={run.handedOffTo}
          />
          <strong style={{ fontSize: '0.88rem' }}>{run.title ?? run.prompt.slice(0, 72)}</strong>
          {run.branch && (
            <span className="badge badge-soft mono">
              <GitBranch className="icon" aria-hidden /> {run.branch}
            </span>
          )}
          {run.worktreePath && <span className="mono muted small hide-sm">{run.worktreePath}</span>}
        </div>

        <div className="review-toolbar-group">
          <button
            type="button"
            className="btn btn-sm btn-ghost review-shortcut-btn"
            onClick={() => setShortcutSheetOpen((open) => !open)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard className="icon" aria-hidden /> <kbd className="kbd">?</kbd> Shortcuts
          </button>
          {run.terminalId && (
            <Link href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost">
              Full Terminal ↗
            </Link>
          )}
          {onInspectRun && (
            <button type="button" className="btn btn-sm" onClick={() => onInspectRun(run.id)}>
              Dock Live Terminal
            </button>
          )}
        </div>
      </div>

      <div className="review-page-body">
        <div className="review-page-main">
          <ErrorBoundary resetKey={run.id}>
            <ReviewView
              run={run}
              onRunUpdated={setRun}
              shortcutSheetOpen={shortcutSheetOpen}
              onShortcutSheetOpenChange={setShortcutSheetOpen}
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
