import type { Project, ProjectStatusSummary } from '@emberline/protocol';
import { Globe } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { ErrorBoundary, ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { LiveBrowserStudio } from '../components/LiveBrowserStudio';
import { HelpHint } from '../components/ui/HelpHint';
import { PageHeader } from '../components/ui/PageHeader';
import { useApi } from '../hooks/useApi';
import '../components/liveBrowser/live-browser.css';

export function LiveBrowserPage({ projectId }: { projectId: string }) {
  const projectsPoll = useApi<Project[]>('/api/projects', 10_000);
  const statusPoll = useApi<ProjectStatusSummary>(`/api/projects/${projectId}/status`, 5_000);
  const [targetId, setTargetId] = useState('main');

  const project = (projectsPoll.data ?? []).find((p) => p.id === projectId);
  const targets = statusPoll.data?.targets ?? [];

  if (projectsPoll.error && !projectsPoll.data) {
    return (
      <div className="board-page live-browser-page">
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
      <div className="board-page live-browser-page">
        <ViewLoadingState label="Loading live browser…" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="board-page live-browser-page">
        <div className="empty">
          <p>Project not found.</p>
          <Link href="/" className="btn btn-sm">
            Open dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="board-page live-browser-page">
      <PageHeader
        title="Live browser"
        icon={<Globe className="icon" aria-hidden />}
        meta={
          <>
            <span className="badge badge-soft">{project.name}</span>
            <HelpHint topic="live browser">
              Shared runner Chromium over CDP (1280×720 at http://127.0.0.1:9222) and Playwright MCP. Click
              the viewport to send mouse clicks, or open More for playtest, QA checks, device sizes, and
              console logs.
            </HelpHint>
          </>
        }
        subtitle="A Chromium in the runner that agents and you share"
        actions={
          targets.length > 1 ? (
            <select
              className="input live-browser-target-select"
              aria-label="Live browser target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

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
