import type { SchedulerState } from '@emberline/protocol';
import { useCallback, useState } from 'react';
import { api } from '../api';
import { useEvents } from './useEvents';

/** Live quota scheduler state (slots, queue, exhausted window). */
export function useScheduler(): {
  scheduler: SchedulerState | undefined;
  setScheduler: (state: SchedulerState) => void;
} {
  const [scheduler, setScheduler] = useState<SchedulerState>();

  const refresh = useCallback(async () => {
    try {
      setScheduler(await api<SchedulerState>('/api/scheduler'));
    } catch {
      // Keep the last known state.
    }
  }, []);

  useEvents(
    (event) => {
      if (event.type === 'scheduler') setScheduler(event.scheduler);
    },
    () => void refresh(),
  );

  return { scheduler, setScheduler };
}
