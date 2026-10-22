import {
  CSRF_HEADER,
  SESSION_KEY_MISSING_MESSAGE,
  SESSION_KEY_PROTOCOL_PREFIX,
  WS_PROTOCOL,
} from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { authGateState, clearSessionKey, getSessionKey, sessionProtocols, setSessionKey } from './sessionKey';

/** A Map-backed localStorage. */
const mapStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
};

/** Stubs fetch with a 200 JSON answer and returns the headers of each request. */
const recordFetch = () => {
  const sent: Record<string, string>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: string, init: RequestInit) => {
      sent.push({ ...(init.headers as Record<string, string>) });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }),
  );
  return sent;
};

beforeEach(() => {
  vi.stubGlobal('localStorage', mapStorage().storage);
  clearSessionKey();
});
afterEach(() => vi.unstubAllGlobals());

describe('the per-login key', () => {
  it('is sent as the CSRF header on changes and on reads once the browser holds it', async () => {
    const { map, storage } = mapStorage();
    vi.stubGlobal('localStorage', storage);
    setSessionKey('k');
    expect([...map.values()]).toEqual(['k']);
    const sent = recordFetch();
    await api('/api/projects', 'POST', {});
    await api('/api/projects');
    expect(sent.map((h) => h[CSRF_HEADER])).toEqual(['k', 'k']);
  });

  it('without a key, changes send "1" (setup and login) and reads send nothing', async () => {
    const sent = recordFetch();
    await api('/api/auth/login', 'POST', { password: 'x' });
    await api('/api/auth/state');
    expect(sent.map((h) => h[CSRF_HEADER])).toEqual(['1', undefined]);
  });

  it('a blocked localStorage leaves api() working, with the key kept in memory for this tab', async () => {
    // The getter itself throws (Safari private mode, blocked site data); afterEach restores it.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    setSessionKey('in-memory');
    expect(getSessionKey()).toBe('in-memory');
    const sent = recordFetch();
    await api('/api/projects', 'POST', {});
    expect(sent[0]?.[CSRF_HEADER]).toBe('in-memory');
    clearSessionKey();
    expect(getSessionKey()).toBeNull();
  });

  it('is cleared on sign-out', () => {
    setSessionKey('k');
    clearSessionKey();
    expect(getSessionKey()).toBeNull();
  });

  it('travels as a WebSocket subprotocol after "emberline", never first', () => {
    expect(sessionProtocols()).toEqual([WS_PROTOCOL]);
    setSessionKey('k');
    expect(sessionProtocols()).toEqual([WS_PROTOCOL, `${SESSION_KEY_PROTOCOL_PREFIX}k`]);
    expect(sessionProtocols()[0]).toBe('emberline');
  });
});

describe('authGateState', () => {
  it('a valid cookie whose key this browser lost gets the sign-in form with the notice', () => {
    expect(authGateState({ authenticated: true }, null)).toEqual({
      signedIn: false,
      notice: SESSION_KEY_MISSING_MESSAGE,
    });
  });

  it('signed in only with both the session and the key', () => {
    expect(authGateState({ authenticated: true }, 'k')).toEqual({ signedIn: true });
    expect(authGateState({ authenticated: false }, 'k')).toEqual({ signedIn: false, notice: undefined });
    expect(authGateState({ authenticated: false, signedOut: SESSION_KEY_MISSING_MESSAGE }, 'k')).toEqual({
      signedIn: false,
      notice: SESSION_KEY_MISSING_MESSAGE,
    });
  });
});
