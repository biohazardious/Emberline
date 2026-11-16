import {
  type AgentId,
  type ClaudeUsageTelemetry,
  type FactorySettings,
  type Project,
  PROVIDER_REGISTRY,
  type Run,
  type SchedulerState,
  type SystemStatus,
} from '@emberline/protocol';
import { ChevronsLeft, ChevronsRight, Moon, Search, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { trapTab } from '../focusTrap';
import { BrandLogo } from './BrandLogo';
import type { ProjectDeleted } from './ProjectDeleteConfirm';
import { SidebarNav } from './sidebar/SidebarNav';
import { SidebarProjectSwitcher } from './sidebar/SidebarProjectSwitcher';
import { SidebarProviderTelemetry } from './sidebar/SidebarProviderTelemetry';
import { SidebarRunningList } from './sidebar/SidebarRunningList';
import './sidebar/sidebar.css';

const SIDEBAR_PROVIDER_STORAGE_KEY = 'emberline.sidebarProvider';

export function AppSidebar({
  sidebarCollapsed,
  onToggleCollapse,
  mobileNavOpen,
  onCloseMobileNav,
  location,
  system,
  updatesAvailable,
  projects,
  activeProject,
  onSwitchProject,
  onOpenWizard,
  onCleanupWorktrees,
  onProjectDeleted,
  onOpenCommandPalette,
  attentionCount,
  activeRuns,
  projectById,
  inspectRunId,
  onToggleInspectRun,
  scheduler,
  claudeUsage,
  factorySettings,
  allRuns,
  theme,
  onToggleTheme,
  onLogout,
}: {
  sidebarCollapsed: boolean;
  onToggleCollapse: () => void;
  mobileNavOpen: boolean;
  onCloseMobileNav: () => void;
  location: string;
  system: SystemStatus | undefined;
  updatesAvailable: number;
  projects: Project[];
  activeProject: Project | undefined;
  onSwitchProject: (nextId: string) => void;
  onOpenWizard: () => void;
  onCleanupWorktrees: () => void;
  onProjectDeleted: (res: ProjectDeleted) => Promise<void>;
  onOpenCommandPalette: () => void;
  attentionCount: number;
  activeRuns: Run[];
  projectById: ReadonlyMap<string, Project>;
  inspectRunId: string | undefined;
  onToggleInspectRun: (id: string) => void;
  scheduler: SchedulerState | undefined;
  claudeUsage: ClaudeUsageTelemetry | undefined;
  factorySettings: FactorySettings | undefined;
  allRuns: Run[] | undefined;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const closeMobileRef = useRef(onCloseMobileNav);
  closeMobileRef.current = onCloseMobileNav;

  useEffect(() => {
    if (!mobileNavOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileRef.current();
      } else {
        trapTab(asideRef.current, event);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [mobileNavOpen]);

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
      factorySettings?.enabledProviders?.length ? factorySettings.enabledProviders : ['claude'],
    );
    const personaAgents = factorySettings?.personaAgents;
    if (personaAgents) {
      for (const ag of Object.values(personaAgents)) {
        if (ag in PROVIDER_REGISTRY) set.add(ag);
      }
    }
    if (set.size === 0) set.add('claude');
    return Array.from(set);
  }, [factorySettings]);

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

  const effectiveCollapsed = sidebarCollapsed && !mobileNavOpen;

  return (
    <aside
      ref={asideRef}
      id="workspace-sidebar"
      className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`}
      aria-label="Workspace navigation"
    >
      <div className="sidebar-top">
        <Link href="/" className="brand" title="Emberline">
          <BrandLogo size={24} />
          <span className="brand-name">Emberline</span>
          {system?.version && <span className="brand-version mono">v{system.version}</span>}
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
          onClick={onToggleCollapse}
        >
          {sidebarCollapsed ? (
            <ChevronsRight className="icon" aria-hidden />
          ) : (
            <ChevronsLeft className="icon" aria-hidden />
          )}
        </button>
        {mobileNavOpen && (
          <button
            ref={closeBtnRef}
            type="button"
            className="icon-btn sidebar-mobile-close"
            aria-label="Close navigation menu"
            onClick={onCloseMobileNav}
          >
            <X className="icon" aria-hidden />
          </button>
        )}
      </div>

      {!effectiveCollapsed && (
        <SidebarProjectSwitcher
          projects={projects}
          activeProject={activeProject}
          onSwitchProject={onSwitchProject}
          onOpenWizard={onOpenWizard}
          onCleanupWorktrees={onCleanupWorktrees}
          onProjectDeleted={onProjectDeleted}
        />
      )}

      <button
        id="cmd-trigger"
        type="button"
        className="cmd-trigger"
        onClick={onOpenCommandPalette}
        title="Command palette (⌘K)"
      >
        <span className="cmd-trigger-icon mono" aria-hidden="true">
          <Search className="icon" aria-hidden />
        </span>
        <span className="cmd-trigger-text">Search or jump…</span>
        <kbd className="kbd">⌘K</kbd>
      </button>

      <SidebarNav
        location={location}
        activeProject={activeProject}
        attentionCount={attentionCount}
        dockerEnabled={Boolean(system?.docker?.enabled)}
      />

      <SidebarRunningList
        activeRuns={activeRuns}
        projectById={projectById}
        inspectRunId={inspectRunId}
        onToggleInspectRun={onToggleInspectRun}
      />

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
        {!effectiveCollapsed && (
          <SidebarProviderTelemetry
            activeProviders={activeSidebarProviders}
            currentProvider={currentSidebarProvider}
            onSelectProvider={selectSidebarProvider}
            factorySettings={factorySettings}
            claudeUsage={claudeUsage}
            allRuns={allRuns}
          />
        )}
        <div className="sidebar-mobile-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onToggleTheme}>
            {theme === 'dark' ? <Sun className="icon" aria-hidden /> : <Moon className="icon" aria-hidden />}
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </footer>
    </aside>
  );
}
