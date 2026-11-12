import { FileCode2, Package, SquareKanban } from 'lucide-react';
import { Link } from 'wouter';
import { errorMessage } from '../../api';
import { ico } from '../SectionState';
import type { ExplorerCtx } from './fileTypes';

export function ExplorerToolbarSection({
  ctx,
  loading,
  error,
  onRetry,
}: {
  ctx: ExplorerCtx;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => Promise<void>;
}) {
  const { pid, proj: project, wsPath, tid, setTid, runs, err, msg } = ctx;

  return (
    <>
      <div
        className="panel"
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 }}>
          <span className="badge badge-soft mono" style={{ fontWeight: 600 }}>
            {ico(FileCode2)} Code Explorer
          </span>
          <strong>{project?.name ?? (loading ? 'Loading…' : pid)}</strong>
          <span className="muted mono small" style={{ overflowWrap: 'anywhere' }}>
            {wsPath ?? project?.path}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          <label className="small muted" htmlFor="code-target-select">
            Target:
          </label>
          <select
            id="code-target-select"
            className="input"
            style={{ width: 'auto', maxWidth: 'min(320px, 100%)', padding: '4px 8px', fontSize: '0.78rem' }}
            value={tid}
            onChange={(e) => setTid(e.target.value)}
          >
            <option value="main">Main Workspace ({project?.defaultBranch ?? 'main'})</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                Worktree · {r.title ?? r.branch} ({r.state})
              </option>
            ))}
          </select>

          <Link href={`/projects/${pid}/board`} className="btn btn-sm btn-ghost">
            {ico(SquareKanban)} Kanban Board
          </Link>
          <a
            href={`/api/projects/${pid}/export.tar.gz`}
            className="btn btn-sm btn-ghost"
            title="Download workspace as .tar.gz archive"
          >
            {ico(Package)} Download .tar.gz
          </a>
        </div>
      </div>

      {error !== undefined && !project && (
        <div className="banner banner-error" role="alert" style={{ margin: 0 }}>
          <span>Could not load project: {errorMessage(error)}</span>
          {onRetry && (
            <button type="button" className="btn btn-sm" onClick={() => void onRetry()}>
              Retry
            </button>
          )}
        </div>
      )}
      {err && (
        <div className="banner banner-error" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="banner banner-ok" style={{ margin: 0 }}>
          {msg}
        </div>
      )}
    </>
  );
}
