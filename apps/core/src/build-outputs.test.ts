import { mkdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARCHIVE_DIR_NAME } from './outputs/archive.js';
import { buildOutputs, projects, runs, tickets } from './db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp({ workspacesHostDir: '/srv/emberline/workspaces' });
  cookie = await setupAndLogin(t.app);
  auth = { cookie };
  mut = { cookie, ...CSRF };
});
afterEach(async () => {
  await t.close();
});

let auth: Record<string, string>;
let mut: Record<string, string>;

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
    expect(res.headers['content-disposition']).toBe('attachment; filename="we_ird.apk"');
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

  it('deletes the file and the row', async () => {
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
    expect(t.db.select().from(buildOutputs).all()).toHaveLength(0);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/build-outputs/${row.id}`, headers: mut })).statusCode).toBe(404);
  });

  it('collects from the project runs whose worktrees exist, and counts', async () => {
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

    const res = await t.app.inject({ method: 'POST', url: '/api/projects/p1/build-outputs/collect', headers: mut });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ archived: 2, skipped: 0, failed: 0 });
    expect(t.db.select().from(buildOutputs).all().map((o) => o.name).sort()).toEqual(['a.apk', 'b.apk']);

    const again = await t.app.inject({ method: 'POST', url: '/api/projects/p1/build-outputs/collect', headers: mut });
    expect(again.json()).toEqual({ archived: 0, skipped: 2, failed: 0 });
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
    const res = await t.app.inject({ method: 'POST', url: '/api/projects/p1/build-outputs/collect', headers: mut });
    expect(res.json().archived).toBe(0);
    expect(t.db.select().from(buildOutputs).all()).toHaveLength(0);
  });
});
