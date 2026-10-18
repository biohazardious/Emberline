/** The two ways to remove a project, and what each does to its folder. */
import type { Project } from '@emberline/protocol';

export interface ProjectDeleteChoice {
  label: string;
  /** The DELETE request; `deleteFiles` is always explicit. */
  url: string;
  description: string;
}

export function projectDeleteChoices(project: Pick<Project, 'id' | 'path' | 'importSource'>): {
  keep: ProjectDeleteChoice;
  purge: ProjectDeleteChoice;
} {
  const base = `/api/projects/${encodeURIComponent(project.id)}`;
  return {
    keep: {
      label: 'Remove from Emberline',
      url: `${base}?deleteFiles=0`,
      description: `Stops its runs and removes its tickets, run worktrees and archived build outputs (pinned ones included). The folder ${project.path} stays as it is.`,
    },
    purge: {
      label: 'Remove and delete files',
      url: `${base}?deleteFiles=1`,
      description:
        project.importSource === 'folder'
          ? `The same, and this deletes your repository folder ${project.path}, with anything in it that is not pushed.`
          : `The same, and this deletes the workspace folder ${project.path}.`,
    },
  };
}
