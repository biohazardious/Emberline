import type { SystemStatus } from '@emberline/protocol';
import { lazy, Suspense } from 'react';
import { Link, Route, Switch } from 'wouter';
import { api } from './api';
import { AuthGate, useAuth } from './auth';
import { usePoll } from './hooks/usePoll';
import { Dashboard } from './pages/Dashboard';

// xterm.js is the bulk of the bundle; only load it when a terminal is opened.
const TerminalPage = lazy(() => import('./pages/TerminalPage').then((m) => ({ default: m.TerminalPage })));
const BoardPage = lazy(() => import('./pages/BoardPage').then((m) => ({ default: m.BoardPage })));

export function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

function Shell() {
  const { logout } = useAuth();
  const system = usePoll(() => api<SystemStatus>('/api/system'), 5_000);
  const ptyd = system.data?.ptyd ?? 'connecting';

  return (
    <div className="app">
      <div className="glow" aria-hidden="true" />
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Emberline</span>
        </Link>
        <div className="topbar-right">
          <span id="runner-status" className={`pill pill-runner-${ptyd}`} title="Runner (ptyd) connection">
            <span className="dot" />
            runner {ptyd}
          </span>
          <button id="logout" className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Switch>
          <Route path="/terminals/:id">
            {(params) => (
              <Suspense fallback={<div className="term-shell" aria-busy="true" />}>
                <TerminalPage id={params.id} />
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
          <Route path="/">
            <h1 className="sr-only">Emberline dashboard</h1>
            <Dashboard system={system.data} />
          </Route>
          <Route>
            <div className="empty">
              <p>Page not found.</p>
              <Link href="/">Back to dashboard</Link>
            </div>
          </Route>
        </Switch>
      </main>
      <footer className="footer">One installation = one user = your own Claude subscription. Not affiliated with Anthropic.</footer>
    </div>
  );
}
