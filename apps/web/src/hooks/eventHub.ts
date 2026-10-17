import { type ClientPresenceMessage, ServerEvent } from '@emberline/protocol';

type Listener = { onEvent: (event: ServerEvent) => void; onOpen: () => void };

/**
 * One `/api/events` WebSocket shared by every subscriber in the tab. Opens with the first
 * subscriber, closes with the last, and reconnects with backoff in between.
 */
const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let delay = 500;
/** When the server last cut us off for being too slow (close 1013); reconnecting right after must keep backing off. */
let overflowAt = 0;

const HEARTBEAT_MS = 60_000;
/** Which run each part of the UI has open; the first non-null by priority is what we report. */
type PresenceSource = 'inspector' | 'fleet' | 'inbox';
const PRESENCE_PRIORITY: PresenceSource[] = ['inspector', 'inbox', 'fleet'];
const presenceRuns = new Map<PresenceSource, string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

function presenceMessage(): ClientPresenceMessage {
  const runId = PRESENCE_PRIORITY.map((source) => presenceRuns.get(source)).find(Boolean) ?? null;
  return { type: 'presence', visible: document.visibilityState === 'visible', runId };
}

function sendPresence(): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(presenceMessage()));
}

/** Tells core which run this tab is showing (null clears it). Each UI part owns one source slot. */
export function setPresenceRun(runId: string | null, source: PresenceSource = 'inspector'): void {
  if (runId) presenceRuns.set(source, runId);
  else presenceRuns.delete(source);
  sendPresence();
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sendPresence);

function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    if (Date.now() - overflowAt > 10_000) delay = 500;
    for (const listener of listeners) listener.onOpen();
    sendPresence();
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (document.visibilityState === 'visible') sendPresence();
    }, HEARTBEAT_MS);
  };
  ws.onmessage = (message) => {
    const parsed = ServerEvent.safeParse(JSON.parse(String(message.data)));
    if (!parsed.success) return;
    for (const listener of listeners) listener.onEvent(parsed.data);
  };
  ws.onclose = (close) => {
    if (close.code === 1013) overflowAt = Date.now();
    if (socket !== ws) return; // closed on purpose
    clearInterval(heartbeat);
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
    clearInterval(heartbeat);
    timer = undefined;
    const ws = socket;
    socket = undefined;
    ws?.close();
  };
}
