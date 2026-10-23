import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicAuthValue, type GitHttpCredential } from '../git-credentials.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import { openUpstream, type UpstreamRequest, UpstreamAgents } from './upstream.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'upstream-secret-token';
let a: FakeForge;
let b: FakeForge;
let agents: UpstreamAgents;
const servers: Server[] = [];
const cred = (): GitHttpCredential => ({ serverUrl: a.url, username: 'alice', token: TOKEN });
const listen = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const request = (url: string, extra: Partial<UpstreamRequest> = {}): UpstreamRequest => ({
  url: new URL(url),
  method: 'GET',
  headers: {},
  credential: cred(),
  agents,
  signal: AbortSignal.timeout(10_000),
  idleTimeoutMs: 5_000,
  ...extra,
});
const drain = async (res: IncomingMessage) => {
  for await (const _chunk of res) {
    // read to the end
  }
};

beforeEach(async () => {
  a = await startFakeForge({ token: TOKEN });
  b = await startFakeForge({ token: 'other-token' });
  a.bare('alice', 'app');
  b.bare('alice', 'app');
  agents = new UpstreamAgents();
});
afterEach(async () => {
  agents.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await a.close();
  await b.close();
});

describe('openUpstream', () => {
  it('sends only its own Authorization, and refuses a URL outside the account server before sending', async () => {
    const res = await openUpstream(
      request(`${a.url}/alice/app.git/info/refs?service=git-upload-pack`, {
        headers: { Authorization: 'Basic ZXZpbDpldmls' },
      }),
    );
    expect(res.statusCode).toBe(200);
    await drain(res);
    expect(a.seen.map((r) => r.authorization)).toEqual([`Basic ${basicAuthValue(cred())}`]);
    await expect(
      openUpstream(request(`${b.url}/alice/app.git/info/refs?service=git-upload-pack`)),
    ).rejects.toMatchObject({
      code: 'url_refused',
    });
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
      const { openUpstream, UpstreamAgents } = await import(process.env.EMB_MODULE);
      const url = process.env.EMB_URL;
      const viaGlobal = await new Promise((resolve, reject) =>
        http.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
      const agents = new UpstreamAgents();
      const res = await openUpstream({ url: new URL(process.env.EMB_URL), method: 'GET', headers: {}, credential: JSON.parse(process.env.EMB_CRED), agents, signal: AbortSignal.timeout(10_000), idleTimeoutMs: 5_000 });
      res.resume();
      agents.destroy();
      console.log(JSON.stringify({ viaGlobal, own: res.statusCode }));
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
      EMB_MODULE: pathToFileURL(fileURLToPath(new URL('./upstream.ts', import.meta.url))).href,
      EMB_URL: `${a.url}/alice/app.git/info/refs?service=git-upload-pack`,
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
    // ...and the gateway's request did not; it reached the forge with the account.
    expect(a.seen.filter((r) => r.authorization === `Basic ${basicAuthValue(cred())}`)).toHaveLength(1);
    expect(b.seen).toEqual([]);
  });

  it('a server that stops sending in the middle of a response hits the idle limit', async () => {
    const stalls = await listen((_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(1024));
    });
    const res = await openUpstream(
      request(`${stalls}/a/b.git/info/refs`, {
        credential: { serverUrl: stalls, username: 'u', token: 'T' },
        idleTimeoutMs: 200,
      }),
    );
    // The server never ends the response: only the idle limit ends the read.
    await expect(drain(res)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a GET follows no redirect to another server, and a POST follows none at all', async () => {
    a.redirectTo = b.url;
    await expect(
      openUpstream(request(`${a.url}/alice/app.git/info/refs?service=git-upload-pack`)),
    ).rejects.toMatchObject({
      code: 'redirect_refused',
    });
    expect(b.seen).toEqual([]);
    // Even to the same server, a POST is never re-sent elsewhere.
    a.redirectTo = a.url;
    await expect(
      openUpstream(
        request(`${a.url}/alice/app.git/git-upload-pack`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-git-upload-pack-request' },
          body: Readable.from([Buffer.from('0000')]),
        }),
      ),
    ).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(a.seen.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(b.seen).toEqual([]);
  });
});
