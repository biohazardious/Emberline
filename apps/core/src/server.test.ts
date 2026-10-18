import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthResponse } from '@emberline/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig, parseAllowedHosts } from './config.js';
import { CSRF, createTestApp, setupAndLogin, TEST_SETUP_TOKEN, type TestApp } from './test-utils.js';
import { appCsp } from './security-headers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('core server', () => {
  it('serves a public health check', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json()).status).toBe('ok');
  });

  it('serves the web UI with SPA fallback but keeps API 404s as JSON', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<h1>ember</h1>');
    try {
      t = await createTestApp({ webDir });
      expect((await t.app.inject({ url: '/' })).body).toContain('ember');
      expect((await t.app.inject({ url: '/terminals/42' })).body).toContain('ember');
      const cookie = await setupAndLogin(t.app);
      const api = await t.app.inject({ url: '/api/nope', headers: { cookie } });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toMatchObject({ error: 'not_found' });
    } finally {
      rmSync(webDir, { recursive: true, force: true });
    }
  });
});

describe('host allow-list (DNS rebinding)', () => {
  const webDirWithIndex = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(dir, 'index.html'), '<h1>ember</h1>');
    return dir;
  };

  it('answers 421 to unknown host names on API, SPA, setup and metrics', async () => {
    const webDir = webDirWithIndex();
    try {
      t = await createTestApp({ webDir });
      process.env.EMBERLINE_METRICS_TOKEN = 'scrape-secret';
      for (const url of ['/api/health', '/', '/metrics']) {
        const res = await t.app.inject({ url, headers: { host: 'evil.example:7420' } });
        expect(res.statusCode, url).toBe(421);
        expect(res.body).toContain('EMBERLINE_ALLOWED_HOSTS');
      }
      const setup = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { ...CSRF, host: 'evil.example' },
        payload: { password: 'long enough password', setupToken: TEST_SETUP_TOKEN },
      });
      expect(setup.statusCode).toBe(421);
    } finally {
      delete process.env.EMBERLINE_METRICS_TOKEN;
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it.each(['192.168.1.16:7420', '[::1]:7420', '[fe80::1]', 'localhost:7420', 'LOCALHOST.:7420', 'core:7420', '10.0.0.5'])(
    'lets %s through',
    async (host) => {
      t = await createTestApp({ hookUrl: 'http://core:7420' });
      expect((await t.app.inject({ url: '/api/health', headers: { host } })).statusCode).toBe(200);
    },
  );

  it('allows names from EMBERLINE_ALLOWED_HOSTS and "*" disables the check', async () => {
    t = await createTestApp({ allowedHosts: ['emberline.lan'] });
    expect((await t.app.inject({ url: '/api/health', headers: { host: 'Emberline.LAN:8080' } })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/health', headers: { host: 'other.lan' } })).statusCode).toBe(421);
    await t.close();
    t = await createTestApp({ allowedHosts: ['*'] });
    expect((await t.app.inject({ url: '/api/health', headers: { host: 'anything.example' } })).statusCode).toBe(200);
  });

  it('checks X-Forwarded-Host instead of Host when behind a trusted proxy', async () => {
    t = await createTestApp({ trustProxy: true, allowedHosts: ['emberline.lan'] });
    const get = (forwarded: string) =>
      t!.app.inject({ url: '/api/health', headers: { host: 'core:7420', 'x-forwarded-host': forwarded } });
    expect((await get('evil.example')).statusCode).toBe(421);
    expect((await get('emberline.lan')).statusCode).toBe(200);
  });

  it('parses EMBERLINE_ALLOWED_HOSTS from the environment', () => {
    expect(loadConfig({ EMBERLINE_ALLOWED_HOSTS: ' a.lan, B.lan. ,,*' }).allowedHosts).toEqual(['a.lan', 'b.lan', '*']);
    expect(loadConfig({}).allowedHosts).toEqual([]);
  });

  it('reduces EMBERLINE_ALLOWED_HOSTS entries pasted as URLs to the host name and ignores the rest', () => {
    const parsed = parseAllowedHosts(
      'https://Emberline.Example.com:8443/app?x=1, http://user@nas.lan/, core_1:7420, [::1]:7420, nas2.lan/, has space, bad!name, https://, -dash.lan, a..b',
    );
    expect(parsed.hosts).toEqual(['emberline.example.com', 'nas.lan', 'core_1', '::1', 'nas2.lan']);
    expect(parsed.ignored).toEqual(['has space', 'bad!name', 'https://', '-dash.lan', 'a..b']);
    expect(loadConfig({ EMBERLINE_ALLOWED_HOSTS: 'https://emberline.example.com/' }).allowedHosts).toEqual([
      'emberline.example.com',
    ]);
  });

  it('refuses WebSocket upgrades without an Origin header, even with a valid cookie', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, { headers: { cookie } });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('error', () => undefined);
    });
    expect(status).toBe(403);
  });
});

describe('hardening', () => {
  it('sends security headers and a CSP on the web UI', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<h1>ember</h1>');
    try {
      t = await createTestApp({ webDir });
      const page = await t.app.inject({ url: '/' });
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(page.headers['content-security-policy']).toContain("object-src 'none'");
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      const api = await t.app.inject({ url: '/api/health' });
      expect(api.headers['x-content-type-options']).toBe('nosniff');
      expect(api.headers['referrer-policy']).toBe('same-origin');
    } finally {
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it('lets the web UI frame previews on its own host only, on any port', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<h1>ember</h1>');
    const saved = process.env.EMBERLINE_PREVIEW_HOST;
    try {
      delete process.env.EMBERLINE_PREVIEW_HOST;
      t = await createTestApp({ webDir });
      const frameSrc = async (host: string) => {
        const page = await t!.app.inject({ url: '/', headers: { host } });
        return /frame-src ([^;]*)/.exec(String(page.headers['content-security-policy']))?.[1];
      };
      expect(await frameSrc('192.168.1.16:7420')).toBe("'self' http://192.168.1.16:*");
      expect(await frameSrc('localhost:7497')).toBe("'self' http://localhost:*");
      // CSP host sources cannot name an IPv6 literal: no preview source then.
      expect(await frameSrc('[::1]:7420')).toBe("'self'");
      // A malformed Host never reaches the policy.
      expect(appCsp("evil; script-src 'unsafe-inline'")).toContain("frame-src 'self';");
      expect(appCsp(undefined)).toContain("frame-src 'self';");
      process.env.EMBERLINE_PREVIEW_HOST = 'http://previews.lan/';
      expect(await frameSrc('192.168.1.16:7420')).toBe("'self' http://previews.lan:*");
      process.env.EMBERLINE_PREVIEW_HOST = 'javascript:alert(1)';
      expect(await frameSrc('192.168.1.16:7420')).toBe("'self'");
    } finally {
      if (saved === undefined) delete process.env.EMBERLINE_PREVIEW_HOST;
      else process.env.EMBERLINE_PREVIEW_HOST = saved;
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it("frames previews on the host a trusted proxy forwarded, not the proxy's own Host", async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<h1>ember</h1>');
    const saved = process.env.EMBERLINE_PREVIEW_HOST;
    try {
      delete process.env.EMBERLINE_PREVIEW_HOST;
      t = await createTestApp({ webDir, trustProxy: true, allowedHosts: ['emberline.lan'] });
      const page = await t.app.inject({ url: '/', headers: { host: '127.0.0.1:7420', 'x-forwarded-host': 'emberline.lan' } });
      expect(/frame-src ([^;]*)/.exec(String(page.headers['content-security-policy']))?.[1]).toBe(
        "'self' http://emberline.lan:*",
      );
    } finally {
      if (saved === undefined) delete process.env.EMBERLINE_PREVIEW_HOST;
      else process.env.EMBERLINE_PREVIEW_HOST = saved;
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it('caps request bodies at 1 MiB on routes without a larger limit', async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'content-type': 'application/json' },
      payload: JSON.stringify({ password: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('auth', () => {
  it('requires setup first, then issues a session', async () => {
    t = await createTestApp();
    expect((await t.app.inject({ url: '/api/auth/state' })).json()).toEqual({
      setupRequired: true,
      authenticated: false,
    });
    expect((await t.app.inject({ url: '/api/projects' })).statusCode).toBe(401);

    const cookie = await setupAndLogin(t.app);
    const state = await t.app.inject({ url: '/api/auth/state', headers: { cookie } });
    expect(state.json()).toEqual({ setupRequired: false, authenticated: true });
    expect((await t.app.inject({ url: '/api/projects', headers: { cookie } })).statusCode).toBe(200);
  });

  it('requires the one-time setup token printed in the core log', async () => {
    t = await createTestApp();
    for (const setupToken of [undefined, 'wrong-token']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: CSRF,
        payload: { password: 'long enough password', setupToken },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(404);
    }
    expect((await t.app.inject({ url: '/api/auth/state' })).json()).toMatchObject({ setupRequired: true });
  });

  it('rejects a second setup and short passwords', async () => {
    t = await createTestApp();
    const short = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password: 'short', setupToken: TEST_SETUP_TOKEN },
    });
    expect(short.statusCode).toBe(400);
    await setupAndLogin(t.app);
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password: 'another long password', setupToken: TEST_SETUP_TOKEN },
    });
    expect(again.statusCode).toBe(409);
  });

  it('logs in, logs out and throttles repeated failures', async () => {
    t = await createTestApp();
    await setupAndLogin(t.app, 'the right password');
    const login = (password: string) =>
      t!.app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { password } });

    const ok = await login('the right password');
    expect(ok.statusCode).toBe(200);
    const cookie = `emberline_session=${ok.cookies.find((c) => c.name === 'emberline_session')?.value}`;

    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } });
    expect((await t.app.inject({ url: '/api/projects', headers: { cookie } })).statusCode).toBe(401);

    for (let i = 0; i < 5; i++) expect((await login('wrong')).statusCode).toBe(401);
    expect((await login('the right password')).statusCode).toBe(429);
  });

  it('changes the password, ending every other session', async () => {
    t = await createTestApp();
    const first = await setupAndLogin(t.app, 'the first password');
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: CSRF,
      payload: { password: 'the first password' },
    });
    const other = `emberline_session=${second.cookies.find((c) => c.name === 'emberline_session')?.value}`;
    const change = (cookie: string, currentPassword: string, newPassword: string) =>
      t!.app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: { ...CSRF, cookie },
        payload: { currentPassword, newPassword },
      });
    expect((await change(first, 'wrong password', 'a brand new password')).statusCode).toBe(403);
    expect((await change(first, 'the first password', 'short')).statusCode).toBe(400);
    const ok = await change(first, 'the first password', 'a brand new password');
    expect(ok.statusCode).toBe(200);
    const fresh = `emberline_session=${ok.cookies.find((c) => c.name === 'emberline_session')?.value}`;
    expect((await t.app.inject({ url: '/api/projects', headers: { cookie: other } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/projects', headers: { cookie: first } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/projects', headers: { cookie: fresh } })).statusCode).toBe(200);
    const login = (password: string) =>
      t!.app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { password } });
    expect((await login('the first password')).statusCode).toBe(401);
    expect((await login('a brand new password')).statusCode).toBe(200);
  });

  it('uses a Secure __Host- cookie behind an HTTPS proxy (S18)', async () => {
    t = await createTestApp({ trustProxy: true });
    await setupAndLogin(t.app, 'the right password');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...CSRF, 'x-forwarded-proto': 'https' },
      payload: { password: 'the right password' },
    });
    const cookie = res.cookies.find((c) => c.name === '__Host-emberline_session');
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/' });
    expect(res.cookies.find((c) => c.name === 'emberline_session')).toBeUndefined();
    const auth = `__Host-emberline_session=${cookie?.value}`;
    expect((await t.app.inject({ url: '/api/projects', headers: { cookie: auth } })).statusCode).toBe(200);
  });

  it('closes open WebSockets when their session logs out (S18)', async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, { headers: { cookie, origin: address } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...CSRF, cookie } });
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('says how long a throttled client has to wait', async () => {
    t = await createTestApp();
    await setupAndLogin(t.app, 'the right password');
    const login = (password: string) =>
      t!.app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { password } });
    for (let i = 0; i < 5; i++) await login('wrong');
    const blocked = await login('the right password');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json().message).toMatch(/try again in \d+ minutes?/);
  });

  it('enforces the CSRF header and same-origin requests', async () => {
    t = await createTestApp({ allowedHosts: ['emberline.local'] });
    const noHeader = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'long enough password' },
    });
    expect(noHeader.statusCode).toBe(403);

    const crossOrigin = await t.app.inject({
      url: '/api/auth/state',
      headers: { origin: 'https://evil.example', host: 'emberline.local' },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const sameOrigin = await t.app.inject({
      url: '/api/auth/state',
      headers: { origin: 'http://emberline.local', host: 'emberline.local' },
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it.each(['/%61pi/projects', '/ap%69/projects', '/api/%70rojects'])(
    'decides auth on the matched route, not the raw URL (%s)',
    async (url) => {
      t = await createTestApp();
      await setupAndLogin(t.app);
      const res = await t.app.inject({ url });
      expect(res.statusCode).toBe(401);
    },
  );

  it('rejects absolute-form request targets without a session', async () => {
    t = await createTestApp();
    await setupAndLogin(t.app);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as { port: number };
    const { connect } = await import('node:net');
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET http://127.0.0.1:${port}/api/projects HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += String(chunk);
      });
      socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    expect(status).not.toMatch(/ 200 /);
    expect(status).toMatch(/ 40[0134] /);
  });
});
