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
import {
  API_VERSION,
  CSRF_HEADER,
  SESSION_KEY_MISSING_MESSAGE,
  SESSION_KEY_PROTOCOL_PREFIX,
  type SessionIssued,
  WS_PROTOCOL,
} from '@emberline/protocol';
import {
  authHeaders,
  CSRF,
  createTestApp,
  keyOf,
  sessionFrom,
  setupAndLogin,
  TEST_SETUP_TOKEN,
  type TestApp,
  wsProtocols,
} from './test-utils.js';

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
  return sessionFrom(res);
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
      const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), {
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

describe('a per-login key', () => {
  /** Signs in from `remoteAddress` (setup is done already), optionally sending this browser's cookie. */
  const login = (remoteAddress: string, headers: Record<string, string> = {}) =>
    t!.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress,
      headers: { ...CSRF, ...headers },
      payload: { password: 'correct horse battery' },
    });
  const wsStatus = (address: string, cookie: string, protocols?: string[]) =>
    new Promise<{ status: number; protocol?: string }>((resolve) => {
      const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, protocols, {
        headers: { cookie, origin: address },
      });
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
      ws.once('open', () => {
        const protocol = ws.protocol;
        ws.close();
        resolve({ status: 101, protocol });
      });
      ws.once('error', () => undefined);
    });

  it('mutations need the key, plain GETs need only the cookie', async () => {
    t = await createTestApp();
    await setupFrom(t, '192.0.2.10');
    const res = await login('192.0.2.10');
    const cookie = sessionFrom(res);
    const key = (res.json() as SessionIssued).sessionKey;
    expect(key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const post = (k: string) =>
      t!.app.inject({
        method: 'POST',
        url: '/api/projects',
        remoteAddress: '192.0.2.10',
        headers: { cookie, [CSRF_HEADER]: k },
        payload: { name: 'K', initGit: false },
      });
    expect((await post('1')).json()).toMatchObject({ error: 'session_key_missing', message: SESSION_KEY_MISSING_MESSAGE });
    expect((await post('1')).statusCode).toBe(401);
    expect((await post(key)).statusCode).toBe(201);
    expect((await get(t, '/api/projects', cookie, '192.0.2.10')).statusCode).toBe(200);
  });

  it('the key works with EMBERLINE_SESSION_BIND_IP=false and is required there too', async () => {
    t = await createTestApp({ sessionBindIp: false });
    await setupFrom(t, '192.0.2.10');
    const res = await login('192.0.2.10');
    const cookie = sessionFrom(res);
    const key = (res.json() as SessionIssued).sessionKey;
    const post = (k: string) =>
      t!.app.inject({
        method: 'POST',
        url: '/api/projects',
        remoteAddress: '198.51.100.7',
        headers: { cookie, [CSRF_HEADER]: k },
        payload: { name: 'K', initGit: false },
      });
    expect((await post('1')).statusCode).toBe(401);
    expect((await post(key)).statusCode).toBe(201);
  });

  it('a WebSocket needs the key as a subprotocol; the server echoes only "emberline"', async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password: 'correct horse battery', setupToken: TEST_SETUP_TOKEN },
    });
    const cookie = sessionFrom(res);
    const key = (res.json() as SessionIssued).sessionKey;
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    expect((await wsStatus(address, cookie)).status).toBe(401);
    expect((await wsStatus(address, cookie, [WS_PROTOCOL])).status).toBe(401);
    expect((await wsStatus(address, cookie, [WS_PROTOCOL, `${SESSION_KEY_PROTOCOL_PREFIX}wrong`])).status).toBe(401);
    expect(await wsStatus(address, cookie, [WS_PROTOCOL, `${SESSION_KEY_PROTOCOL_PREFIX}${key}`])).toEqual({
      status: 101,
      protocol: 'emberline',
    });
  });

  it('a session from before 0.5.0 (no key) is signed out once with the notice', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    t.db.update(sessions).set({ keyHash: null }).run();
    const projects = await t.app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(projects.statusCode).toBe(401);
    expect(projects.json()).toMatchObject({ error: 'session_key_missing', message: SESSION_KEY_MISSING_MESSAGE });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/state', headers: { cookie } })).json()).toEqual({
      authenticated: false,
      signedOut: SESSION_KEY_MISSING_MESSAGE,
      setupRequired: false,
    });
  });

  it('/api/auth/state checks a key the browser sends, and answers signed in without one', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const state = (headers: Record<string, string>) =>
      t!.app.inject({ method: 'GET', url: '/api/auth/state', headers: { cookie, ...headers } }).then((r) => r.json());
    expect(await state({})).toEqual({ authenticated: true, setupRequired: false });
    expect(await state({ [CSRF_HEADER]: keyOf(cookie) })).toEqual({ authenticated: true, setupRequired: false });
    expect(await state({ [CSRF_HEADER]: 'a-key-from-another-sign-in' })).toEqual({
      authenticated: false,
      signedOut: SESSION_KEY_MISSING_MESSAGE,
      setupRequired: false,
    });
  });

  it('every changing method needs the key, and a live key from another sign-in is not this one', async () => {
    t = await createTestApp();
    const a = await setupFrom(t, '192.0.2.10');
    const other = await setupFromLogin(t, '192.0.2.10');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      remoteAddress: '192.0.2.10',
      headers: authHeaders(a),
      payload: { name: 'Keyed', initGit: false },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json().project as { id: string }).id;
    const changes = [
      ['PATCH', `/api/projects/${id}/settings`],
      ['PUT', '/api/projects/active'],
      ['DELETE', `/api/projects/${id}`],
    ] as const;
    for (const [method, url] of changes) {
      for (const key of ['1', keyOf(other)]) {
        const res = await t.app.inject({
          method,
          url,
          remoteAddress: '192.0.2.10',
          headers: { cookie: a, [CSRF_HEADER]: key },
          payload: {},
        });
        expect(res.statusCode, `${method} with ${key === '1' ? 'no key' : "another sign-in's key"}`).toBe(401);
        expect(res.json()).toMatchObject({ error: 'session_key_missing' });
      }
    }
    const logout = (key: string) =>
      t!.app.inject({ method: 'POST', url: '/api/auth/logout', remoteAddress: '192.0.2.10', headers: { cookie: a, [CSRF_HEADER]: key } });
    expect((await logout(keyOf(other))).statusCode).toBe(401);
    expect((await logout(keyOf(a))).statusCode).toBe(200);
  });

  it('a tab from before 0.5.0 reads the new API version with its cookie alone, so it offers a reload', async () => {
    // Bumped for the per-login key: an old bundle sends no key, so its changes and live connections fail.
    expect(API_VERSION).toBe(2);
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const system = await t.app.inject({ method: 'GET', url: '/api/system', headers: { cookie } });
    expect(system.statusCode).toBe(200);
    expect(system.json()).toMatchObject({ apiVersion: 2 });
  });

  it("a sign-in revokes the session this browser's cookie named; other devices keep theirs", async () => {
    t = await createTestApp();
    const a = await setupFrom(t, '192.0.2.10');
    const c = sessionFrom(await login('203.0.113.9'));
    const b = sessionFrom(await login('198.51.100.7', { cookie: a }));
    expect((await get(t, '/api/projects', a, '192.0.2.10')).statusCode).toBe(401);
    expect((await get(t, '/api/projects', b, '198.51.100.7')).statusCode).toBe(200);
    expect((await get(t, '/api/projects', c, '203.0.113.9')).statusCode).toBe(200);
  });

  it("a sign-in closes the WebSockets of the session it revokes", async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password: 'correct horse battery', setupToken: TEST_SETUP_TOKEN },
    });
    const cookie = sessionFrom(res);
    const key = (res.json() as SessionIssued).sessionKey;
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, [WS_PROTOCOL, `${SESSION_KEY_PROTOCOL_PREFIX}${key}`], {
      headers: { cookie, origin: address },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    expect((await login('127.0.0.1', { cookie })).statusCode).toBe(200);
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
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
      headers: authHeaders(browser),
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
  return sessionFrom(res);
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
      localNetworks: () => ['172.18.0.0/16'],
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

  /** A lookup that answers from `answers` (an Error is thrown, an unknown host resolves to nothing). */
  const lookupFrom = (answers: Record<string, string[] | Error>) => async (host: string) => {
    const a = answers[host];
    if (a instanceof Error) throw a;
    return a ?? [];
  };

  it('drops a host that no longer resolves (ENOTFOUND) and keeps one on a temporary failure', async () => {
    const answers: Record<string, string[] | Error> = { runner: ['172.18.0.5'], docker: ['172.18.0.9'] };
    const c = new ContainerAddresses(['runner', 'docker'], {
      lookup: lookupFrom(answers),
      refreshMs: 0,
      localNetworks: () => ['172.18.0.0/16'],
    });
    await c.refresh();
    expect(await c.has('172.18.0.9')).toBe(true);
    answers.docker = Object.assign(new Error('getaddrinfo ENOTFOUND docker'), { code: 'ENOTFOUND' });
    answers.runner = Object.assign(new Error('getaddrinfo EAI_AGAIN runner'), { code: 'EAI_AGAIN' });
    await c.refresh();
    expect(await c.has('172.18.0.9')).toBe(false);
    expect(await c.has('172.18.0.5')).toBe(true);
    c.stop();
  });

  it("accepts only answers on core's own networks (a LAN host named docker is ignored)", async () => {
    const c = new ContainerAddresses(['runner', 'docker'], {
      lookup: lookupFrom({ docker: ['192.168.1.20'], runner: ['172.18.0.3', '8.8.8.8'] }),
      refreshMs: 0,
      localNetworks: () => ['172.18.0.0/16'],
    });
    await c.refresh();
    expect(await c.has('192.168.1.20')).toBe(false);
    expect(await c.has('8.8.8.8')).toBe(false);
    expect(await c.has('172.18.0.3')).toBe(true);
    c.stop();
  });

  it('accepts loopback answers', async () => {
    const c = new ContainerAddresses(['localhost'], {
      lookup: lookupFrom({ localhost: ['127.0.0.1', '::1'] }),
      refreshMs: 0,
      localNetworks: () => [],
    });
    await c.refresh();
    expect(await c.has('127.0.0.1')).toBe(true);
    expect(await c.has('::ffff:127.0.0.1')).toBe(true);
    expect(await c.has('::1')).toBe(true);
    c.stop();
  });

  it('accepts a private IPv6 answer on an IPv6 network of core and nothing public', async () => {
    const c = new ContainerAddresses(['runner'], {
      lookup: lookupFrom({ runner: ['fd00:dead::5', '2001:db8::5', 'fd99::1'] }),
      refreshMs: 0,
      localNetworks: () => ['fd00:dead::/64', '2001:db8::/64'],
    });
    await c.refresh();
    expect(await c.has('fd00:dead::5')).toBe(true);
    expect(await c.has('2001:db8::5')).toBe(false);
    expect(await c.has('fd99::1')).toBe(false);
    c.stop();
  });

  it("core's networks that cannot be listed (a restricted sandbox) leave loopback only, never a failed check", async () => {
    const c = new ContainerAddresses(['runner', 'localhost'], {
      lookup: lookupFrom({ runner: ['172.18.0.3'], localhost: ['127.0.0.1'] }),
      refreshMs: 60_000, // the first resolution starts in the constructor
      localNetworks: () => {
        throw Object.assign(new Error('uv_interface_addresses returned Unknown system error 1'), { code: 'ERR_SYSTEM_ERROR' });
      },
    });
    try {
      await expect(c.has('127.0.0.1')).resolves.toBe(true);
      await expect(c.has('172.18.0.3')).resolves.toBe(false);
      await expect(c.refresh()).resolves.toBeUndefined();
    } finally {
      c.stop();
    }
  });

  it('defaults to the compose service names and can be set', () => {
    expect(loadConfig({}).containerHosts).toEqual(['runner', 'docker']);
    expect(loadConfig({ EMBERLINE_CONTAINER_HOSTS: 'agents, engine' }).containerHosts).toEqual(['agents', 'engine']);
    expect(loadConfig({ EMBERLINE_CONTAINER_HOSTS: '' }).containerHosts).toEqual([]);
  });
});
