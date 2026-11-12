import type { Project } from '@emberline/protocol';
import { useMemo } from 'react';
import { useApi } from './useApi';

/** All projects, polled on `intervalMs` and shared across project-scoped pages. */
export function useProjects(intervalMs = 15_000) {
  return useApi<Project[]>('/api/projects', intervalMs);
}

/** Single project resolved from the shared `/api/projects` query cache. */
export function useProject(projectId: string, intervalMs = 15_000) {
  const query = useProjects(intervalMs);
  const project = useMemo(() => query.data?.find((item) => item.id === projectId), [query.data, projectId]);
  return { ...query, project };
}
