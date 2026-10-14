import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { Run, RunDetail } from '@emberline/protocol';
import { api, errorMessage } from '../api';
import { ReviewView } from '../components/ReviewView';
import { RunStatePill } from '../components/RunStatePill';

export function ReviewPage({
  id,
  onInspectRun,
}: {
  id: string;
  onInspectRun?: (runId: string) => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRun = useCallback(async () => {
    try {
      const r = await api<RunDetail>(`/api/runs/${id}`);
      setRun(r);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  if (error) {
    return (
      <div style={{ padding: '1rem' }}>
        <p className="form-error">{error}</p>
      </div>
    );
  }

  if (!run) {
    return (
      <div style={{ padding: '1rem' }} className="muted small">
        Loading run review…
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
          <RunStatePill state={run.state} />
          <strong style={{ fontSize: '0.88rem' }}>
            {run.title ?? run.prompt.slice(0, 72)}
          </strong>
          {run.branch && <span className="badge badge-soft mono">⎇ {run.branch}</span>}
          {run.worktreePath && (
            <span className="mono muted small">{run.worktreePath}</span>
          )}
        </div>

        <div className="review-toolbar-group">
          {run.terminalId && (
            <Link href={`/terminals/${run.terminalId}`} className="btn btn-sm btn-ghost">
              Full Terminal ↗
            </Link>
          )}
          {onInspectRun && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onInspectRun(run.id)}
            >
              Dock Live Terminal
            </button>
          )}
        </div>
      </div>

      <div className="review-page-body">
        <div className="review-page-main">
          <ReviewView run={run} onRunUpdated={setRun} />
        </div>
      </div>
    </div>
  );
}
