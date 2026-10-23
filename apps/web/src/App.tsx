import {
  type ActiveProjectPreference,
  type AgentId,
  type ClaudeUsageTelemetry,
  type FactorySettings,
  type GarbageCollectRunsResponse,
  type Project,
  PROVIDER_REGISTRY,
  type Run,
  type SystemStatus,
  type UpdatesResponse,
} from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronsLeft,
  ChevronsRight,
  Container,
  Eraser,
  FileCode,
  Globe,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Menu,
  Moon,
  Package,
  Search,
  Settings,
  SquareKanban,
  Sun,
  Target,
  Trash,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { api, errorMessage, withTimeout } from './api';
import { keptWorktreesSummary } from './gcSummary';
import { AuthGate, useAuth } from './auth';
import { BrandLogo } from './components/BrandLogo';
import { CommandPalette } from './components/CommandPalette';
import { PersonaBadge } from './components/PersonaBadge';
import { ProjectDeleteConfirm, type ProjectDeleted } from './components/ProjectDeleteConfirm';
import { ProjectWizard } from './components/wizard/WizardShell';
import { formatClaudePlanLabel, formatTokensCompact } from './components/QuotaPanel';
import { ProviderMark } from './components/ProviderMark';
import { RunInspector } from './components/RunInspector';
import { ScopedPage } from './components/ScopedPage';
import { SecurityBanner } from './components/SecurityBanner';
import { RunStatePill } from './components/RunStatePill';
import { useApi } from './hooks/useApi';
import { LiveEvents, useRuns, useScheduler } from './hooks/liveData';
import { useTrackPageViews } from './hooks/navigation';
import { setPresenceRun } from './hooks/eventHub';
import { useAttention } from './hooks/useAttention';
import {
  inActiveScope,
  pageScope,
  projectIdFromPath,
  resolveActiveProject,
  SERVER_CHOICE_WAIT_MS,
  switchProjectPath,
} from './projectPaths';
import { Dashboard } from './pages/Dashboard';
import { Toasts, toastError, toastInfo } from './toast';

// xterm.js and Monaco are the bulk of the bundle; only load them when opened.
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
const RoadmapPage = lazy(() => import('./pages/RoadmapPage').then((m) => ({ default: m.RoadmapPage })));
const ProjectSettingsPage = lazy(() =>
  import('./pages/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })),
);
const InboxPage = lazy(() => import('./pages/InboxPage').then((m) => ({ default: m.InboxPage })));
const DockerPage = lazy(() => import('./pages/DockerPage').then((m) => ({ default: m.DockerPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const ACTIVE_PROJECT_STORAGE_KEY = 'emberline.activeProjectId';
const THEME_STORAGE_KEY = 'emberline.theme';
const SIDEBAR_PROVIDER_STORAGE_KEY = 'emberline.sidebarProvider';

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
  const { runs } = useRuns();
  const { scheduler } = useScheduler();

  const [sidebarProvider, setSidebarProvider] = useState<AgentId>(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_PROVIDER_STORAGE_KEY) as AgentId | null;
      if (saved && saved in PROVIDER_REGISTRY) return saved;
    } catch {
      // ignore storage errors
    }
    return 'claude';
  });

  const activeSidebarProviders = useMemo<AgentId[]>(() => {
    const set = new Set<AgentId>(
      factorySettings.data?.enabledProviders?.length ? factorySettings.data.enabledProviders : ['claude'],
    );
    const personaAgents = factorySettings.data?.personaAgents;
    if (personaAgents) {
      for (const ag of Object.values(personaAgents)) {
        if (ag in PROVIDER_REGISTRY) set.add(ag);
      }
    }
    if (set.size === 0) set.add('claude');
    return Array.from(set);
  }, [factorySettings.data]);

  const currentSidebarProvider: AgentId = activeSidebarProviders.includes(sidebarProvider)
    ? sidebarProvider
    : (activeSidebarProviders[0] ?? 'claude');

  const selectSidebarProvider = useCallback((next: AgentId) => {
    setSidebarProvider(next);
    try {
      localStorage.setItem(SIDEBAR_PROVIDER_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

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

  /** The theme last seen on the server; a change there (another device) is adopted, a local toggle is not undone. */
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
  // Whether the person (or a project page's URL) picked a project: the server's choice arriving after
  // the wait never replaces that pick.
  const picked = useRef(false);
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

  // The server's stored choice, asked once when neither the URL nor this browser names a usable project.
  const askedServer = useRef(false);
  const urlProjectId = projectIdFromPath(location);
  // Any /projects/<id>/… page makes <id> the active project; a stale or missing stored id resolves to
  // the server's choice (else the first project), and the result is stored so every view agrees.
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
      // Bounded: the pages wait for this answer, and a request that never answers must not keep them blank.
      const request = api<ActiveProjectPreference>('/api/projects/active');
      void withTimeout(request, SERVER_CHOICE_WAIT_MS)
        .then((pref) => setServerActiveId(pref.activeProjectId ?? null))
        .catch(() => {
          setServerFailed(true);
          // An answer after the wait replaces the fallback's pick (never stored), unless a project
          // was picked since.
          request
            .then((pref) => {
              if (picked.current) return;
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
      else setActiveProjectId(resolution.id);
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
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);
  const activeProject = useMemo(
    () => (resolution.id ? projectById.get(resolution.id) : undefined),
    [resolution.id, projectById],
  );
  // Inbox, Docker, Fleet and the dashboard wait for the active project instead of showing every project first.
  const scope = pageScope(resolution.id, !projects.data && projects.error !== undefined);

  // Scope active fleet strictly to the active project so other projects' runs never clutter the sidebar
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
  /** Docks the run that has waited longest for the user (the oldest Inbox item). */
  const openNextAttention = useCallback(() => {
    const next = attention.items[0];
    if (next) setInspectRunId(next.id);
  }, [attention.items]);
  // Core suppresses a page while this tab shows exactly that run.
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
    // On any per-project page (board, roadmap, code, outputs, browser, settings, and later ones), open the same page of the new project.
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

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const handleProjectDeleted = async (res: ProjectDeleted) => {
    setDeleteConfirmOpen(false);
    await projects.refresh();
    handleSwitchProject(res.nextActiveProjectId ?? '');
    if (!res.nextActiveProjectId) navigate('/');
  };

  return (
    <div className={`app workbench${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <LiveEvents />
      <Toasts />
      <aside className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`} aria-label="Workspace navigation">
        <div className="sidebar-top">
          <Link href="/" className="brand" title="Emberline — AI Coding Factory">
            <BrandLogo size={24} />
            <span className="brand-name">Emberline</span>
            {system.data?.version && <span className="brand-version mono">v{system.data.version}</span>}
          </Link>
          {updatesAvailable > 0 && (
            <Link
              href="/settings?tab=updates"
              className="update-dot"
              aria-label={`${updatesAvailable} update${updatesAvailable === 1 ? '' : 's'} available`}
              title={`${updatesAvailable} update${updatesAvailable === 1 ? '' : 's'} available`}
            />
          )}
          <button
            type="button"
            className="icon-btn sidebar-collapse-btn hide-sm"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? (
              <ChevronsRight className="icon" aria-hidden />
            ) : (
              <ChevronsLeft className="icon" aria-hidden />
            )}
          </button>
        </div>

        {!sidebarCollapsed && (
          <div
            style={{
              padding: '0 8px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}
            >
              <span className="eyebrow">Active Project</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {activeProject && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      style={{ padding: '2px 5px', fontSize: '0.72rem' }}
                      onClick={() => void handleCleanupProjectWorktrees()}
                      title={`Prune finished git worktrees for ${activeProject.name}`}
                    >
                      <Eraser className="icon" aria-hidden />
                    </button>
                    <button
                      id="sidebar-delete-project"
                      type="button"
                      className="btn btn-sm btn-ghost"
                      style={{ padding: '2px 5px', fontSize: '0.72rem', color: 'var(--danger)' }}
                      aria-expanded={deleteConfirmOpen}
                      onClick={() => setDeleteConfirmOpen((v) => !v)}
                      title={`Remove project ${activeProject.name}`}
                    >
                      <Trash className="icon" aria-hidden />
                    </button>
                  </>
                )}
                <button
                  id="sidebar-new-project"
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                  onClick={() => setWizardOpen(true)}
                  title="Create new project with AI Factory Wizard or Git Clone"
                >
                  + New
                </button>
              </div>
            </div>
            <select
              id="project-switcher"
              className="input"
              aria-label="Switch active project"
              style={{ width: '100%', padding: '6px 8px', fontSize: '0.85rem' }}
              value={activeProject?.id ?? ''}
              onChange={(e) => handleSwitchProject(e.target.value)}
            >
              {(projects.data?.length ?? 0) === 0 && <option value="">No projects yet</option>}
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="__new__">+ Create New Project…</option>
            </select>
            {activeProject && deleteConfirmOpen && (
              <ProjectDeleteConfirm
                key={activeProject.id}
                project={activeProject}
                onCancel={() => setDeleteConfirmOpen(false)}
                onDeleted={handleProjectDeleted}
              />
            )}
          </div>
        )}

        <button
          id="cmd-trigger"
          type="button"
          className="cmd-trigger"
          onClick={() => setCmdOpen(true)}
          title="Open command palette (⌘K / Ctrl+K)"
        >
          <span className="cmd-trigger-icon mono" aria-hidden="true">
            <Search className="icon" aria-hidden />
          </span>
          <span className="cmd-trigger-text">Search or jump…</span>
          <kbd className="kbd">⌘K</kbd>
        </button>

        <nav className="sidebar-nav" aria-label="Main views">
          <Link href="/" className={`nav-item${location === '/' ? ' active' : ''}`} title="Factory Overview">
            <span className="nav-icon mono">
              <LayoutDashboard className="icon" aria-hidden />
            </span>
            <span className="nav-label">Factory Overview</span>
          </Link>
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/roadmap`}
              className={`nav-item${location === `/projects/${activeProject.id}/roadmap` ? ' active' : ''}`}
              title="Roadmap & AI Brainstorming Studio"
            >
              <span className="nav-icon mono">
                <Target className="icon" aria-hidden />
              </span>
              <span className="nav-label">Roadmap & Brainstorm</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/board`}
              className={`nav-item${location === `/projects/${activeProject.id}/board` ? ' active' : ''}`}
              title="Kanban Board"
            >
              <span className="nav-icon mono">
                <SquareKanban className="icon" aria-hidden />
              </span>
              <span className="nav-label">Kanban Board</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/code`}
              className={`nav-item${location === `/projects/${activeProject.id}/code` ? ' active' : ''}`}
              title="Code Explorer"
            >
              <span className="nav-icon mono">
                <FileCode className="icon" aria-hidden />
              </span>
              <span className="nav-label">Code Explorer</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/outputs`}
              className={`nav-item${location === `/projects/${activeProject.id}/outputs` ? ' active' : ''}`}
              title="Build Outputs"
            >
              <span className="nav-icon mono">
                <Package className="icon" aria-hidden />
              </span>
              <span className="nav-label">Build Outputs</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/browser`}
              className={`nav-item${location === `/projects/${activeProject.id}/browser` ? ' active' : ''}`}
              title="Live Browser Studio"
            >
              <span className="nav-icon mono">
                <Globe className="icon" aria-hidden />
              </span>
              <span className="nav-label">Live Browser</span>
            </Link>
          )}
          <Link
            id="nav-inbox"
            href="/inbox"
            className={`nav-item${location === '/inbox' ? ' active' : ''}`}
            title="Inbox: runs that need you (Alt+N opens the oldest)"
          >
            <span className="nav-icon mono">
              <Inbox className="icon" aria-hidden />
            </span>
            <span className="nav-label">Inbox</span>
            {attention.count > 0 && (
              <span className="nav-badge nav-badge-warn mono" title="Runs that need you, all projects">
                {attention.count}
              </span>
            )}
          </Link>
          <Link
            id="nav-fleet"
            href="/fleet"
            className={`nav-item${location === '/fleet' ? ' active' : ''}`}
            title="Fleet Multiplexer"
          >
            <span className="nav-icon mono">
              <LayoutGrid className="icon" aria-hidden />
            </span>
            <span className="nav-label">Fleet Multiplexer</span>
            {attention.count > 0 && (
              <span className="nav-badge nav-badge-warn mono" title="Runs that need you, all projects">
                {attention.count}
              </span>
            )}
          </Link>
          {system.data?.docker?.enabled && (
            <Link
              id="nav-docker"
              href="/docker"
              className={`nav-item${location === '/docker' ? ' active' : ''}`}
              title="Docker: Emberline's compose projects in the Docker engine"
            >
              <span className="nav-icon mono">
                <Container className="icon" aria-hidden />
              </span>
              <span className="nav-label">Docker</span>
            </Link>
          )}
          <Link
            id="nav-settings"
            href="/settings"
            className={`nav-item${location === '/settings' ? ' active' : ''}`}
            title="Factory Settings"
          >
            <span className="nav-icon mono">
              <Settings className="icon" aria-hidden />
            </span>
            <span className="nav-label">Factory Settings</span>
          </Link>
        </nav>

        <div className="sidebar-section sidebar-section-grow">
          <div className="sidebar-section-head">
            <span className="eyebrow">Active Fleet</span>
            <span className="sidebar-count mono">{activeRuns.length}</span>
          </div>
          <ul className="sidebar-list">
            {activeRuns.map((r) => {
              const title = r.title ?? projectById.get(r.projectId)?.name ?? 'Run';
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`nav-item nav-run${inspectRunId === r.id ? ' active' : ''}`}
                    onClick={() => setInspectRunId(inspectRunId === r.id ? undefined : r.id)}
                    title={`${title} (${r.state}) — click to dock inspector`}
                  >
                    <span className={`dot run-${r.state}`} />
                    <span className="nav-label">{title}</span>
                    {r.persona && r.persona !== 'coder' && <PersonaBadge persona={r.persona} />}
                    <RunStatePill
                      state={r.state}
                      cancelled={r.cancelled}
                      autoRetry={r.autoRetry}
                      handedOffTo={r.handedOffTo}
                    />
                  </button>
                </li>
              );
            })}
            {activeRuns.length === 0 && <li className="sidebar-empty muted small">All agents idle</li>}
          </ul>
        </div>

        <footer className="sidebar-foot">
          {scheduler && (
            <div className={`sidebar-quota${scheduler.windows.length > 0 ? ' sidebar-quota-paused' : ''}`}>
              <span className="dot" />
              <span className="mono">
                {scheduler.windows.length > 0
                  ? `${scheduler.windows.length} lane${scheduler.windows.length > 1 ? 's' : ''} out of quota`
                  : `${scheduler.busy}/${scheduler.maxConcurrentRuns} slots`}
              </span>
            </div>
          )}
          {!sidebarCollapsed &&
            (() => {
              const entry = PROVIDER_REGISTRY[currentSidebarProvider];
              const authInfo = factorySettings.data?.providerAuth?.[currentSidebarProvider];
              const isClaude = currentSidebarProvider === 'claude';
              const isAuthed =
                authInfo?.authenticated ?? (isClaude ? Boolean(claudeUsage.data?.authenticated) : true);
              const providerBucket =
                claudeUsage.data?.providerTokens?.[currentSidebarProvider] ??
                (isClaude && claudeUsage.data
                  ? {
                      hourlyTokens: claudeUsage.data.hourlyTokens,
                      dailyTokens: claudeUsage.data.dailyTokens,
                      weeklyTokens: claudeUsage.data.weeklyTokens,
                    }
                  : undefined);
              const providerRuns = (runs ?? []).filter((r) => r.agent === currentSidebarProvider);
              const activeProviderRuns = providerRuns.filter(
                (r) => !r.endedAt && r.state !== 'done' && r.state !== 'failed',
              ).length;
              const doneProviderRuns = providerRuns.filter((r) => r.state === 'done').length;

              return (
                <div
                  id="sidebar-provider-telemetry"
                  className="mono muted"
                  style={{
                    fontSize: '0.72rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                    padding: '7px 8px',
                    borderRadius: 'var(--radius)',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {activeSidebarProviders.length > 1 && (
                    <div
                      role="tablist"
                      aria-label="Active AI Providers"
                      style={{
                        display: 'flex',
                        gap: 4,
                        flexWrap: 'wrap',
                        paddingBottom: 4,
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      {activeSidebarProviders.map((pid) => {
                        const pEntry = PROVIDER_REGISTRY[pid];
                        const pAuth =
                          factorySettings.data?.providerAuth?.[pid]?.authenticated ??
                          (pid === 'claude' ? Boolean(claudeUsage.data?.authenticated) : true);
                        const selected = pid === currentSidebarProvider;
                        return (
                          <button
                            key={pid}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            onClick={() => selectSidebarProvider(pid)}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              padding: '3px 6px',
                              fontSize: '0.68rem',
                              fontFamily: 'inherit',
                              fontWeight: selected ? 700 : 500,
                              borderRadius: 5,
                              border: selected ? '1px solid var(--accent)' : '1px solid transparent',
                              background: selected
                                ? 'color-mix(in srgb, var(--info) 16%, transparent)'
                                : 'transparent',
                              color: selected ? 'var(--text)' : 'var(--text-muted)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 4,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={`Switch telemetry view to ${pEntry.label}`}
                          >
                            <span
                              style={{
                                width: 5,
                                height: 5,
                                borderRadius: '50%',
                                background: pAuth ? 'var(--ok)' : 'var(--warn)',
                                flexShrink: 0,
                              }}
                            />
                            <span>
                              <ProviderMark id={pEntry.id} />
                              {pEntry.shortLabel}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text)' }}>
                    <strong>
                      <ProviderMark id={entry.id} />
                      {isClaude ? formatClaudePlanLabel(claudeUsage.data) : entry.shortLabel}
                    </strong>
                    <span style={{ color: isAuthed ? 'var(--ok)' : 'var(--warn)' }}>
                      ● {isAuthed ? 'active' : 'setup'}
                    </span>
                  </div>

                  {isClaude && claudeUsage.data ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>5h: {Math.round(claudeUsage.data.fiveHour?.utilizationPercent ?? 0)}%</span>
                      <span>7d: {Math.round(claudeUsage.data.sevenDay?.utilizationPercent ?? 0)}%</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Turns: {providerBucket ? providerBucket.weeklyTokens.turnCount : 0}</span>
                      <span>
                        Runs: {activeProviderRuns > 0 ? `${activeProviderRuns} live / ` : ''}
                        {doneProviderRuns} done
                      </span>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>1h: {formatTokensCompact(providerBucket?.hourlyTokens.totalTokens ?? 0)}</span>
                    <span>7d: {formatTokensCompact(providerBucket?.weeklyTokens.totalTokens ?? 0)}</span>
                  </div>
                </div>
              );
            })()}
          <div className="sidebar-mobile-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? (
                <Sun className="icon" aria-hidden />
              ) : (
                <Moon className="icon" aria-hidden />
              )}
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </footer>
      </aside>

      {mobileNavOpen && <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />}

      <div className="workbench-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="btn btn-ghost btn-sm mobile-menu-btn"
              aria-label="Toggle navigation"
              onClick={() => setMobileNavOpen((v) => !v)}
            >
              <Menu className="icon" aria-hidden />
            </button>
            <div className="topbar-tabs">
              <Link href="/" className={`topbar-tab${location === '/' ? ' active' : ''}`} title="Overview">
                <LayoutDashboard className="icon" aria-hidden /> <span className="tab-label">Overview</span>
              </Link>
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/roadmap`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/roadmap` ? ' active' : ''}`}
                  title="Roadmap"
                >
                  <Target className="icon" aria-hidden /> <span className="tab-label">Roadmap</span>
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/board`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/board` ? ' active' : ''}`}
                  title="Board"
                >
                  <SquareKanban className="icon" aria-hidden /> <span className="tab-label">Board</span>
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/code`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/code` ? ' active' : ''}`}
                  title="Code Explorer"
                >
                  <FileCode className="icon" aria-hidden /> <span className="tab-label">Code Explorer</span>
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/outputs`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/outputs` ? ' active' : ''}`}
                  title="Build Outputs"
                >
                  <Package className="icon" aria-hidden /> <span className="tab-label">Build Outputs</span>
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/browser`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/browser` ? ' active' : ''}`}
                  title="Live Browser"
                >
                  <Globe className="icon" aria-hidden /> <span className="tab-label">Live Browser</span>
                </Link>
              )}
              <Link
                href="/fleet"
                className={`topbar-tab${location === '/fleet' ? ' active' : ''}`}
                title="Fleet"
              >
                <LayoutGrid className="icon" aria-hidden /> <span className="tab-label">Fleet</span>
                {attention.count > 0 && <span className="badge mono">{attention.count}</span>}
              </Link>
              <Link
                href="/settings"
                className={`topbar-tab${location === '/settings' ? ' active' : ''}`}
                title="Settings"
              >
                <Settings className="icon" aria-hidden /> <span className="tab-label">Settings</span>
              </Link>
            </div>
          </div>

          <div className="topbar-right">
            <button
              id="topbar-new-project"
              type="button"
              className="btn btn-sm hide-sm"
              onClick={() => setWizardOpen(true)}
            >
              + New Project
            </button>
            <button
              id="theme-toggle"
              type="button"
              className="btn btn-ghost btn-sm hide-mobile"
              onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
              title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="icon" aria-hidden /> <span className="tab-label">Light</span>
                </>
              ) : (
                <>
                  <Moon className="icon" aria-hidden /> <span className="tab-label">Dark</span>
                </>
              )}
            </button>
            {attention.count > 0 && (
              <button
                id="attention-pill"
                type="button"
                className="pill pill-attention"
                onClick={() => navigate('/inbox')}
                title="Open the Inbox: runs that need you, across all projects"
              >
                <span className="dot" />
                {attention.count} need you
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm hide-sm"
              onClick={() => setCmdOpen(true)}
              title="Command palette (⌘K)"
            >
              <span className="mono">⌘K</span>
            </button>
            <span id="runner-status" className={`pill pill-runner-${ptyd}`} title={`Runner (ptyd): ${ptyd}`}>
              <span className="dot" />
              <span className="tab-label">runner {ptyd}</span>
            </span>
            <button id="logout" className="btn btn-ghost btn-sm hide-mobile" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>

        <SecurityBanner />

        <div className="workbench-stage">
          <main className="content">
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
                {(params) => (
                  <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                    <RoadmapPage key={params.id} projectId={params.id} />
                  </Suspense>
                )}
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
          </main>

          {inspectedRun && (
            <RunInspector
              key={inspectedRun.id}
              run={inspectedRun}
              projectName={projectById.get(inspectedRun.projectId)?.name}
              onClose={() => setInspectRunId(undefined)}
            />
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
        onInspectRun={(id) => setInspectRunId(id)}
        onLogout={() => void logout()}
      />
    </div>
  );
}
