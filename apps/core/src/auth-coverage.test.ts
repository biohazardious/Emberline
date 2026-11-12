import { afterEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, type TestApp } from './test-utils.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

interface RouteEntry {
  method: string;
  path: string;
}

/** Reads every registered route out of Fastify's route tree (`printRoutes`), one entry per method. */
function registeredRoutes(tree: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const match = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?$/.exec(line);
    if (!match) continue;
    const depth = (match[1] ?? '').length / 4;
    const segment = (match[2] ?? '').split('|')[0] ?? '';
    stack.length = depth;
    stack[depth] = segment;
    const methods = (match[3] ?? '').split(',').map((m) => m.trim());
    const path = stack.join('').replace(/:[A-Za-z]+/g, 'x');
    for (const method of methods) {
      if (method && method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, path });
    }
  }
  return routes;
}

const OPEN_ROUTES = new Set([
  'GET /api/health',
  'GET /api/health/deep',
  'GET /api/auth/state',
  'POST /api/auth/setup',
  'POST /api/auth/login',
]);

describe('every API route demands a signed-in session', () => {
  it('rejects an anonymous caller on all routes outside the public, internal and demo-token ones', async () => {
    t = await createTestApp();
    const routes = registeredRoutes(t.app.printRoutes({ commonPrefix: false }));
    const api = routes.filter((r) => r.path.startsWith('/api/'));
    expect(api.length).toBeGreaterThan(100);

    const leaks: string[] = [];
    for (const { method, path } of api) {
      const key = `${method} ${path}`;
      if (OPEN_ROUTES.has(key)) continue;
      if (path.startsWith('/api/internal/') || path.startsWith('/api/demo/')) continue;
      const res = await t.app.inject({ method: method as 'GET', url: path, headers: CSRF, payload: {} });
      if (res.statusCode !== 401) leaks.push(`${key} -> ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('refuses a state-changing request without the CSRF header before looking at the session', async () => {
    t = await createTestApp();
    const routes = registeredRoutes(t.app.printRoutes({ commonPrefix: false }));
    const writes = routes.filter(
      (r) =>
        r.path.startsWith('/api/') && !r.path.startsWith('/api/internal/') && !['GET'].includes(r.method),
    );
    const accepted: string[] = [];
    for (const { method, path } of writes) {
      if (path.startsWith('/api/demo/')) continue;
      const res = await t.app.inject({ method: method as 'POST', url: path, payload: {} });
      if (res.statusCode !== 403) accepted.push(`${method} ${path} -> ${res.statusCode}`);
    }
    expect(accepted).toEqual([]);
  });

  it('keeps internal hook routes closed to callers without a run token', async () => {
    t = await createTestApp();
    const routes = registeredRoutes(t.app.printRoutes({ commonPrefix: false }));
    const internal = routes.filter((r) => r.path.startsWith('/api/internal/'));
    expect(internal.length).toBeGreaterThan(0);
    const open: string[] = [];
    for (const { method, path } of internal) {
      const res = await t.app.inject({ method: method as 'POST', url: path, payload: {} });
      if (res.statusCode < 400) open.push(`${method} ${path} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});
