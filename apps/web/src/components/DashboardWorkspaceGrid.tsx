import type {
  AgentPersona,
  GarbageCollectRunsResponse,
  Project,
  Run,
  TerminalInfo,
} from '@emberline/protocol';
import { Eraser, Trash, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { keptWorktreesSummary } from '../gcSummary';
import { timeAgo } from '../time';
import { StartRunForm } from './DashboardRunsSection';
import { ViewErrorBanner, ViewLoadingState } from './ErrorBoundary';
import { ProjectDeleteConfirm, type ProjectDeleted } from './ProjectDeleteConfirm';

const KIND_LABEL: Record<TerminalInfo['kind'], string> = {
  shell: 'shell',
  claude: 'claude',
  clone: 'git clone',
  agent: 'agent',
};

export function DashboardWorkspaceGrid({
  activeProject,
  visibleProjects,
  runnerDown,
  onOpenWizard,
  onOpenBlueprint,
  onOpenTerminal,
  onRemoveTerminal,
  onCleanedWorktrees,
  onActionError,
  onProjectDeleted,
  runFormFor,
  onToggleRunForm,
  runFormPersona,
  runFormPrompt,
  onRunStarted,
  plainTerminals,
  terminalsLoading,
  terminalsError,
  hasTerminalsData,
  onRetryTerminals,
  projectName,
}: {
  activeProject: Project | undefined;
  visibleProjects: Project[];
  runnerDown: boolean;
  onOpenWizard?: () => void;
  onOpenBlueprint: (project: Project) => void;
  onOpenTerminal: (kind: 'shell' | 'claude', projectId?: string) => void;
  onRemoveTerminal: (id: string) => void;
  onCleanedWorktrees: (notice: string | undefined) => void;
  onActionError: (message: string | undefined) => void;
  onProjectDeleted: (res: ProjectDeleted) => Promise<void>;
  runFormFor: string | undefined;
  onToggleRunForm: (projectId: string | undefined, persona?: AgentPersona, prompt?: string) => void;
  runFormPersona: AgentPersona;
  runFormPrompt: string;
  onRunStarted: (run: Run) => void;
  plainTerminals: TerminalInfo[];
  terminalsLoading: boolean;
  terminalsError: unknown;
  hasTerminalsData: boolean;
  onRetryTerminals: () => Promise<void>;
  projectName: (id: string | null) => string | undefined;
}) {
  const [deleteConfirmFor, setDeleteConfirmFor] = useState<string>();

  return (
    <div className="dashboard-grid">
      <section className="panel" aria-labelledby="projects-title">
        <header className="panel-head">
          <div>
            <h2 id="projects-title">{activeProject ? 'Workspace Controls' : 'Projects'}</h2>
            <p className="muted">
              {activeProject
                ? `Repository path and quick actions for ${activeProject.name}.`
                : 'Create your first project to start the AI Coding Factory.'}
            </p>
          </div>
          {onOpenWizard && (
            <div className="actions">
              <button
                id="open-project-wizard"
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onOpenWizard}
              >
                + AI Factory Wizard
              </button>
            </div>
          )}
        </header>
        <ul className="list">
          {visibleProjects.map((p) => (
            <li key={p.id} className="row row-wrap">
              <div className="row-main">
                <span className="row-title">{p.name}</span>
                {p.appType && p.appType !== 'custom' && (
                  <span className="badge badge-soft">{p.appType.replace('_', ' ')}</span>
                )}
                <span className="row-meta mono">{p.repoUrl ?? p.path}</span>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onOpenBlueprint(p)}
                  title="Open PROJECT.md Blueprint"
                >
                  PROJECT.md
                </button>
                <Link id={`board-${p.slug}`} href={`/projects/${p.id}/board`} className="btn btn-sm">
                  Board
                </Link>
                <button
                  className="btn btn-sm"
                  disabled={runnerDown}
                  onClick={() => onOpenTerminal('shell', p.id)}
                >
                  Shell
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title="Prune finished git worktrees for this project"
                  onClick={async () => {
                    onActionError(undefined);
                    try {
                      const res = await api<GarbageCollectRunsResponse>(
                        `/api/projects/${p.id}/cleanup-worktrees`,
                        'POST',
                      );
                      onCleanedWorktrees(keptWorktreesSummary(res) ?? undefined);
                    } catch (e) {
                      onActionError(errorMessage(e));
                    }
                  }}
                >
                  <Eraser className="icon" aria-hidden /> Clean Worktrees
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ color: 'var(--danger)' }}
                  title="Remove the project from Emberline, keeping or deleting its files"
                  aria-expanded={deleteConfirmFor === p.id}
                  onClick={() => setDeleteConfirmFor(deleteConfirmFor === p.id ? undefined : p.id)}
                >
                  <Trash className="icon" aria-hidden /> Remove
                </button>
                <button
                  id={`start-run-${p.slug}`}
                  className="btn btn-sm btn-primary"
                  disabled={runnerDown}
                  aria-expanded={runFormFor === p.id}
                  onClick={() => onToggleRunForm(runFormFor === p.id ? undefined : p.id, 'coder', '')}
                >
                  Start run
                </button>
              </div>
              {deleteConfirmFor === p.id && (
                <ProjectDeleteConfirm
                  project={p}
                  onCancel={() => setDeleteConfirmFor(undefined)}
                  onDeleted={async (res) => {
                    setDeleteConfirmFor(undefined);
                    await onProjectDeleted(res);
                  }}
                />
              )}
              {runFormFor === p.id && (
                <StartRunForm
                  key={`${p.id}-${runFormPersona}-${runFormPrompt.slice(0, 16)}`}
                  project={p}
                  initialPersona={runFormPersona}
                  initialPrompt={runFormPrompt}
                  onCancel={() => onToggleRunForm(undefined)}
                  onStarted={onRunStarted}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="terminals-title">
        <header className="panel-head">
          <div>
            <h2 id="terminals-title">Terminals</h2>
            <p className="muted">Sessions live in the runner and survive reloads and core restarts.</p>
          </div>
          <div className="actions">
            <button
              id="new-shell"
              className="btn btn-sm"
              disabled={runnerDown}
              onClick={() => onOpenTerminal('shell', activeProject?.id)}
            >
              New shell
            </button>
            <button
              id="new-claude"
              className="btn btn-sm btn-primary"
              disabled={runnerDown}
              onClick={() => onOpenTerminal('claude', activeProject?.id)}
              title="Starts Claude Code; on first run it walks you through logging in with your subscription"
            >
              Claude
            </button>
          </div>
        </header>

        {Boolean(terminalsError && !hasTerminalsData) && (
          <ViewErrorBanner
            compact
            label="Could not load terminals"
            error={terminalsError}
            onRetry={onRetryTerminals}
          />
        )}
        {terminalsLoading && !hasTerminalsData && !terminalsError ? (
          <ViewLoadingState compact label="Loading terminals…" />
        ) : plainTerminals.length === 0 && !terminalsError ? (
          <div className="empty">
            <p>No terminals yet.</p>
            <p className="muted">
              First time here? Open <strong>Claude</strong> and log in with your own subscription.
            </p>
          </div>
        ) : (
          <ul className="list">
            {plainTerminals.map((t) => (
              <li key={t.id} className="row">
                <Link href={`/terminals/${t.id}`} className="row-main">
                  <span className={`dot dot-${t.status}`} aria-label={t.status} />
                  <span className="row-title">{t.title}</span>
                  <span className="badge">{KIND_LABEL[t.kind]}</span>
                  {t.projectId && (
                    <span className="badge badge-soft">{projectName(t.projectId) ?? 'project'}</span>
                  )}
                  <span className="row-meta mono">
                    {t.status === 'exited' ? `exited${t.exitCode !== null ? ` (${t.exitCode})` : ''} · ` : ''}
                    {timeAgo(t.createdAt)}
                  </span>
                </Link>
                <button
                  className="icon-btn"
                  aria-label={`Close ${t.title}`}
                  title={t.status === 'running' ? 'Kill and remove' : 'Remove'}
                  onClick={() => onRemoveTerminal(t.id)}
                >
                  <X className="icon" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
