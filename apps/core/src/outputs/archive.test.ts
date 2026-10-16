import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreConfig } from '../config.js';
import { type OpenedDb, openDb } from '../db/index.js';
import { buildOutputs, projects, runs, tickets } from '../db/schema.js';
import { updateFactorySettings } from '../factory/settings.js';
import { ARCHIVE_DIR_NAME, BuildOutputArchive } from './archive.js';

const GIB = 1024 ** 3;

let dir: string;
let opened: OpenedDb;
let archive: BuildOutputArchive;
let notes: { runId: string; type: string; payload: unknown }[];
/** Quota for the next passes; undefined reads the factory setting. */
let quota: number | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'outputs-'));
  opened = openDb(':memory:');
  notes = [];
  quota = undefined;
  const config = { workspacesDir: dir, workspacesHostDir: '/srv/emberline/workspaces' } as CoreConfig;
  archive = new BuildOutputArchive(opened.db, config, {
    note: (runId, type, payload) => notes.push({ runId, type, payload }),
    quotaBytes: () => quota,
  });
});

afterEach(async () => {
  await archive.idle();
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

const db = () => opened.db;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);

function addProject(id: string): string {
  const projectPath = path.join(dir, id);
  mkdirSync(projectPath, { recursive: true });
  db().insert(projects).values({ id, name: id, slug: id, path: projectPath, createdAt: new Date() }).run();
  return projectPath;
}

/** A worktree directory for a run (a plain directory unless `withGit`). */
function addWorktree(name: string, withGit = false): string {
  const wt = path.join(dir, '.worktrees', name);
  mkdirSync(wt, { recursive: true });
  if (withGit) {
    git(wt, 'init', '-q', '-b', 'main');
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  return wt;
}

function addRun(
  id: string,
  projectId: string,
  worktreePath: string,
  extra: { ticketId?: string; predecessorRunId?: string; handedOffTo?: string; persona?: string } = {},
): void {
  db()
    .insert(runs)
    .values({
      id,
      projectId,
      agent: 'claude',
      state: 'done',
      worktreePath,
      hookTokenHash: 'x',
      stateChangedAt: new Date(),
      createdAt: new Date(),
      ...extra,
    })
    .run();
}

/** Writes `bytes` bytes of `fill` at `rel` in `wt`, with an explicit mtime (seconds) when given. */
function put(wt: string, rel: string, bytes: number, opts: { fill?: number; mtimeSec?: number } = {}): void {
  const abs = path.join(wt, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, opts.fill ?? 1));
  if (opts.mtimeSec !== undefined) utimesSync(abs, opts.mtimeSec, opts.mtimeSec);
}

function setQuotaBytes(bytes: number): void {
  quota = bytes;
}

const rowsOf = (projectId: string) =>
  db().select().from(buildOutputs).where(eq(buildOutputs.projectId, projectId)).all();
const stored = (storedPath: string) => path.join(dir, ARCHIVE_DIR_NAME, storedPath);

describe('BuildOutputArchive.archiveRun', () => {
  it('copies tracked and git-ignored outputs into <archive>/<projectId>/<runId>/', async () => {
    addProject('p1');
    const wt = addWorktree('r1', true);
    db()
      .insert(tickets)
      .values({
        id: 't1',
        projectId: 'p1',
        number: 1,
        key: 'EMB-1',
        title: 'Ship it',
        status: 'review',
        position: 1024,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    addRun('r1', 'p1', wt, { ticketId: 't1' });
    writeFileSync(path.join(wt, '.gitignore'), 'build/\n');
    put(wt, 'build/app/outputs/apk/debug/app-debug.apk', 2048, { fill: 7 });
    put(wt, 'public/downloads/game.apk', 1024);
    git(wt, 'add', '.gitignore', 'public/downloads/game.apk');
    git(wt, 'commit', '-q', '-m', 'game');

    expect(await archive.archiveRun('r1')).toEqual({ archived: 2, skipped: 0, failed: 0 });

    const rows = rowsOf('p1');
    expect(rows.map((r) => r.sourcePath).sort()).toEqual([
      'build/app/outputs/apk/debug/app-debug.apk',
      'public/downloads/game.apk',
    ]);
    const apk = rows.find((r) => r.name === 'app-debug.apk');
    expect(apk).toMatchObject({
      runId: 'r1',
      ticketId: 't1',
      sizeBytes: 2048,
      storedPath: 'p1/r1/app-debug.apk',
      pinned: false,
    });
    expect(apk?.sourceMtime.getTime()).toBe(
      statSync(path.join(wt, 'build/app/outputs/apk/debug/app-debug.apk')).mtime.getTime(),
    );
    expect(readFileSync(stored('p1/r1/app-debug.apk'))).toEqual(Buffer.alloc(2048, 7));
    expect(notes).toEqual([]);
  });

  it('does not copy an unchanged output again, and replaces a rebuilt one in place', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 1000, { mtimeSec: 1_700_000_000 });
    await archive.archiveRun('r1');
    // Mark the stored copy: a second copy would replace this mtime.
    utimesSync(stored('p1/r1/app.apk'), 1_000_000, 1_000_000);

    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(statSync(stored('p1/r1/app.apk')).mtimeMs).toBe(1_000_000_000);

    put(wt, 'dist/app.apk', 1500, { fill: 9, mtimeSec: 1_700_000_100 });
    expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    const rows = rowsOf('p1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sizeBytes: 1500, storedPath: 'p1/r1/app.apk' });
    expect(rows[0]?.sourceMtime.getTime()).toBe(1_700_000_100_000);
    expect(readFileSync(stored('p1/r1/app.apk'))).toEqual(Buffer.alloc(1500, 9));
  });

  it('keeps two outputs with the same file name apart', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, '.pio/build/esp32dev/firmware.bin', 100, { fill: 1 });
    put(wt, '.pio/build/esp32s3/firmware.bin', 200, { fill: 2 });

    expect(await archive.archiveRun('r1')).toEqual({ archived: 2, skipped: 0, failed: 0 });
    const rows = rowsOf('p1');
    expect(new Set(rows.map((r) => r.storedPath)).size).toBe(2);
    expect(rows.every((r) => r.name === 'firmware.bin')).toBe(true);
    for (const row of rows) expect(statSync(stored(row.storedPath)).size).toBe(row.sizeBytes);
  });

  it('evicts the oldest unpinned outputs of the same project only, once over the quota', async () => {
    setQuotaBytes(3000);
    addProject('p1');
    addProject('p2');
    const archiveAt = async (runId: string, projectId: string, file: string, bytes: number, at: number) => {
      const wt = addWorktree(runId);
      addRun(runId, projectId, wt);
      put(wt, `dist/${file}`, bytes);
      await archive.archiveRun(runId);
      db()
        .update(buildOutputs)
        .set({ archivedAt: new Date(at) })
        .where(eq(buildOutputs.runId, runId))
        .run();
    };
    await archiveAt('other', 'p2', 'other.apk', 2500, 500);
    await archiveAt('r1', 'p1', 'pinned-old.apk', 1000, 1_000);
    await archiveAt('r2', 'p1', 'old.apk', 1000, 2_000);
    const pinned = rowsOf('p1').find((r) => r.name === 'pinned-old.apk');
    archive.setPinned(pinned?.id ?? '', true);

    await archiveAt('r3', 'p1', 'new.apk', 1500, 3_000);

    expect(
      rowsOf('p1')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['new.apk', 'pinned-old.apk']);
    expect(existsSync(stored('p1/r2/old.apk'))).toBe(false);
    expect(existsSync(stored('p1/r1/pinned-old.apk'))).toBe(true);
    // Another project's outputs count against its own quota, not this one's.
    expect(rowsOf('p2').map((r) => r.name)).toEqual(['other.apk']);
    expect(existsSync(stored('p2/other/other.apk'))).toBe(true);
  });

  it('archives nothing more while pinned outputs fill the quota, and says so', async () => {
    setQuotaBytes(3000);
    addProject('p1');
    const wt1 = addWorktree('r1');
    addRun('r1', 'p1', wt1);
    put(wt1, 'dist/keep.apk', 3000);
    await archive.archiveRun('r1');
    archive.setPinned(rowsOf('p1')[0]?.id ?? '', true);
    const wt2 = addWorktree('r2');
    addRun('r2', 'p1', wt2);
    put(wt2, 'dist/next.apk', 500);

    expect(await archive.archiveRun('r2')).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(rowsOf('p1').map((r) => r.name)).toEqual(['keep.apk']);
    expect(existsSync(stored('p1/r2/next.apk'))).toBe(false);
    expect(notes).toEqual([
      expect.objectContaining({
        runId: 'r2',
        type: 'build_outputs_quota_full',
        payload: expect.objectContaining({ skipped: ['dist/next.apk'] }),
      }),
    ]);
  });

  it('skips an output larger than the whole quota', async () => {
    setQuotaBytes(3000);
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/huge.apk', 5000);
    put(wt, 'dist/small.apk', 100);

    expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 1, failed: 0 });
    expect(rowsOf('p1').map((r) => r.name)).toEqual(['small.apk']);
    expect(notes).toEqual([
      expect.objectContaining({
        runId: 'r1',
        type: 'build_output_too_large',
        payload: expect.objectContaining({ path: 'dist/huge.apk', sizeBytes: 5000 }),
      }),
    ]);
  });

  it('records a copy error as a run event and never throws', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    // A file where the project's archive directory should be: mkdir fails.
    mkdirSync(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    writeFileSync(path.join(dir, ARCHIVE_DIR_NAME, 'p1'), 'in the way');

    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 1 });
    expect(rowsOf('p1')).toEqual([]);
    expect(notes).toEqual([
      expect.objectContaining({
        runId: 'r1',
        type: 'build_outputs_archive_failed',
        payload: expect.objectContaining({ failures: [expect.objectContaining({ path: 'dist/app.apk' })] }),
      }),
    ]);
  });

  it('does not archive the same file again for a handoff successor in the same worktree', async () => {
    addProject('p1');
    const wt = addWorktree('shared');
    addRun('r1', 'p1', wt, { handedOffTo: 'r2' });
    addRun('r2', 'p1', wt, { predecessorRunId: 'r1', handedOffTo: 'r3' });
    addRun('r3', 'p1', wt, { predecessorRunId: 'r2' });
    put(wt, 'dist/app.apk', 100, { mtimeSec: 1_700_000_000 });
    await archive.archiveRun('r1');

    expect(await archive.archiveRun('r3')).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(rowsOf('p1').map((r) => r.runId)).toEqual(['r1']);

    // A pass for an earlier run of the chain does not copy what a later one already archived.
    expect(await archive.archiveRun('r2')).toEqual({ archived: 0, skipped: 1, failed: 0 });

    // Rebuilt after the handoff: archived under the run that is current now.
    put(wt, 'dist/app.apk', 200, { mtimeSec: 1_700_000_500 });
    expect(await archive.archiveRun('r3')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(
      rowsOf('p1')
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['r1', 'r3']);
    // ... and a pre-prune pass for the first run does not copy the rebuilt file again.
    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(
      rowsOf('p1')
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['r1', 'r3']);
  });

  it('never archives through a symlinked archive root', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'elsewhere-'));
    try {
      symlinkSync(elsewhere, path.join(dir, ARCHIVE_DIR_NAME));
      expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 1 });
      expect(existsSync(path.join(elsewhere, 'p1'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('serializes passes of one project so two passes do not copy the same output twice', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    const results = await Promise.all([archive.archiveRun('r1'), archive.archiveRun('r1')]);
    // The second pass sees the first one's copy as unchanged: no second copy, no unique-index clash.
    expect(results.map((r) => `${r.archived}/${r.skipped}/${r.failed}`).sort()).toEqual(['0/1/0', '1/0/0']);
    expect(rowsOf('p1')).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it('archives a run that is gone or has no worktree as nothing', async () => {
    addProject('p1');
    addRun('r1', 'p1', path.join(dir, '.worktrees', 'missing'));
    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 0 });
    expect(await archive.archiveRun('no-such-run')).toEqual({ archived: 0, skipped: 0, failed: 0 });
    expect(notes).toEqual([]);
  });
});

describe('BuildOutputArchive background passes', () => {
  it('archiveSoon never throws and idle() waits for it', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    archive.archiveSoon('r1');
    archive.archiveSoon('no-such-run');
    expect(rowsOf('p1')).toEqual([]);
    await archive.idle();
    expect(rowsOf('p1')).toHaveLength(1);
  });

  it('archiveBeforePrune gives up after its timeout and records it', async () => {
    addProject('p1');
    addRun('r1', 'p1', addWorktree('r1'));
    let release: () => void = () => undefined;
    const spy = vi
      .spyOn(archive, 'archiveRun')
      .mockImplementation(
        () => new Promise((resolve) => (release = () => resolve({ archived: 0, skipped: 0, failed: 0 }))),
      );
    try {
      expect(await archive.archiveBeforePrune('r1', 20)).toBe('timeout');
      expect(notes).toEqual([
        expect.objectContaining({
          runId: 'r1',
          type: 'build_outputs_archive_failed',
          payload: expect.objectContaining({ reason: 'timeout' }),
        }),
      ]);
    } finally {
      release();
      spy.mockRestore();
    }
    expect(await archive.archiveBeforePrune('r1', 5_000)).toBe('archived');
  });
});

describe('BuildOutputArchive by id', () => {
  async function archived(projectId: string, runId: string, file = 'app.apk', bytes = 100) {
    if (!db().select().from(projects).where(eq(projects.id, projectId)).get()) addProject(projectId);
    const wt = addWorktree(runId);
    addRun(runId, projectId, wt, { persona: 'tester' });
    put(wt, `dist/${file}`, bytes);
    await archive.archiveRun(runId);
    const row = rowsOf(projectId).find((r) => r.runId === runId);
    if (!row) throw new Error('not archived');
    return row;
  }

  it('lists a project newest first with run, ticket and host path details', async () => {
    db()
      .insert(projects)
      .values({ id: 'p1', name: 'p1', slug: 'p1', path: path.join(dir, 'p1'), createdAt: new Date() })
      .run();
    db()
      .insert(tickets)
      .values({
        id: 't1',
        projectId: 'p1',
        number: 7,
        key: 'EMB-7',
        title: 'Build the APK',
        status: 'done',
        position: 1024,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const first = await archived('p1', 'r1', 'one.apk', 100);
    db()
      .update(buildOutputs)
      .set({ archivedAt: new Date(1_000) })
      .where(eq(buildOutputs.id, first.id))
      .run();
    const wt = addWorktree('r2');
    addRun('r2', 'p1', wt, { ticketId: 't1' });
    put(wt, 'dist/two.apk', 250);
    await archive.archiveRun('r2');
    db().delete(runs).where(eq(runs.id, 'r1')).run();

    updateFactorySettings(db(), { buildOutputsQuotaGb: 2 });
    const res = archive.list('p1');
    expect(res.quotaBytes).toBe(2 * GIB);
    expect(res.usedBytes).toBe(350);
    expect(res.hostArchiveDir).toBe(`/srv/emberline/workspaces/${ARCHIVE_DIR_NAME}/p1`);
    expect(res.outputs.map((o) => o.name)).toEqual(['two.apk', 'one.apk']);
    expect(res.outputs[0]).toMatchObject({
      runId: 'r2',
      runExists: true,
      ticketId: 't1',
      ticketKey: 'EMB-7',
      ticketTitle: 'Build the APK',
      persona: 'coder',
      agent: 'claude',
      pinned: false,
      sizeBytes: 250,
      hostPath: `/srv/emberline/workspaces/${ARCHIVE_DIR_NAME}/p1/r2/two.apk`,
    });
    expect(res.outputs[1]).toMatchObject({
      runId: 'r1',
      runExists: false,
      ticketKey: null,
      persona: null,
      agent: null,
    });
    expect(archive.list('nobody').outputs).toEqual([]);
  });

  it('opens an archived file by id', async () => {
    const row = await archived('p1', 'r1', 'app.apk', 321);
    const opened1 = await archive.open(row.id);
    expect(opened1).toMatchObject({ fileName: 'app.apk', size: 321 });
    expect(readFileSync(opened1.abs).length).toBe(321);
    await expect(archive.open('no-such-id')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 404 for a file that vanished and drops its row', async () => {
    const row = await archived('p1', 'r1');
    rmSync(stored(row.storedPath));
    await expect(archive.open(row.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(archive.get(row.id)).toBeUndefined();

    const other = await archived('p1', 'r2');
    rmSync(stored(other.storedPath));
    await expect(archive.remove(other.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(archive.get(other.id)).toBeUndefined();
  });

  it('never serves a path outside the archive', async () => {
    const row = await archived('p1', 'r1');
    const secret = path.join(dir, 'secret.txt');
    writeFileSync(secret, 'core secret');
    db().update(buildOutputs).set({ storedPath: '../secret.txt' }).where(eq(buildOutputs.id, row.id)).run();
    await expect(archive.open(row.id)).rejects.toMatchObject({ statusCode: expect.any(Number) });

    // A symlink planted in the archive (the workspaces volume is agent-writable) is refused too.
    const planted = await archived('p1', 'r2');
    rmSync(stored(planted.storedPath));
    symlinkSync(secret, stored(planted.storedPath));
    await expect(archive.open(planted.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(readFileSync(secret, 'utf8')).toBe('core secret');
  });

  it('pins, unpins and removes by id', async () => {
    const row = await archived('p1', 'r1');
    expect(archive.setPinned(row.id, true).pinned).toBe(true);
    expect(archive.get(row.id)?.pinned).toBe(true);
    expect(archive.setPinned(row.id, false).pinned).toBe(false);
    expect(() => archive.setPinned('no-such-id', true)).toThrow(expect.objectContaining({ statusCode: 404 }));

    await archive.remove(row.id);
    expect(archive.get(row.id)).toBeUndefined();
    expect(existsSync(stored(row.storedPath))).toBe(false);
    await expect(archive.remove(row.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('removeProject deletes the project rows and archive directory only', async () => {
    await archived('p1', 'r1');
    const keep = await archived('p2', 'r2');
    await archive.removeProject('p1');
    expect(rowsOf('p1')).toEqual([]);
    expect(existsSync(path.join(dir, ARCHIVE_DIR_NAME, 'p1'))).toBe(false);
    expect(rowsOf('p2')).toHaveLength(1);
    expect(existsSync(stored(keep.storedPath))).toBe(true);
  });
});
