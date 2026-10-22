import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';
import { openDb } from './db/index.js';
import { quotaWindows } from './db/schema.js';
import { PtydServer } from '@emberline/ptyd/server';
import { PTYD_MIN_PROTOCOL_VERSION, PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

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

  describe('runner protocol skew', () => {
    let server: PtydServer | undefined;
    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    /** Core connected to a runner that answers `hello` with `version`. */
    async function withRunner(version: number) {
      t = await createTestApp();
      server = new PtydServer({ socketPath: t.config.ptydSocket });
      await server.listen();
      t.ptyd.start();
      await t.ptyd.waitUntilConnected();
      Object.defineProperty(t.ptyd, 'protocolVersion', { get: () => version });
      const cookie = await setupAndLogin(t.app);
      const deep = await t.app.inject({ url: '/api/health/deep' });
      const system = (await t.app.inject({ url: '/api/system', headers: authHeaders(cookie) })).json();
      return { deep, system };
    }

    it('a current runner is ok, with nothing to update', async () => {
      expect(PTYD_PROTOCOL_VERSION).toBe(3);
      expect(PTYD_MIN_PROTOCOL_VERSION).toBe(2);
      const { deep, system } = await withRunner(3);
      expect(deep.statusCode).toBe(200);
      expect(deep.json().checks.runnerProtocol).toMatchObject({ ok: true });
      expect(system).toMatchObject({ runnerOutdated: false, runnerUpdateAvailable: false });
    });

    it('a protocol-2 runner still works: ok, with an update available', async () => {
      const { deep, system } = await withRunner(2);
      expect(deep.statusCode).toBe(200);
      expect(deep.json().checks.runnerProtocol.ok).toBe(true);
      expect(deep.json().checks.runnerProtocol.detail).toContain('update available');
      expect(system).toMatchObject({ runnerOutdated: false, runnerUpdateAvailable: true });
    });

    it('a runner below the minimum is outdated', async () => {
      const { deep, system } = await withRunner(1);
      expect(deep.statusCode).toBe(503);
      expect(deep.json().checks.runnerProtocol.ok).toBe(false);
      expect(system).toMatchObject({ runnerOutdated: true, runnerUpdateAvailable: false });
    });
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
    expect(res.body).toContain('emberline_quota_paused 0');
  });

  it('reports how many quota lanes are out of quota', async () => {
    t = await createTestApp();
    process.env.EMBERLINE_METRICS_TOKEN = 'scrape-secret';
    const resumeAt = new Date(Date.now() + 3_600_000);
    for (const agent of ['claude', 'antigravity']) {
      t.db.insert(quotaWindows).values({ id: agent, agent, exhaustedAt: new Date(), resumeAt, source: 'hook' }).run();
    }
    const res = await t.app.inject({ url: '/metrics', headers: { authorization: 'Bearer scrape-secret' } });
    expect(res.body).toMatch(/# HELP emberline_quota_paused .*lanes out of quota/);
    expect(res.body).toContain('emberline_quota_paused 2');
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
