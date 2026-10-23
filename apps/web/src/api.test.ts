import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, withTimeout } from './api';

const respond = (status: number, statusText: string, body: string) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, statusText })));

afterEach(() => vi.unstubAllGlobals());

describe('api errors', () => {
  it('a non-JSON error body (a proxy page) still becomes an ApiRequestError', async () => {
    respond(413, 'Payload Too Large', '<html><body>413 Request Entity Too Large</body></html>');
    await expect(api('/api/projects', 'POST', {})).rejects.toEqual(
      new ApiRequestError(413, 'http_error', 'Payload Too Large'),
    );
  });
  it('a JSON error body keeps its code and message', async () => {
    respond(409, 'Conflict', JSON.stringify({ error: 'name_taken', message: 'Taken' }));
    await expect(api('/api/projects', 'POST', {})).rejects.toMatchObject({
      status: 409,
      code: 'name_taken',
      message: 'Taken',
    });
  });
});

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects once the time is up without an answer, so a caller can fall back', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const raced = withTimeout(never, 5_000);
    const settled = vi.fn();
    raced.then(settled, settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(raced).rejects.toThrow('no answer within 5000 ms');
  });

  it('passes an answer or an error that comes in time through', async () => {
    await expect(withTimeout(Promise.resolve('p1'), 5_000)).resolves.toBe('p1');
    const failed = new ApiRequestError(500, 'boom', 'boom');
    await expect(withTimeout(Promise.reject(failed), 5_000)).rejects.toBe(failed);
  });
});
