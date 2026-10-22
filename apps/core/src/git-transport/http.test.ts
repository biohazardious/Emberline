import { execFile } from 'node:child_process';
import { createServer, type RequestListener, type Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicAuthValue, type GitHttpCredential } from '../git-credentials.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import { createGitHttp } from './http.js';

const execFileAsync = promisify(execFile);
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

  it('ignores proxy variables that Node itself honours (a process started with them)', async () => {
    const proxied: string[] = [];
    const proxy = await listen((req, res) => {
      proxied.push(req.url ?? '');
      res.writeHead(502).end();
    });
    // Node reads proxy variables once, at start: only a fresh process shows whether they would apply.
    const script = `
      const http = await import('node:http');
      const { createGitHttp } = await import(process.env.EMB_MODULE);
      const url = process.env.EMB_URL;
      const viaGlobal = await new Promise((resolve, reject) =>
        http.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
      const client = createGitHttp({ remoteUrl: process.env.EMB_REPO, credential: JSON.parse(process.env.EMB_CRED) });
      const own = await client.request({ url });
      client.close();
      console.log(JSON.stringify({ viaGlobal, own: own.statusCode }));
    `;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
      NODE_NO_WARNINGS: '1',
      EMB_MODULE: pathToFileURL(fileURLToPath(new URL('./http.ts', import.meta.url))).href,
      EMB_URL: `${a.url}/alice/app.git/info/refs?service=git-upload-pack`,
      EMB_REPO: `${a.url}/alice/app.git`,
      EMB_CRED: JSON.stringify(cred()),
    };
    delete env.NO_PROXY;
    delete env.no_proxy;
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        env,
        timeout: 30_000,
      },
    );
    // The variables are live in that process: Node's global agent went through the proxy...
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ viaGlobal: 502, own: 200 });
    expect(proxied).toEqual([`${a.url}/alice/app.git/info/refs?service=git-upload-pack`]);
    // ...and the transport's request did not; it reached the forge with the account.
    expect(a.seen.filter((r) => r.authorization === `Basic ${basicAuthValue(cred())}`)).toHaveLength(1);
    expect(b.seen).toEqual([]);
  });

  it('a server that stops sending in the middle of a response hits the idle limit', async () => {
    const stalls = await listen((_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(1024));
    });
    const client = createGitHttp({
      remoteUrl: `${stalls}/a/b.git`,
      credential: { serverUrl: stalls, username: 'u', token: 'T' },
      limits: { idleTimeoutMs: 200, totalTimeoutMs: 10_000 },
    });
    await expect(client.request({ url: `${stalls}/a/b.git/info/refs` })).rejects.toMatchObject({
      code: 'timeout',
    });
    client.close();
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
