import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ScheduledJob } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { CronService } from './cron/service.js';
import { computeNextCronDate, previewCronRuns } from './cron/schedule.js';
import { quotaWindows, scheduledJobs } from './db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const next = (expr: string, from: string, zone = 'UTC') => computeNextCronDate(expr, new Date(from), zone).toISOString();

describe('cron schedule', () => {
  it('evaluates in the given time zone (B12)', () => {
    // 02:00 in Istanbul (UTC+3) is 23:00 UTC the evening before.
    expect(next('0 2 * * *', '2026-10-14T20:00:00Z', 'Europe/Istanbul')).toBe('2026-10-14T23:00:00.000Z');
    expect(next('0 2 * * *', '2026-10-14T20:00:00Z')).toBe('2026-10-15T02:00:00.000Z');
  });

  it('skips a local time that daylight saving removes and fires once when it repeats', () => {
    // 2027-03-14 02:30 does not exist in New York; the next 02:30 is on the 15th (EDT).
    expect(next('30 2 * * *', '2027-03-14T05:00:00Z', 'America/New_York')).toBe('2027-03-15T06:30:00.000Z');
    // 2027-11-07 01:30 happens twice; only the first (EDT) fires, then the next day (EST).
    const first = next('30 1 * * *', '2027-11-07T04:00:00Z', 'America/New_York');
    expect(first).toBe('2027-11-07T05:30:00.000Z');
    expect(next('30 1 * * *', first, 'America/New_York')).toBe('2027-11-08T06:30:00.000Z');
  });

  it('ORs day-of-month and day-of-week when both are restricted', () => {
    // 13th OR Friday: Friday 2026-10-16 comes first (AND would wait for Friday 2026-11-13).
    expect(next('0 0 13 * 5', '2026-10-14T00:00:00Z')).toBe('2026-10-16T00:00:00.000Z');
    // A starred day field does not restrict: only the other one counts.
    expect(next('0 0 * * 5', '2026-10-14T00:00:00Z')).toBe('2026-10-16T00:00:00.000Z');
  });

  it('accepts names and rejects malformed fields', () => {
    expect(next('0 9 * * MON-FRI', '2026-10-16T10:00:00Z')).toBe('2026-10-19T09:00:00.000Z');
    expect(next('0 0 1 JAN *', '2026-10-16T10:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
    for (const bad of ['-5 * * * *', '61 * * * *', '* * * * MON-', '5-1 * * * *', '* * * *', '*/0 * * * *']) {
      expect(() => computeNextCronDate(bad, new Date())).toThrow();
    }
    expect(() => computeNextCronDate('0 0 30 2 *', new Date())).toThrow(/never fires/);
    expect(() => computeNextCronDate('0 0 * * *', new Date(), 'Mars/Olympus')).toThrow(/time zone/);
  });

  it('previews the next five runs', () => {
    const runs = previewCronRuns('0 */6 * * *', 'UTC', 5, new Date('2026-10-14T01:00:00Z')).map((d) => d.toISOString());
    expect(runs).toEqual([
      '2026-10-14T06:00:00.000Z',
      '2026-10-14T12:00:00.000Z',
      '2026-10-14T18:00:00.000Z',
      '2026-10-15T00:00:00.000Z',
      '2026-10-15T06:00:00.000Z',
    ]);
  });
});

describe('cron jobs', () => {
  let t: TestApp;
  let server: PtydServer;
  afterEach(async () => {
    await t.close();
    await server.close();
  });

  async function start() {
    t = await createTestApp();
    const fake = path.join(t.dir, 'fake-claude.sh');
    writeFileSync(fake, '#!/bin/sh\nread line\n', { mode: 0o755 });
    t.config.claudeCommand = fake;
    server = new PtydServer({ socketPath: t.config.ptydSocket });
    await server.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
    const cookie = await setupAndLogin(t.app);
    const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });
    const { project } = (await api('POST', '/api/projects', { name: 'Cron Project' })).json();
    return { api, projectId: project.id as string };
  }

  it('skips an occurrence while the previous run is still going, unless the job queues (B13)', async () => {
    const { api, projectId } = await start();
    const cron = new CronService(t.db, t.runs, t.scheduler, 'Europe/Istanbul');
    const create = (name: string, overlapPolicy?: 'skip' | 'queue') =>
      api('POST', '/api/cron', { projectId, name, cronExpr: '*/5 * * * *', prompt: 'check', overlapPolicy });
    const skip: ScheduledJob = (await create('skipper')).json();
    const queue: ScheduledJob = (await create('queuer', 'queue')).json();
    expect(skip).toMatchObject({ overlapPolicy: 'skip', timeZone: 'UTC' });
    expect(queue.overlapPolicy).toBe('queue');

    await cron.triggerNow(skip.id);
    await cron.triggerNow(queue.id);
    const due = new Date(Date.now() - 60_000);
    t.db.update(scheduledJobs).set({ nextRunAt: due }).run();

    const spawned = await cron.tick();
    expect(spawned).toHaveLength(1);
    const runsOf = (prompt: string) => t.runs.list().filter((r) => r.prompt === prompt).length;
    expect(runsOf('check')).toBe(3);
    const skipped = t.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, skip.id)).get()!;
    expect(skipped.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("another provider's quota window does not hold back a Claude job; its own lane queues it and skips the next tick", async () => {
    const { api, projectId } = await start();
    const cron = new CronService(t.db, t.runs, t.scheduler, 'UTC');
    const job: ScheduledJob = (await api('POST', '/api/cron', { projectId, name: 'nightly', cronExpr: '*/5 * * * *', prompt: 'nightly' })).json();
    const due = () => t.db.update(scheduledJobs).set({ nextRunAt: new Date(Date.now() - 60_000) }).run();
    const window = (agent: string) =>
      t.db.insert(quotaWindows).values({ id: agent, agent, credential: 'login', pool: '*', exhaustedAt: new Date(), resumeAt: new Date(Date.now() + 3_600_000), source: 'hook' }).run();

    window('antigravity');
    due();
    const [run] = await cron.tick();
    expect(run).toMatchObject({ agent: 'claude' });
    await expect.poll(() => t.runs.getRun(run!.id).state, { timeout: 5_000 }).toBe('starting');
    await t.runs.stop(run!.id);
    await expect
      .poll(async () => {
        await t.runs.reconcile();
        return t.runs.getRun(run!.id).endedAt;
      }, { timeout: 5_000 })
      .not.toBeNull();

    // Claude's own lane closed: the job's run waits queued, and the next occurrence is skipped behind it.
    window('claude');
    due();
    const [queued] = await cron.tick();
    expect(t.runs.getRun(queued!.id).state).toBe('queued');
    due();
    expect(await cron.tick()).toHaveLength(0);
    expect(t.runs.list().filter((r) => r.prompt === 'nightly')).toHaveLength(2);
    expect(job.overlapPolicy).toBe('skip');
  });

  it('stores a job time zone and previews runs over the API', async () => {
    const { api, projectId } = await start();
    const job: ScheduledJob = (
      await api('POST', '/api/cron', {
        projectId,
        name: 'nightly',
        cronExpr: '0 2 * * *',
        prompt: 'nightly',
        timeZone: 'Europe/Istanbul',
      })
    ).json();
    expect(job.timeZone).toBe('Europe/Istanbul');
    expect(new Date(job.nextRunAt).getUTCHours()).toBe(23);
    expect(
      (await api('POST', '/api/cron', { projectId, name: 'x', cronExpr: '0 2 * * *', prompt: 'x', timeZone: 'Nowhere/City' }))
        .statusCode,
    ).toBe(400);

    const preview = await api('POST', '/api/cron/preview', { cronExpr: '0 9 * * MON-FRI', timeZone: 'Europe/Istanbul' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().nextRuns).toHaveLength(5);
    expect(new Date(preview.json().nextRuns[0]).getUTCHours()).toBe(6);
    expect((await api('POST', '/api/cron/preview', { cronExpr: '-5 * * * *' })).statusCode).toBe(400);
  });

  it('offers only auto and bypassPermissions to unattended jobs (R5)', async () => {
    const { api, projectId } = await start();
    const body = { projectId, name: 'n', cronExpr: '*/5 * * * *', prompt: 'p' };
    for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
      expect((await api('POST', '/api/cron', { ...body, permissionMode })).statusCode, permissionMode).toBe(400);
    }
    expect((await api('POST', '/api/cron', { ...body, permissionMode: 'bypassPermissions' })).statusCode).toBe(201);
    const job: ScheduledJob = (await api('POST', '/api/cron', body)).json();
    expect(job.permissionMode).toBe('auto');
    expect((await api('PATCH', `/api/cron/${job.id}`, { permissionMode: 'default' })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/cron/${job.id}`, { permissionMode: 'bypassPermissions' })).statusCode).toBe(200);
  });

  it('runs a stored legacy job with a prompting mode as auto and says so in the run (R5)', async () => {
    const { api, projectId } = await start();
    const cron = new CronService(t.db, t.runs, t.scheduler, 'UTC');
    const job: ScheduledJob = (await api('POST', '/api/cron', { projectId, name: 'old', cronExpr: '*/5 * * * *', prompt: 'old' })).json();
    t.db.update(scheduledJobs).set({ permissionMode: 'default' }).where(eq(scheduledJobs.id, job.id)).run();
    const { run } = await cron.triggerNow(job.id);
    expect(t.runs.get(run.id).permissionMode).toBe('auto');
    const note = t.runs.get(run.id).events.find((e) => e.type === 'permission_mode_overridden');
    expect(note).toBeDefined();
    expect(t.runs.get(run.id).events.find((e) => e.type === 'queued')?.payload).toMatchObject({ unattended: 'cron' });
  });
});
