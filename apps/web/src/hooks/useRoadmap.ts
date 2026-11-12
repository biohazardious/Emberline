import type { ProjectRoadmapState } from '@emberline/protocol';
import { useApi } from './useApi';

/** Project roadmap milestones and brainstorm suggestions, polled every 6 s while visible. */
export function useProjectRoadmap(projectId: string) {
  return useApi<ProjectRoadmapState>(`/api/projects/${projectId}/roadmap`, 6_000);
}
