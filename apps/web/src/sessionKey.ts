/**
 * The per-login key core issues at setup, login and a password change. It is kept in localStorage
 * (shared by this browser's tabs) and sent on every change (the CSRF header) and every WebSocket
 * (a subprotocol, never the URL); the session cookie alone only authorises plain reads.
 */
import { SESSION_KEY_MISSING_MESSAGE, SESSION_KEY_PROTOCOL_PREFIX, WS_PROTOCOL } from '@emberline/protocol';

const STORAGE_KEY = 'emberline.sessionKey';
let memory: string | null = null; // storage blocked: this tab only, until a reload

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function getSessionKey(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setSessionKey(key: string): void {
  memory = key;
  try {
    storage()?.setItem(STORAGE_KEY, key);
  } catch {
    // Memory only; an older stored key must not win over this one.
    try {
      storage()?.removeItem(STORAGE_KEY);
    } catch {
      // nothing kept
    }
  }
}

export function clearSessionKey(): void {
  memory = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // nothing kept
  }
}

/** The subprotocols a WebSocket to core offers: `emberline` first (the one core echoes), then the key. */
export function sessionProtocols(): string[] {
  const key = getSessionKey();
  return key ? [WS_PROTOCOL, `${SESSION_KEY_PROTOCOL_PREFIX}${key}`] : [WS_PROTOCOL];
}

/** Signed in only with a key: a cookie whose key this browser lost gets the sign-in form and the notice, never a page of 401s. */
export function authGateState(
  state: { authenticated: boolean; signedOut?: string },
  key: string | null,
): { signedIn: boolean; notice?: string } {
  if (state.authenticated && key) return { signedIn: true };
  return {
    signedIn: false,
    notice: state.signedOut ?? (state.authenticated ? SESSION_KEY_MISSING_MESSAGE : undefined),
  };
}
