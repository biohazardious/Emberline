import type { Run, SchedulerState, Ticket } from '@emberline/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api';
import { upsert, useEvents } from './useEvents';

/** Query keys of the data `/api/events` keeps live. */
export const liveKeys = {
  runs: ['runs'] as const,
  tickets: (projectId: string) => ['tickets', projectId] as const,
  scheduler: ['scheduler'] as const,
};

/**
 * Mounted once (inside the authenticated shell): applies pushed events to the query cache and
 * refetches live data after every reconnect, so no update is missed while disconnected.
 */
export function LiveEvents(): null {
  const client = useQueryClient();
  useEvents(
    (event) => {
      switch (event.type) {
        case 'run':
          client.setQueryData<Run[]>(liveKeys.runs, (list) => (list ? upsert(list, event.run) : list));
          break;
        case 'run_removed':
          client.setQueryData<Run[]>(liveKeys.runs, (list) => list?.filter((r) => r.id !== event.id));
          break;
        case 'ticket':
          client.setQueryData<Ticket[]>(liveKeys.tickets(event.ticket.projectId), (list) =>
            list ? upsert(list, event.ticket) : list,
          );
          break;
        case 'ticket_removed':
          client.setQueryData<Ticket[]>(liveKeys.tickets(event.projectId), (list) =>
            list?.filter((t) => t.id !== event.id),
          );
          break;
        case 'scheduler':
          client.setQueryData(liveKeys.scheduler, event.scheduler);
          break;
      }
    },
    () => {
      void client.invalidateQueries({ queryKey: liveKeys.runs });
      void client.invalidateQueries({ queryKey: ['tickets'] });
      void client.invalidateQueries({ queryKey: liveKeys.scheduler });
    },
  );
  return null;
}

/** All runs, kept live by {@link LiveEvents}. */
export function useRuns(): { runs: Run[] | undefined; refresh: () => Promise<void> } {
  const query = useQuery({
    queryKey: liveKeys.runs,
    queryFn: () => api<Run[]>('/api/runs'),
    staleTime: Infinity,
  });
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return { runs: query.data, refresh };
}

/** A project's tickets, kept live by {@link LiveEvents}. */
export function useTickets(projectId: string): {
  tickets: Ticket[] | undefined;
  /** Optimistic local update; the server echo overwrites it. */
  patchLocal: (ticket: Ticket) => void;
  refresh: () => Promise<void>;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: liveKeys.tickets(projectId),
    queryFn: () => api<Ticket[]>(`/api/projects/${projectId}/tickets`),
    staleTime: Infinity,
  });
  const patchLocal = useCallback(
    (ticket: Ticket) =>
      client.setQueryData<Ticket[]>(liveKeys.tickets(projectId), (list) => upsert(list, ticket)),
    [client, projectId],
  );
  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return { tickets: query.data, patchLocal, refresh };
}

/** Live quota scheduler state (slots, queue, exhausted window). */
export function useScheduler(): {
  scheduler: SchedulerState | undefined;
  setScheduler: (state: SchedulerState) => void;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: liveKeys.scheduler,
    queryFn: () => api<SchedulerState>('/api/scheduler'),
    staleTime: Infinity,
  });
  const setScheduler = useCallback(
    (state: SchedulerState) => client.setQueryData(liveKeys.scheduler, state),
    [client],
  );
  return { scheduler: query.data, setScheduler };
}
