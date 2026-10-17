/** A client that has not sent a presence message for this long no longer counts. */
export const PRESENCE_TTL_MS = 120_000;

interface Presence {
  visible: boolean;
  runId: string | null;
  at: number;
}

/**
 * Which clients are looking at which run, as their events sockets last said. Expiry is lazy (checked
 * on read), so a client that vanished without closing its socket stops counting after the TTL.
 */
export class PresenceRegistry {
  private readonly sockets = new Map<symbol, Presence>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records (or refreshes) one socket's presence. */
  set(socket: symbol, state: { visible: boolean; runId: string | null }): void {
    this.sockets.set(socket, { ...state, at: this.now() });
  }

  remove(socket: symbol): void {
    this.sockets.delete(socket);
  }

  /** Whether any live, visible client has exactly this run open. */
  isWatched(runId: string): boolean {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    for (const [socket, p] of this.sockets) {
      if (p.at <= cutoff) {
        this.sockets.delete(socket);
        continue;
      }
      if (p.visible && p.runId === runId) return true;
    }
    return false;
  }
}
