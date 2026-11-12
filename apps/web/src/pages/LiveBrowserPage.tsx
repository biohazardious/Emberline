import type { Project, ProjectStatusSummary } from '@emberline/protocol';
import { Globe } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { ErrorBoundary, ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { LiveBrowserStudio } from '../components/LiveBrowserStudio';
import { useApi } from '../hooks/useApi';

export function LiveBrowserPage({ projectId }: { projectId: string }) {
  const projectsPoll = useApi<Project[]>('/api/projects', 10_000);
  const statusPoll = useApi<ProjectStatusSummary>(`/api/projects/${projectId}/status`, 5_000);
  const [targetId, setTargetId] = useState('main');

  const project = (projectsPoll.data ?? []).find((p) => p.id === projectId);
  const targets = statusPoll.data?.targets ?? [];

  if (projectsPoll.error && !projectsPoll.data) {
    return (
      <div className="board-page">
        <ViewErrorBanner
          label="Could not load project"
          error={projectsPoll.error}
          onRetry={projectsPoll.refresh}
        />
      </div>
    );
  }

  if (projectsPoll.loading && !project) {
    return (
      <div className="board-page">
        <ViewLoadingState label="Loading Live Browser Studio…" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="board-page">
        <div className="empty">
          <p>Project not found.</p>
          <Link href="/" className="btn btn-sm">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="board-page">
      <header className="board-head">
        <div className="board-title">
          <Link href="/" className="btn btn-ghost btn-sm" aria-label="Back to overview">
            ←
          </Link>
          <div>
            <p className="eyebrow">{project.name} · Shared Runner Chromium + Playwright MCP</p>
            <h1>
              <Globe className="icon" aria-hidden /> Live Browser Studio
            </h1>
            <p className="muted small">
              Watch agents navigate, click, and verify the application in real time, or interact with the live
              Chromium browser directly.
            </p>
          </div>
        </div>

        <div className="board-controls">
          {targets.length > 1 && (
            <select
              className="input"
              aria-label="Live Browser target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              style={{
                width: 'auto',
                maxWidth: 'min(320px, 100%)',
                fontSize: '0.78rem',
                padding: '5px 10px',
              }}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  Target: {t.label}
                </option>
              ))}
            </select>
          )}
          <Link href={`/projects/${project.id}/board`} className="btn btn-sm">
            Kanban Board
          </Link>
          <Link href="/fleet" className="btn btn-sm">
            Fleet &amp; Terminals
          </Link>
        </div>
      </header>

      {Boolean(statusPoll.error && !statusPoll.data) && (
        <ViewErrorBanner
          compact
          label="Could not load browser targets"
          error={statusPoll.error}
          onRetry={statusPoll.refresh}
        />
      )}

      <ErrorBoundary resetKey={`${project.id}:${targetId}`}>
        <LiveBrowserStudio project={project} targetId={targetId} />
      </ErrorBoundary>
    </div>
  );
}
