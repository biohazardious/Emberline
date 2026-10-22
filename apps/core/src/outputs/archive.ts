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
 * `build_outputs_quota_full`, `build_output_too_large`, `build_outputs_disk_low`); the last three at
 * most once per run and output, and a failure with the same message only once per run.
 *
 * Identity: an output is the same build when its worktree-relative path, size and mtime match, or,
 * for a candidate with the same path and size archived from another run (runs that share the main
 * workspace, a committed file checked out in every worktree), when its SHA-256 matches. The quota
 * evicts the oldest unpinned copies, and a user delete removes one; both keep the row as a hidden
 * tombstone, so that build is never copied back (a file that vanished on its own is forgotten).
 */
import { createHash, type Hash, randomUUID } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { type FileHandle, lstat, readdir, rename, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AgentPersona, ProjectBuildOutputsResponse, RunBuildOutput } from '@emberline/protocol';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { buildOutputs, projects, runEvents, runs, tickets } from '../db/schema.js';
import { notFound } from '../errors.js';
import { getFactorySettings } from '../factory/settings.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { predecessorChain, successorChain } from '../runs/handoff-chain.js';
import { listBuildOutputs, resolveSafeWorktreePath } from '../runs/git.js';
import {
  copyBetweenHandles,
  createExclusiveFile,
  type OpenedFile,
  openFileUnder,
  realDirUnder,
  SafeRoot,
  sha256OfHandle,
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
/** A copy must leave at least this much free on the workspaces volume, for the agents' own builds. */
export const MIN_FREE_AFTER_COPY_BYTES = GIB;
/** Source hashes remembered per (worktree, path, size, mtime), so shared files are not re-read every pass. */
const HASH_CACHE_SIZE = 500;
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
  private readonly hashCache = new Map<string, string>();

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
      this.notifyFailure(runId, {
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
        this.lastCollect.set(projectId, {
          archived: 0,
          skipped: 0,
          failed: 1,
          finishedAt: new Date().toISOString(),
        });
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
   * the project included). On timeout the pass stops writing and the run's timeline says so; with
   * `keepOnTimeout` the caller keeps the worktree and tries again later, otherwise it prunes anyway.
   * 'failed' means some output could not be copied.
   */
  async archiveBeforePrune(
    runId: string,
    timeoutMs = PRE_PRUNE_ARCHIVE_TIMEOUT_MS,
    opts: { keepOnTimeout?: boolean } = {},
  ): Promise<'archived' | 'timeout' | 'failed'> {
    const { counts, timedOut } = await this.track(this.boundedPass(runId, timeoutMs));
    if (timedOut) {
      this.notifyFailure(runId, {
        reason: 'timeout',
        timeoutMs,
        message: opts.keepOnTimeout
          ? 'Archiving build outputs ran out of time; the worktree is kept and archiving is tried again at the next clean-up'
          : `Archiving build outputs took longer than ${Math.round(timeoutMs / 1000)} s; the worktree was pruned without waiting for it`,
      });
      return 'timeout';
    }
    return counts.failed > 0 ? 'failed' : 'archived';
  }

  /**
   * Applies the quota to every project now (it was lowered in Settings) instead of at each
   * project's next pass. Never throws.
   */
  async enforceQuota(): Promise<void> {
    const projectIds = new Set(
      this.db
        .select({ projectId: buildOutputs.projectId })
        .from(buildOutputs)
        .where(isNull(buildOutputs.evictedAt))
        .all()
        .map((r) => r.projectId),
    );
    await this.track(
      Promise.all(
        [...projectIds].map((projectId) =>
          this.lock
            .run(projectId, async () => {
              if (!this.projectGone(projectId)) await this.evict(projectId, this.quotaBytes());
            })
            .catch(() => undefined),
        ),
      ),
    );
  }

  /** The run and the other runs of its handoff chain; just the id when the run is gone. */
  chainOf(runId: string): string[] {
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    return run ? [run.id, ...this.chainIds(run)] : [runId];
  }

  /** Archived outputs of the run's whole handoff chain (a successor's copy may belong to its predecessor). */
  archivedCount(runId: string): number {
    return this.db
      .select({ id: buildOutputs.id })
      .from(buildOutputs)
      .where(and(inArray(buildOutputs.runId, this.chainOf(runId)), isNull(buildOutputs.evictedAt)))
      .all().length;
  }

  /** Test hook: resolves once every pass started so far (and any they started) settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** `runId`: also report that run's handoff chain, for the page's run filter. */
  list(projectId: string, opts: { runId?: string } = {}): ProjectBuildOutputsResponse {
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
      .where(and(eq(buildOutputs.projectId, projectId), isNull(buildOutputs.evictedAt)))
      .orderBy(desc(buildOutputs.archivedAt), desc(buildOutputs.sourceMtime))
      .all();
    // Without EMBERLINE_WORKSPACES_HOST_DIR core cannot know where the volume sits on the host.
    const hostDir = this.config.workspacesHostDir;
    const hostRoot = hostDir ? path.join(hostDir, ARCHIVE_DIR_NAME) : null;
    return {
      collecting: this.collecting.has(projectId),
      lastCollect: this.lastCollect.get(projectId) ?? null,
      quotaBytes: this.quotaBytes(),
      usedBytes: rows.reduce((sum, r) => sum + r.output.sizeBytes, 0),
      hostArchiveDir: hostRoot ? path.join(hostRoot, projectId) : null,
      archiveDir: path.join(this.files.root, projectId),
      runChain: opts.runId ? this.chainOf(opts.runId) : null,
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
        hostPath: hostRoot ? path.join(hostRoot, output.storedPath) : null,
        containerPath: path.join(this.files.root, output.storedPath),
      })),
    };
  }

  /** An archived output; quota tombstones count as gone. */
  get(id: string): BuildOutputRow | undefined {
    return this.db
      .select()
      .from(buildOutputs)
      .where(and(eq(buildOutputs.id, id), isNull(buildOutputs.evictedAt)))
      .get();
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
    const row = this.db
      .update(buildOutputs)
      .set({ pinned })
      .where(and(eq(buildOutputs.id, id), isNull(buildOutputs.evictedAt)))
      .returning()
      .get();
    if (!row) throw notFound('no such build output');
    return row;
  }

  /**
   * Deletes an archived file. Its row stays as a tombstone (like a quota eviction), so a later pass
   * does not copy the same build back from a worktree that still holds it. A file that already
   * vanished is forgotten the same way, with 404.
   */
  async remove(id: string): Promise<void> {
    const row = this.get(id);
    if (!row) throw notFound('no such build output');
    const present = await this.lock.run(row.projectId, async () => {
      const current = this.get(id);
      return current ? this.tombstone(current) : false;
    });
    if (!present) throw notFound('file no longer on disk');
  }

  /**
   * When archiving this run's outputs first failed (a copy error, or a worktree or archive root
   * reached through a link); time-outs do not count. Null when it never failed.
   */
  firstFailureAt(runId: string): Date | null {
    const failures = this.db
      .select({ ts: runEvents.ts, payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'build_outputs_archive_failed')))
      .orderBy(asc(runEvents.ts))
      .all()
      .filter((e) => (e.payload as { reason?: unknown } | null)?.reason !== 'timeout');
    return failures[0]?.ts ?? null;
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

  /** A `build_outputs_archive_failed` note, unless the run's timeline already has one saying the same. */
  private notifyFailure(runId: string, payload: { message: string } & Record<string, unknown>): void {
    const said = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'build_outputs_archive_failed')))
      .all()
      .some((e) => (e.payload as { message?: unknown } | null)?.message === payload.message);
    if (!said) this.notify(runId, 'build_outputs_archive_failed', payload);
  }

  /** Bytes free for core on the workspaces volume; unknown counts as plenty. */
  private async freeBytes(): Promise<number> {
    const stats = await statfs(this.config.workspacesDir).catch(() => null);
    return stats ? stats.bavail * stats.bsize : Number.POSITIVE_INFINITY;
  }

  /** Another run (a handoff successor, or any run in a shared main workspace) is building there now. */
  private sharedWithActiveRun(run: RunRow): boolean {
    return Boolean(
      this.db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.worktreePath, run.worktreePath),
            ne(runs.id, run.id),
            inArray(runs.state, ['starting', 'working']),
          ),
        )
        .get(),
    );
  }

  /** SHA-256 of an opened source, remembered while its path, size and mtime stay the same. */
  private async sourceDigest(run: RunRow, relPath: string, source: OpenedFile): Promise<string> {
    const key = [run.worktreePath, relPath, source.size, source.mtime.getTime()].join('\0');
    const known = this.hashCache.get(key);
    if (known) return known;
    const digest = await sha256OfHandle(source.handle, source.size);
    this.hashCache.set(key, digest);
    if (this.hashCache.size > HASH_CACHE_SIZE) {
      const oldest = this.hashCache.keys().next().value;
      if (oldest !== undefined) this.hashCache.delete(oldest);
    }
    return digest;
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
              this.notifyFailure(runId, {
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
      this.notifyFailure(runId, {
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
    // Files there may still be growing; the run building there archives them at its own `done`.
    if (this.sharedWithActiveRun(run)) return counts;
    await this.sweepPartFiles(run.projectId).catch(() => undefined);
    // The worktree must really be where it should be: one swapped for a symlink is never walked.
    const worktree = await realDirUnder(this.config.workspacesDir, run.worktreePath);
    const outputs = worktree ? await listBuildOutputs(run.worktreePath) : [];
    const quota = this.quotaBytes();
    // Every row of the project, quota tombstones included (they stop an evicted build coming back).
    const projectRows = this.db
      .select()
      .from(buildOutputs)
      .where(eq(buildOutputs.projectId, run.projectId))
      .all();
    const live = (r: BuildOutputRow) => r.evictedAt === null;
    let pinnedBytes = projectRows.filter((r) => live(r) && r.pinned).reduce((sum, r) => sum + r.sizeBytes, 0);
    const own = new Map(projectRows.filter((r) => r.runId === runId).map((r) => [r.sourcePath, r]));
    const chain = this.chainIds(run);
    const tooLarge: { path: string; name: string; sizeBytes: number }[] = [];
    const overQuota: string[] = [];
    const noSpace: string[] = [];
    const failures: { path: string; error: string }[] = [];
    // Bytes copied in this pass: they are the newest, so they must fit next to the pinned ones.
    let copiedBytes = 0;
    let freeBytes = Number.POSITIVE_INFINITY;
    const now = new Date();
    const replaceRow = (row: BuildOutputRow) => {
      const index = projectRows.findIndex((r) => r.id === row.id);
      if (index >= 0) projectRows[index] = row;
      else projectRows.push(row);
    };

    // Newest first: when the quota cannot take everything, the latest builds win.
    for (const output of outputs) {
      if (control.aborted || this.projectGone(run.projectId)) break;
      const listedMtime = Date.parse(output.mtime);
      const same = (r: BuildOutputRow) =>
        r.sourcePath === output.path &&
        r.sizeBytes === output.sizeBytes &&
        r.sourceMtime.getTime() === listedMtime;
      const existing = own.get(output.path);
      // Unchanged since this run archived it, or since the quota evicted it (never copied back).
      if (
        existing &&
        same(existing) &&
        (!live(existing) || (await this.files.hasFile(existing.storedPath)))
      ) {
        counts.skipped += 1;
        continue;
      }
      // The same build, evicted from another run of the project (e.g. one sharing the main workspace).
      if (projectRows.some((r) => !live(r) && same(r))) {
        counts.skipped += 1;
        continue;
      }
      const chainCopy = projectRows.find((r) => live(r) && chain.has(r.runId) && same(r));
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
        // Identical bytes already archived in the project (another run in the same workspace, a
        // committed file in another worktree), or evicted or deleted (a tombstone, whatever its
        // mtime): hashed only when such a candidate exists.
        const twins = projectRows.filter((r) => r.sourcePath === output.path && r.sizeBytes === source.size);
        if (twins.length > 0) {
          const digest = await this.sourceDigest(run, output.path, source);
          if (twins.some((r) => !live(r) && r.sha256 === digest)) {
            counts.skipped += 1;
            continue;
          }
          let twin: BuildOutputRow | undefined;
          for (const candidate of twins) {
            if (
              live(candidate) &&
              candidate.sha256 === digest &&
              (await this.files.hasFile(candidate.storedPath))
            ) {
              twin = candidate;
              break;
            }
          }
          if (twin) {
            if (twin.id === existing?.id) {
              // Touched, not rebuilt: remember the new mtime so the next pass needs no hash.
              const updated = this.db
                .update(buildOutputs)
                .set({ sourceMtime: source.mtime })
                .where(eq(buildOutputs.id, twin.id))
                .returning()
                .get();
              if (updated) replaceRow(updated);
            }
            counts.skipped += 1;
            continue;
          }
        }
        // A rebuilt pinned output stays pinned, so it replaces its own share of the pinned bytes.
        const pinnedOthers =
          existing?.pinned && live(existing) ? pinnedBytes - existing.sizeBytes : pinnedBytes;
        if (pinnedOthers + copiedBytes + source.size > quota) {
          overQuota.push(output.path);
          counts.skipped += 1;
          continue;
        }
        // Agents build on this volume too: never fill it.
        freeBytes = await this.freeBytes();
        if (freeBytes < source.size + MIN_FREE_AFTER_COPY_BYTES) {
          noSpace.push(output.path);
          counts.skipped += 1;
          continue;
        }
        const row = await this.copyIn(run, output, source, now, existing, projectRows, control);
        counts.archived += 1;
        if (row.pinned) pinnedBytes = pinnedOthers + row.sizeBytes;
        else copiedBytes += row.sizeBytes;
        replaceRow(row);
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

    const newlyNoSpace = noSpace.filter((p) => !this.alreadyNoted(runId, 'build_outputs_disk_low', p));
    if (newlyNoSpace.length > 0) {
      this.notify(runId, 'build_outputs_disk_low', {
        skipped: newlyNoSpace,
        freeBytes,
        message: `The workspaces volume is nearly full (${formatBytes(freeBytes)} free); ${newlyNoSpace.length} build output(s) were not archived so at least ${formatBytes(MIN_FREE_AFTER_COPY_BYTES)} stays free`,
      });
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
      this.notifyFailure(runId, {
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
    const ids = new Set([
      ...predecessorChain(this.db, run.id, MAX_CHAIN_LENGTH),
      ...successorChain(this.db, run.id, MAX_CHAIN_LENGTH),
    ]);
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
    const hash = createHash('sha256');
    let placed = false;
    try {
      try {
        await this.copyBytes(source.handle, out, source.size, hash);
      } finally {
        await out.close();
      }
      // Still being written (a build in progress): a copy of part of it is worse than none.
      const after = await source.handle.stat();
      if (after.size !== source.size || after.mtime.getTime() !== source.mtime.getTime())
        throw new Error('the file changed while it was copied');
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
      sha256: hash.digest('hex'),
      evictedAt: null,
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
  private async copyBytes(src: FileHandle, dst: FileHandle, size: number, hash?: Hash): Promise<void> {
    await copyBetweenHandles(src, dst, size, hash);
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

  /**
   * Deletes the files of the oldest unpinned outputs of the project until it fits its quota. Their
   * rows stay as tombstones, so the same build is not copied back by a later pass.
   */
  private async evict(projectId: string, quota: number): Promise<void> {
    const rows = this.db
      .select()
      .from(buildOutputs)
      .where(and(eq(buildOutputs.projectId, projectId), isNull(buildOutputs.evictedAt)))
      .orderBy(asc(buildOutputs.archivedAt), asc(buildOutputs.sourceMtime))
      .all();
    let total = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
    for (const row of rows) {
      if (total <= quota) break;
      if (row.pinned) continue;
      await this.tombstone(row);
      total -= row.sizeBytes;
    }
  }

  /**
   * Removes the file and keeps the row as a hidden tombstone (evicted or deleted). The file is
   * unlinked only inside its verified directory (a link planted in its place is removed itself,
   * never its target). True if the file was there.
   */
  private async tombstone(row: BuildOutputRow): Promise<boolean> {
    const removed = await this.files.unlinkFile(row.storedPath).catch(() => false);
    this.db
      .update(buildOutputs)
      .set({ evictedAt: new Date(), pinned: false })
      .where(eq(buildOutputs.id, row.id))
      .run();
    await this.removeRunDirIfEmpty(row.storedPath);
    return removed;
  }

  /** The run directory of a stored file goes once its last file did. */
  private async removeRunDirIfEmpty(storedPath: string): Promise<void> {
    try {
      const rel = path.relative(this.files.root, this.files.resolve(storedPath));
      await this.files.removeEmptyDir(path.dirname(rel));
    } catch {
      // Not empty, already gone, or not a plain directory: leave it.
    }
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
