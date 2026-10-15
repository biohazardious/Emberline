import type { Project, ProjectStatusSummary } from '@emberline/protocol';
import { Globe } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { LiveBrowserStudio } from '../components/LiveBrowserStudio';
import { useApi } from '../hooks/useApi';

export function LiveBrowserPage({ projectId }: { projectId: string }) {
  const projectsPoll = useApi<Project[]>('/api/projects', 10_000);
  const statusPoll = useApi<ProjectStatusSummary>(`/api/projects/${projectId}/status`, 5_000);
  const [targetId, setTargetId] = useState('main');

  const project = (projectsPoll.data ?? []).find((p) => p.id === projectId);
  const targets = statusPoll.data?.targets ?? [];

  if (!project) {
    return (
      <div className="page">
        <p className="muted">Loading project…</p>
      </div>
    );
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1>
              <Globe className="icon" aria-hidden /> Live Browser Studio · {project.name}
            </h1>
            <span className="badge badge-soft mono">Shared Runner Chromium + Playwright MCP</span>
          </div>
          <p className="sub">
            Watch your agents navigate, click, and verify the application in real time, or interact
            with the live Chromium browser directly.
          </p>
        </div>

        <div className="actions">
          {targets.length > 1 && (
            <select
              className="input"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              style={{ width: 'auto', fontSize: '0.78rem', padding: '5px 10px' }}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  Target: {t.label}
                </option>
              ))}
            </select>
          )}
          <Link href="/" className="btn btn-sm">
            ← Overview
          </Link>
          <Link href={`/projects/${project.id}/board`} className="btn btn-sm">
            Kanban Board
          </Link>
          <Link href="/fleet" className="btn btn-sm">
            Fleet &amp; Terminals
          </Link>
        </div>
      </header>

      <LiveBrowserStudio project={project} targetId={targetId} />
    </div>
  );
}
