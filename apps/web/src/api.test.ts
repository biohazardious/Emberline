import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';

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
