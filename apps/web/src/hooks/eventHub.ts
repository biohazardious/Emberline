import { ServerEvent } from '@emberline/protocol';

type Listener = { onEvent: (event: ServerEvent) => void; onOpen: () => void };

/**
 * One `/api/events` WebSocket shared by every subscriber in the tab. Opens with the first
 * subscriber, closes with the last, and reconnects with backoff in between.
 */
const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let delay = 500;

function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    delay = 500;
    for (const listener of listeners) listener.onOpen();
  };
  ws.onmessage = (message) => {
    const parsed = ServerEvent.safeParse(JSON.parse(String(message.data)));
    if (!parsed.success) return;
    for (const listener of listeners) listener.onEvent(parsed.data);
  };
  ws.onclose = () => {
    if (socket !== ws) return; // closed on purpose
    socket = undefined;
    if (listeners.size === 0) return;
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10_000);
  };
}

export function subscribeEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (socket?.readyState === WebSocket.OPEN) listener.onOpen();
  else if (!socket && !timer) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
    const ws = socket;
    socket = undefined;
    ws?.close();
  };
}
