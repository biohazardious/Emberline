import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api';

interface ApiQuery<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * GETs `url` and refetches every `intervalMs` while the tab is visible. Views asking for the same
 * URL share one cached request; a changed URL (e.g. another project) fetches right away.
 */
export function useApi<T>(url: string, intervalMs = 3_000): ApiQuery<T> {
  const query = useQuery({
    queryKey: ['api', url],
    queryFn: () => api<T>(url),
    refetchInterval: intervalMs,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return { data: query.data, error: query.error ?? undefined, loading: query.isPending, refresh };
}
