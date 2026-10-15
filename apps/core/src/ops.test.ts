import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';
import { openDb } from './db/index.js';
import { createTestApp, type TestApp } from './test-utils.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  delete process.env.EMBERLINE_METRICS_TOKEN;
});

describe('ops endpoints', () => {
  it('reports a deep health check without a session (degraded while the runner is down)', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ url: '/api/health/deep' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.runner.ok).toBe(false);
    expect(Object.keys(body.checks)).toEqual(
      expect.arrayContaining(['database', 'runner', 'runnerProtocol', 'workspaces', 'diskData', 'diskWorkspaces']),
    );
  });

  it('serves Prometheus metrics only with the configured bearer token', async () => {
    t = await createTestApp();
    expect((await t.app.inject({ url: '/metrics' })).statusCode).toBe(404);

    process.env.EMBERLINE_METRICS_TOKEN = 'scrape-secret';
    expect((await t.app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong-secret' } })).statusCode,
    ).toBe(401);
    await t.app.inject({ url: '/api/health' });
    const res = await t.app.inject({ url: '/metrics', headers: { authorization: 'Bearer scrape-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE emberline_up gauge');
    expect(res.body).toContain('emberline_runner_connected 0');
    expect(res.body).toMatch(/emberline_http_requests_total\{method="GET",status="2xx"\} \d+/);
  });
});

describe('backupDatabase', () => {
  it('writes consistent snapshots and keeps only the newest ones', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'backup-'));
    try {
      const file = path.join(dir, 'emberline.db');
      openDb(file).close();
      const backups = path.join(dir, 'backups');
      for (let i = 0; i < 4; i++) backupDatabase(file, backups, 2, new Date(Date.UTC(2026, 9, 15, 10, 0, i)));
      expect(readdirSync(backups).sort()).toEqual(['emberline-20261015T100002Z.db', 'emberline-20261015T100003Z.db']);
      const copy = new Database(path.join(backups, 'emberline-20261015T100003Z.db'), { readonly: true });
      expect(copy.prepare(`select count(*) as n from __drizzle_migrations`).get()).toMatchObject({ n: expect.any(Number) });
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
