import type { ActiveProjectPreference, ClaudeUsageTelemetry, FactorySettings, Project, SystemStatus } from '@emberline/protocol';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { api } from './api';
import { AuthGate, useAuth } from './auth';
import { BrandLogo } from './components/BrandLogo';
import { CommandPalette } from './components/CommandPalette';
import { PersonaBadge } from './components/PersonaBadge';
import { ProjectWizardModal } from './components/ProjectWizardModal';
import { formatClaudePlanLabel, formatTokensCompact } from './components/QuotaPanel';
import { RunInspector } from './components/RunInspector';
import { RunStatePill } from './components/RunStatePill';
import { usePoll } from './hooks/usePoll';
import { useRuns } from './hooks/useRuns';
import { useScheduler } from './hooks/useScheduler';
import { Dashboard } from './pages/Dashboard';

// xterm.js and Monaco are the bulk of the bundle; only load them when opened.
const TerminalPage = lazy(() => import('./pages/TerminalPage').then((m) => ({ default: m.TerminalPage })));
const BoardPage = lazy(() => import('./pages/BoardPage').then((m) => ({ default: m.BoardPage })));
const FleetPage = lazy(() => import('./pages/FleetPage').then((m) => ({ default: m.FleetPage })));
const ReviewPage = lazy(() => import('./pages/ReviewPage').then((m) => ({ default: m.ReviewPage })));
const CodeExplorerPage = lazy(() =>
  import('./pages/CodeExplorerPage').then((m) => ({ default: m.CodeExplorerPage })),
);
const LiveBrowserPage = lazy(() =>
  import('./pages/LiveBrowserPage').then((m) => ({ default: m.LiveBrowserPage })),
);
const RoadmapPage = lazy(() =>
  import('./pages/RoadmapPage').then((m) => ({ default: m.RoadmapPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

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
  const system = usePoll(() => api<SystemStatus>('/api/system'), 5_000);
  const projects = usePoll(() => api<Project[]>('/api/projects'), 10_000);
  const claudeUsage = usePoll(() => api<ClaudeUsageTelemetry>('/api/factory/claude-usage'), 30_000);
  const { runs } = useRuns();
  const { scheduler } = useScheduler();

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore storage errors
    }
    return 'dark';
  });

  const applyTheme = useCallback((next: 'dark' | 'light') => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
    void api<FactorySettings>('/api/factory/settings', 'PATCH', { theme: next }).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void api<FactorySettings>('/api/factory/settings')
      .then((res) => {
        if (res.theme === 'light' || res.theme === 'dark') {
          setTheme(res.theme);
          document.documentElement.dataset.theme = res.theme;
        }
      })
      .catch(() => undefined);
  }, []);

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

  const selectProject = useCallback(
    (id: string | null) => {
      setActiveProjectId(id);
      try {
        if (id) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id);
        else localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
      void api<ActiveProjectPreference>('/api/projects/active', 'PUT', { activeProjectId: id }).catch(() => undefined);
    },
    [],
  );

  // Sync initial active project preference from server if local preference is missing or stale
  useEffect(() => {
    const list = projects.data;
    if (!list || list.length === 0) return;
    if (activeProjectId && list.some((p) => p.id === activeProjectId)) return;

    void api<ActiveProjectPreference>('/api/projects/active')
      .then((pref) => {
        const candidate = pref.activeProjectId && list.some((p) => p.id === pref.activeProjectId)
          ? pref.activeProjectId
          : list[0]?.id ?? null;
        if (candidate) selectProject(candidate);
      })
      .catch(() => {
        if (list[0]) selectProject(list[0].id);
      });
  }, [projects.data, activeProjectId, selectProject]);

  // If the user navigates directly to /projects/:id/board|code|browser|roadmap, sync activeProjectId
  useEffect(() => {
    const match = /^\/projects\/([^/]+)\/(board|code|browser|roadmap)/.exec(location);
    if (match?.[1] && match[1] !== activeProjectId) {
      selectProject(match[1]);
    }
  }, [location, activeProjectId, selectProject]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((open) => !open);
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
    () => (activeProjectId ? projectById.get(activeProjectId) : undefined) ?? projects.data?.[0],
    [activeProjectId, projectById, projects.data],
  );

  // Scope active fleet strictly to the active project so other projects' runs never clutter the sidebar
  const activeRuns = useMemo(() => {
    const list = (runs ?? []).filter(
      (r) =>
        !r.endedAt &&
        r.state !== 'done' &&
        r.state !== 'failed' &&
        (!activeProject || r.projectId === activeProject.id),
    );
    return list.sort((a, b) => {
      const rank = (s: string) => (s === 'waiting_input' ? 0 : s === 'working' || s === 'starting' ? 1 : 2);
      return rank(a.state) - rank(b.state);
    });
  }, [runs, activeProject]);

  const waitingRuns = useMemo(() => activeRuns.filter((r) => r.state === 'waiting_input'), [activeRuns]);
  const inspectedRun = useMemo(() => (runs ?? []).find((r) => r.id === inspectRunId), [runs, inspectRunId]);

  const handleSwitchProject = (nextId: string) => {
    if (nextId === '__new__') {
      setWizardOpen(true);
      return;
    }
    const targetId = nextId || null;
    selectProject(targetId);
    // When currently viewing a project board, roadmap, browser, or code explorer, switch directly to the new project's view!
    if (targetId && /^\/projects\/[^/]+\/board/.test(location)) {
      navigate(`/projects/${targetId}/board`);
    } else if (targetId && /^\/projects\/[^/]+\/code/.test(location)) {
      navigate(`/projects/${targetId}/code`);
    } else if (targetId && /^\/projects\/[^/]+\/browser/.test(location)) {
      navigate(`/projects/${targetId}/browser`);
    } else if (targetId && /^\/projects\/[^/]+\/roadmap/.test(location)) {
      navigate(`/projects/${targetId}/roadmap`);
    }
  };

  const handleCleanupProjectWorktrees = async () => {
    if (!activeProject) return;
    try {
      await api(`/api/projects/${activeProject.id}/cleanup-worktrees`, 'POST');
    } catch {
      // ignore
    }
  };

  const handleDeleteActiveProject = async () => {
    if (!activeProject) return;
    const confirmed = window.confirm(
      `Delete project "${activeProject.name}" (${activeProject.slug})?\n\nThis will stop all runs, remove its tickets & worktrees, and delete the workspace folder (${activeProject.path}).`,
    );
    if (!confirmed) return;
    try {
      const res = await api<{ ok: boolean; deletedProjectId: string; nextActiveProjectId: string | null }>(
        `/api/projects/${activeProject.id}`,
        'DELETE',
      );
      await projects.refresh();
      handleSwitchProject(res.nextActiveProjectId ?? '');
      if (!res.nextActiveProjectId) navigate('/');
    } catch {
      // ignore
    }
  };

  return (
    <div className={`app workbench${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`} aria-label="Workspace navigation">
        <div className="sidebar-top">
          <Link href="/" className="brand" title="Emberline — AI Coding Factory">
            <BrandLogo size={24} />
            <span className="brand-name">Emberline</span>
          </Link>
          <button
            type="button"
            className="icon-btn sidebar-collapse-btn hide-sm"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? '»' : '«'}
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
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
                      🧹
                    </button>
                    <button
                      id="sidebar-delete-project"
                      type="button"
                      className="btn btn-sm btn-ghost"
                      style={{ padding: '2px 5px', fontSize: '0.72rem', color: 'var(--danger)' }}
                      onClick={() => void handleDeleteActiveProject()}
                      title={`Delete project ${activeProject.name} and its workspace files`}
                    >
                      🗑
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
          </div>
        )}

        <button
          id="cmd-trigger"
          type="button"
          className="cmd-trigger"
          onClick={() => setCmdOpen(true)}
          title="Open command palette (⌘K / Ctrl+K)"
        >
          <span className="cmd-trigger-icon mono" aria-hidden="true">⌕</span>
          <span className="cmd-trigger-text">Search or jump…</span>
          <kbd className="kbd">⌘K</kbd>
        </button>

        <nav className="sidebar-nav" aria-label="Main views">
          <Link href="/" className={`nav-item${location === '/' ? ' active' : ''}`} title="Factory Overview">
            <span className="nav-icon mono">◈</span>
            <span className="nav-label">Factory Overview</span>
          </Link>
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/roadmap`}
              className={`nav-item${location === `/projects/${activeProject.id}/roadmap` ? ' active' : ''}`}
              title="Roadmap & AI Brainstorming Studio"
            >
              <span className="nav-icon mono">🎯</span>
              <span className="nav-label">Roadmap & Brainstorm</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/board`}
              className={`nav-item${location === `/projects/${activeProject.id}/board` ? ' active' : ''}`}
              title="Kanban Board"
            >
              <span className="nav-icon mono">▤</span>
              <span className="nav-label">Kanban Board</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/code`}
              className={`nav-item${location === `/projects/${activeProject.id}/code` ? ' active' : ''}`}
              title="Code Explorer"
            >
              <span className="nav-icon mono">◫</span>
              <span className="nav-label">Code Explorer</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/browser`}
              className={`nav-item${location === `/projects/${activeProject.id}/browser` ? ' active' : ''}`}
              title="Live Browser Studio"
            >
              <span className="nav-icon mono">🌐</span>
              <span className="nav-label">Live Browser</span>
            </Link>
          )}
          <Link
            id="nav-fleet"
            href="/fleet"
            className={`nav-item${location === '/fleet' ? ' active' : ''}`}
            title="Fleet Multiplexer"
          >
            <span className="nav-icon mono">⊞</span>
            <span className="nav-label">Fleet Multiplexer</span>
            {activeRuns.length > 0 && (
              <span className={`nav-badge mono${waitingRuns.length > 0 ? ' nav-badge-warn' : ''}`}>
                {activeRuns.length}
              </span>
            )}
          </Link>
          <Link
            id="nav-settings"
            href="/settings"
            className={`nav-item${location === '/settings' ? ' active' : ''}`}
            title="Factory Settings"
          >
            <span className="nav-icon mono">⚙</span>
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
                    <RunStatePill state={r.state} />
                  </button>
                </li>
              );
            })}
            {activeRuns.length === 0 && <li className="sidebar-empty muted small">All agents idle</li>}
          </ul>
        </div>

        <footer className="sidebar-foot">
          {scheduler && (
            <div className={`sidebar-quota${scheduler.window ? ' sidebar-quota-paused' : ''}`}>
              <span className="dot" />
              <span className="mono">
                {scheduler.window
                  ? `Quota paused (${scheduler.rateLimited})`
                  : `${scheduler.busy}/${scheduler.maxConcurrentRuns} slots`}
              </span>
            </div>
          )}
          {claudeUsage.data && !sidebarCollapsed && (
            <div
              className="mono muted"
              style={{
                fontSize: '0.72rem',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                padding: '6px 8px',
                borderRadius: 'var(--radius)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
              }}
              title="Live Claude OAuth 5-hour & 7-day utilization and token consumption"
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text)' }}>
                <strong>⚡ {formatClaudePlanLabel(claudeUsage.data)}</strong>
                <span style={{ color: claudeUsage.data.authenticated ? 'var(--ok)' : 'var(--warn)' }}>
                  ● {claudeUsage.data.authenticated ? 'active' : 'offline'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>5h: {Math.round(claudeUsage.data.fiveHour?.utilizationPercent ?? 0)}%</span>
                <span>7d: {Math.round(claudeUsage.data.sevenDay?.utilizationPercent ?? 0)}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>1h: {formatTokensCompact(claudeUsage.data.hourlyTokens.totalTokens)}</span>
                <span>7d: {formatTokensCompact(claudeUsage.data.weeklyTokens.totalTokens)}</span>
              </div>
            </div>
          )}
          <p className="footer">One installation = one user = your own Claude subscription. Not affiliated with Anthropic.</p>
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
              ☰
            </button>
            <div className="topbar-tabs">
              <Link href="/" className={`topbar-tab${location === '/' ? ' active' : ''}`}>
                Overview
              </Link>
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/roadmap`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/roadmap` ? ' active' : ''}`}
                >
                  🎯 Roadmap
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/board`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/board` ? ' active' : ''}`}
                >
                  Board
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/code`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/code` ? ' active' : ''}`}
                >
                  Code Explorer
                </Link>
              )}
              {activeProject && (
                <Link
                  href={`/projects/${activeProject.id}/browser`}
                  className={`topbar-tab${location === `/projects/${activeProject.id}/browser` ? ' active' : ''}`}
                >
                  🌐 Live Browser
                </Link>
              )}
              <Link href="/fleet" className={`topbar-tab${location === '/fleet' ? ' active' : ''}`}>
                Fleet
                {activeRuns.length > 0 && <span className="badge mono">{activeRuns.length}</span>}
              </Link>
              <Link href="/settings" className={`topbar-tab${location === '/settings' ? ' active' : ''}`}>
                ⚙ Settings
              </Link>
            </div>
          </div>

          <div className="topbar-right">
            {claudeUsage.data && (
              <span
                id="topbar-claude-usage"
                className="pill hide-sm mono"
                style={{ fontSize: '0.74rem', gap: 6 }}
                title={`Claude OAuth (${formatClaudePlanLabel(claudeUsage.data)}) · 1h tokens: ${formatTokensCompact(claudeUsage.data.hourlyTokens.totalTokens)} · 7d tokens: ${formatTokensCompact(claudeUsage.data.weeklyTokens.totalTokens)}`}
              >
                <span
                  className="dot"
                  style={{
                    background: claudeUsage.data.authenticated ? 'var(--ok)' : 'var(--warn)',
                  }}
                />
                5h: {Math.round(claudeUsage.data.fiveHour?.utilizationPercent ?? 0)}% · 7d:{' '}
                {Math.round(claudeUsage.data.sevenDay?.utilizationPercent ?? 0)}%
              </span>
            )}
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
              className="btn btn-ghost btn-sm"
              onClick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
              title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
            >
              {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
            </button>
            {waitingRuns[0] && (
              <button
                id="attention-pill"
                type="button"
                className="pill pill-attention"
                onClick={() => setInspectRunId(waitingRuns[0]?.id)}
                title="Click to inspect the agent waiting for your input"
              >
                <span className="dot" />
                {waitingRuns.length} waiting on you
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
            <span id="runner-status" className={`pill pill-runner-${ptyd}`} title="Runner (ptyd) connection">
              <span className="dot" />
              runner {ptyd}
            </span>
            <button id="logout" className="btn btn-ghost btn-sm" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>

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
              <Route path="/projects/:id/code">
                {(params) => (
                  <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                    <CodeExplorerPage key={params.id} projectId={params.id} />
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
              <Route path="/fleet">
                <Suspense fallback={<div className="fleet-page" aria-busy="true" />}>
                  <FleetPage
                    activeProjectId={activeProject?.id ?? null}
                    onInspectRun={(id) => setInspectRunId(id)}
                  />
                </Suspense>
              </Route>
              <Route path="/">
                <h1 className="sr-only">Emberline dashboard</h1>
                <Dashboard
                  system={system.data}
                  activeProjectId={activeProject?.id ?? null}
                  onSelectProject={selectProject}
                  onOpenWizard={() => setWizardOpen(true)}
                  onInspectRun={(id) => setInspectRunId(id)}
                />
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

      <ProjectWizardModal
        open={wizardOpen}
        runnerDown={ptyd !== 'connected'}
        onClose={() => setWizardOpen(false)}
        onCreated={async (res) => {
          await projects.refresh();
          selectProject(res.project.id);
          if (res.terminalId) navigate(`/terminals/${res.terminalId}`);
        }}
      />

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        projects={projects.data ?? []}
        runs={(runs ?? []).filter((r) => !activeProject || r.projectId === activeProject.id)}
        scheduler={scheduler}
        onInspectRun={(id) => setInspectRunId(id)}
        onLogout={() => void logout()}
      />
    </div>
  );
}
