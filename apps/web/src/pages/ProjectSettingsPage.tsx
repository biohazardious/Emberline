import type { Project } from '@emberline/protocol';
import { Link } from 'wouter';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { ProjectSettingsPanel } from '../components/ProjectSettingsPanel';
import { useApi } from '../hooks/useApi';

export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const projects = useApi<Project[]>('/api/projects', 10_000);
  const project = projects.data?.find((p) => p.id === projectId);
  return (
    <div className="board-page">
      <header className="board-head">
        <div className="board-title">
          <Link
            href={`/projects/${projectId}/board`}
            className="btn btn-ghost btn-sm"
            aria-label="Back to the board"
          >
            ←
          </Link>
          <div>
            <p className="eyebrow">{project?.name ?? 'Project'}</p>
            <h1>Project settings</h1>
          </div>
        </div>
      </header>
      {Boolean(projects.error && !projects.data) && (
        <ViewErrorBanner
          label="Could not load project settings"
          error={projects.error}
          onRetry={projects.refresh}
        />
      )}
      {projects.loading && !projects.data && !projects.error ? (
        <ViewLoadingState label="Loading project settings…" />
      ) : project ? (
        <ProjectSettingsPanel project={project} />
      ) : !projects.error ? (
        <div className="empty">
          <p>No such project.</p>
          <Link href="/" className="btn btn-sm">
            Back to dashboard
          </Link>
        </div>
      ) : null}
    </div>
  );
}
