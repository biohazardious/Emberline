import { type Run, ServerEvent } from '@emberline/protocol';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * All runs, kept live: initial fetch, then updates pushed over `/api/events`.
 * Reconnects with backoff and refetches after every reconnect so no update is missed.
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

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let disposed = false;

    const connect = () => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
      socket = new WebSocket(url);
      socket.onopen = () => {
        delay = 500;
        void refresh();
      };
      socket.onmessage = (message) => {
        const parsed = ServerEvent.safeParse(JSON.parse(String(message.data)));
        if (!parsed.success) return;
        const event = parsed.data;
        setRuns((current) => {
          const list = current ?? [];
          if (event.type === 'run_removed') return list.filter((r) => r.id !== event.id);
          const index = list.findIndex((r) => r.id === event.run.id);
          if (index === -1) return [event.run, ...list];
          const next = list.slice();
          next[index] = event.run;
          return next;
        });
      };
      socket.onclose = () => {
        if (disposed) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [refresh]);

  return { runs, refresh };
}
