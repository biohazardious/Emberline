import type { Run } from '@emberline/protocol';
import { useCallback, useState } from 'react';
import { api } from '../api';
import { upsert, useEvents } from './useEvents';

/**
 * All runs, kept live: initial fetch, then updates pushed over `/api/events`.
 * Refetches after every reconnect so no update is missed.
 */
export function useRuns(): { runs: Run[] | undefined; refresh: () => Promise<void> } {
  const [runs, setRuns] = useState<Run[]>();

  const refresh = useCallback(async () => {
    try {
      setRuns(await api<Run[]>('/api/runs'));
    } catch {
      // Surfaced elsewhere (401 handler / runner banner); keep the last known list.
    }
  }, []);

  useEvents(
    (event) => {
      if (event.type === 'run') setRuns((list) => upsert(list, event.run));
      else if (event.type === 'run_removed') setRuns((list) => list?.filter((r) => r.id !== event.id));
    },
    () => void refresh(),
  );

  return { runs, refresh };
}
