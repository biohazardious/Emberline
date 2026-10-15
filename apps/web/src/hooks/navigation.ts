import { useCallback, useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';

/** Pages shown since this tab loaded the app; more than one means there is in-app history to go back to. */
let pageViews = 0;

/** Counts in-app page views; mounted once, in the app shell. */
export function useTrackPageViews(): void {
  const [location] = useLocation();
  useEffect(() => {
    pageViews += 1;
  }, [location]);
}

/**
 * "Back" that returns to the page the user came from (Settings, a board, Fleet, ...) and falls back
 * to `fallback` when the page was opened directly.
 */
export function useGoBack(fallback = '/'): () => void {
  const [, navigate] = useLocation();
  return useCallback(() => {
    if (pageViews > 1) window.history.back();
    else navigate(fallback);
  }, [fallback, navigate]);
}

/** Updates several address parameters at once (null removes one), replacing the history entry. */
export function useUpdateQuery(): (patch: Record<string, string | null>) => void {
  const [location, navigate] = useLocation();
  return useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      const query = params.toString();
      navigate(query ? `${location}?${query}` : location, { replace: true });
    },
    [location, navigate],
  );
}

/**
 * Page state kept in the address (`?tab=quota`), so going back to a page, reloading it or sharing
 * the link restores it. Changing it replaces the current history entry instead of adding one.
 */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const search = useSearch();
  const updateQuery = useUpdateQuery();
  const value = new URLSearchParams(search).get(name);
  const setValue = useCallback((next: string | null) => updateQuery({ [name]: next }), [name, updateQuery]);
  return [value, setValue];
}
