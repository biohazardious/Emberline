import type { WorkspaceFileContentResponse, WorkspaceFileListResponse } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api';
import { useApi } from './useApi';

/** Workspace file tree for `targetId` (`'main'` or a run id), polled every 6 s. */
export function useWorkspaceFiles(projectId: string, targetId: string) {
  return useApi<WorkspaceFileListResponse>(
    `/api/projects/${projectId}/files?targetId=${encodeURIComponent(targetId)}`,
    6_000,
  );
}

/** Fetches file content through the query client so concurrent reads share in-flight requests. */
export function useWorkspaceFileLoader(projectId: string, targetId: string) {
  const client = useQueryClient();
  return useCallback(
    (relPath: string) => {
      const url = `/api/projects/${projectId}/files/content?targetId=${encodeURIComponent(targetId)}&path=${encodeURIComponent(relPath)}`;
      return client.fetchQuery({
        queryKey: ['api', url],
        queryFn: () => api<WorkspaceFileContentResponse>(url),
        staleTime: 0,
      });
    },
    [client, projectId, targetId],
  );
}
