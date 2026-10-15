import type { ServerEvent } from '@emberline/protocol';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { subscribeEvents } from './eventHub';

/**
 * Subscribes to the `/api/events` push channel (one shared socket per tab). `onOpen` fires after
 * every (re)connect so callers can refetch and never miss an update that happened while disconnected.
 */
export function useEvents(onEvent: (event: ServerEvent) => void, onOpen: () => void): void {
  const handlers = useRef({ onEvent, onOpen });
  useLayoutEffect(() => {
    handlers.current = { onEvent, onOpen };
  });

  useEffect(
    () =>
      subscribeEvents({
        onEvent: (event) => handlers.current.onEvent(event),
        onOpen: () => handlers.current.onOpen(),
      }),
    [],
  );
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
