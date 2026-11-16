import type { Project } from '@emberline/protocol';
import { Link } from 'wouter';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { ProjectSettingsPanel } from '../components/ProjectSettingsPanel';
import '../components/project-settings-ux.css';
import { PageHeader } from '../components/ui/PageHeader';
import { useApi } from '../hooks/useApi';

export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const projects = useApi<Project[]>('/api/projects', 10_000);
  const project = projects.data?.find((p) => p.id === projectId);
  return (
    <div className="board-page project-settings-page">
      <PageHeader
        title="Project settings"
        meta={project ? <span className="badge mono">{project.name}</span> : undefined}
        actions={
          <Link
            href={`/projects/${projectId}/board`}
            className="btn btn-ghost btn-sm"
            aria-label="Back to the board"
          >
            Open board
          </Link>
        }
      />
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
