import { mkdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_DIR_NAME } from './outputs/archive.js';
import { buildOutputs, projects, runs, tickets } from './db/schema.js';
import { authHeaders, CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let auth: Record<string, string>;
let mut: Record<string, string>;

beforeEach(async () => {
  t = await createTestApp({ workspacesHostDir: '/srv/emberline/workspaces' });
  cookie = await setupAndLogin(t.app);
  auth = { cookie };
  mut = authHeaders(cookie);
});
afterEach(async () => {
  await t.close();
});

function addProject(id = 'p1'): void {
  const p = path.join(t.dir, id);
  mkdirSync(p, { recursive: true });
  t.db.insert(projects).values({ id, name: id, slug: id, path: p, createdAt: new Date() }).run();
}

function addRun(id: string, projectId: string, ticketId?: string): string {
  const wt = path.join(t.dir, '.worktrees', id);
  mkdirSync(wt, { recursive: true });
  t.db
    .insert(runs)
    .values({
      id, projectId, agent: 'claude', state: 'done', worktreePath: wt, hookTokenHash: 'x',
      stateChangedAt: new Date(), createdAt: new Date(), ...(ticketId ? { ticketId } : {}),
    })
    .run();
  return wt;
}

function put(wt: string, rel: string, content: string): void {
  const abs = path.join(wt, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

async function archiveFrom(runId: string): Promise<void> {
  await t.runs.outputs.archiveRun(runId);
}

describe('build outputs API', () => {
  it('requires a session, and CSRF on mutations', async () => {
    addProject();
    expect((await t.app.inject({ method: 'GET', url: '/api/projects/p1/build-outputs' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/build-outputs/x/download' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/build-outputs/x', headers: CSRF, payload: { pinned: true } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/build-outputs/x', headers: auth, payload: { pinned: true } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/build-outputs/x', headers: auth })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/projects/p1/build-outputs/collect', headers: auth })).statusCode).toBe(403);
  });

  it('lists newest first with run and ticket enrichment, and keeps rows after the run is removed', async () => {
    addProject();
    t.db.insert(tickets).values({
      id: 'tk1', projectId: 'p1', number: 7, key: 'EMB-7', title: 'Ship the APK', status: 'review', position: 1,
      createdAt: new Date(), updatedAt: new Date(),
    }).run();
    const wt1 = addRun('r1', 'p1', 'tk1');
    const wt2 = addRun('r2', 'p1');
    put(wt1, 'build/app.apk', 'one');
    put(wt2, 'build/other.apk', 'twotwo');
    await archiveFrom('r1');
    await new Promise((r) => setTimeout(r, 5));
    await archiveFrom('r2');

    const res = await t.app.inject({ method: 'GET', url: '/api/projects/p1/build-outputs', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outputs.map((o: { name: string }) => o.name)).toEqual(['other.apk', 'app.apk']);
    expect(body.usedBytes).toBe(9);
    expect(body.hostArchiveDir).toBe(`/srv/emberline/workspaces/${ARCHIVE_DIR_NAME}/p1`);
    const app = body.outputs[1];
    expect(app).toMatchObject({ runId: 'r1', runExists: true, ticketId: 'tk1', ticketKey: 'EMB-7', ticketTitle: 'Ship the APK', agent: 'claude' });
    expect(app.hostPath.startsWith(`/srv/emberline/workspaces/${ARCHIVE_DIR_NAME}/p1/`)).toBe(true);

    t.db.delete(runs).where(eq(runs.id, 'r1')).run();
    const after = (await t.app.inject({ method: 'GET', url: '/api/projects/p1/build-outputs', headers: auth })).json();
    const kept = after.outputs.find((o: { name: string }) => o.name === 'app.apk');
    expect(kept).toMatchObject({ runExists: false, agent: null });
  });

  it('404s for an unknown project', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/projects/nope/build-outputs', headers: auth })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/api/projects/nope/build-outputs/collect', headers: mut })).statusCode).toBe(404);
  });

  it('downloads as an attachment with the untrusted-content headers', async () => {
    addProject();
    const wt = addRun('r1', 'p1');
    put(wt, 'build/we"ird.apk', 'APKDATA');
    await archiveFrom('r1');
    const id = t.db.select().from(buildOutputs).get()!.id;
    const res = await t.app.inject({ method: 'GET', url: `/api/build-outputs/${id}/download`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe('7');
    expect(res.headers['content-disposition']).toBe('attachment; filename="we_ird.apk"; filename*=UTF-8\'\'we%22ird.apk');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.body).toBe('APKDATA');
  });

  it('404s and forgets the row when the archived file is gone', async () => {
    addProject();
    const wt = addRun('r1', 'p1');
    put(wt, 'a.apk', 'x');
    await archiveFrom('r1');
    const row = t.db.select().from(buildOutputs).get()!;
    rmSync(path.join(t.dir, ARCHIVE_DIR_NAME, row.storedPath));
    const res = await t.app.inject({ method: 'GET', url: `/api/build-outputs/${row.id}/download`, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(t.db.select().from(buildOutputs).all()).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/build-outputs/unknown/download', headers: auth })).statusCode).toBe(404);
  });

  it('pins and unpins', async () => {
    addProject();
    const wt = addRun('r1', 'p1');
    put(wt, 'a.apk', 'x');
    await archiveFrom('r1');
    const id = t.db.select().from(buildOutputs).get()!.id;
    const res = await t.app.inject({ method: 'PATCH', url: `/api/build-outputs/${id}`, headers: mut, payload: { pinned: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, pinned: true, name: 'a.apk' });
    expect(t.db.select().from(buildOutputs).get()!.pinned).toBe(true);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/build-outputs/${id}`, headers: mut, payload: { pinned: 'yes' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/build-outputs/nope', headers: mut, payload: { pinned: true } })).statusCode).toBe(404);
  });

  it('deletes the file and hides the row (kept as a tombstone)', async () => {
    addProject();
    const wt = addRun('r1', 'p1');
    put(wt, 'a.apk', 'x');
    await archiveFrom('r1');
    const row = t.db.select().from(buildOutputs).get()!;
    const file = path.join(t.dir, ARCHIVE_DIR_NAME, row.storedPath);
    expect(existsSync(file)).toBe(true);
    const res = await t.app.inject({ method: 'DELETE', url: `/api/build-outputs/${row.id}`, headers: mut });
    expect(res.statusCode).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect(t.db.select().from(buildOutputs).all().map((o) => o.evictedAt !== null)).toEqual([true]);
    expect((await listOf()).outputs).toEqual([]);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/build-outputs/${row.id}`, headers: mut })).statusCode).toBe(404);
  });

  const collect = (id = 'p1') => t.app.inject({ method: 'POST', url: `/api/projects/${id}/build-outputs/collect`, headers: mut });
  const listOf = async (id = 'p1') => (await t.app.inject({ method: 'GET', url: `/api/projects/${id}/build-outputs`, headers: auth })).json();

  it('collects in the background: 202 at once, coalesced, progress and counts on the list', async () => {
    addProject();
    addProject('p2');
    const wt1 = addRun('r1', 'p1');
    const wt2 = addRun('r2', 'p1');
    const wtOther = addRun('r3', 'p2');
    addRun('r4', 'p1'); // worktree removed below
    rmSync(path.join(t.dir, '.worktrees', 'r4'), { recursive: true });
    put(wt1, 'build/a.apk', 'aa');
    put(wt2, 'build/b.apk', 'bb');
    put(wtOther, 'build/c.apk', 'cc');

    const [first, second] = await Promise.all([collect(), collect()]);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ status: 'started' });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ status: 'running' });
    const during = await listOf();
    expect(during.collecting).toBe(true);
    expect(during.lastCollect).toBeNull();

    await t.runs.outputs.idle();
    const done = await listOf();
    expect(done.collecting).toBe(false);
    expect(done.lastCollect).toMatchObject({ archived: 2, skipped: 0, failed: 0 });
    expect(typeof done.lastCollect.finishedAt).toBe('string');
    expect(t.db.select().from(buildOutputs).all().map((o) => o.name).sort()).toEqual(['a.apk', 'b.apk']);

    expect((await collect()).json()).toEqual({ status: 'started' });
    await t.runs.outputs.idle();
    expect((await listOf()).lastCollect).toMatchObject({ archived: 0, skipped: 2, failed: 0 });
  });

  it('collect skips runs that are mid-turn and takes every other state', async () => {
    addProject();
    const states = ['starting', 'working', 'waiting_input', 'failed', 'done'];
    states.forEach((state, i) => {
      const wt = addRun(`r${i}`, 'p1');
      t.db.update(runs).set({ state }).where(eq(runs.id, `r${i}`)).run();
      put(wt, `build/${state}.apk`, state);
    });
    await collect();
    await t.runs.outputs.idle();
    expect(t.db.select().from(buildOutputs).all().map((o) => o.name).sort()).toEqual(['done.apk', 'failed.apk', 'waiting_input.apk']);
  });

  it('a worktree that vanishes before its pass is skipped without failing the collect', async () => {
    addProject();
    const wt1 = addRun('r1', 'p1');
    const wt2 = addRun('r2', 'p1');
    put(wt1, 'build/a.apk', 'a');
    put(wt2, 'build/b.apk', 'b');
    const first = collect();
    rmSync(wt2, { recursive: true });
    await first;
    await t.runs.outputs.idle();
    const last = (await listOf()).lastCollect;
    expect(last.archived).toBe(1);
    expect(last.failed).toBe(0);
  });

  it('downloads names outside Latin-1 with an ASCII fallback and an encoded UTF-8 name', async () => {
    addProject();
    const wt = addRun('r1', 'p1');
    put(wt, 'build/çıktı-üç-ü.apk', 'x');
    put(wt, 'build/🚀 app.apk', 'y');
    await archiveFrom('r1');
    for (const o of t.db.select().from(buildOutputs).all()) {
      const res = await t.app.inject({ method: 'GET', url: `/api/build-outputs/${o.id}/download`, headers: auth });
      expect(res.statusCode).toBe(200);
      const cd = res.headers['content-disposition'] as string;
      expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(o.name)}`);
      expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]*"; /);
    }
  });

  it('collect ignores a worktree swapped for a symlink', async () => {
    addProject();
    const outside = path.join(t.dir, 'outside');
    put(outside, 'secret.apk', 'secret');
    const wt = path.join(t.dir, '.worktrees', 'r1');
    mkdirSync(path.dirname(wt), { recursive: true });
    symlinkSync(outside, wt);
    t.db.insert(runs).values({
      id: 'r1', projectId: 'p1', agent: 'claude', state: 'done', worktreePath: wt, hookTokenHash: 'x',
      stateChangedAt: new Date(), createdAt: new Date(),
    }).run();
    await collect();
    await t.runs.outputs.idle();
    expect((await listOf()).lastCollect).toMatchObject({ archived: 0 });
    expect(t.db.select().from(buildOutputs).all()).toHaveLength(0);
  });

  it('a run\'s build outputs count what its handoff chain archived, and ?run= reports the chain', async () => {
    addProject();
    const wt = addRun('r1', 'p1');
    t.db.insert(runs).values({
      id: 'r2', projectId: 'p1', agent: 'claude', state: 'done', worktreePath: wt, hookTokenHash: 'x',
      stateChangedAt: new Date(), createdAt: new Date(), predecessorRunId: 'r1',
    }).run();
    t.db.update(runs).set({ handedOffTo: 'r2' }).where(eq(runs.id, 'r1')).run();
    put(wt, 'build/app.apk', 'apk');
    await archiveFrom('r1');
    await archiveFrom('r2');
    rmSync(wt, { recursive: true });

    const run = (await t.app.inject({ method: 'GET', url: '/api/runs/r2/build-outputs', headers: auth })).json();
    expect(run).toMatchObject({ outputs: [], archivedCount: 1 });
    const filtered = (await t.app.inject({ method: 'GET', url: '/api/projects/p1/build-outputs?run=r2', headers: auth })).json();
    expect(filtered.runChain.sort()).toEqual(['r1', 'r2']);
    expect(filtered.outputs.map((o: { runId: string }) => o.runId)).toEqual(['r1']);
    expect((await listOf()).runChain).toBeNull();
  });

  it('saving a lower quota applies it at once; a higher or unchanged one does not', async () => {
    const enforce = vi.spyOn(t.runs.outputs, 'enforceQuota');
    const patch = (buildOutputsQuotaGb: number) =>
      t.app.inject({ method: 'PATCH', url: '/api/factory/settings', headers: mut, payload: { buildOutputsQuotaGb } });
    expect((await patch(10)).statusCode).toBe(200);
    expect((await patch(10)).statusCode).toBe(200);
    expect(enforce).not.toHaveBeenCalled();
    expect((await patch(2)).statusCode).toBe(200);
    expect(enforce).toHaveBeenCalledTimes(1);
  });
});
