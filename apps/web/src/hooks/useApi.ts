import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api';

export interface ApiQuery<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
  setData: (updater: T | ((prev: T | undefined) => T | undefined)) => void;
}

/**
 * GETs `url` and refetches every `intervalMs` while the tab is visible. Views asking for the same
 * URL share one cached request; a changed URL (e.g. another project) fetches right away.
 * `intervalMs` may be `false` (fetch once) or a function of the latest data, re-read after every
 * fetch (e.g. poll faster while the server reports work in progress).
 */
export function useApi<T>(
  url: string,
  intervalMs: number | false | ((data: T | undefined) => number | false) = 3_000,
): ApiQuery<T> {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['api', url],
    queryFn: () => api<T>(url),
    refetchInterval: typeof intervalMs === 'function' ? (q) => intervalMs(q.state.data) : intervalMs,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const setData = useCallback(
    (updater: T | ((prev: T | undefined) => T | undefined)) => {
      client.setQueryData<T | undefined>(['api', url], updater);
    },
    [client, url],
  );
  return { data: query.data, error: query.error ?? undefined, loading: query.isPending, refresh, setData };
}
