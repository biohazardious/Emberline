import { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from './api';

/** One cache for the whole app: views asking for the same data share a single request. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Fresh enough for a dashboard; live data arrives over /api/events anyway.
      staleTime: 2_000,
      // 4xx answers (401, 404) do not get better by retrying.
      retry: (failures, error) => failures < 2 && !(error instanceof ApiRequestError && error.status < 500),
    },
  },
});
