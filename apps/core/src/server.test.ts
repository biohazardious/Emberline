import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HealthResponse } from '@emberline/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

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

  it('rejects a second setup and short passwords', async () => {
    t = await createTestApp();
    const short = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password: 'short' },
    });
    expect(short.statusCode).toBe(400);
    await setupAndLogin(t.app);
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: CSRF,
      payload: { password: 'another long password' },
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

  it('enforces the CSRF header and same-origin requests', async () => {
    t = await createTestApp();
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
