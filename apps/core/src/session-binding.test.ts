/**
 * Sessions are bound to the client address that created them, and a session cookie that arrives
 * from Emberline's own containers (runner, docker) is refused: cookies ignore ports, so a browser
 * sends Emberline's cookie to agent-controlled preview servers on the same host, which could
 * replay it to core.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ContainerAddresses } from './auth/container-addresses.js';
import { loadConfig } from './config.js';
import { runs, sessions } from './db/schema.js';
import { CSRF, createTestApp, TEST_SETUP_TOKEN, type TestApp } from './test-utils.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const ADDRESS_CHANGED = 'signed out: your network address changed';

/** First-run setup from `remoteAddress` (and an optional X-Forwarded-For); returns the cookie. */
async function setupFrom(app: TestApp, remoteAddress: string, forwardedFor?: string): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    remoteAddress,
    headers: { ...CSRF, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
    payload: { password: 'correct horse battery', setupToken: TEST_SETUP_TOKEN },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'emberline_session')!;
  return `${cookie.name}=${cookie.value}`;
}

const get = (app: TestApp, url: string, cookie: string, remoteAddress: string, headers: Record<string, string> = {}) =>
  app.app.inject({ method: 'GET', url, remoteAddress, headers: { cookie, ...headers } });

describe('sessions are bound to the client address', () => {
  it('accepts the address that signed in and refuses another one with a clear reason', async () => {
    t = await createTestApp();
    const cookie = await setupFrom(t, '192.0.2.10');
    expect((await get(t, '/api/projects', cookie, '192.0.2.10')).statusCode).toBe(200);
    const other = await get(t, '/api/projects', cookie, '198.51.100.7');
    expect(other.statusCode).toBe(401);
    expect(other.json()).toMatchObject({ error: 'session_address_changed', message: ADDRESS_CHANGED });
    // The login screen can say why.
    const state = await get(t, '/api/auth/state', cookie, '198.51.100.7');
    expect(state.json()).toMatchObject({ authenticated: false, signedOut: ADDRESS_CHANGED });
    expect((await get(t, '/api/auth/state', cookie, '192.0.2.10')).json()).toMatchObject({ authenticated: true });
    // The owner's session keeps working: a replay from elsewhere does not end it.
    expect((await get(t, '/api/projects', cookie, '192.0.2.10')).statusCode).toBe(200);
  });

  it('uses X-Forwarded-For only with EMBERLINE_TRUST_PROXY', async () => {
    t = await createTestApp({ trustProxy: true });
    const cookie = await setupFrom(t, '127.0.0.1', '203.0.113.5');
    expect((await get(t, '/api/projects', cookie, '127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })).statusCode).toBe(200);
    expect((await get(t, '/api/projects', cookie, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(401);
    await t.close();

    t = await createTestApp({ trustProxy: false });
    const plain = await setupFrom(t, '127.0.0.1', '203.0.113.5');
    // Without a trusted proxy the header is ignored: the socket address is the client.
    expect((await get(t, '/api/projects', plain, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(200);
  });

  it('can be turned off with EMBERLINE_SESSION_BIND_IP=false', async () => {
    expect(loadConfig({}).sessionBindIp).toBe(true);
    expect(loadConfig({ EMBERLINE_SESSION_BIND_IP: 'false' }).sessionBindIp).toBe(false);
    t = await createTestApp({ sessionBindIp: false });
    const cookie = await setupFrom(t, '192.0.2.10');
    expect((await get(t, '/api/projects', cookie, '198.51.100.7')).statusCode).toBe(200);
  });

  it('treats a session from before the upgrade (no address) as signed out, unless binding is off', async () => {
    t = await createTestApp();
    const cookie = await setupFrom(t, '192.0.2.10');
    t.db.update(sessions).set({ clientIp: null }).run();
    expect((await get(t, '/api/projects', cookie, '192.0.2.10')).statusCode).toBe(401);
    await t.close();

    t = await createTestApp({ sessionBindIp: false });
    const legacy = await setupFrom(t, '192.0.2.10');
    t.db.update(sessions).set({ clientIp: null }).run();
    expect((await get(t, '/api/projects', legacy, '192.0.2.10')).statusCode).toBe(200);
  });

  it('applies to WebSocket upgrades', async () => {
    t = await createTestApp();
    const cookie = await setupFrom(t, '192.0.2.10');
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, {
        headers: { cookie, origin: address },
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('error', () => undefined);
    });
    expect(status).toBe(401);
  });
});

describe("session cookies from Emberline's own containers", () => {
  it('are refused with 403, while a browser elsewhere keeps its session', async () => {
    // `localhost` stands in for the runner: it resolves to the inject default 127.0.0.1.
    t = await createTestApp({ containerHosts: ['localhost'] });
    const cookie = await setupFrom(t, '127.0.0.1');
    const res = await get(t, '/api/projects', cookie, '127.0.0.1');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'session_from_container' });
    expect((await get(t, '/api/auth/state', cookie, '127.0.0.1')).json()).toMatchObject({ authenticated: false });

    const browser = await setupFromLogin(t, '192.0.2.10');
    expect((await get(t, '/api/projects', browser, '192.0.2.10')).statusCode).toBe(200);
  });

  it('are refused by the socket address even when a trusted proxy header names another client', async () => {
    t = await createTestApp({ containerHosts: ['localhost'], trustProxy: true });
    const cookie = await setupFrom(t, '127.0.0.1', '203.0.113.5');
    const res = await get(t, '/api/projects', cookie, '127.0.0.1', { 'x-forwarded-for': '203.0.113.5' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'session_from_container' });
  });

  it('leave hook-token (agent, MCP, hook) and demo-token requests from the runner alone', async () => {
    t = await createTestApp({ containerHosts: ['localhost'] });
    const browser = await setupFrom(t, '192.0.2.10');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      remoteAddress: '192.0.2.10',
      headers: { ...CSRF, cookie: browser },
      payload: { name: 'Bound', initGit: false },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json().project as { id: string; path: string };
    const run = { id: randomUUID() };
    const now = new Date();
    // A live run whose agent holds hook token `tok` (inserted directly: no runner in this test).
    t.db
      .insert(runs)
      .values({
        id: run.id,
        projectId: project.id,
        agent: 'claude',
        state: 'working',
        prompt: 'p',
        worktreePath: project.path,
        hookTokenHash: createHash('sha256').update('tok').digest('hex'),
        stateChangedAt: now,
        createdAt: now,
      })
      .run();
    // From the "runner" address, with a stray session cookie too: the bearer route decides alone.
    const hook = await t.app.inject({
      method: 'POST',
      url: `/api/internal/runs/${run.id}/preview`,
      remoteAddress: '127.0.0.1',
      headers: { authorization: 'Bearer tok', cookie: browser },
      payload: {},
    });
    expect(hook.statusCode).toBe(200);
    const wrong = await t.app.inject({
      method: 'POST',
      url: `/api/internal/runs/${run.id}/preview`,
      remoteAddress: '127.0.0.1',
      headers: { authorization: 'Bearer nope' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).not.toBe('session_from_container');
    // Capability demo URLs carry no session and stay open to the runner's browser.
    const demo = await t.app.inject({ method: 'GET', url: '/api/demo/not-a-token/', remoteAddress: '127.0.0.1' });
    expect(demo.statusCode).not.toBe(403);
  });
});

/** A second browser signs in (setup is done already). */
async function setupFromLogin(app: TestApp, remoteAddress: string): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress,
    headers: CSRF,
    payload: { password: 'correct horse battery' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'emberline_session')!;
  return `${cookie.name}=${cookie.value}`;
}

describe('container addresses', () => {
  it('resolves the hosts, normalises IPv4-mapped addresses and tolerates failures', async () => {
    const answers: Record<string, string[] | Error> = {
      runner: ['172.18.0.3'],
      docker: new Error('ENOTFOUND docker'),
    };
    const addresses = new ContainerAddresses(['runner', 'docker'], {
      lookup: async (host) => {
        const a = answers[host];
        if (a instanceof Error) throw a;
        return a ?? [];
      },
      refreshMs: 0,
    });
    await addresses.refresh();
    expect(await addresses.has('172.18.0.3')).toBe(true);
    expect(await addresses.has('::ffff:172.18.0.3')).toBe(true);
    expect(await addresses.has('172.18.0.4')).toBe(false);
    // The engine comes up later; a refresh picks it up, and the runner's old address is dropped.
    answers.docker = ['172.18.0.9'];
    answers.runner = ['172.18.0.5'];
    await addresses.refresh();
    expect(await addresses.has('172.18.0.9')).toBe(true);
    expect(await addresses.has('172.18.0.3')).toBe(false);
    // A failed lookup keeps that host's last known addresses.
    answers.runner = new Error('EAI_AGAIN');
    await addresses.refresh();
    expect(await addresses.has('172.18.0.5')).toBe(true);
    addresses.stop();
  });

  it('defaults to the compose service names and can be set', () => {
    expect(loadConfig({}).containerHosts).toEqual(['runner', 'docker']);
    expect(loadConfig({ EMBERLINE_CONTAINER_HOSTS: 'agents, engine' }).containerHosts).toEqual(['agents', 'engine']);
    expect(loadConfig({ EMBERLINE_CONTAINER_HOSTS: '' }).containerHosts).toEqual([]);
  });
});
