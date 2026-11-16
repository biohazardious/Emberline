import type { Project, Run } from '@emberline/protocol';
import { FileCode2, Package, SquareKanban } from 'lucide-react';
import { useLocation } from 'wouter';
import { ViewErrorBanner } from '../ErrorBoundary';
import { SectionState } from '../SectionState';
import { HelpHint } from '../ui/HelpHint';
import { MoreMenu, type MoreMenuItem } from '../ui/MoreMenu';
import { PageHeader } from '../ui/PageHeader';

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
  const [, navigate] = useLocation();

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

  const menuItems: MoreMenuItem[] = [
    {
      id: 'download-archive',
      label: 'Download archive',
      description: 'Export workspace as .tar.gz',
      icon: <Package className="icon" aria-hidden />,
      href: `/api/projects/${projectId}/export.tar.gz`,
    },
    {
      id: 'open-board',
      label: 'Open board',
      icon: <SquareKanban className="icon" aria-hidden />,
      onSelect: () => navigate(`/projects/${projectId}/board`),
    },
  ];

  return (
    <>
      <PageHeader
        title="Code"
        icon={<FileCode2 className="icon" aria-hidden />}
        meta={
          <>
            <span className="badge badge-soft">{project?.name ?? projectId}</span>
            <HelpHint topic="workspace">
              Workspace path:{' '}
              <span className="mono">{workspacePath ?? project?.path ?? 'No workspace path available'}</span>
            </HelpHint>
          </>
        }
        actions={
          <>
            <select
              id="code-target-select"
              className="input code-target-select"
              aria-label="Workspace target"
              value={targetId}
              onChange={(e) => onChangeTargetId(e.target.value)}
            >
              <option value="main">{project?.defaultBranch ?? 'main'}</option>
              {projectRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title ?? r.branch} ({r.state})
                </option>
              ))}
            </select>
            <MoreMenu items={menuItems} ariaLabel="Workspace actions" />
          </>
        }
      />

      {Boolean(fileListError && !hasFileListData) && (
        <ViewErrorBanner
          label="Could not load workspace files"
          error={fileListError}
          onRetry={onRetryFileList}
        />
      )}
      {error && (
        <div className="banner banner-error code-banner" role="alert">
          {error}
        </div>
      )}
      {statusMessage && <div className="banner banner-ok code-banner">{statusMessage}</div>}
    </>
  );
}
