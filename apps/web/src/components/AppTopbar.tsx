import type { Project, SystemStatus } from '@emberline/protocol';
import {
  FileCode,
  GitBranch,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  Menu,
  Moon,
  Package,
  Settings,
  SquareKanban,
  Sun,
  Target,
} from 'lucide-react';
import { Link } from 'wouter';

export function AppTopbar({
  location,
  activeProject,
  mobileNavOpen,
  onToggleMobileNav,
  attentionCount,
  onOpenWizard,
  theme,
  onToggleTheme,
  onOpenInbox,
  onOpenCommandPalette,
  ptyd,
  onLogout,
}: {
  location: string;
  activeProject: Project | undefined;
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  attentionCount: number;
  onOpenWizard: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenInbox: () => void;
  onOpenCommandPalette: () => void;
  ptyd: SystemStatus['ptyd'] | 'connecting';
  onLogout: () => void;
}) {
  const badgeLabel = `${attentionCount} ${attentionCount === 1 ? 'run needs' : 'runs need'} you`;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="btn btn-ghost btn-sm mobile-menu-btn"
          aria-label="Toggle navigation"
          aria-expanded={mobileNavOpen}
          aria-controls="workspace-sidebar"
          onClick={onToggleMobileNav}
        >
          <Menu className="icon" aria-hidden />
        </button>
        <div className="topbar-tabs">
          <Link
            href="/"
            className={`topbar-tab${location === '/' ? ' active' : ''}`}
            aria-current={location === '/' ? 'page' : undefined}
            title="Overview"
          >
            <LayoutDashboard className="icon" aria-hidden /> <span className="tab-label">Overview</span>
          </Link>
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/roadmap`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/roadmap` ? ' active' : ''}`}
              aria-current={location === `/projects/${activeProject.id}/roadmap` ? 'page' : undefined}
              title="Roadmap"
            >
              <Target className="icon" aria-hidden /> <span className="tab-label">Roadmap</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/board`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/board` ? ' active' : ''}`}
              aria-current={location === `/projects/${activeProject.id}/board` ? 'page' : undefined}
              title="Board"
            >
              <SquareKanban className="icon" aria-hidden /> <span className="tab-label">Board</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/code`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/code` ? ' active' : ''}`}
              aria-current={location === `/projects/${activeProject.id}/code` ? 'page' : undefined}
              title="Code"
            >
              <FileCode className="icon" aria-hidden /> <span className="tab-label">Code</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/git`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/git` ? ' active' : ''}`}
              aria-current={location === `/projects/${activeProject.id}/git` ? 'page' : undefined}
              title="Git: history, branches and releases"
            >
              <GitBranch className="icon" aria-hidden /> <span className="tab-label">Git</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/outputs`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/outputs` ? ' active' : ''}`}
              aria-current={location === `/projects/${activeProject.id}/outputs` ? 'page' : undefined}
              title="Build outputs"
            >
              <Package className="icon" aria-hidden /> <span className="tab-label">Build outputs</span>
            </Link>
          )}
          {activeProject && (
            <Link
              href={`/projects/${activeProject.id}/browser`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/browser` ? ' active' : ''}`}
              aria-current={location === `/projects/${activeProject.id}/browser` ? 'page' : undefined}
              title="Live browser"
            >
              <Globe className="icon" aria-hidden /> <span className="tab-label">Live browser</span>
            </Link>
          )}
          <Link
            href="/fleet"
            className={`topbar-tab${location === '/fleet' ? ' active' : ''}`}
            aria-current={location === '/fleet' ? 'page' : undefined}
            title="Fleet"
          >
            <LayoutGrid className="icon" aria-hidden /> <span className="tab-label">Fleet</span>
            {attentionCount > 0 && (
              <span className="badge mono" aria-label={badgeLabel}>
                {attentionCount}
              </span>
            )}
          </Link>
          <Link
            href="/settings"
            className={`topbar-tab${location === '/settings' ? ' active' : ''}`}
            aria-current={location === '/settings' ? 'page' : undefined}
            title="Settings"
          >
            <Settings className="icon" aria-hidden /> <span className="tab-label">Settings</span>
          </Link>
        </div>
      </div>

      <div className="topbar-right">
        <button id="topbar-new-project" type="button" className="btn btn-sm hide-sm" onClick={onOpenWizard}>
          New project
        </button>
        <button
          id="theme-toggle"
          type="button"
          className="btn btn-ghost btn-sm hide-mobile"
          onClick={onToggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
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
        {attentionCount > 0 && (
          <button
            id="attention-pill"
            type="button"
            className="pill pill-attention"
            onClick={onOpenInbox}
            title="Open inbox"
          >
            <span className="dot" />
            {attentionCount} need you
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm hide-sm"
          onClick={onOpenCommandPalette}
          title="Command palette (⌘K)"
        >
          <span className="mono">⌘K</span>
        </button>
        <span id="runner-status" className={`pill pill-runner-${ptyd}`} title={`Runner: ${ptyd}`}>
          <span className="dot" />
          <span className="tab-label">Runner {ptyd}</span>
        </span>
        <button id="logout" type="button" className="btn btn-ghost btn-sm hide-mobile" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
