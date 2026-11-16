import type { Project } from '@emberline/protocol';
import {
  Container,
  FileCode,
  GitBranch,
  Globe,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  Package,
  Settings,
  SquareKanban,
  Target,
} from 'lucide-react';
import { Link } from 'wouter';

interface NavEntry {
  id?: string;
  href: string;
  label: string;
  icon: LucideIcon;
  showAttention?: boolean;
}

export function SidebarNav({
  location,
  activeProject,
  attentionCount,
  dockerEnabled,
}: {
  location: string;
  activeProject: Project | undefined;
  attentionCount: number;
  dockerEnabled: boolean;
}) {
  const badgeLabel = `${attentionCount} ${attentionCount === 1 ? 'run needs' : 'runs need'} you`;

  const projectItems: readonly NavEntry[] = activeProject
    ? [
        { href: '/', label: 'Overview', icon: LayoutDashboard },
        { href: `/projects/${activeProject.id}/roadmap`, label: 'Roadmap', icon: Target },
        { href: `/projects/${activeProject.id}/board`, label: 'Board', icon: SquareKanban },
        { href: `/projects/${activeProject.id}/code`, label: 'Code', icon: FileCode },
        { href: `/projects/${activeProject.id}/git`, label: 'Git', icon: GitBranch },
        { href: `/projects/${activeProject.id}/outputs`, label: 'Build outputs', icon: Package },
        { href: `/projects/${activeProject.id}/browser`, label: 'Live browser', icon: Globe },
      ]
    : [];

  const workspaceItems: readonly NavEntry[] = [
    { id: 'nav-inbox', href: '/inbox', label: 'Inbox', icon: Inbox, showAttention: true },
    { id: 'nav-fleet', href: '/fleet', label: 'Fleet', icon: LayoutGrid, showAttention: true },
    ...(dockerEnabled ? [{ id: 'nav-docker', href: '/docker', label: 'Docker', icon: Container }] : []),
    { id: 'nav-settings', href: '/settings', label: 'Settings', icon: Settings },
  ];

  const renderLink = (item: NavEntry) => {
    const active = location === item.href;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        id={item.id}
        href={item.href}
        className={`nav-item${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={item.label}
      >
        <span className="nav-icon mono">
          <Icon className="icon" aria-hidden />
        </span>
        <span className="nav-label">{item.label}</span>
        {item.showAttention && attentionCount > 0 && (
          <span className="nav-badge nav-badge-warn mono" aria-label={badgeLabel}>
            {attentionCount}
          </span>
        )}
      </Link>
    );
  };

  return (
    <nav className="sidebar-nav" aria-label="Main views">
      {projectItems.length > 0 && (
        <div className="sidebar-nav-group" role="group" aria-label="Project">
          <span className="sidebar-group-label">Project</span>
          <div className="sidebar-nav-items">{projectItems.map(renderLink)}</div>
        </div>
      )}
      <div className="sidebar-nav-group" role="group" aria-label="Workspace">
        <span className="sidebar-group-label">Workspace</span>
        <div className="sidebar-nav-items">{workspaceItems.map(renderLink)}</div>
      </div>
    </nav>
  );
}
