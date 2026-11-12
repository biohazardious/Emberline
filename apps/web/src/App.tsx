import type {
  ActiveProjectPreference,
  ClaudeUsageTelemetry,
  FactorySettings,
  GarbageCollectRunsResponse,
  Project,
  Run,
  SystemStatus,
  UpdatesResponse,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { api, errorMessage, withTimeout } from './api';
import { AuthGate, useAuth } from './auth';
import { AppSidebar } from './components/AppSidebar';
import { AppTopbar } from './components/AppTopbar';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { ProjectDeleted } from './components/ProjectDeleteConfirm';
import { RunInspector } from './components/RunInspector';
import { ScopedPage } from './components/ScopedPage';
import {
  OpsMissingBanner,
  RunnerNotAnsweringBanner,
  RunnerNotSecuredBanner,
  RunnerSecurityUpdateBanner,
  SecurityBanner,
  SshKeyMissingBanner,
} from './components/SecurityBanner';
import { ProjectWizard } from './components/wizard/WizardShell';
import { keptWorktreesSummary } from './gcSummary';
import { setPresenceRun } from './hooks/eventHub';
import { LiveEvents, useRuns, useScheduler } from './hooks/liveData';
import { useTrackPageViews } from './hooks/navigation';
import { useApi } from './hooks/useApi';
import { useAttention } from './hooks/useAttention';
import { Dashboard } from './pages/Dashboard';
import { RoadmapPage } from './pages/RoadmapPage';
import {
  inActiveScope,
  pageScope,
  projectIdFromPath,
  resolveActiveProject,
  SERVER_CHOICE_WAIT_MS,
  switchProjectPath,
} from './projectPaths';
import { Toasts, toastError, toastInfo } from './toast';

const TerminalPage = lazy(() => import('./pages/TerminalPage').then((m) => ({ default: m.TerminalPage })));
const BoardPage = lazy(() => import('./pages/BoardPage').then((m) => ({ default: m.BoardPage })));
const FleetPage = lazy(() => import('./pages/FleetPage').then((m) => ({ default: m.FleetPage })));
const ReviewPage = lazy(() => import('./pages/ReviewPage').then((m) => ({ default: m.ReviewPage })));
const BuildOutputsPage = lazy(() =>
  import('./pages/BuildOutputsPage').then((m) => ({ default: m.BuildOutputsPage })),
);
const CodeExplorerPage = lazy(() =>
  import('./pages/CodeExplorerPage').then((m) => ({ default: m.CodeExplorerPage })),
);
const LiveBrowserPage = lazy(() =>
  import('./pages/LiveBrowserPage').then((m) => ({ default: m.LiveBrowserPage })),
);
const ProjectSettingsPage = lazy(() =>
  import('./pages/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })),
);
const InboxPage = lazy(() => import('./pages/InboxPage').then((m) => ({ default: m.InboxPage })));
const DockerPage = lazy(() => import('./pages/DockerPage').then((m) => ({ default: m.DockerPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const ACTIVE_PROJECT_STORAGE_KEY = 'emberline.activeProjectId';
const THEME_STORAGE_KEY = 'emberline.theme';

export function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

function Shell() {
  const { logout } = useAuth();
  const [location, navigate] = useLocation();
  useTrackPageViews();
  const system = useApi<SystemStatus>('/api/system', 5_000);
  const updates = useApi<UpdatesResponse>('/api/updates', 5 * 60_000);
  const updatesAvailable = updates.data?.status.available ?? 0;
  const projects = useApi<Project[]>('/api/projects', 10_000);
  const claudeUsage = useApi<ClaudeUsageTelemetry>('/api/factory/claude-usage', 30_000);
  const factorySettings = useApi<FactorySettings>('/api/factory/settings', 15_000);
  const { runs, loading: runsLoading, error: runsError, refresh: refreshRuns } = useRuns();
  const { scheduler } = useScheduler();

  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore storage errors
    }
    return 'dark';
  });

  const serverTheme = useRef<'dark' | 'light' | undefined>(undefined);

  const applyTheme = useCallback(
    (next: 'dark' | 'light') => {
      setTheme(next);
      serverTheme.current = next;
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // ignore storage errors
      }
      api<FactorySettings>('/api/factory/settings', 'PATCH', { theme: next })
        .then((saved) => queryClient.setQueryData(['api', '/api/factory/settings'], saved))
        .catch((e: unknown) => toastError(`Could not save the theme: ${errorMessage(e)}`));
    },
    [queryClient],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const remote = factorySettings.data?.theme;
    if (remote !== 'light' && remote !== 'dark') return;
    if (remote === serverTheme.current) return;
    serverTheme.current = remote;
    setTheme(remote);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, remote);
    } catch {
      // ignore storage errors
    }
  }, [factorySettings.data]);

  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [inspectRunId, setInspectRunId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const ptyd = system.data?.ptyd ?? 'connecting';

  const [serverActiveId, setServerActiveId] = useState<string | null | undefined>(undefined);
  const [serverFailed, setServerFailed] = useState(false);
  const picked = useRef(false);
  const fallbackPick = useRef<string | null>(null);
  const projectList = useRef(projects.data);
  projectList.current = projects.data;
  const selectProject = useCallback((id: string | null) => {
    picked.current = true;
    setActiveProjectId(id);
    setServerActiveId(id);
    try {
      if (id) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id);
      else localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    void api<ActiveProjectPreference>('/api/projects/active', 'PUT', { activeProjectId: id }).catch(
      (e: unknown) => toastError(`Could not remember the active project: ${errorMessage(e)}`),
    );
  }, []);

  const askedServer = useRef(false);
  const urlProjectId = projectIdFromPath(location);
  const resolution = useMemo(
    () =>
      projects.data
        ? resolveActiveProject(
            projects.data.map((p) => p.id),
            { fromUrl: urlProjectId, stored: activeProjectId, server: serverActiveId, serverFailed },
          )
        : { id: undefined, remember: true },
    [projects.data, urlProjectId, activeProjectId, serverActiveId, serverFailed],
  );
  useEffect(() => {
    if (!projects.data) return;
    if (resolution.id === undefined) {
      if (askedServer.current) return;
      askedServer.current = true;
      const request = api<ActiveProjectPreference>('/api/projects/active');
      void withTimeout(request, SERVER_CHOICE_WAIT_MS)
        .then((pref) => setServerActiveId(pref.activeProjectId ?? null))
        .catch(() => {
          setServerFailed(true);
          request
            .then((pref) => {
              if (picked.current) return;
              const saved = projectList.current?.find((p) => p.id === pref.activeProjectId);
              if (saved && saved.id !== fallbackPick.current)
                toastInfo(`Switched to ${saved.name}, the active project saved on the server.`);
              setActiveProjectId(null);
              setServerActiveId(pref.activeProjectId ?? null);
              setServerFailed(false);
            })
            .catch(() => undefined);
        });
      return;
    }
    if (resolution.id && resolution.id !== activeProjectId) {
      if (resolution.remember) selectProject(resolution.id);
      else {
        fallbackPick.current = resolution.id;
        setActiveProjectId(resolution.id);
      }
    }
  }, [projects.data, resolution, activeProjectId, selectProject]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((open) => !open);
      } else if (e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        openNextAttentionRef.current();
      } else if (e.key === 'Escape' && mobileNavOpen) {
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const activeProject = useMemo(
    () => (resolution.id ? projectById.get(resolution.id) : undefined),
    [resolution.id, projectById],
  );
  const scope = pageScope(resolution.id, !projects.data && projects.error !== undefined);

  const activeRuns = useMemo(() => {
    const list = (runs ?? []).filter(
      (r) =>
        !r.endedAt &&
        r.state !== 'done' &&
        r.state !== 'failed' &&
        inActiveScope(projects.data ? resolution.id : undefined, r.projectId),
    );
    return list.sort((a, b) => {
      const rank = (s: string) => (s === 'waiting_input' ? 0 : s === 'working' || s === 'starting' ? 1 : 2);
      return rank(a.state) - rank(b.state);
    });
  }, [runs, projects.data, resolution.id]);

  const inspectedRun = useMemo(() => (runs ?? []).find((r) => r.id === inspectRunId), [runs, inspectRunId]);

  const openRun = useCallback((run: Run) => setInspectRunId(run.id), []);
  const attention = useAttention(runs, openRun);
  const openNextAttention = useCallback(() => {
    const next = attention.items[0];
    if (next) setInspectRunId(next.id);
  }, [attention.items]);
  useEffect(() => {
    setPresenceRun(inspectRunId ?? null, 'inspector');
  }, [inspectRunId]);
  const openNextAttentionRef = useRef(openNextAttention);
  openNextAttentionRef.current = openNextAttention;

  const handleSwitchProject = (nextId: string) => {
    if (nextId === '__new__') {
      setWizardOpen(true);
      return;
    }
    const targetId = nextId || null;
    selectProject(targetId);
    const next = targetId ? switchProjectPath(location, targetId) : null;
    if (next && next !== location) navigate(next);
  };

  const handleCleanupProjectWorktrees = async () => {
    if (!activeProject) return;
    try {
      const res = await api<GarbageCollectRunsResponse>(
        `/api/projects/${activeProject.id}/cleanup-worktrees`,
        'POST',
      );
      const kept = keptWorktreesSummary(res);
      if (kept && res.prunedWorktrees === 0) toastInfo(kept);
      else toastInfo(kept ? `Finished worktrees cleaned up. ${kept}` : 'Finished worktrees cleaned up.');
    } catch (e) {
      toastError(`Cleanup failed: ${errorMessage(e)}`);
    }
  };

  const handleProjectDeleted = async (res: ProjectDeleted) => {
    await projects.refresh();
    handleSwitchProject(res.nextActiveProjectId ?? '');
    if (!res.nextActiveProjectId) navigate('/');
  };

  return (
    <div className={`app workbench${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <LiveEvents />
      <Toasts />
      <AppSidebar
        sidebarCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        mobileNavOpen={mobileNavOpen}
        onCloseMobileNav={() => setMobileNavOpen(false)}
        location={location}
        system={system.data}
        updatesAvailable={updatesAvailable}
        projects={projects.data ?? []}
        activeProject={activeProject}
        onSwitchProject={handleSwitchProject}
        onOpenWizard={() => setWizardOpen(true)}
        onCleanupWorktrees={() => void handleCleanupProjectWorktrees()}
        onProjectDeleted={handleProjectDeleted}
        onOpenCommandPalette={() => setCmdOpen(true)}
        attentionCount={attention.count}
        activeRuns={activeRuns}
        projectById={projectById}
        inspectRunId={inspectRunId}
        onToggleInspectRun={(id) => setInspectRunId(inspectRunId === id ? undefined : id)}
        scheduler={scheduler}
        claudeUsage={claudeUsage.data}
        factorySettings={factorySettings.data}
        allRuns={runs}
        theme={theme}
        onToggleTheme={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
        onLogout={() => void logout()}
      />

      {mobileNavOpen && <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />}

      <div className="workbench-main">
        <AppTopbar
          location={location}
          activeProject={activeProject}
          mobileNavOpen={mobileNavOpen}
          onToggleMobileNav={() => setMobileNavOpen((v) => !v)}
          attentionCount={attention.count}
          onOpenWizard={() => setWizardOpen(true)}
          theme={theme}
          onToggleTheme={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
          onOpenInbox={() => navigate('/inbox')}
          onOpenCommandPalette={() => setCmdOpen(true)}
          ptyd={ptyd}
          onLogout={() => void logout()}
        />

        <SecurityBanner />
        <OpsMissingBanner missing={system.data?.opsMissing} />
        <SshKeyMissingBanner projects={system.data?.sshKeyMissing} />
        <RunnerSecurityUpdateBanner outdated={system.data?.runnerOutdated} />
        <RunnerNotSecuredBanner notSecured={system.data?.runnerNotSecured} />
        <RunnerNotAnsweringBanner problem={system.data?.runnerProblem} />

        <div className="workbench-stage">
          <main className="content">
            <ErrorBoundary resetKey={location}>
              <Switch>
                <Route path="/terminals/:id">
                  {(params) => (
                    <Suspense fallback={<div className="term-shell" aria-busy="true" />}>
                      <TerminalPage id={params.id} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/runs/:id/review">
                  {(params) => (
                    <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                      <ReviewPage key={params.id} id={params.id} onInspectRun={(id) => setInspectRunId(id)} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/projects/:id/roadmap">
                  {(params) => <RoadmapPage key={params.id} projectId={params.id} />}
                </Route>
                <Route path="/projects/:id/board">
                  {(params) => (
                    <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                      <BoardPage key={params.id} projectId={params.id} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/projects/:id/settings">
                  {(params) => (
                    <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                      <ProjectSettingsPage key={params.id} projectId={params.id} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/projects/:id/code">
                  {(params) => (
                    <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                      <CodeExplorerPage key={params.id} projectId={params.id} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/projects/:id/outputs">
                  {(params) => (
                    <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                      <BuildOutputsPage key={params.id} projectId={params.id} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/projects/:id/browser">
                  {(params) => (
                    <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                      <LiveBrowserPage key={params.id} projectId={params.id} />
                    </Suspense>
                  )}
                </Route>
                <Route path="/settings">
                  <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                    <SettingsPage theme={theme} onChangeTheme={applyTheme} />
                  </Suspense>
                </Route>
                <Route path="/inbox">
                  <Suspense fallback={<div className="inbox-page" aria-busy="true" />}>
                    <ScopedPage scope={scope} pendingClassName="inbox-page">
                      {(activeProjectId) => (
                        <InboxPage
                          runs={runs}
                          runsLoading={runsLoading}
                          runsError={runsError}
                          onRetryRuns={refreshRuns}
                          seen={attention.seen}
                          activeProjectId={activeProjectId}
                          projectName={activeProject?.name}
                          onOpenRun={(id) => setInspectRunId(id)}
                          onDismiss={attention.dismiss}
                        />
                      )}
                    </ScopedPage>
                  </Suspense>
                </Route>
                <Route path="/docker">
                  <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                    <ScopedPage scope={scope} pendingClassName="board-page">
                      {(activeProjectId) => (
                        <DockerPage activeProjectId={activeProjectId} projects={projects.data} />
                      )}
                    </ScopedPage>
                  </Suspense>
                </Route>
                <Route path="/fleet">
                  <Suspense fallback={<div className="fleet-page" aria-busy="true" />}>
                    <ScopedPage scope={scope} pendingClassName="fleet-page">
                      {(activeProjectId) => (
                        <FleetPage
                          activeProjectId={activeProjectId}
                          seen={attention.seen}
                          onInspectRun={(id) => setInspectRunId(id)}
                        />
                      )}
                    </ScopedPage>
                  </Suspense>
                </Route>
                <Route path="/">
                  <h1 className="sr-only">Emberline dashboard</h1>
                  <ScopedPage scope={scope} pendingClassName="dashboard">
                    {(activeProjectId) => (
                      <Dashboard
                        system={system.data}
                        activeProjectId={activeProjectId}
                        onSelectProject={selectProject}
                        onOpenWizard={() => setWizardOpen(true)}
                        onInspectRun={(id) => setInspectRunId(id)}
                      />
                    )}
                  </ScopedPage>
                </Route>
                <Route>
                  <div className="empty">
                    <p>Page not found.</p>
                    <Link href="/">Back to dashboard</Link>
                  </div>
                </Route>
              </Switch>
            </ErrorBoundary>
          </main>

          {inspectedRun && (
            <ErrorBoundary resetKey={inspectedRun.id} compact title="Run inspector error">
              <RunInspector
                key={inspectedRun.id}
                run={inspectedRun}
                projectName={projectById.get(inspectedRun.projectId)?.name}
                onClose={() => setInspectRunId(undefined)}
              />
            </ErrorBoundary>
          )}
        </div>
      </div>

      <ProjectWizard
        open={wizardOpen}
        runnerDown={ptyd !== 'connected'}
        onClose={() => setWizardOpen(false)}
        onProjectsChanged={() => void projects.refresh()}
        onCreated={async (project) => {
          await projects.refresh();
          selectProject(project.id);
          navigate(`/projects/${project.id}/board`);
        }}
      />

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        projects={projects.data ?? []}
        runs={(runs ?? []).filter((r) =>
          inActiveScope(projects.data ? resolution.id : undefined, r.projectId),
        )}
        scheduler={scheduler}
        dockerEnabled={Boolean(system.data?.docker?.enabled)}
        onInspectRun={(id) => setInspectRunId(id)}
        onLogout={() => void logout()}
      />
    </div>
  );
}
