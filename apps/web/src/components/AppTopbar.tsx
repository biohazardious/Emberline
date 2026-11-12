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
              href={`/projects/${activeProject.id}/git`}
              className={`topbar-tab${location === `/projects/${activeProject.id}/git` ? ' active' : ''}`}
              title="Git: history, branches and releases"
            >
              <GitBranch className="icon" aria-hidden /> <span className="tab-label">Git</span>
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
          <Link href="/fleet" className={`topbar-tab${location === '/fleet' ? ' active' : ''}`} title="Fleet">
            <LayoutGrid className="icon" aria-hidden /> <span className="tab-label">Fleet</span>
            {attentionCount > 0 && <span className="badge mono">{attentionCount}</span>}
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
        <button id="topbar-new-project" type="button" className="btn btn-sm hide-sm" onClick={onOpenWizard}>
          + New Project
        </button>
        <button
          id="theme-toggle"
          type="button"
          className="btn btn-ghost btn-sm hide-mobile"
          onClick={onToggleTheme}
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
        {attentionCount > 0 && (
          <button
            id="attention-pill"
            type="button"
            className="pill pill-attention"
            onClick={onOpenInbox}
            title="Open the Inbox: runs that need you, across all projects"
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
        <span id="runner-status" className={`pill pill-runner-${ptyd}`} title={`Runner (ptyd): ${ptyd}`}>
          <span className="dot" />
          <span className="tab-label">runner {ptyd}</span>
        </span>
        <button id="logout" className="btn btn-ghost btn-sm hide-mobile" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
