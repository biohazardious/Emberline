import type {
  AgentPersona,
  Project,
  PruneWorktreeResponse,
  RunDetail,
  SystemStatus,
  TerminalInfo,
} from '@emberline/protocol';
import { API_VERSION } from '@emberline/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ApiRequestError, api, errorMessage } from '../api';
import { BlueprintModal } from '../components/BlueprintModal';
import { BudgetPanel } from '../components/BudgetPanel';
import { DashboardRunsSection } from '../components/DashboardRunsSection';
import { DashboardWorkspaceGrid } from '../components/DashboardWorkspaceGrid';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { UnfinishedImportNote } from '../components/ImportRecovery';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { ProjectAdvisorPanel } from '../components/ProjectAdvisorPanel';
import { ProjectSettingsPanel } from '../components/ProjectSettingsPanel';
import { ProjectStatusAndDemoPanel } from '../components/ProjectStatusAndDemoPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import { ScheduledJobsPanel } from '../components/ScheduledJobsPanel';
import { PageHeader } from '../components/ui/PageHeader';
import { dockerEngineLine, dockerEngineTitle } from '../dockerEngine';
import { type PrunePending, prunePendingNote } from '../gcSummary';
import { useRuns } from '../hooks/liveData';
import { useQueryParam } from '../hooks/navigation';
import { useApi } from '../hooks/useApi';
import type { DashboardRunCategory } from '../runFilter';
import { RoadmapStudioPanel } from './RoadmapPage';
import './dashboard-ux.css';

const OVERVIEW_TABS = ['studio', 'roadmap', 'runs', 'automation', 'system'] as const;
type OverviewTab = (typeof OVERVIEW_TABS)[number];

export function Dashboard({
  system,
  activeProjectId,
  onSelectProject,
  onOpenWizard,
  onInspectRun,
}: {
  system: SystemStatus | undefined;
  activeProjectId?: string | null;
  onSelectProject?: (id: string | null) => void;
  onOpenWizard?: () => void;
  onInspectRun?: (runId: string) => void;
}) {
  const [, navigate] = useLocation();
  const terminals = useApi<TerminalInfo[]>('/api/terminals', 3_000);
  const projects = useApi<Project[]>('/api/projects', 10_000);
  const { runs, loading: runsLoading, error: runsError, refresh: refreshRuns } = useRuns();
  const [sectionParam, setSectionParam] = useQueryParam('section');
  const overviewTab: OverviewTab = OVERVIEW_TABS.includes(sectionParam as OverviewTab)
    ? (sectionParam as OverviewTab)
    : 'studio';
  const setOverviewTab = (tab: OverviewTab) => setSectionParam(tab === 'studio' ? null : tab);
  const [runCategory, setRunCategory] = useState<DashboardRunCategory>('all');
  const [runQuery, setRunQuery] = useState<string>('');
  const [actionError, setActionError] = useState<string>();
  const [cleanupNotice, setCleanupNotice] = useState<string>();
  const [pruneBlocked, setPruneBlocked] = useState<{ id: string; message: string }>();
  const [prunePending, setPrunePending] = useState<PrunePending>();
  const [runFormFor, setRunFormFor] = useState<string>();
  const [runFormPersona, setRunFormPersona] = useState<AgentPersona>('coder');
  const [runFormPrompt, setRunFormPrompt] = useState<string>('');
  const [blueprintFor, setBlueprintFor] = useState<Project>();

  const runnerDown = system?.ptyd !== 'connected';
  const activeProject = useMemo(
    () =>
      (activeProjectId ? projects.data?.find((p) => p.id === activeProjectId) : undefined) ??
      projects.data?.[0],
    [activeProjectId, projects.data],
  );

  const visibleProjects = useMemo(
    () => (activeProject ? [activeProject] : (projects.data ?? [])),
    [activeProject, projects.data],
  );

  const plainTerminals = useMemo(() => {
    const list = terminals.data?.filter((t) => t.kind !== 'agent') ?? [];
    if (activeProject) {
      return list.filter((t) => !t.projectId || t.projectId === activeProject.id);
    }
    return list;
  }, [terminals.data, activeProject]);

  const visibleRuns = useMemo(() => {
    const list = runs ?? [];
    if (activeProject) {
      return list.filter((r) => r.projectId === activeProject.id);
    }
    return list;
  }, [runs, activeProject]);

  const stats = useMemo(() => {
    const all = visibleRuns;
    return {
      working: all.filter((r) => r.state === 'starting' || r.state === 'working').length,
      attention: all.filter((r) => r.state === 'waiting_input' || Boolean(r.attention)).length,
      queuedOrPaused: all.filter((r) => r.state === 'queued' || r.state === 'rate_limited').length,
      completed: all.filter((r) => r.state === 'done').length,
    };
  }, [visibleRuns]);

  const selectStatCategory = (target: DashboardRunCategory) => {
    if (overviewTab === 'runs' && runCategory === target) {
      setRunCategory('all');
    } else {
      setRunCategory(target);
      setOverviewTab('runs');
    }
  };

  const openTerminal = async (kind: 'shell' | 'claude', projectId?: string) => {
    setActionError(undefined);
    try {
      const terminal = await api<TerminalInfo>('/api/terminals', 'POST', { kind, projectId });
      navigate(`/terminals/${terminal.id}`);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const removeTerminal = async (id: string) => {
    try {
      await api(`/api/terminals/${id}`, 'DELETE');
      await terminals.refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const runAction = async (id: string, action: 'stop' | 'remove' | 'resume' | 'prune', force = false) => {
    setActionError(undefined);
    setPruneBlocked(undefined);
    try {
      if (action === 'stop') await api(`/api/runs/${id}/stop`, 'POST');
      else if (action === 'resume') await api(`/api/runs/${id}/resume`, 'POST', {});
      else if (action === 'prune') {
        const res = await api<PruneWorktreeResponse>(
          `/api/runs/${id}/worktree/prune`,
          'POST',
          force ? { force: true } : {},
        );
        setPrunePending(res.pending ? { runId: id, since: res.since ?? null } : undefined);
      } else await api(`/api/runs/${id}`, 'DELETE');
    } catch (e) {
      if (action === 'prune' && e instanceof ApiRequestError && e.code === 'worktree_has_work') {
        setPruneBlocked({ id, message: e.message });
      } else {
        setActionError(errorMessage(e));
      }
    }
  };

  const prunedRun = runs?.find((r) => r.id === prunePending?.runId);
  const pruneEvents = useQuery({
    queryKey: ['prune-outcome', prunePending?.runId, prunePending?.since],
    queryFn: () => api<RunDetail>(`/api/runs/${prunePending!.runId}`),
    enabled: Boolean(prunePending && prunedRun),
    select: (detail) => detail.events,
    refetchInterval: (query) =>
      prunePendingNote(prunePending, runs, query.state.data?.events)?.failed === false ? 5_000 : false,
  });
  const refetchPruneEvents = pruneEvents.refetch;
  const prunedRunEvent = prunedRun?.lastEvent;
  useEffect(() => {
    if (prunedRunEvent !== undefined) void refetchPruneEvents();
  }, [prunedRunEvent, refetchPruneEvents]);
  const pruneNote = prunePendingNote(prunePending, runs, pruneEvents.data);
  const dockerLine = dockerEngineLine(system?.docker);
  const projectName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name;

  return (
    <div className="dashboard">
      {activeProject && <UnfinishedImportNote project={activeProject} />}
      {runnerDown && (
        <div className="banner banner-warn" role="status">
          Runner (ptyd) is {system?.ptyd ?? 'unknown'} — terminals are unavailable until it reconnects.
        </div>
      )}
      {system?.runnerUpdateAvailable && !system.runnerOutdated && (
        <div className="banner banner-info" role="status">
          Runner update available: stopping a run during setup waits for its current command.{' '}
          <code>make up</code> when convenient (restarts agents).
        </div>
      )}
      {dockerLine && system?.docker && (
        <p className="muted dashboard-docker" title={dockerEngineTitle(system.docker)}>
          {dockerLine}
        </p>
      )}
      {system && system.apiVersion !== API_VERSION && (
        <div className="banner banner-warn" role="status">
          <span>Emberline was updated.</span>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
            Reload
          </button>
          <span>to use the new version.</span>
        </div>
      )}
      {Boolean(projects.error && !projects.data) && (
        <ViewErrorBanner label="Could not load projects" error={projects.error} onRetry={projects.refresh} />
      )}
      {cleanupNotice && (
        <div className="banner banner-warn" role="status">
          {cleanupNotice}
        </div>
      )}
      {pruneNote && (
        <div className={`banner ${pruneNote.failed ? 'banner-error' : 'banner-info'}`} role="status">
          {pruneNote.text}
        </div>
      )}
      {pruneBlocked && (
        <div className="banner banner-error" role="alert">
          {pruneBlocked.message}{' '}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runAction(pruneBlocked.id, 'prune', true)}
          >
            Prune anyway
          </button>
        </div>
      )}
      {actionError && (
        <div className="banner banner-error" role="alert">
          {actionError}
        </div>
      )}

      <div className="dashboard-head-stack">
        <PageHeader
          title="Overview"
          actions={
            <div className="segmented overview-tabs" role="tablist" aria-label="Overview sections">
              {(['studio', 'runs'] as const).map((tab) => (
                <button
                  key={tab}
                  id={`overview-tab-${tab}`}
                  type="button"
                  role="tab"
                  aria-selected={overviewTab === tab}
                  className={overviewTab === tab ? 'active' : ''}
                  onClick={() => setOverviewTab(tab)}
                >
                  {tab === 'studio' ? 'Project' : 'Runs'}
                </button>
              ))}
            </div>
          }
        />

        <div className="stat-strip" role="group" aria-label="Filter runs by status">
          {(
            [
              { category: 'working', label: 'Active', value: stats.working, warn: false },
              {
                category: 'attention',
                label: 'Needs your input',
                value: stats.attention,
                warn: stats.attention > 0,
              },
              { category: 'queued', label: 'Queued', value: stats.queuedOrPaused, warn: false },
              { category: 'done', label: 'Completed', value: stats.completed, warn: false },
            ] as const
          ).map((card) => {
            const active = overviewTab === 'runs' && runCategory === card.category;
            return (
              <button
                key={card.category}
                type="button"
                className={`stat-card stat-card-btn${card.warn ? ' stat-card-warn' : ''}${active ? ' stat-card-active' : ''}`}
                aria-pressed={active}
                onClick={() => selectStatCategory(card.category)}
              >
                <span className="stat-label">{card.label}</span>
                <strong className="stat-value mono">{card.value}</strong>
              </button>
            );
          })}
        </div>

        {overviewTab !== 'system' && <QuotaPanel compact />}
      </div>

      {overviewTab === 'studio' && (
        <>
          {projects.loading && !projects.data && !projects.error ? (
            <ViewLoadingState label="Loading workspace…" />
          ) : activeProject ? (
            <>
              <ProjectStatusAndDemoPanel key={`status-${activeProject.id}`} project={activeProject} />
              <ProjectAdvisorPanel
                key={activeProject.id}
                project={activeProject}
                runnerDown={runnerDown}
                onOpenBlueprint={() => setBlueprintFor(activeProject)}
                onStartPersonaRun={(persona, defaultPrompt) => {
                  setRunFormPersona(persona);
                  setRunFormPrompt(defaultPrompt ?? '');
                  setRunFormFor(activeProject.id);
                  setOverviewTab('runs');
                }}
                onRunStarted={(run) => {
                  if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
                  else onInspectRun?.(run.id);
                }}
              />
            </>
          ) : !projects.error ? (
            <section className="panel">
              <header className="panel-head">
                <div>
                  <h2>Create your first project</h2>
                  <p className="muted">Create or clone a repository to get started.</p>
                </div>
                {onOpenWizard && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={onOpenWizard}>
                    Create project
                  </button>
                )}
              </header>
            </section>
          ) : null}
        </>
      )}

      {overviewTab === 'runs' && (
        <>
          <DashboardWorkspaceGrid
            activeProject={activeProject}
            visibleProjects={visibleProjects}
            runnerDown={runnerDown}
            onOpenWizard={onOpenWizard}
            onOpenBlueprint={setBlueprintFor}
            onOpenTerminal={(kind, projectId) => void openTerminal(kind, projectId)}
            onRemoveTerminal={(id) => void removeTerminal(id)}
            onCleanedWorktrees={(notice) => {
              setCleanupNotice(notice);
              setPrunePending(undefined);
            }}
            onActionError={setActionError}
            onProjectDeleted={async (res) => {
              await projects.refresh();
              onSelectProject?.(res.nextActiveProjectId);
            }}
            runFormFor={runFormFor}
            onToggleRunForm={(projectId, persona = 'coder', prompt = '') => {
              setRunFormPersona(persona);
              setRunFormPrompt(prompt);
              setRunFormFor(projectId);
            }}
            runFormPersona={runFormPersona}
            runFormPrompt={runFormPrompt}
            onRunStarted={(run) => {
              setRunFormFor(undefined);
              if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
              else onInspectRun?.(run.id);
            }}
            plainTerminals={plainTerminals}
            terminalsLoading={terminals.loading}
            terminalsError={terminals.error}
            hasTerminalsData={Boolean(terminals.data)}
            onRetryTerminals={terminals.refresh}
            projectName={projectName}
          />

          <DashboardRunsSection
            runs={visibleRuns}
            runsLoading={runsLoading}
            runsError={runsError}
            onRetryRuns={refreshRuns}
            category={runCategory}
            onCategoryChange={setRunCategory}
            query={runQuery}
            onQueryChange={setRunQuery}
            projectName={projectName}
            onInspectRun={onInspectRun}
            onRunAction={(id, action) => void runAction(id, action)}
          />

          <ScheduledJobsPanel projects={visibleProjects} />
          {activeProject && <BudgetPanel key={`budget-${activeProject.id}`} project={activeProject} />}
        </>
      )}

      {overviewTab === 'roadmap' &&
        (activeProject ? (
          <RoadmapStudioPanel key={`roadmap-${activeProject.id}`} projectId={activeProject.id} />
        ) : (
          <section className="panel">
            <div className="empty">
              <p>Select or create a project first to open its roadmap.</p>
              {onOpenWizard && (
                <button type="button" className="btn btn-sm btn-primary" onClick={onOpenWizard}>
                  Create project
                </button>
              )}
            </div>
          </section>
        ))}

      {overviewTab === 'automation' && (
        <>
          {activeProject && <BudgetPanel key={`budget-${activeProject.id}`} project={activeProject} />}
          {activeProject && (
            <ProjectSettingsPanel key={`settings-${activeProject.id}`} project={activeProject} />
          )}
          <ScheduledJobsPanel projects={visibleProjects} />
        </>
      )}

      {overviewTab === 'system' && (
        <>
          <QuotaPanel />
          <NotificationsPanel />
        </>
      )}

      {blueprintFor && (
        <BlueprintModal
          project={blueprintFor}
          open={Boolean(blueprintFor)}
          onClose={() => setBlueprintFor(undefined)}
          onRunStarted={(run) => {
            if (run.terminalId) navigate(`/terminals/${run.terminalId}`);
            else onInspectRun?.(run.id);
          }}
        />
      )}
    </div>
  );
}
