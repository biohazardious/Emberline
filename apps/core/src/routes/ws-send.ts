import type { WebSocket } from 'ws';

/** A browser that falls this far behind on the terminal stream is cut off; it reconnects and gets a fresh snapshot. */
export const TERMINAL_SEND_CAP = 8 * 1024 * 1024;
/** Same for the events channel; the client refetches on reconnect. */
export const EVENTS_SEND_CAP = 4 * 1024 * 1024;
/** Output or input held while a terminal attaches. Past this the socket is closed and the client reconnects. */
export const PRE_READY_CAP = 1024 * 1024;

/**
 * Sends one JSON message unless the socket's unsent backlog is over `cap`; then it closes the
 * socket (1013, try again later) instead of letting a slow reader grow core's memory. Returns
 * whether the message was sent.
 */
export function sendBounded(
  socket: Pick<WebSocket, 'readyState' | 'OPEN' | 'bufferedAmount' | 'send' | 'close'>,
  message: unknown,
  cap: number,
): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > cap) {
    socket.close(1013, 'client too slow');
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}
