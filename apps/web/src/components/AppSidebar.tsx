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
import {
  ChevronsLeft,
  ChevronsRight,
  Container,
  Eraser,
  FileCode,
  GitBranch,
  Globe,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Moon,
  Package,
  Search,
  Settings,
  SquareKanban,
  Sun,
  Target,
  Trash,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { BrandLogo } from './BrandLogo';
import { PersonaBadge } from './PersonaBadge';
import { ProjectDeleteConfirm, type ProjectDeleted } from './ProjectDeleteConfirm';
import { ProviderMark } from './ProviderMark';
import { formatClaudePlanLabel, formatTokensCompact } from './QuotaPanel';
import { RunStatePill } from './RunStatePill';

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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
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
      id="workspace-sidebar"
      className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`}
      aria-label="Workspace navigation"
    >
      <div className="sidebar-top">
        <Link href="/" className="brand" title="Emberline — AI Coding Factory">
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
        <div className="sidebar-project-box">
          <div className="sidebar-project-head">
            <span className="eyebrow">Active Project</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {activeProject && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ padding: '2px 5px', fontSize: '0.72rem' }}
                    onClick={onCleanupWorktrees}
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
                onClick={onOpenWizard}
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
            onChange={(e) => onSwitchProject(e.target.value)}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
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
              onDeleted={async (res) => {
                setDeleteConfirmOpen(false);
                await onProjectDeleted(res);
              }}
            />
          )}
        </div>
      )}

      <button
        id="cmd-trigger"
        type="button"
        className="cmd-trigger"
        onClick={onOpenCommandPalette}
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
            <span className="nav-label">Roadmap &amp; Brainstorm</span>
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
            href={`/projects/${activeProject.id}/git`}
            className={`nav-item${location === `/projects/${activeProject.id}/git` ? ' active' : ''}`}
            title="Git: history, branches and releases"
          >
            <span className="nav-icon mono">
              <GitBranch className="icon" aria-hidden />
            </span>
            <span className="nav-label">Git</span>
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
          {attentionCount > 0 && (
            <span className="nav-badge nav-badge-warn mono" title="Runs that need you, all projects">
              {attentionCount}
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
          {attentionCount > 0 && (
            <span className="nav-badge nav-badge-warn mono" title="Runs that need you, all projects">
              {attentionCount}
            </span>
          )}
        </Link>
        {system?.docker?.enabled && (
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
                  onClick={() => onToggleInspectRun(r.id)}
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

function SidebarProviderTelemetry({
  activeProviders,
  currentProvider,
  onSelectProvider,
  factorySettings,
  claudeUsage,
  allRuns,
}: {
  activeProviders: AgentId[];
  currentProvider: AgentId;
  onSelectProvider: (id: AgentId) => void;
  factorySettings: FactorySettings | undefined;
  claudeUsage: ClaudeUsageTelemetry | undefined;
  allRuns: Run[] | undefined;
}) {
  const entry = PROVIDER_REGISTRY[currentProvider];
  const authInfo = factorySettings?.providerAuth?.[currentProvider];
  const isClaude = currentProvider === 'claude';
  const isAuthed = authInfo?.authenticated ?? (isClaude ? Boolean(claudeUsage?.authenticated) : true);
  const providerBucket =
    claudeUsage?.providerTokens?.[currentProvider] ??
    (isClaude && claudeUsage
      ? {
          hourlyTokens: claudeUsage.hourlyTokens,
          dailyTokens: claudeUsage.dailyTokens,
          weeklyTokens: claudeUsage.weeklyTokens,
        }
      : undefined);
  const providerRuns = (allRuns ?? []).filter((r) => r.agent === currentProvider);
  const activeProviderRuns = providerRuns.filter(
    (r) => !r.endedAt && r.state !== 'done' && r.state !== 'failed',
  ).length;
  const doneProviderRuns = providerRuns.filter((r) => r.state === 'done').length;

  return (
    <div id="sidebar-provider-telemetry" className="sidebar-telemetry mono muted">
      {activeProviders.length > 1 && (
        <div role="tablist" aria-label="Active AI Providers" className="sidebar-telemetry-tabs">
          {activeProviders.map((pid) => {
            const pEntry = PROVIDER_REGISTRY[pid];
            const pAuth =
              factorySettings?.providerAuth?.[pid]?.authenticated ??
              (pid === 'claude' ? Boolean(claudeUsage?.authenticated) : true);
            const selected = pid === currentProvider;
            return (
              <button
                key={pid}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`sidebar-telemetry-tab${selected ? ' active' : ''}`}
                onClick={() => onSelectProvider(pid)}
                title={`Switch telemetry view to ${pEntry.label}`}
              >
                <span className={`sidebar-telemetry-dot${pAuth ? ' ok' : ' warn'}`} />
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
          {isClaude ? formatClaudePlanLabel(claudeUsage) : entry.shortLabel}
        </strong>
        <span style={{ color: isAuthed ? 'var(--ok)' : 'var(--warn)' }}>
          ● {isAuthed ? 'active' : 'setup'}
        </span>
      </div>

      {isClaude && claudeUsage ? (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>5h: {Math.round(claudeUsage.fiveHour?.utilizationPercent ?? 0)}%</span>
          <span>7d: {Math.round(claudeUsage.sevenDay?.utilizationPercent ?? 0)}%</span>
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
}
