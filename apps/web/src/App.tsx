import type { Project, SystemStatus } from '@emberline/protocol';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { api } from './api';
import { AuthGate, useAuth } from './auth';
import { CommandPalette } from './components/CommandPalette';
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

export function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

function Shell() {
  const { logout } = useAuth();
  const [location] = useLocation();
  const system = usePoll(() => api<SystemStatus>('/api/system'), 5_000);
  const projects = usePoll(() => api<Project[]>('/api/projects'), 10_000);
  const { runs } = useRuns();
  const { scheduler } = useScheduler();

  const [cmdOpen, setCmdOpen] = useState(false);
  const [inspectRunId, setInspectRunId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const ptyd = system.data?.ptyd ?? 'connecting';

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

  const activeRuns = useMemo(() => {
    const list = (runs ?? []).filter((r) => !r.endedAt);
    return list.sort((a, b) => {
      const rank = (s: string) => (s === 'waiting_input' ? 0 : s === 'working' || s === 'starting' ? 1 : 2);
      return rank(a.state) - rank(b.state);
    });
  }, [runs]);

  const waitingRuns = useMemo(() => activeRuns.filter((r) => r.state === 'waiting_input'), [activeRuns]);
  const inspectedRun = useMemo(() => (runs ?? []).find((r) => r.id === inspectRunId), [runs, inspectRunId]);

  return (
    <div className={`app workbench${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`} aria-label="Workspace navigation">
        <div className="sidebar-top">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden="true" />
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

        <button
          id="cmd-trigger"
          type="button"
          className="cmd-trigger"
          onClick={() => setCmdOpen(true)}
          title="Open command palette (⌘K / Ctrl+K)"
        >
          <span className="cmd-trigger-text">Search or jump…</span>
          <kbd className="kbd">⌘K</kbd>
        </button>

        <nav className="sidebar-nav" aria-label="Main views">
          <Link href="/" className={`nav-item${location === '/' ? ' active' : ''}`}>
            <span className="nav-icon mono">◈</span>
            <span className="nav-label">Overview</span>
          </Link>
          <Link id="nav-fleet" href="/fleet" className={`nav-item${location === '/fleet' ? ' active' : ''}`}>
            <span className="nav-icon mono">⊞</span>
            <span className="nav-label">Fleet Multiplexer</span>
            {activeRuns.length > 0 && (
              <span className={`nav-badge mono${waitingRuns.length > 0 ? ' nav-badge-warn' : ''}`}>
                {activeRuns.length}
              </span>
            )}
          </Link>
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span className="eyebrow">Boards</span>
            <span className="sidebar-count mono">{projects.data?.length ?? 0}</span>
          </div>
          <ul className="sidebar-list">
            {(projects.data ?? []).map((p) => {
              const boardHref = `/projects/${p.id}/board`;
              return (
                <li key={p.id}>
                  <Link href={boardHref} className={`nav-item${location === boardHref ? ' active' : ''}`}>
                    <span className="nav-icon mono">#</span>
                    <span className="nav-label">{p.name}</span>
                  </Link>
                </li>
              );
            })}
            {(projects.data?.length ?? 0) === 0 && <li className="sidebar-empty muted small">No projects yet</li>}
          </ul>
        </div>

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
              <Link href="/fleet" className={`topbar-tab${location === '/fleet' ? ' active' : ''}`}>
                Fleet
                {activeRuns.length > 0 && <span className="badge mono">{activeRuns.length}</span>}
              </Link>
            </div>
          </div>

          <div className="topbar-right">
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
              <Route path="/projects/:id/board">
                {(params) => (
                  <Suspense fallback={<div className="board-page" aria-busy="true" />}>
                    <BoardPage key={params.id} projectId={params.id} />
                  </Suspense>
                )}
              </Route>
              <Route path="/fleet">
                <Suspense fallback={<div className="fleet-page" aria-busy="true" />}>
                  <FleetPage onInspectRun={(id) => setInspectRunId(id)} />
                </Suspense>
              </Route>
              <Route path="/">
                <h1 className="sr-only">Emberline dashboard</h1>
                <Dashboard system={system.data} onInspectRun={(id) => setInspectRunId(id)} />
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

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        projects={projects.data ?? []}
        runs={runs ?? []}
        scheduler={scheduler}
        onInspectRun={(id) => setInspectRunId(id)}
        onLogout={() => void logout()}
      />
    </div>
  );
}
