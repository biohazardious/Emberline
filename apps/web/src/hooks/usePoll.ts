import { useCallback, useEffect, useRef, useState } from 'react';

interface PollState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Fetches immediately, then every `intervalMs` while the tab is visible. */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 3_000): PollState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
