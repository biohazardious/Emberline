import type { Project } from '@emberline/protocol';
import { Eraser, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ProjectDeleteConfirm, type ProjectDeleted } from '../ProjectDeleteConfirm';
import { MoreMenu, type MoreMenuItem } from '../ui/MoreMenu';

export function SidebarProjectSwitcher({
  projects,
  activeProject,
  onSwitchProject,
  onOpenWizard,
  onCleanupWorktrees,
  onProjectDeleted,
}: {
  projects: Project[];
  activeProject: Project | undefined;
  onSwitchProject: (nextId: string) => void;
  onOpenWizard: () => void;
  onCleanupWorktrees: () => void;
  onProjectDeleted: (res: ProjectDeleted) => Promise<void>;
}) {
  const [confirmProjectId, setConfirmProjectId] = useState<string>();
  const deleteConfirmOpen = Boolean(activeProject && confirmProjectId === activeProject.id);

  const menuItems = useMemo<MoreMenuItem[]>(() => {
    if (!activeProject) return [];
    return [
      {
        id: 'prune-worktrees',
        label: 'Prune worktrees',
        icon: <Eraser className="icon" aria-hidden />,
        onSelect: onCleanupWorktrees,
      },
      {
        id: 'remove-project',
        label: 'Remove project',
        icon: <Trash className="icon" aria-hidden />,
        danger: true,
        onSelect: () => setConfirmProjectId(activeProject.id),
      },
    ];
  }, [activeProject, onCleanupWorktrees]);

  return (
    <div className="sidebar-project-box">
      <div className="sidebar-project-row">
        <select
          id="project-switcher"
          className="input sidebar-project-select"
          aria-label="Switch active project"
          value={activeProject?.id ?? ''}
          onChange={(e) => onSwitchProject(e.target.value)}
        >
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__new__">New project…</option>
        </select>
      </div>
      <div className="sidebar-project-actions">
        <button id="sidebar-new-project" type="button" className="btn btn-sm" onClick={onOpenWizard}>
          New project
        </button>
        {activeProject && (
          <MoreMenu items={menuItems} label="More" ariaLabel={`Project actions for ${activeProject.name}`} />
        )}
      </div>
      {activeProject && deleteConfirmOpen && (
        <ProjectDeleteConfirm
          key={activeProject.id}
          project={activeProject}
          onCancel={() => setConfirmProjectId(undefined)}
          onDeleted={async (res) => {
            setConfirmProjectId(undefined);
            await onProjectDeleted(res);
          }}
        />
      )}
    </div>
  );
}
