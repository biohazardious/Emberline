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

/** siteStorageBlocked asked at most once, and only when called: each probe also fires `storage` events in the other tabs. */
export function storageProbe(): () => boolean {
  let blocked: boolean | undefined;
  return () => (blocked ??= siteStorageBlocked());
}

/**
 * Signed in only with a key: a cookie whose key this browser lost gets the sign-in form and the notice,
 * never a page of 401s. With blocked site storage the key could not survive a reload: that is the notice.
 * `storageBlocked` is asked only for that notice.
 */
export function authGateState(
  state: { authenticated: boolean; signedOut?: string },
  key: string | null,
  storageBlocked: () => boolean = () => false,
): { signedIn: boolean; notice?: string } {
  if (state.authenticated && key) return { signedIn: true };
  const keyLost = () => (storageBlocked() ? SITE_STORAGE_BLOCKED_MESSAGE : SESSION_KEY_MISSING_MESSAGE);
  const notice =
    state.signedOut === SESSION_KEY_MISSING_MESSAGE
      ? keyLost()
      : (state.signedOut ?? (state.authenticated ? keyLost() : undefined));
  return { signedIn: false, notice };
}

let keyChange: Promise<void> | null = null;

/**
 * Runs `change`, a request that issues a new key and stores it (a password change), and marks it in
 * flight from before it is sent until the new key is stored: an auth check that comes back signed
 * out meanwhile waits for it.
 */
export async function changingKey<T>(change: () => Promise<T>): Promise<T> {
  const running = change();
  const settled = running.then(
    () => undefined,
    () => undefined,
  );
  keyChange = settled;
  try {
    return await running;
  } finally {
    if (keyChange === settled) keyChange = null;
  }
}

/**
 * The auth state, asked once more when it says signed out and the key changed while it was on its
 * way: a password change stores its new key after a check may already have gone out with the old one.
 * A signed-out answer that comes while a key change is in flight waits for that change first.
 */
export async function currentAuthState<T extends { authenticated: boolean; signedOut?: string }>(
  ask: () => Promise<T>,
): Promise<T> {
  const sentWith = getSessionKey();
  const state = await ask();
  if (authGateState(state, getSessionKey()).signedIn) return state;
  if (keyChange) await keyChange;
  if (getSessionKey() === sentWith) return state;
  return ask();
}
