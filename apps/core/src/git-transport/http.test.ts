import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicAuthValue, type GitHttpCredential } from '../git-credentials.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import { createGitHttp } from './http.js';

const TOKEN = 'http-secret-token';
let a: FakeForge;
let b: FakeForge;
const servers: Server[] = [];
const cred = (): GitHttpCredential => ({ serverUrl: a.url, username: 'alice', token: TOKEN });
const listen = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

beforeEach(async () => {
  a = await startFakeForge({ token: TOKEN });
  b = await startFakeForge({ token: 'other-token' });
  a.bare('alice', 'app');
  b.bare('alice', 'app');
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await a.close();
  await b.close();
});

describe('createGitHttp', () => {
  it('sends only its own Authorization, and only to the repository it was made for', async () => {
    const client = createGitHttp({ remoteUrl: `${a.url}/alice/app.git`, credential: cred() });
    try {
      const res = await client.request({
        url: `${a.url}/alice/app.git/info/refs?service=git-upload-pack`,
        headers: { Authorization: 'Basic ZXZpbDpldmls', 'Proxy-Authorization': 'Basic eA==' },
      });
      expect(res.statusCode).toBe(200);
      expect(a.seen.at(-1)?.authorization).toBe(`Basic ${basicAuthValue(cred())}`);
      for (const url of [
        `${b.url}/alice/app.git/info/refs?service=git-upload-pack`,
        `${a.url}/alice/app.git.evil/info/refs?service=git-upload-pack`,
        `${a.url}/alice/other.git/info/refs?service=git-upload-pack`,
        `${b.url}/${a.url}/alice/app.git/info/refs?service=git-upload-pack`, // what an http.corsProxy would make
      ]) {
        await expect(client.request({ url }), url).rejects.toMatchObject({ code: 'url_refused' });
      }
      expect(b.seen).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('a repository URL outside the account server is refused before any request', () => {
    let error: unknown;
    try {
      createGitHttp({ remoteUrl: `${b.url}/alice/app.git`, credential: cred() });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'url_refused' });
    expect(b.seen).toEqual([]);
  });

  it('ignores proxy variables', async () => {
    const keys = [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'NODE_USE_ENV_PROXY',
    ] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = k === 'NODE_USE_ENV_PROXY' ? '1' : b.url;
    const client = createGitHttp({ remoteUrl: `${a.url}/alice/app.git`, credential: cred() });
    try {
      expect(
        (await client.request({ url: `${a.url}/alice/app.git/info/refs?service=git-upload-pack` }))
          .statusCode,
      ).toBe(200);
      expect(b.seen).toEqual([]);
    } finally {
      client.close();
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('stops at the response cap and at the time limit', async () => {
    const big = await listen((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(2 * 1024 * 1024));
    });
    const capped = createGitHttp({
      remoteUrl: `${big}/a/b.git`,
      credential: { serverUrl: big, username: 'u', token: 'T' },
      limits: { maxResponseBytes: 1024 * 1024 },
    });
    await expect(capped.request({ url: `${big}/a/b.git/info/refs` })).rejects.toMatchObject({
      code: 'too_large',
    });
    capped.close();
    const silent = await listen(() => undefined);
    const slow = createGitHttp({
      remoteUrl: `${silent}/a/b.git`,
      credential: { serverUrl: silent, username: 'u', token: 'T' },
      limits: { totalTimeoutMs: 300 },
    });
    await expect(slow.request({ url: `${silent}/a/b.git/info/refs` })).rejects.toMatchObject({
      code: 'timeout',
    });
    slow.close();
  });
});
