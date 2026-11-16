import type { Project } from '@emberline/protocol';
import { ProjectStatusAndDemoView } from './projectStatus/ProjectStatusAndDemoView';

export function ProjectStatusAndDemoPanel({ project }: { project: Project }) {
  return <ProjectStatusAndDemoView project={project} />;
}
