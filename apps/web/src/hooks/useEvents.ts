import { ServerEvent } from '@emberline/protocol';
import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Subscribes to the `/api/events` push channel. Reconnects with backoff; `onOpen` fires after every
 * (re)connect so callers can refetch and never miss an update that happened while disconnected.
 */
export function useEvents(onEvent: (event: ServerEvent) => void, onOpen: () => void): void {
  const handlers = useRef({ onEvent, onOpen });
  useLayoutEffect(() => {
    handlers.current = { onEvent, onOpen };
  });

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
        handlers.current.onOpen();
      };
      socket.onmessage = (message) => {
        const parsed = ServerEvent.safeParse(JSON.parse(String(message.data)));
        if (parsed.success) handlers.current.onEvent(parsed.data);
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
  }, []);
}

/** Replace-or-prepend by id. */
export function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const current = list ?? [];
  const index = current.findIndex((x) => x.id === item.id);
  if (index === -1) return [item, ...current];
  const next = current.slice();
  next[index] = item;
  return next;
}
