/**
 * Archive of run deliverables (APKs, installers, firmware), so they outlive the run's worktree.
 *
 * Files live at `<workspacesDir>/.emberline-outputs/<projectId>/<runId>/<file name>` on the same
 * volume as the worktrees; core reads and writes them directly (no command runs in the runner).
 * That volume is writable by agents, so sources and stored files are only ever read through
 * descriptors verified by ./safe-fs.ts, and nothing outside the worktree or the archive is read.
 *
 * A pass never throws to its caller and never holds a project's lock past its time limit.
 * Problems become informational run events (`build_outputs_archive_failed`,
 * `build_outputs_quota_full`, `build_output_too_large`); the last two at most once per run and output.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { type FileHandle, lstat, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AgentPersona, ProjectBuildOutputsResponse, RunBuildOutput } from '@emberline/protocol';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { buildOutputs, projects, runEvents, runs, tickets } from '../db/schema.js';
import { notFound } from '../errors.js';
import { getFactorySettings } from '../factory/settings.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { listBuildOutputs, resolveSafeWorktreePath } from '../runs/git.js';
import {
  copyBetweenHandles,
  createExclusiveFile,
  type OpenedFile,
  openFileUnder,
  realDirUnder,
  SafeRoot,
  streamOpenedFile,
  UnsafePathError,
} from './safe-fs.js';

/** Directory under the workspaces root that holds the archive. */
export const ARCHIVE_DIR_NAME = '.emberline-outputs';
/** How long a prune waits for its pre-prune archive pass before it deletes the worktree anyway. */
export const PRE_PRUNE_ARCHIVE_TIMEOUT_MS = 60_000;
/** Upper bound for a background pass (done/failed/collect); then it gives up and frees the project. */
export const BACKGROUND_PASS_TIMEOUT_MS = 10 * 60_000;
const GIB = 1024 ** 3;
/** Handoff chains are short; this only stops a corrupt chain cycle. */
const MAX_CHAIN_LENGTH = 100;
/** Temp copies are `.<name>.<uuid>.part`; ones older than this were left by a crash and are swept. */
const PART_FILE = /^\..+\.part$/;
const STALE_PART_MS = 60 * 60_000;

export interface ArchiveCounts {
  archived: number;
  skipped: number;
  failed: number;
}

export interface BuildOutputArchiveOptions {
  /** Appends an informational event to a run's timeline (RunService.note). */
  note?: (runId: string, type: string, payload: unknown) => void;
  /** Overrides the factory setting `buildOutputsQuotaGb` (tests use quotas below its 0.5 GB minimum). */
  quotaBytes?: () => number | undefined;
}

export type BuildOutputRow = typeof buildOutputs.$inferSelect;
type RunRow = typeof runs.$inferSelect;
/** Set once a pass ran out of time: from then on it writes nothing. */
interface PassControl {
  aborted: boolean;
}

const noCounts = (): ArchiveCounts => ({ archived: 0, skipped: 0, failed: 0 });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Human-readable size for event messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export class BuildOutputArchive {
  /** The archive directory and its path checks. */
  readonly files: SafeRoot;
  /** One archive pass, removal or project wipe at a time per project. */
  private readonly lock = new KeyedMutex();
  /** Passes still running (including ones that ran out of time); {@link idle} waits for them. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Projects being deleted: queued or late passes for them write nothing. */
  private readonly removedProjects = new Set<string>();
  /** When each project's stale `.part` files were last swept. */
  private readonly partSweepAt = new Map<string, number>();
  /** "Collect now" jobs in flight, and each project's last finished one. */
  private readonly collecting = new Map<string, Promise<void>>();
  private readonly lastCollect = new Map<string, ArchiveCounts & { finishedAt: string }>();

  constructor(
    private readonly db: Db,
    private readonly config: CoreConfig,
    private readonly opts: BuildOutputArchiveOptions = {},
  ) {
    this.files = new SafeRoot(config.workspacesDir, ARCHIVE_DIR_NAME);
  }

  /** Archive root as configured (not resolved through links). */
  get root(): string {
    return this.files.root;
  }

  /**
   * Copies the run's current build outputs into the archive, then applies the project's quota.
   * Never throws: failures are counted and recorded as a run event. After `timeoutMs` the pass
   * stops writing and releases the project.
   */
  async archiveRun(runId: string, opts: { timeoutMs?: number } = {}): Promise<ArchiveCounts> {
    const timeoutMs = opts.timeoutMs ?? BACKGROUND_PASS_TIMEOUT_MS;
    const { counts, timedOut } = await this.boundedPass(runId, timeoutMs);
    if (timedOut) {
      this.notify(runId, 'build_outputs_archive_failed', {
        reason: 'timeout',
        timeoutMs,
        message: `Archiving build outputs took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`,
      });
    }
    return counts;
  }

  /**
   * "Collect now": starts archiving, in the background, from every run of the project whose
   * worktree exists and is not mid-turn. A second call while one runs joins it ('running').
   */
  startCollect(projectId: string): 'started' | 'running' {
    if (this.collecting.has(projectId)) return 'running';
    const job = this.collectProject(projectId)
      .then((counts) => {
        this.lastCollect.set(projectId, { ...counts, finishedAt: new Date().toISOString() });
      })
      .catch(() => {
        this.lastCollect.set(projectId, { archived: 0, skipped: 0, failed: 1, finishedAt: new Date().toISOString() });
      })
      .finally(() => this.collecting.delete(projectId));
    this.collecting.set(projectId, job);
    void this.track(job);
    return 'started';
  }

  /**
   * Archives, oldest run first (so a chain's earlier runs own their copies), one pass after
   * another under the project's lock; the counts are summed. Runs that are starting or working
   * are left alone: their outputs are still being written.
   */
  async collectProject(projectId: string): Promise<ArchiveCounts> {
    const total = noCounts();
    const rows = this.db
      .select({ id: runs.id, worktreePath: runs.worktreePath, state: runs.state })
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .orderBy(asc(runs.createdAt))
      .all();
    for (const row of rows) {
      if (row.state === 'starting' || row.state === 'working') continue;
      if (!(await lstat(row.worktreePath).catch(() => null))) continue;
      const counts = await this.archiveRun(row.id);
      total.archived += counts.archived;
      total.skipped += counts.skipped;
      total.failed += counts.failed;
    }
    return total;
  }

  /** Starts an archive pass in the background (run reached `done` or `failed`). Never throws. */
  archiveSoon(runId: string): void {
    void this.track(
      Promise.resolve()
        .then(() => this.archiveRun(runId))
        .catch(() => noCounts()),
    );
  }

  /**
   * The pass a prune waits for before it deletes a worktree, bounded by `timeoutMs` (queueing for
   * the project included). On timeout the pass stops writing, the prune goes ahead, and the run's
   * timeline says so.
   */
  async archiveBeforePrune(
    runId: string,
    timeoutMs = PRE_PRUNE_ARCHIVE_TIMEOUT_MS,
  ): Promise<'archived' | 'timeout'> {
    const { timedOut } = await this.track(this.boundedPass(runId, timeoutMs));
    if (timedOut) {
      this.notify(runId, 'build_outputs_archive_failed', {
        reason: 'timeout',
        timeoutMs,
        message: `Archiving build outputs took longer than ${Math.round(timeoutMs / 1000)} s; the worktree was pruned without waiting for it`,
      });
    }
    return timedOut ? 'timeout' : 'archived';
  }

  /** Test hook: resolves once every pass started so far (and any they started) settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  list(projectId: string): ProjectBuildOutputsResponse {
    const rows = this.db
      .select({
        output: buildOutputs,
        runId: runs.id,
        runPersona: runs.persona,
        agent: runs.agent,
        ticketKey: tickets.key,
        ticketTitle: tickets.title,
        ticketPersona: tickets.persona,
      })
      .from(buildOutputs)
      .leftJoin(runs, eq(runs.id, buildOutputs.runId))
      .leftJoin(tickets, eq(tickets.id, buildOutputs.ticketId))
      .where(eq(buildOutputs.projectId, projectId))
      .orderBy(desc(buildOutputs.archivedAt), desc(buildOutputs.sourceMtime))
      .all();
    const hostRoot = path.join(this.config.workspacesHostDir ?? this.config.workspacesDir, ARCHIVE_DIR_NAME);
    return {
      collecting: this.collecting.has(projectId),
      lastCollect: this.lastCollect.get(projectId) ?? null,
      quotaBytes: this.quotaBytes(),
      usedBytes: rows.reduce((sum, r) => sum + r.output.sizeBytes, 0),
      hostArchiveDir: path.join(hostRoot, projectId),
      outputs: rows.map(({ output, runId, runPersona, agent, ticketKey, ticketTitle, ticketPersona }) => ({
        id: output.id,
        name: output.name,
        sizeBytes: output.sizeBytes,
        archivedAt: output.archivedAt.toISOString(),
        sourceMtime: output.sourceMtime.toISOString(),
        pinned: output.pinned,
        runId: output.runId,
        runExists: runId !== null,
        ticketId: output.ticketId,
        ticketKey: ticketKey ?? null,
        ticketTitle: ticketTitle ?? null,
        persona: ((runPersona ?? ticketPersona) as AgentPersona | null) ?? null,
        agent: agent ?? null,
        hostPath: path.join(hostRoot, output.storedPath),
      })),
    };
  }

  get(id: string): BuildOutputRow | undefined {
    return this.db.select().from(buildOutputs).where(eq(buildOutputs.id, id)).get();
  }

  /**
   * Opens an archived file for download through a verified descriptor; the stream is exactly
   * `size` bytes and closes the file when done. A file that vanished (or was replaced by a link)
   * is forgotten: its row is removed and the caller gets 404.
   */
  async open(id: string): Promise<{ stream: Readable; fileName: string; size: number }> {
    const row = this.get(id);
    if (!row) throw notFound('no such build output');
    const opened = await this.files.openFile(row.storedPath).catch(() => null);
    if (!opened) {
      this.db.delete(buildOutputs).where(eq(buildOutputs.id, id)).run();
      throw notFound('file no longer on disk');
    }
    return { stream: streamOpenedFile(opened), fileName: row.name, size: opened.size };
  }

  setPinned(id: string, pinned: boolean): BuildOutputRow {
    const row = this.db.update(buildOutputs).set({ pinned }).where(eq(buildOutputs.id, id)).returning().get();
    if (!row) throw notFound('no such build output');
    return row;
  }

  /** Deletes an archived file and its row. A file that already vanished still drops the row, with 404. */
  async remove(id: string): Promise<void> {
    const row = this.get(id);
    if (!row) throw notFound('no such build output');
    const present = await this.lock.run(row.projectId, async () => {
      const current = this.get(id);
      return current ? this.deleteRow(current) : false;
    });
    if (!present) throw notFound('file no longer on disk');
  }

  /**
   * Project deletion: every row of the project and its archive directory. Passes queued for the
   * project, or still running after their time ran out, write nothing from here on.
   */
  async removeProject(projectId: string): Promise<void> {
    this.removedProjects.add(projectId);
    await this.lock.run(projectId, async () => {
      this.db.delete(buildOutputs).where(eq(buildOutputs.projectId, projectId)).run();
      await this.files.removeTree(projectId);
    });
  }

  // --- internals -------------------------------------------------------------------------------

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  private notify(runId: string, type: string, payload: unknown): void {
    try {
      this.opts.note?.(runId, type, payload);
    } catch {
      // A note is informational; losing one must not break a pass.
    }
  }

  private quotaBytes(): number {
    const override = this.opts.quotaBytes?.();
    if (override !== undefined) return override;
    return Math.round(getFactorySettings(this.db).buildOutputsQuotaGb * GIB);
  }

  /** The project is being deleted, or is gone: nothing may be written for it. */
  private projectGone(projectId: string): boolean {
    if (this.removedProjects.has(projectId)) return true;
    return !this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  }

  /**
   * Runs a pass under the project's lock for at most `timeoutMs`, queueing included. When time is
   * up the pass is told to stop writing and the lock is released; the pass itself may still be
   * finishing a read, and stays tracked for {@link idle}. Never throws.
   */
  private async boundedPass(
    runId: string,
    timeoutMs: number,
  ): Promise<{ counts: ArchiveCounts; timedOut: boolean }> {
    const control: PassControl = { aborted: false };
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        control.aborted = true;
        resolve(null);
      }, timeoutMs);
      timer.unref();
    });
    try {
      const run = this.db.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId)).get();
      if (!run) return { counts: noCounts(), timedOut: false };
      const locked = this.lock
        .run(run.projectId, async () => {
          if (control.aborted) return null;
          const pass = this.track(
            this.archivePass(runId, control).catch((error: unknown) => {
              this.notify(runId, 'build_outputs_archive_failed', {
                failures: [{ path: '', error: errorText(error) }],
                message: `Could not archive build outputs: ${errorText(error)}`,
              });
              return { archived: 0, skipped: 0, failed: 1 };
            }),
          );
          return Promise.race([pass, expired]);
        })
        .catch((error: unknown) => ({ error }));
      const result = await Promise.race([locked, expired]);
      if (result === null) return { counts: { archived: 0, skipped: 0, failed: 1 }, timedOut: true };
      if ('error' in result) throw result.error;
      return { counts: result, timedOut: false };
    } catch (error) {
      this.notify(runId, 'build_outputs_archive_failed', {
        failures: [{ path: '', error: errorText(error) }],
        message: `Could not archive build outputs: ${errorText(error)}`,
      });
      return { counts: { archived: 0, skipped: 0, failed: 1 }, timedOut: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private async archivePass(runId: string, control: PassControl): Promise<ArchiveCounts> {
    const counts = noCounts();
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run || control.aborted || this.projectGone(run.projectId)) return counts;
    await this.sweepPartFiles(run.projectId).catch(() => undefined);
    // The worktree must really be where it should be: one swapped for a symlink is never walked.
    const worktree = await realDirUnder(this.config.workspacesDir, run.worktreePath);
    const outputs = worktree ? await listBuildOutputs(run.worktreePath) : [];
    const quota = this.quotaBytes();
    const projectRows = this.db
      .select()
      .from(buildOutputs)
      .where(eq(buildOutputs.projectId, run.projectId))
      .all();
    let pinnedBytes = projectRows.filter((r) => r.pinned).reduce((sum, r) => sum + r.sizeBytes, 0);
    const own = new Map(projectRows.filter((r) => r.runId === runId).map((r) => [r.sourcePath, r]));
    const chain = this.chainIds(run);
    const tooLarge: { path: string; name: string; sizeBytes: number }[] = [];
    const overQuota: string[] = [];
    const failures: { path: string; error: string }[] = [];
    // Bytes copied in this pass: they are the newest, so they must fit next to the pinned ones.
    let copiedBytes = 0;
    const now = new Date();

    // Newest first: when the quota cannot take everything, the latest builds win.
    for (const output of outputs) {
      if (control.aborted || this.projectGone(run.projectId)) break;
      const listedMtime = Date.parse(output.mtime);
      const same = (r: BuildOutputRow) =>
        r.sourcePath === output.path &&
        r.sizeBytes === output.sizeBytes &&
        r.sourceMtime.getTime() === listedMtime;
      const existing = own.get(output.path);
      if (existing && same(existing) && (await this.files.hasFile(existing.storedPath))) {
        counts.skipped += 1;
        continue;
      }
      const chainCopy = projectRows.find((r) => chain.has(r.runId) && same(r));
      if (chainCopy && (await this.files.hasFile(chainCopy.storedPath))) {
        counts.skipped += 1;
        continue;
      }
      // From here on the opened descriptor is the source: its size and mtime, its bytes.
      let source: OpenedFile;
      try {
        source = await openFileUnder(
          this.config.workspacesDir,
          run.worktreePath,
          resolveSafeWorktreePath(run.worktreePath, output.path).rel,
        );
      } catch (error) {
        counts.failed += 1;
        failures.push({ path: output.path, error: errorText(error) });
        continue;
      }
      try {
        if (source.size > quota) {
          tooLarge.push({ path: output.path, name: output.name, sizeBytes: source.size });
          counts.skipped += 1;
          continue;
        }
        // A rebuilt pinned output stays pinned, so it replaces its own share of the pinned bytes.
        const pinnedOthers = existing?.pinned ? pinnedBytes - existing.sizeBytes : pinnedBytes;
        if (pinnedOthers + copiedBytes + source.size > quota) {
          overQuota.push(output.path);
          counts.skipped += 1;
          continue;
        }
        const row = await this.copyIn(run, output, source, now, existing, projectRows, control);
        counts.archived += 1;
        if (row.pinned) pinnedBytes = pinnedOthers + row.sizeBytes;
        else copiedBytes += row.sizeBytes;
        const index = projectRows.findIndex((r) => r.id === row.id);
        if (index >= 0) projectRows[index] = row;
        else projectRows.push(row);
      } catch (error) {
        counts.failed += 1;
        failures.push({ path: output.path, error: errorText(error) });
      } finally {
        await source.handle.close().catch(() => undefined);
      }
    }

    if (this.projectGone(run.projectId)) {
      // A pass that raced the project's deletion may have recreated its directory: remove it again.
      await this.files.removeTree(run.projectId).catch(() => undefined);
    } else if (!control.aborted) {
      await this.evict(run.projectId, quota).catch((error: unknown) =>
        failures.push({ path: '', error: `quota cleanup failed: ${errorText(error)}` }),
      );
    }

    for (const output of tooLarge) {
      if (this.alreadyNoted(runId, 'build_output_too_large', output.path)) continue;
      this.notify(runId, 'build_output_too_large', {
        ...output,
        quotaBytes: quota,
        message: `${output.name} (${formatBytes(output.sizeBytes)}) is larger than the project's whole build output quota (${formatBytes(quota)}) and was not archived`,
      });
    }
    const newlyOverQuota = overQuota.filter((p) => !this.alreadyNoted(runId, 'build_outputs_quota_full', p));
    if (newlyOverQuota.length > 0) {
      const pinnedFull = pinnedBytes >= quota;
      this.notify(runId, 'build_outputs_quota_full', {
        reason: pinnedFull ? 'pinned' : 'run_outputs',
        skipped: newlyOverQuota,
        quotaBytes: quota,
        pinnedBytes,
        message: pinnedFull
          ? `Pinned build outputs fill the project's quota (${formatBytes(pinnedBytes)} of ${formatBytes(quota)}); ${newlyOverQuota.length} new output(s) were not archived. Unpin or delete some, or raise the quota.`
          : `The project's build output quota (${formatBytes(quota)}) has no room for ${newlyOverQuota.length} more output(s) of this run; the newest ones were archived.`,
      });
    }
    if (failures.length > 0) {
      this.notify(runId, 'build_outputs_archive_failed', {
        failures,
        message: `Could not archive ${failures.length} build output(s): ${failures[0]?.error ?? ''}`,
      });
    }
    return counts;
  }

  /** True when this run's timeline already has a `type` note about the output at `sourcePath`. */
  private alreadyNoted(runId: string, type: string, sourcePath: string): boolean {
    return this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
      .all()
      .some(({ payload }) => {
        const p = payload as { path?: unknown; skipped?: unknown } | null;
        return p?.path === sourcePath || (Array.isArray(p?.skipped) && p.skipped.includes(sourcePath));
      });
  }

  /**
   * The other runs of this run's handoff chain (they share its worktree): the runs it took over
   * from, and the runs that took over from it.
   */
  private chainIds(run: RunRow): Set<string> {
    const ids = new Set<string>([run.id]);
    const walk = (start: string | null, step: (id: string) => string | null | undefined) => {
      let next = start;
      while (next && !ids.has(next) && ids.size < MAX_CHAIN_LENGTH) {
        ids.add(next);
        next = step(next) ?? null;
      }
    };
    walk(
      run.predecessorRunId,
      (id) => this.db.select({ id: runs.predecessorRunId }).from(runs).where(eq(runs.id, id)).get()?.id,
    );
    walk(
      run.handedOffTo,
      (id) => this.db.select({ id: runs.handedOffTo }).from(runs).where(eq(runs.id, id)).get()?.id,
    );
    ids.delete(run.id);
    return ids;
  }

  /**
   * Copies an opened source into the archive: an exclusive temp file in the verified run directory,
   * filled from the source descriptor, renamed into place once the directory is verified again.
   */
  private async copyIn(
    run: RunRow,
    output: RunBuildOutput,
    source: OpenedFile,
    now: Date,
    existing: BuildOutputRow | undefined,
    projectRows: BuildOutputRow[],
    control: PassControl,
  ): Promise<BuildOutputRow> {
    const stopped = () => control.aborted || this.projectGone(run.projectId);
    if (stopped()) throw new Error('the archive pass was stopped');
    const storedPath = existing?.storedPath ?? this.freshStoredPath(run, output, projectRows);
    const rel = path.relative(this.files.root, this.files.resolve(storedPath));
    const relDir = path.dirname(rel);
    const dir = await this.files.realDir(relDir, { create: true });
    if (!dir) throw new Error('the archive directory could not be created');
    const base = path.basename(rel);
    const tempName = `.${base}.${randomUUID()}.part`;
    const out = await createExclusiveFile(dir, tempName);
    let placed = false;
    try {
      try {
        await this.copyBytes(source.handle, out, source.size);
      } finally {
        await out.close();
      }
      if ((await this.files.realDir(relDir)) !== dir)
        throw new UnsafePathError(`${relDir} changed while copying`);
      // Checked last, with no await before the rename is issued: a pass whose time ran out never
      // places a file, so it cannot replace one that a newer pass (free to run now) placed.
      if (stopped()) throw new Error('the archive pass was stopped (time limit or project deleted)');
      // rename replaces the destination entry itself, even if a link was planted there.
      await rename(path.join(dir, tempName), path.join(dir, base));
      placed = true;
    } finally {
      if (!placed) await this.files.unlinkIn(relDir, tempName).catch(() => undefined);
    }
    const values = {
      projectId: run.projectId,
      runId: run.id,
      ticketId: run.ticketId,
      name: output.name,
      sourcePath: output.path,
      storedPath,
      sizeBytes: source.size,
      sourceMtime: source.mtime,
      archivedAt: now,
    };
    try {
      if (existing) {
        const updated = this.db
          .update(buildOutputs)
          .set(values)
          .where(eq(buildOutputs.id, existing.id))
          .returning()
          .get();
        if (updated) return updated;
      }
      return this.db
        .insert(buildOutputs)
        .values({ id: randomUUID(), ...values })
        .returning()
        .get();
    } catch (error) {
      // The project was deleted meanwhile: no row, so no file either. Any other failure (e.g. the
      // unique index, because another pass recorded this output) leaves the file to that row.
      if (this.projectGone(run.projectId)) await this.files.unlinkFile(storedPath).catch(() => undefined);
      throw error;
    }
  }

  /** The byte copy, separate so tests can make it slow. */
  private async copyBytes(src: FileHandle, dst: FileHandle, size: number): Promise<void> {
    await copyBetweenHandles(src, dst, size);
  }

  /** `<projectId>/<runId>/<name>`; a second output with the same name gets a stable suffix. */
  private freshStoredPath(run: RunRow, output: RunBuildOutput, projectRows: BuildOutputRow[]): string {
    if (!output.name || output.name === '.' || output.name === '..' || /[/\\\0]/.test(output.name)) {
      throw new Error(`unusable file name: ${output.name}`);
    }
    const plain = `${run.projectId}/${run.id}/${output.name}`;
    const taken = projectRows.some(
      (r) => r.runId === run.id && r.storedPath === plain && r.sourcePath !== output.path,
    );
    if (!taken) return plain;
    const ext = path.extname(output.name);
    const stem = output.name.slice(0, output.name.length - ext.length);
    const hash = createHash('sha256').update(output.path).digest('hex').slice(0, 8);
    return `${run.projectId}/${run.id}/${stem}-${hash}${ext}`;
  }

  /** Deletes the oldest unpinned outputs of the project until it fits its quota. */
  private async evict(projectId: string, quota: number): Promise<void> {
    const rows = this.db
      .select()
      .from(buildOutputs)
      .where(eq(buildOutputs.projectId, projectId))
      .orderBy(asc(buildOutputs.archivedAt), asc(buildOutputs.sourceMtime))
      .all();
    let total = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
    for (const row of rows) {
      if (total <= quota) break;
      if (row.pinned) continue;
      await this.deleteRow(row);
      total -= row.sizeBytes;
    }
  }

  /**
   * Removes the row and its file. The file is unlinked only inside its verified directory (a link
   * planted in its place is removed itself, never its target). True if the file was there.
   */
  private async deleteRow(row: BuildOutputRow): Promise<boolean> {
    const removed = await this.files.unlinkFile(row.storedPath).catch(() => false);
    this.db.delete(buildOutputs).where(eq(buildOutputs.id, row.id)).run();
    return removed;
  }

  /**
   * Removes `.part` temp files older than an hour from the project's run directories (left by a
   * crash mid-copy), at most once an hour per project.
   */
  private async sweepPartFiles(projectId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.partSweepAt.get(projectId) ?? 0) < STALE_PART_MS) return;
    this.partSweepAt.set(projectId, now);
    const projectDir = await this.files.realDir(projectId).catch(() => null);
    if (!projectDir) return;
    const runDirs: Dirent[] = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const dir = await this.files.realDir(`${projectId}/${runDir.name}`).catch(() => null);
      if (!dir) continue;
      const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !PART_FILE.test(entry.name)) continue;
        const info = await lstat(path.join(dir, entry.name)).catch(() => null);
        if (info?.isFile() && now - info.mtimeMs > STALE_PART_MS) {
          await this.files.unlinkIn(`${projectId}/${runDir.name}`, entry.name).catch(() => undefined);
        }
      }
    }
  }
}
