import type { Project, Run } from '@emberline/protocol';
import { FileCode2, Package, SquareKanban } from 'lucide-react';
import { Link } from 'wouter';
import { ViewErrorBanner } from '../ErrorBoundary';
import { SectionState } from '../SectionState';

export function CodeExplorerToolbar({
  projectId,
  project,
  projectLoading,
  projectError,
  onRetryProject,
  workspacePath,
  targetId,
  onChangeTargetId,
  projectRuns,
  fileListError,
  hasFileListData,
  onRetryFileList,
  error,
  statusMessage,
}: {
  projectId: string;
  project: Project | undefined;
  projectLoading?: boolean;
  projectError?: unknown;
  onRetryProject?: () => void | Promise<void>;
  workspacePath: string | undefined;
  targetId: string;
  onChangeTargetId: (next: string) => void;
  projectRuns: Run[];
  fileListError?: unknown;
  hasFileListData: boolean;
  onRetryFileList?: () => void | Promise<void>;
  error: string | null;
  statusMessage: string | null;
}) {
  if (!project && (projectLoading || projectError !== undefined)) {
    return (
      <SectionState
        loading={projectLoading}
        error={projectError}
        onRetry={onRetryProject}
        loadingText="Loading workspace metadata…"
        errorPrefix="Could not load project workspace"
      />
    );
  }

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
            <FileCode2 className="icon" aria-hidden /> Code Explorer
          </span>
          <strong>{project?.name ?? projectId}</strong>
          <span className="muted mono small" style={{ overflowWrap: 'anywhere' }}>
            {workspacePath ?? project?.path ?? 'No workspace path available'}
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
            value={targetId}
            onChange={(e) => onChangeTargetId(e.target.value)}
          >
            <option value="main">Main Workspace ({project?.defaultBranch ?? 'main'})</option>
            {projectRuns.map((r) => (
              <option key={r.id} value={r.id}>
                Worktree · {r.title ?? r.branch} ({r.state})
              </option>
            ))}
          </select>

          <Link href={`/projects/${projectId}/board`} className="btn btn-sm btn-ghost">
            <SquareKanban className="icon" aria-hidden /> Kanban Board
          </Link>
          <a
            href={`/api/projects/${projectId}/export.tar.gz`}
            className="btn btn-sm btn-ghost"
            title="Download workspace as .tar.gz archive"
          >
            <Package className="icon" aria-hidden /> Download .tar.gz
          </a>
        </div>
      </div>

      {Boolean(fileListError && !hasFileListData) && (
        <ViewErrorBanner
          label="Could not load workspace files"
          error={fileListError}
          onRetry={onRetryFileList}
        />
      )}
      {error && (
        <div className="banner banner-error" role="alert" style={{ margin: 0 }}>
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="banner banner-ok" style={{ margin: 0 }}>
          {statusMessage}
        </div>
      )}
    </>
  );
}
