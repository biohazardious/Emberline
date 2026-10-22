/**
 * How live connections (the event stream, terminals) and 401 answers hand over to the sign-in form.
 * A refused WebSocket handshake (401: the key is missing or wrong) reaches the browser only as a
 * close before `open`, so the connection asks core whether this browser is still signed in before
 * it reconnects: signed out, it stops and the sign-in form takes over instead of a reconnect storm.
 */
import type { AuthState } from '@emberline/protocol';
import { api } from './api';
import { authGateState, getSessionKey } from './sessionKey';

/** One shared run of `fn` while it is pending: a burst of 401s becomes one auth check. */
export function shareInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= fn().finally(() => {
      pending = undefined;
    }));
}

/**
 * What a live connection does after its socket closed. One that was open retries (core restarting,
 * a dropped network). One refused before `open` retries only while core still says this browser is
 * signed in, or cannot be reached; otherwise it is `signed_out` and stops.
 */
export async function afterSocketClose(
  opened: boolean,
  probe: () => Promise<AuthState> = () => api<AuthState>('/api/auth/state'),
): Promise<'retry' | 'signed_out'> {
  if (opened) return 'retry';
  if (!getSessionKey()) return 'signed_out';
  try {
    return authGateState(await probe(), getSessionKey()).signedIn ? 'retry' : 'signed_out';
  } catch {
    return 'retry';
  }
}

/** Asks the auth gate to check again; it shows the sign-in form (with its notice) when signed out. */
export function signalSignedOut(): void {
  window.dispatchEvent(new Event('emberline:unauthorized'));
}
