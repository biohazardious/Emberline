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
import { HelpHint } from './ui/HelpHint';
import { MoreMenu, type MoreMenuItem } from './ui/MoreMenu';
import '../pages/dashboard-ux.css';

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

  const cleanWorktrees = async (projectId: string) => {
    onActionError(undefined);
    try {
      const res = await api<GarbageCollectRunsResponse>(
        `/api/projects/${projectId}/cleanup-worktrees`,
        'POST',
      );
      onCleanedWorktrees(keptWorktreesSummary(res) ?? undefined);
    } catch (e) {
      onActionError(errorMessage(e));
    }
  };

  return (
    <div className="dashboard-grid">
      <section className="panel" aria-labelledby="projects-title">
        <header className="panel-head">
          <h2 id="projects-title">Workspace</h2>
          {visibleProjects.length === 0 && onOpenWizard && (
            <div className="actions">
              <button
                id="open-project-wizard"
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onOpenWizard}
              >
                Create project
              </button>
            </div>
          )}
        </header>

        <ul className="list">
          {visibleProjects.map((p) => {
            const moreItems: MoreMenuItem[] = [
              {
                id: `open-blueprint-${p.id}`,
                label: 'Open PROJECT.md',
                onSelect: () => onOpenBlueprint(p),
              },
              {
                id: `open-shell-${p.id}`,
                label: 'Open shell',
                disabled: runnerDown,
                onSelect: () => onOpenTerminal('shell', p.id),
              },
              {
                id: `clean-worktrees-${p.id}`,
                label: 'Clean worktrees',
                description: 'Prune finished git worktrees for this project',
                icon: <Eraser className="icon" aria-hidden />,
                onSelect: () => void cleanWorktrees(p.id),
              },
              ...(onOpenWizard
                ? [
                    {
                      id: `new-project-${p.id}`,
                      label: 'New project',
                      onSelect: onOpenWizard,
                    },
                  ]
                : []),
              {
                id: `remove-project-${p.id}`,
                label: 'Remove project',
                description: 'Remove from Emberline, keeping or deleting files',
                icon: <Trash className="icon" aria-hidden />,
                danger: true,
                onSelect: () => setDeleteConfirmFor(deleteConfirmFor === p.id ? undefined : p.id),
              },
            ];

            return (
              <li key={p.id} className="row row-wrap">
                <div className="row-main">
                  <span className="row-title">{p.name}</span>
                  {p.appType && p.appType !== 'custom' && (
                    <span className="badge badge-soft">{p.appType.replace('_', ' ')}</span>
                  )}
                  <span className="row-meta mono">{p.repoUrl ?? p.path}</span>
                </div>
                <div className="workspace-row-actions">
                  <button
                    id={`start-run-${p.slug}`}
                    type="button"
                    className={`btn btn-sm${runFormFor ? '' : ' btn-primary'}`}
                    disabled={runnerDown}
                    aria-expanded={runFormFor === p.id}
                    onClick={() => onToggleRunForm(runFormFor === p.id ? undefined : p.id, 'coder', '')}
                  >
                    Start run
                  </button>
                  <Link id={`board-${p.slug}`} href={`/projects/${p.id}/board`} className="btn btn-sm">
                    Open board
                  </Link>
                  <MoreMenu items={moreItems} ariaLabel={`Workspace actions for ${p.name}`} />
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
            );
          })}
        </ul>
      </section>

      <section className="panel" aria-labelledby="terminals-title">
        <header className="panel-head">
          <div className="budget-heading-row">
            <h2 id="terminals-title">Terminals</h2>
            <HelpHint topic="terminals">
              Sessions live in the runner and survive reloads and restarts. Open Claude to sign in with your
              subscription.
            </HelpHint>
          </div>
          <div className="actions">
            <button
              id="new-shell"
              type="button"
              className="btn btn-sm"
              disabled={runnerDown}
              onClick={() => onOpenTerminal('shell', activeProject?.id)}
            >
              Open shell
            </button>
            <button
              id="new-claude"
              type="button"
              className="btn btn-sm"
              disabled={runnerDown}
              onClick={() => onOpenTerminal('claude', activeProject?.id)}
            >
              Open Claude
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
                  type="button"
                  className="icon-btn"
                  aria-label={`Close ${t.title}`}
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
