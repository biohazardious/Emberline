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

/** Logs out and forgets the key here, also when the request fails (the key must not outlive the sign-out). */
export async function signOut(post: () => Promise<unknown>): Promise<void> {
  try {
    await post();
  } finally {
    clearSessionKey();
  }
}

/** The login notice when this browser keeps no site storage (shown capitalised, with ". Sign in again." after it). */
export const SITE_STORAGE_BLOCKED_MESSAGE =
  'signed out: this browser blocks site storage, so a sign-in lasts only until the page reloads. Allow site data for this address to stay signed in';

const PROBE_KEY = 'emberline.storageProbe';

/** True when this browser refuses to keep anything for Emberline (private mode, blocked site data). */
export function siteStorageBlocked(): boolean {
  try {
    const s = storage();
    if (!s) return true;
    s.setItem(PROBE_KEY, '1');
    s.removeItem(PROBE_KEY);
    return false;
  } catch {
    return true;
  }
}

/**
 * Signed in only with a key: a cookie whose key this browser lost gets the sign-in form and the notice,
 * never a page of 401s. With blocked site storage the key could not survive a reload: that is the notice.
 */
export function authGateState(
  state: { authenticated: boolean; signedOut?: string },
  key: string | null,
  storageBlocked = false,
): { signedIn: boolean; notice?: string } {
  if (state.authenticated && key) return { signedIn: true };
  const keyLost = storageBlocked ? SITE_STORAGE_BLOCKED_MESSAGE : SESSION_KEY_MISSING_MESSAGE;
  const notice =
    state.signedOut === SESSION_KEY_MISSING_MESSAGE
      ? keyLost
      : (state.signedOut ?? (state.authenticated ? keyLost : undefined));
  return { signedIn: false, notice };
}
