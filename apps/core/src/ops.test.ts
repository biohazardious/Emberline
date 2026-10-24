import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';
import { openDb } from './db/index.js';
import { quotaWindows } from './db/schema.js';
import { PtydServer } from '@emberline/ptyd/server';
import { PTYD_MIN_PROTOCOL_VERSION, PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { socketDirGuarded } from './ptyd-bridge.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { rmTemp } from './test-rm.js';

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
      expect.arrayContaining([
        'database',
        'runner',
        'runnerProtocol',
        'workspaces',
        'diskData',
        'diskWorkspaces',
      ]),
    );
  });

  describe('runner protocol skew', () => {
    let server: PtydServer | undefined;
    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    /**
     * Core connected to a runner that answers `hello` with `version`, on a host whose Yama setting is
     * `yama` (the file's content; none: no Yama), with ptyd's socket in a directory agents cannot
     * change unless `guarded` is false.
     */
    async function withRunner(
      version: number,
      { yama = '1\n', guarded = true }: { yama?: string | null; guarded?: boolean } = {},
    ) {
      t = await createTestApp();
      const yamaFile = path.join(t.dir, 'ptrace_scope');
      if (yama !== null) writeFileSync(yamaFile, yama);
      server = new PtydServer({ socketPath: t.config.ptydSocket, ptraceScopeFile: yamaFile });
      await server.listen();
      t.ptyd.start();
      await t.ptyd.waitUntilConnected();
      Object.defineProperty(t.ptyd, 'protocolVersion', { get: () => version });
      Object.defineProperty(t.ptyd, 'socketGuarded', { get: () => guarded });
      const cookie = await setupAndLogin(t.app);
      const deep = await t.app.inject({ url: '/api/health/deep' });
      const system = (await t.app.inject({ url: '/api/system', headers: authHeaders(cookie) })).json();
      return { deep, system };
    }

    async function closeRunner() {
      await server?.close();
      server = undefined;
      await t?.close();
      t = undefined;
    }

    it('a current runner is ok, with nothing to update', async () => {
      expect(PTYD_PROTOCOL_VERSION).toBe(4);
      expect(PTYD_MIN_PROTOCOL_VERSION).toBe(4);
      const { deep, system } = await withRunner(4);
      expect(deep.statusCode).toBe(200);
      expect(deep.json().checks.runnerProtocol).toMatchObject({ ok: true });
      expect(system).toMatchObject({ runnerOutdated: false, runnerUpdateAvailable: false });
    });

    for (const version of [2, 3])
      it(`a protocol-${version} runner needs a security update: degraded, and named so`, async () => {
        const { deep, system } = await withRunner(version);
        expect(deep.statusCode).toBe(503);
        expect(deep.json().checks.runnerProtocol.ok).toBe(false);
        expect(deep.json().checks.runnerProtocol.detail).toContain(
          'Security update required: update the runner image',
        );
        expect(system).toMatchObject({ runnerOutdated: true, runnerUpdateAvailable: false });
      });

    it('a runner below the minimum is outdated', async () => {
      const { deep, system } = await withRunner(1);
      expect(deep.statusCode).toBe(503);
      expect(deep.json().checks.runnerProtocol.ok).toBe(false);
      expect(system).toMatchObject({ runnerOutdated: true, runnerUpdateAvailable: false });
    });

    it("a host whose Yama lets agents trace the runner's service is degraded and named, with how to set it", async () => {
      for (const [yama, why] of [
        ['0\n', 'kernel.yama.ptrace_scope is 0'],
        [null, 'the host kernel has no Yama'],
      ] as const) {
        await closeRunner();
        const { deep, system } = await withRunner(4, { yama });
        expect(deep.statusCode).toBe(503);
        expect(deep.json().checks.runnerPtrace).toMatchObject({ ok: false });
        expect(deep.json().checks.runnerPtrace.detail).toContain(why);
        expect(deep.json().checks.runnerPtrace.detail).toContain(
          'set kernel.yama.ptrace_scope=1 on the Docker host',
        );
        expect(system.runnerPtraceUnrestricted).toBe(true);
      }
      for (const yama of ['1\n', '2\n', '3\n']) {
        await closeRunner();
        const { deep, system } = await withRunner(4, { yama });
        expect(deep.statusCode).toBe(200);
        expect(deep.json().checks.runnerPtrace).toEqual({
          ok: true,
          detail: `kernel.yama.ptrace_scope is ${yama.trim()}`,
        });
        expect(system.runnerPtraceUnrestricted).toBe(false);
      }
    });

    it('a runner that does not report Yama (older) gets no warning: it is not known', async () => {
      const { deep, system } = await withRunner(4);
      Object.defineProperty(t!.ptyd, 'ptraceScope', { get: () => undefined });
      const again = await t!.app.inject({ url: '/api/health/deep' });
      expect(deep.statusCode).toBe(200);
      expect(again.json().checks.runnerPtrace.ok).toBe(true);
      expect(again.json().checks.runnerPtrace.detail).toContain('does not report');
      expect(system.runnerPtraceUnrestricted).toBe(false);
    });

    it("a current runner whose socket's directory agents can change is degraded; an older one is told rebuilding locks it", async () => {
      const current = await withRunner(4, { guarded: false });
      expect(current.deep.statusCode).toBe(503);
      expect(current.deep.json().checks.runnerSocket).toMatchObject({ ok: false });
      expect(current.deep.json().checks.runnerSocket.detail).toContain(
        "an agent can replace the runner's service",
      );
      await closeRunner();
      const older = await withRunner(3, { guarded: false });
      // Refused anyway (runnerProtocol); the socket check does not count it twice.
      expect(older.deep.statusCode).toBe(503);
      expect(older.deep.json().checks.runnerSocket.ok).toBe(true);
      expect(older.deep.json().checks.runnerSocket.detail).toContain(
        'rebuilding the runner with `make up` locks it',
      );
    });
  });

  it("the socket's directory counts as guarded only when it is root's and writable by root alone", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sock-dir-'));
    try {
      // A directory of the test's own user (agents' user in the runner) never counts, whatever its mode.
      if (process.getuid?.() !== 0) {
        chmodSync(dir, 0o700);
        expect(await socketDirGuarded(path.join(dir, 'ptyd.sock'))).toBe(false);
      }
      // `/` is root's, 0755 in every container.
      expect(await socketDirGuarded('/ptyd.sock')).toBe(true);
      expect(await socketDirGuarded(path.join(dir, 'missing', 'ptyd.sock'))).toBe(false);
      // /tmp is root's but anyone may add entries (1777).
      expect(await socketDirGuarded(path.join(tmpdir(), 'ptyd.sock'))).toBe(false);
    } finally {
      rmTemp(dir);
    }
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
      t.db
        .insert(quotaWindows)
        .values({ id: agent, agent, exhaustedAt: new Date(), resumeAt, source: 'hook' })
        .run();
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
      expect(readdirSync(backups).sort()).toEqual([
        'emberline-20261015T100002Z.db',
        'emberline-20261015T100003Z.db',
      ]);
      const copy = new Database(path.join(backups, 'emberline-20261015T100003Z.db'), { readonly: true });
      expect(copy.prepare(`select count(*) as n from __drizzle_migrations`).get()).toMatchObject({
        n: expect.any(Number),
      });
      copy.close();
    } finally {
      rmTemp(dir);
    }
  });
});
