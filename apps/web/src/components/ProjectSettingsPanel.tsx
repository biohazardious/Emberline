import type { Project } from '@emberline/protocol';
import { ContainerPreviewBox } from './ContainerPreviewBox';
import './project-settings-ux.css';
import { ProjectDangerSection } from './projectSettings/ProjectDangerSection';
import { GateRadios, ProjectGatesSection } from './projectSettings/ProjectGatesSection';
import { WorktreeConfigBanner, WorktreeConfigSection } from './projectSettings/WorktreeConfigSection';
import { RepositoryPanel } from './RepositoryPanel';

export { GateRadios, WorktreeConfigBanner };

/** Per-project settings: Repository, Gates, Worktree config, Container preview, and Danger zone. */
export function ProjectSettingsPanel({ project }: { project: Project }) {
  return (
    <div className="project-settings-stack" aria-label="Project settings">
      <RepositoryPanel project={project} />
      <ProjectGatesSection project={project} />
      <WorktreeConfigSection project={project} />
      <ContainerPreviewBox project={project} />
      <ProjectDangerSection project={project} />
    </div>
  );
}
