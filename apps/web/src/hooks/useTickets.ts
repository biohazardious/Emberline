import type { Ticket } from '@emberline/protocol';
import { useCallback, useState } from 'react';
import { api } from '../api';
import { upsert, useEvents } from './useEvents';

/** A project's tickets, kept live over `/api/events`. */
export function useTickets(projectId: string): {
  tickets: Ticket[] | undefined;
  /** Optimistic local update; the server echo overwrites it. */
  patchLocal: (ticket: Ticket) => void;
  refresh: () => Promise<void>;
} {
  const [tickets, setTickets] = useState<Ticket[]>();

  const refresh = useCallback(async () => {
    try {
      setTickets(await api<Ticket[]>(`/api/projects/${projectId}/tickets`));
    } catch {
      // Keep the last known list; errors surface through the 401 handler / actions.
    }
  }, [projectId]);

  useEvents(
    (event) => {
      if (event.type === 'ticket' && event.ticket.projectId === projectId) {
        setTickets((list) => upsert(list, event.ticket));
      } else if (event.type === 'ticket_removed' && event.projectId === projectId) {
        setTickets((list) => list?.filter((t) => t.id !== event.id));
      }
    },
    () => void refresh(),
  );

  const patchLocal = useCallback((ticket: Ticket) => setTickets((list) => upsert(list, ticket)), []);
  return { tickets, patchLocal, refresh };
}
