import { SESSION_KEY_MISSING_MESSAGE } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterSocketClose, shareInFlight } from './liveAuth';
import { clearSessionKey, setSessionKey } from './sessionKey';

beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  clearSessionKey();
});
afterEach(() => vi.unstubAllGlobals());

describe('afterSocketClose', () => {
  it('a socket that was open retries without asking core (a restart, a dropped network)', async () => {
    setSessionKey('k');
    const probe = vi.fn();
    expect(await afterSocketClose(true, probe)).toBe('retry');
    expect(probe).not.toHaveBeenCalled();
  });

  it('a refused handshake while core says the key is gone stops reconnecting', async () => {
    setSessionKey('k');
    const probe = vi
      .fn()
      .mockResolvedValue({
        setupRequired: false,
        authenticated: false,
        signedOut: SESSION_KEY_MISSING_MESSAGE,
      });
    expect(await afterSocketClose(false, probe)).toBe('signed_out');
  });

  it('without a key the browser is signed out, and core is not asked', async () => {
    const probe = vi.fn();
    expect(await afterSocketClose(false, probe)).toBe('signed_out');
    expect(probe).not.toHaveBeenCalled();
  });

  it('a refused handshake while still signed in, or core unreachable, keeps retrying', async () => {
    setSessionKey('k');
    expect(
      await afterSocketClose(false, vi.fn().mockResolvedValue({ setupRequired: false, authenticated: true })),
    ).toBe('retry');
    expect(await afterSocketClose(false, vi.fn().mockRejectedValue(new TypeError('fetch failed')))).toBe(
      'retry',
    );
  });
});

describe('shareInFlight', () => {
  it('a burst of 401s runs one auth check; a later one runs again', async () => {
    let release: (v: string) => void = () => undefined;
    const fn = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const shared = shareInFlight(fn);
    const calls = [shared(), shared(), shared()];
    expect(fn).toHaveBeenCalledTimes(1);
    release('done');
    expect(await Promise.all(calls)).toEqual(['done', 'done', 'done']);
    void shared();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
