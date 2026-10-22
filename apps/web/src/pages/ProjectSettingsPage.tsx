import type { Project } from '@emberline/protocol';
import { Link } from 'wouter';
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
      {project ? (
        <ProjectSettingsPanel project={project} />
      ) : (
        !projects.loading && <p className="muted">No such project.</p>
      )}
    </div>
  );
}
