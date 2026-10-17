import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreConfig } from '../config.js';
import { type OpenedDb, openDb } from '../db/index.js';
import type { Readable } from 'node:stream';
import { buildOutputs, projects, runEvents, runs, tickets } from '../db/schema.js';
import { updateFactorySettings } from '../factory/settings.js';
import { ARCHIVE_DIR_NAME, BuildOutputArchive } from './archive.js';

const GIB = 1024 ** 3;

let dir: string;
let opened: OpenedDb;
let archive: BuildOutputArchive;
let notes: { runId: string; type: string; payload: unknown }[];
/** Quota for the next passes; undefined reads the factory setting. */
let quota: number | undefined;
/** Runs when a pass reads the quota, i.e. right after it listed the worktree. */
let onQuotaRead: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'outputs-'));
  opened = openDb(':memory:');
  notes = [];
  quota = undefined;
  onQuotaRead = undefined;
  const config = { workspacesDir: dir, workspacesHostDir: '/srv/emberline/workspaces' } as CoreConfig;
  archive = new BuildOutputArchive(opened.db, config, {
    // Like RunService.note: the event lands in the run's timeline (the archive reads it back).
    note: (runId, type, payload) => {
      notes.push({ runId, type, payload });
      try {
        opened.db.insert(runEvents).values({ runId, ts: new Date(), source: 'system', type, payload }).run();
      } catch {
        // The run row is gone.
      }
    },
    quotaBytes: () => {
      onQuotaRead?.();
      return quota;
    },
  });
});

afterEach(async () => {
  await archive.idle();
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

const db = () => opened.db;
const readAll = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};
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
  extra: {
    ticketId?: string;
    predecessorRunId?: string;
    handedOffTo?: string;
    persona?: string;
    state?: 'done' | 'working' | 'starting' | 'failed';
  } = {},
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

/** The project's archived outputs (quota tombstones left out). */
const rowsOf = (projectId: string) =>
  db()
    .select()
    .from(buildOutputs)
    .where(and(eq(buildOutputs.projectId, projectId), isNull(buildOutputs.evictedAt)))
    .all();
/** Every row of the project, quota tombstones included. */
const allRowsOf = (projectId: string) =>
  db().select().from(buildOutputs).where(eq(buildOutputs.projectId, projectId)).all();
const stored = (storedPath: string) => path.join(dir, ARCHIVE_DIR_NAME, storedPath);
const archiveRoot = () => path.join(dir, ARCHIVE_DIR_NAME);

/** Every non-directory entry under `root`, relative; [] when it does not exist. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((e) => !e.isDirectory())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .sort();
}

/** Makes every archive copy wait for `gate` first (a slow disk), or run `before` first. */
function hookCopies(before: () => Promise<void> | void) {
  const target = archive as unknown as { copyBytes: (...args: unknown[]) => Promise<void> };
  const original = target.copyBytes.bind(archive);
  return vi.spyOn(target, 'copyBytes').mockImplementation(async (...args: unknown[]) => {
    await before();
    return original(...args);
  });
}
const slowCopies = (gate: Promise<void>) => hookCopies(() => gate);

/** A directory outside the workspaces root standing in for core's /data. */
function outsideDir(): string {
  const outside = mkdtempSync(path.join(tmpdir(), 'core-data-'));
  writeFileSync(path.join(outside, 'emberline.db'), 'core secrets');
  return outside;
}
const archiveLeaks = () =>
  filesUnder(archiveRoot()).some((f) =>
    readFileSync(path.join(archiveRoot(), f), 'utf8').includes('core secrets'),
  );

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

  it('notes the same failure only once per run, so retried passes do not flood the timeline', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'elsewhere-'));
    try {
      symlinkSync(elsewhere, path.join(dir, ARCHIVE_DIR_NAME));
      expect(await archive.archiveBeforePrune('r1', 5_000, { keepOnTimeout: true })).toBe('failed');
      expect(await archive.archiveBeforePrune('r1', 5_000, { keepOnTimeout: true })).toBe('failed');
      expect(notes.map((n) => n.type)).toEqual(['build_outputs_archive_failed']);
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

  it('archiveBeforePrune gives up after its timeout, records it and frees the project', async () => {
    addProject('p1');
    addRun('r1', 'p1', addWorktree('r1'));
    let release: () => void = () => undefined;
    // A pass that hangs (a stuck mount) and would hold the project's lock forever.
    const spy = vi
      .spyOn(archive as unknown as { archivePass: () => Promise<unknown> }, 'archivePass')
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
      // The lock was released on timeout: the next pass runs while the hung one still hangs.
      spy.mockRestore();
      expect(await archive.archiveBeforePrune('r1', 5_000)).toBe('archived');
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('a pass that ran out of time writes nothing when it finally gets there', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = slowCopies(gate);
    try {
      expect(await archive.archiveBeforePrune('r1', 20)).toBe('timeout');
    } finally {
      release();
    }
    await archive.idle();
    slow.mockRestore();
    expect(rowsOf('p1')).toEqual([]);
    expect(filesUnder(path.join(dir, ARCHIVE_DIR_NAME))).toEqual([]);
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
    expect(await readAll(opened1.stream)).toEqual(Buffer.alloc(321, 1));
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
    await expect(archive.open(row.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(archive.get(row.id)).toBeUndefined();

    // A symlink planted in the archive (the workspaces volume is agent-writable) is refused too.
    const planted = await archived('p1', 'r2');
    rmSync(stored(planted.storedPath));
    symlinkSync(secret, stored(planted.storedPath));
    await expect(archive.open(planted.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(archive.get(planted.id)).toBeUndefined();
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

describe('BuildOutputArchive and agent-controlled files', () => {
  let outside: string;
  beforeEach(() => {
    outside = outsideDir();
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it('never copies an output that is a symlink', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/real.apk', 10);
    symlinkSync(path.join(outside, 'emberline.db'), path.join(wt, 'dist/evil.apk'));

    expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(rowsOf('p1').map((r) => r.name)).toEqual(['real.apk']);
    expect(archiveLeaks()).toBe(false);
  });

  it('refuses, and records, a file or directory swapped for a symlink after the listing', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    put(wt, 'pkg/fw.apk', 100);
    writeFileSync(path.join(outside, 'fw.apk'), 'core secrets');
    onQuotaRead = () => {
      onQuotaRead = undefined;
      rmSync(path.join(wt, 'dist/app.apk'));
      symlinkSync(path.join(outside, 'emberline.db'), path.join(wt, 'dist/app.apk'));
      rmSync(path.join(wt, 'pkg'), { recursive: true });
      symlinkSync(outside, path.join(wt, 'pkg'));
    };

    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 2 });
    expect(rowsOf('p1')).toEqual([]);
    expect(archiveLeaks()).toBe(false);
    const failed = notes.find((n) => n.type === 'build_outputs_archive_failed')?.payload as {
      failures: { path: string }[];
    };
    expect(failed.failures.map((f) => f.path).sort()).toEqual(['dist/app.apk', 'pkg/fw.apk']);
  });

  it('copies the bytes of the file it opened, even if a symlink is swapped in during the copy', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100, { fill: 3 });
    const hook = hookCopies(() => {
      rmSync(path.join(wt, 'dist/app.apk'));
      symlinkSync(path.join(outside, 'emberline.db'), path.join(wt, 'dist/app.apk'));
    });
    try {
      expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    } finally {
      hook.mockRestore();
    }
    expect(readFileSync(stored('p1/r1/app.apk'))).toEqual(Buffer.alloc(100, 3));
    expect(archiveLeaks()).toBe(false);
  });

  it('refuses a worktree swapped for a symlink, at its root or at its .worktrees/<slug> parent', async () => {
    addProject('p1');
    mkdirSync(path.join(outside, 'build'));
    writeFileSync(path.join(outside, 'build/x.apk'), 'core secrets');
    mkdirSync(path.join(dir, '.worktrees'), { recursive: true });
    symlinkSync(outside, path.join(dir, '.worktrees', 'r1'));
    addRun('r1', 'p1', path.join(dir, '.worktrees', 'r1'));
    mkdirSync(path.join(outside, 'slug/r2/build'), { recursive: true });
    writeFileSync(path.join(outside, 'slug/r2/build/y.apk'), 'core secrets');
    symlinkSync(path.join(outside, 'slug'), path.join(dir, '.worktrees', 'slug'));
    addRun('r2', 'p1', path.join(dir, '.worktrees', 'slug', 'r2'));

    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 1 });
    expect(await archive.archiveRun('r2')).toEqual({ archived: 0, skipped: 0, failed: 1 });
    expect(rowsOf('p1')).toEqual([]);
    expect(archiveLeaks()).toBe(false);
    expect(notes.map((n) => [n.runId, n.type])).toEqual([
      ['r1', 'build_outputs_archive_failed'],
      ['r2', 'build_outputs_archive_failed'],
    ]);
  });

  it('never deletes outside the archive through a symlinked run directory or stored file', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    put(wt, 'dist/other.apk', 100);
    await archive.archiveRun('r1');
    const [app, other] = ['app.apk', 'other.apk'].map((n) => rowsOf('p1').find((r) => r.name === n));
    writeFileSync(path.join(outside, 'other.apk'), 'keep me');

    // A link planted in place of a stored file: the link goes, its target stays.
    rmSync(stored('p1/r1/other.apk'));
    symlinkSync(path.join(outside, 'other.apk'), stored('p1/r1/other.apk'));
    await archive.remove(other?.id ?? '');
    expect(readFileSync(path.join(outside, 'other.apk'), 'utf8')).toBe('keep me');

    // The run directory swapped for a link: nothing is deleted there.
    writeFileSync(path.join(outside, 'app.apk'), 'keep me too');
    rmSync(path.join(archiveRoot(), 'p1', 'r1'), { recursive: true });
    symlinkSync(outside, path.join(archiveRoot(), 'p1', 'r1'));
    await expect(archive.remove(app?.id ?? '')).rejects.toMatchObject({ statusCode: 404 });
    expect(archive.get(app?.id ?? '')).toBeUndefined();
    expect(readFileSync(path.join(outside, 'app.apk'), 'utf8')).toBe('keep me too');
  });

  it('leaves no temp file behind when placing the copy fails', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    // A directory where the copy should land: the rename fails.
    mkdirSync(stored('p1/r1/app.apk'), { recursive: true });

    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 1 });
    expect(filesUnder(path.join(archiveRoot(), 'p1', 'r1'))).toEqual([]);
  });

  it('sweeps temp files a crash left behind, once they are an hour old', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    const crashed = path.join(archiveRoot(), 'p1', 'old-run');
    mkdirSync(crashed, { recursive: true });
    writeFileSync(path.join(crashed, '.app.apk.1111.part'), 'half');
    writeFileSync(path.join(crashed, '.app.apk.2222.part'), 'in flight');
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
    utimesSync(path.join(crashed, '.app.apk.1111.part'), twoHoursAgo, twoHoursAgo);

    await archive.archiveRun('r1');
    expect(filesUnder(crashed)).toEqual(['.app.apk.2222.part']);
  });
});

describe('BuildOutputArchive notes and races', () => {
  it('notes an oversized output and a full quota once per run and output', async () => {
    quota = 3000;
    addProject('p1');
    const wt1 = addWorktree('r1');
    addRun('r1', 'p1', wt1);
    put(wt1, 'dist/keep.apk', 2900);
    await archive.archiveRun('r1');
    archive.setPinned(rowsOf('p1')[0]?.id ?? '', true);
    const wt2 = addWorktree('r2');
    addRun('r2', 'p1', wt2);
    put(wt2, 'dist/huge.apk', 5000);
    put(wt2, 'dist/next.apk', 500);

    await archive.archiveRun('r2');
    await archive.archiveRun('r2');
    expect(notes.map((n) => n.type).sort()).toEqual(['build_output_too_large', 'build_outputs_quota_full']);

    // A new output that does not fit is still news.
    put(wt2, 'dist/third.apk', 400);
    await archive.archiveRun('r2');
    const quotaNotes = notes.filter((n) => n.type === 'build_outputs_quota_full');
    expect(quotaNotes.map((n) => (n.payload as { skipped: string[] }).skipped)).toEqual([
      ['dist/next.apk'],
      ['dist/third.apk'],
    ]);
  });

  it('a project being deleted wins against a pass in flight and a pass queued after it', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = slowCopies(gate);
    const pass = archive.archiveRun('r1');
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    const removal = archive.removeProject('p1');
    release();
    await pass;
    await removal;
    slow.mockRestore();
    expect(rowsOf('p1')).toEqual([]);
    expect(existsSync(path.join(archiveRoot(), 'p1'))).toBe(false);

    // The route deletes the project row afterwards; a pass in between writes nothing.
    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 0 });
    await archive.idle();
    expect(existsSync(path.join(archiveRoot(), 'p1'))).toBe(false);
  });

  it('copies again when the handoff chain copy it would reuse is gone from disk', async () => {
    addProject('p1');
    const wt = addWorktree('shared');
    addRun('r1', 'p1', wt, { handedOffTo: 'r2' });
    addRun('r2', 'p1', wt, { predecessorRunId: 'r1' });
    put(wt, 'dist/app.apk', 100);
    await archive.archiveRun('r1');
    rmSync(stored('p1/r1/app.apk'));

    expect(await archive.archiveRun('r2')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(existsSync(stored('p1/r2/app.apk'))).toBe(true);
  });
});

describe('BuildOutputArchive and a newer pass', () => {
  it('a failed insert never deletes the file a newer pass recorded for the same output', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    // While this pass copies, another one records the same output (the unique index then refuses
    // this pass's insert).
    const hook = hookCopies(() => {
      db()
        .insert(buildOutputs)
        .values({
          id: 'newer',
          projectId: 'p1',
          runId: 'r1',
          name: 'app.apk',
          sourcePath: 'dist/app.apk',
          storedPath: 'p1/r1/app.apk',
          sizeBytes: 100,
          sourceMtime: new Date(),
          archivedAt: new Date(),
          sha256: 'x',
        })
        .run();
    });
    try {
      expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 1 });
    } finally {
      hook.mockRestore();
    }
    expect(rowsOf('p1').map((r) => r.id)).toEqual(['newer']);
    expect(existsSync(stored('p1/r1/app.apk'))).toBe(true);
  });
});

describe('BuildOutputArchive quota tombstones', () => {
  /** Runs r1..rN, each with its own 1000-byte APK built one second after the previous one. */
  async function buildsInOrder(count: number): Promise<void> {
    for (let i = 1; i <= count; i += 1) {
      const wt = addWorktree(`r${i}`);
      addRun(`r${i}`, 'p1', wt);
      put(wt, 'dist/app.apk', 1000, { fill: i, mtimeSec: 1_700_000_000 + i });
      await archive.archiveRun(`r${i}`);
    }
  }

  it('keeps an evicted output as a hidden tombstone and never copies it back', async () => {
    setQuotaBytes(3000);
    addProject('p1');
    await buildsInOrder(5);
    expect(rowsOf('p1').map((r) => r.runId).sort()).toEqual(['r3', 'r4', 'r5']);
    const tombstones = allRowsOf('p1').filter((r) => r.evictedAt !== null);
    expect(tombstones.map((r) => r.runId).sort()).toEqual(['r1', 'r2']);
    expect(existsSync(stored('p1/r1/app.apk'))).toBe(false);
    const listed = archive.list('p1');
    expect(listed.outputs.map((o) => o.runId)).toEqual(['r5', 'r4', 'r3']);
    expect(listed.usedBytes).toBe(3000);

    // Collect (twice) and a pre-prune pass of an old run copy nothing and keep the newest builds.
    const copies = hookCopies(() => undefined);
    try {
      expect(await archive.collectProject('p1')).toEqual({ archived: 0, skipped: 5, failed: 0 });
      expect(await archive.collectProject('p1')).toEqual({ archived: 0, skipped: 5, failed: 0 });
      expect(await archive.archiveBeforePrune('r1')).toBe('archived');
      expect(copies).not.toHaveBeenCalled();
    } finally {
      copies.mockRestore();
    }
    expect(rowsOf('p1').map((r) => r.runId).sort()).toEqual(['r3', 'r4', 'r5']);
    expect(archive.get(tombstones[0]?.id ?? '')).toBeUndefined();
    await expect(archive.open(tombstones[0]?.id ?? '')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('archives a rebuilt output of an evicted run again, in place of its tombstone', async () => {
    setQuotaBytes(3000);
    addProject('p1');
    await buildsInOrder(4);
    put(path.join(dir, '.worktrees', 'r1'), 'dist/app.apk', 1000, { fill: 9, mtimeSec: 1_700_000_100 });

    expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    const r1 = allRowsOf('p1').filter((r) => r.runId === 'r1');
    expect(r1).toHaveLength(1);
    expect(r1[0]?.evictedAt).toBeNull();
    expect(readFileSync(stored('p1/r1/app.apk'))).toEqual(Buffer.alloc(1000, 9));
  });

  it('removes a run directory once its last file is evicted or deleted', async () => {
    setQuotaBytes(2000);
    addProject('p1');
    await buildsInOrder(3);
    expect(existsSync(path.join(archiveRoot(), 'p1', 'r1'))).toBe(false);
    const r3 = rowsOf('p1').find((r) => r.runId === 'r3');
    await archive.remove(r3?.id ?? '');
    expect(existsSync(path.join(archiveRoot(), 'p1', 'r3'))).toBe(false);
    expect(existsSync(path.join(archiveRoot(), 'p1', 'r2'))).toBe(true);
  });

  it('enforceQuota applies a lowered quota to every project at once', async () => {
    setQuotaBytes(5000);
    addProject('p1');
    await buildsInOrder(4);
    expect(rowsOf('p1')).toHaveLength(4);
    setQuotaBytes(2000);
    await archive.enforceQuota();
    expect(rowsOf('p1').map((r) => r.runId).sort()).toEqual(['r3', 'r4']);
    expect(archive.list('p1').usedBytes).toBe(2000);
  });
});

describe('BuildOutputArchive identical files across runs', () => {
  it('archives a file once when several runs share the main workspace (no git)', async () => {
    const workspace = addProject('p1');
    addRun('r1', 'p1', workspace);
    addRun('r2', 'p1', workspace);
    addRun('r3', 'p1', workspace);
    put(workspace, 'dist/app.apk', 1000, { mtimeSec: 1_700_000_000 });

    expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(await archive.archiveRun('r2')).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(await archive.collectProject('p1')).toEqual({ archived: 0, skipped: 3, failed: 0 });
    expect(rowsOf('p1').map((r) => r.runId)).toEqual(['r1']);

    // Rebuilt by a later run: a new build, archived under that run.
    put(workspace, 'dist/app.apk', 1000, { fill: 4, mtimeSec: 1_700_000_500 });
    expect(await archive.archiveRun('r3')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(rowsOf('p1').map((r) => r.runId).sort()).toEqual(['r1', 'r3']);
  });

  it('copies a committed deliverable once even though every worktree checks it out anew', async () => {
    addProject('p1');
    const wt1 = addWorktree('r1');
    const wt2 = addWorktree('r2');
    const wt3 = addWorktree('r3');
    addRun('r1', 'p1', wt1);
    addRun('r2', 'p1', wt2);
    addRun('r3', 'p1', wt3);
    put(wt1, 'firmware/fw.bin', 800, { fill: 2, mtimeSec: 1_700_000_000 });
    put(wt2, 'firmware/fw.bin', 800, { fill: 2, mtimeSec: 1_700_000_900 });
    // Same size, different bytes: a different build.
    put(wt3, 'firmware/fw.bin', 800, { fill: 3, mtimeSec: 1_700_000_900 });

    expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(await archive.archiveRun('r2')).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(await archive.archiveRun('r3')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(rowsOf('p1').map((r) => r.runId).sort()).toEqual(['r1', 'r3']);
  });
});

describe('BuildOutputArchive and a worktree still in use', () => {
  it('does not archive a run whose worktree a handoff successor is still building in', async () => {
    addProject('p1');
    const wt = addWorktree('shared');
    addRun('r1', 'p1', wt, { handedOffTo: 'r2' });
    addRun('r2', 'p1', wt, { predecessorRunId: 'r1', state: 'working' });
    put(wt, 'dist/app.apk', 100);

    expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 0 });
    expect(await archive.archiveBeforePrune('r1')).toBe('archived');
    expect(await archive.collectProject('p1')).toEqual({ archived: 0, skipped: 0, failed: 0 });
    expect(rowsOf('p1')).toEqual([]);

    // The successor's own `done` archives it.
    db().update(runs).set({ state: 'done' }).where(eq(runs.id, 'r2')).run();
    expect(await archive.archiveRun('r2')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(rowsOf('p1').map((r) => r.runId)).toEqual(['r2']);
  });

  it('discards a copy of a file that changed while it was copied', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    const growing = hookCopies(() => appendFileSync(path.join(wt, 'dist/app.apk'), Buffer.alloc(50, 1)));
    try {
      expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 0, failed: 1 });
    } finally {
      growing.mockRestore();
    }
    expect(rowsOf('p1')).toEqual([]);
    expect(filesUnder(archiveRoot())).toEqual([]);
  });
});

describe('BuildOutputArchive and free disk space', () => {
  it('skips a copy that would leave less than 1 GiB free on the volume, and notes it once', async () => {
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 1000);
    const free = vi
      .spyOn(archive as unknown as { freeBytes: () => Promise<number> }, 'freeBytes')
      .mockResolvedValue(GIB + 999);
    try {
      expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 1, failed: 0 });
      expect(await archive.archiveRun('r1')).toEqual({ archived: 0, skipped: 1, failed: 0 });
      expect(rowsOf('p1')).toEqual([]);
      expect(notes).toEqual([
        expect.objectContaining({
          runId: 'r1',
          type: 'build_outputs_disk_low',
          payload: expect.objectContaining({ skipped: ['dist/app.apk'] }),
        }),
      ]);
      free.mockResolvedValue(GIB + 1000);
      expect(await archive.archiveRun('r1')).toEqual({ archived: 1, skipped: 0, failed: 0 });
    } finally {
      free.mockRestore();
    }
  });
});

describe('BuildOutputArchive handoff chains', () => {
  it('counts and filters the archived outputs of a whole handoff chain', async () => {
    addProject('p1');
    const wt = addWorktree('shared');
    addRun('r1', 'p1', wt, { handedOffTo: 'r2' });
    addRun('r2', 'p1', wt, { predecessorRunId: 'r1' });
    const other = addWorktree('other');
    addRun('r3', 'p1', other);
    put(wt, 'dist/app.apk', 100);
    put(other, 'dist/other.apk', 100);
    await archive.archiveRun('r1');
    await archive.archiveRun('r2');
    await archive.archiveRun('r3');

    // The successor rebuilt nothing: the copy belongs to r1, but r2's badge and filter find it.
    expect(archive.archivedCount('r2')).toBe(1);
    expect(archive.archivedCount('r1')).toBe(1);
    expect(archive.archivedCount('r3')).toBe(1);
    expect(archive.list('p1', { runId: 'r2' }).runChain?.sort()).toEqual(['r1', 'r2']);
    expect(archive.list('p1').runChain).toBeNull();
    expect(archive.list('p1', { runId: 'gone' }).runChain).toEqual(['gone']);
  });
});

describe('BuildOutputArchive without a host path for the workspaces', () => {
  it('reports no host path, and the container path instead', async () => {
    const config = { workspacesDir: dir, workspacesHostDir: undefined } as CoreConfig;
    const plain = new BuildOutputArchive(opened.db, config, { quotaBytes: () => undefined });
    addProject('p1');
    const wt = addWorktree('r1');
    addRun('r1', 'p1', wt);
    put(wt, 'dist/app.apk', 100);
    await plain.archiveRun('r1');
    const res = plain.list('p1');
    expect(res.hostArchiveDir).toBeNull();
    expect(res.archiveDir).toBe(path.join(dir, ARCHIVE_DIR_NAME, 'p1'));
    expect(res.outputs[0]).toMatchObject({
      hostPath: null,
      containerPath: path.join(dir, ARCHIVE_DIR_NAME, 'p1/r1/app.apk'),
    });
  });
});
