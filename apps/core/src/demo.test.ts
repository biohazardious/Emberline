import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CreateProjectResponse } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DemoTokens } from './demo-token.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let projectId: string;
let projectPath: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authHeaders(cookie),
    payload: { name: 'Sandbox Demo' },
  });
  const project = (res.json() as CreateProjectResponse).project;
  projectId = project.id;
  projectPath = project.path;
  mkdirSync(path.join(projectPath, 'dist', 'assets'), { recursive: true });
  writeFileSync(path.join(projectPath, 'dist', 'index.html'), '<!doctype html><html><head></head><body>hi</body></html>');
  writeFileSync(path.join(projectPath, 'dist', 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(path.join(projectPath, 'secret.txt'), 'top secret');
});

afterEach(async () => {
  await t.close();
});

async function demoBase(): Promise<string> {
  const res = await t.app.inject({ url: `/api/projects/${projectId}/demo/main/`, headers: { cookie } });
  expect(res.statusCode).toBe(302);
  return String(res.headers.location);
}

describe('live demo isolation', () => {
  it('requires a session on the project demo route', async () => {
    const res = await t.app.inject({ url: `/api/projects/${projectId}/demo/main/` });
    expect(res.statusCode).toBe(401);
  });

  it('serves demo documents sandboxed with an opaque origin', async () => {
    const base = await demoBase();
    const html = await t.app.inject({ url: base });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    expect(html.headers['content-security-policy']).not.toContain('allow-same-origin');
    const js = await t.app.inject({ url: `${base}assets/app.js` });
    expect(js.statusCode).toBe(200);
    // Module scripts from an opaque origin are CORS requests.
    expect(js.headers['access-control-allow-origin']).toBe('*');
  });

  it('keeps the redirect sub-path', async () => {
    const res = await t.app.inject({
      url: `/api/projects/${projectId}/demo/main/assets/app.js`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toMatch(/\/assets\/app\.js$/);
  });

  it('rejects tampered and expired tokens', async () => {
    const base = await demoBase();
    const tampered = base.replace(/\.([\w-])/, (_m, c: string) => `.${c === 'a' ? 'b' : 'a'}`);
    expect((await t.app.inject({ url: tampered })).statusCode).toBe(404);
    const expired = new DemoTokens(t.db).mint({ projectId, targetId: 'main' }, 1_000, Date.now() - 10_000);
    expect((await t.app.inject({ url: `/api/demo/${expired}/` })).statusCode).toBe(404);
  });

  it('does not follow symlinks or serve dotfiles out of the demo root', async () => {
    symlinkSync(path.join(projectPath, 'secret.txt'), path.join(projectPath, 'dist', 'leak.png'));
    writeFileSync(path.join(projectPath, 'dist', '.env'), 'TOKEN=1');
    const base = await demoBase();
    const leak = await t.app.inject({ url: `${base}leak.png` });
    expect(leak.statusCode).toBe(404);
    expect(leak.body).not.toContain('top secret');
    expect((await t.app.inject({ url: `${base}.env` })).statusCode).toBe(404);
  });
});
