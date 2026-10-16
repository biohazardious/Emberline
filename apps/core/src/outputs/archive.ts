/**
 * Archive of run deliverables (APKs, installers, firmware), so they outlive the run's worktree.
 *
 * Files live at `<workspacesDir>/.emberline-outputs/<projectId>/<runId>/<file name>` on the same
 * volume as the worktrees; core reads and writes them directly (no command runs in the runner).
 * That volume is writable by agents, so every archive path is checked with `realpath`: no
 * component may be a symbolic link, and nothing outside the archive root is read or written.
 *
 * A pass never throws to its caller. Problems become informational run events
 * (`build_outputs_archive_failed`, `build_outputs_quota_full`, `build_output_too_large`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPersona, ProjectBuildOutputsResponse, RunBuildOutput } from '@emberline/protocol';
import { asc, desc, eq } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { buildOutputs, projects, runs, tickets } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { getFactorySettings } from '../factory/settings.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { listBuildOutputs, resolveSafeWorktreePath } from '../runs/git.js';

/** Directory under the workspaces root that holds the archive. */
export const ARCHIVE_DIR_NAME = '.emberline-outputs';
/** How long a prune waits for its pre-prune archive pass before it deletes the worktree anyway. */
export const PRE_PRUNE_ARCHIVE_TIMEOUT_MS = 60_000;
const GIB = 1024 ** 3;
/** Handoff chains are short; this only stops a corrupt predecessor cycle. */
const MAX_CHAIN_LENGTH = 100;

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

const noCounts = (): ArchiveCounts => ({ archived: 0, skipped: 0, failed: 0 });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) =>
  (error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'ENOTDIR';

/** Human-readable size for event messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export class BuildOutputArchive {
  /** Archive root as configured (not resolved through links). */
  readonly root: string;
  /** One archive pass, removal or project wipe at a time per project. */
  private readonly lock = new KeyedMutex();
  /** Background passes still running; {@link idle} waits for them. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly config: CoreConfig,
    private readonly opts: BuildOutputArchiveOptions = {},
  ) {
    this.root = path.join(config.workspacesDir, ARCHIVE_DIR_NAME);
  }

  /**
   * Copies the run's current build outputs into the archive, then applies the project's quota.
   * Never throws: failures are counted and recorded as a run event.
   */
  async archiveRun(runId: string): Promise<ArchiveCounts> {
    try {
      const run = this.db.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId)).get();
      if (!run) return noCounts();
      return await this.lock.run(run.projectId, () => this.archivePass(runId));
    } catch (error) {
      this.notify(runId, 'build_outputs_archive_failed', {
        failures: [{ error: errorText(error) }],
        message: `Could not archive build outputs: ${errorText(error)}`,
      });
      return { archived: 0, skipped: 0, failed: 1 };
    }
  }

  /** Starts an archive pass in the background (run reached `done` or `failed`). Never throws. */
  archiveSoon(runId: string): void {
    void this.startPass(runId);
  }

  /**
   * The pass a prune waits for before it deletes a worktree, bounded by `timeoutMs`. On timeout the
   * prune goes ahead (the pass keeps running and fails once its source is gone) and the run's
   * timeline says so.
   */
  async archiveBeforePrune(
    runId: string,
    timeoutMs = PRE_PRUNE_ARCHIVE_TIMEOUT_MS,
  ): Promise<'archived' | 'timeout'> {
    const pass = this.startPass(runId);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref();
    });
    const outcome = await Promise.race([pass.then(() => 'archived' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.notify(runId, 'build_outputs_archive_failed', {
        reason: 'timeout',
        timeoutMs,
        message: `Archiving build outputs took longer than ${Math.round(timeoutMs / 1000)} s; the worktree was pruned without waiting for it`,
      });
    }
    return outcome;
  }

  /** Test hook: resolves once every background pass started so far (and any they started) settled. */
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
   * Resolves an archived file for download. A file that vanished (or was replaced by a link) is
   * forgotten: its row is removed and the caller gets 404.
   */
  async open(id: string): Promise<{ abs: string; fileName: string; size: number }> {
    const row = this.get(id);
    if (!row) throw notFound('no such build output');
    const abs = await this.verifiedStoredFile(row.storedPath).catch(() => null);
    const info = abs ? await stat(abs).catch(() => null) : null;
    if (!abs || !info?.isFile()) {
      this.db.delete(buildOutputs).where(eq(buildOutputs.id, id)).run();
      throw notFound('file no longer on disk');
    }
    return { abs, fileName: row.name, size: info.size };
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

  /** Project deletion: every row of the project and its archive directory. */
  async removeProject(projectId: string): Promise<void> {
    await this.lock.run(projectId, async () => {
      this.db.delete(buildOutputs).where(eq(buildOutputs.projectId, projectId)).run();
      const dir = this.storedAbs(projectId);
      // Only through a real archive root; rm itself never follows a link it removes.
      if (await this.rootIsRealDir()) await rm(dir, { recursive: true, force: true });
    });
  }

  // --- internals -------------------------------------------------------------------------------

  /** A tracked pass that starts after the caller's synchronous work and never rejects. */
  private startPass(runId: string): Promise<ArchiveCounts> {
    const pass = Promise.resolve()
      .then(() => this.archiveRun(runId))
      .catch(() => ({ archived: 0, skipped: 0, failed: 1 }));
    this.pending.add(pass);
    void pass.finally(() => this.pending.delete(pass));
    return pass;
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

  private async archivePass(runId: string): Promise<ArchiveCounts> {
    const counts = noCounts();
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return counts;
    const project = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, run.projectId))
      .get();
    if (!project) return counts;
    const outputs = await listBuildOutputs(run.worktreePath);
    const quota = this.quotaBytes();
    const projectRows = this.db
      .select()
      .from(buildOutputs)
      .where(eq(buildOutputs.projectId, run.projectId))
      .all();
    let pinnedBytes = projectRows.filter((r) => r.pinned).reduce((sum, r) => sum + r.sizeBytes, 0);
    const own = new Map(projectRows.filter((r) => r.runId === runId).map((r) => [r.sourcePath, r]));
    const chain = this.chainIds(run);
    const tooLarge: RunBuildOutput[] = [];
    const overQuota: string[] = [];
    const failures: { path: string; error: string }[] = [];
    // Bytes copied in this pass: they are the newest, so they must fit next to the pinned ones.
    let copiedBytes = 0;
    const now = new Date();

    // Newest first: when the quota cannot take everything, the latest builds win.
    for (const output of outputs) {
      const mtime = Date.parse(output.mtime);
      const same = (r: BuildOutputRow) =>
        r.sourcePath === output.path && r.sizeBytes === output.sizeBytes && r.sourceMtime.getTime() === mtime;
      const existing = own.get(output.path);
      if (
        existing &&
        same(existing) &&
        (await this.verifiedStoredFile(existing.storedPath).catch(() => null))
      ) {
        counts.skipped += 1;
        continue;
      }
      if (projectRows.some((r) => chain.has(r.runId) && same(r))) {
        counts.skipped += 1;
        continue;
      }
      if (output.sizeBytes > quota) {
        tooLarge.push(output);
        counts.skipped += 1;
        continue;
      }
      // A rebuilt pinned output stays pinned, so it replaces its own share of the pinned bytes.
      const pinnedOthers = existing?.pinned ? pinnedBytes - existing.sizeBytes : pinnedBytes;
      if (pinnedOthers + copiedBytes + output.sizeBytes > quota) {
        overQuota.push(output.path);
        counts.skipped += 1;
        continue;
      }
      try {
        const row = await this.copyIn(run, output, mtime, now, existing, projectRows);
        counts.archived += 1;
        if (row.pinned) pinnedBytes = pinnedOthers + row.sizeBytes;
        else copiedBytes += row.sizeBytes;
        const index = projectRows.findIndex((r) => r.id === row.id);
        if (index >= 0) projectRows[index] = row;
        else projectRows.push(row);
      } catch (error) {
        counts.failed += 1;
        failures.push({ path: output.path, error: errorText(error) });
      }
    }

    await this.evict(run.projectId, quota).catch((error: unknown) =>
      failures.push({ path: '', error: `quota cleanup failed: ${errorText(error)}` }),
    );

    for (const output of tooLarge) {
      this.notify(runId, 'build_output_too_large', {
        path: output.path,
        name: output.name,
        sizeBytes: output.sizeBytes,
        quotaBytes: quota,
        message: `${output.name} (${formatBytes(output.sizeBytes)}) is larger than the project's whole build output quota (${formatBytes(quota)}) and was not archived`,
      });
    }
    if (overQuota.length > 0) {
      const pinnedFull = pinnedBytes >= quota;
      this.notify(runId, 'build_outputs_quota_full', {
        reason: pinnedFull ? 'pinned' : 'run_outputs',
        skipped: overQuota,
        quotaBytes: quota,
        pinnedBytes,
        message: pinnedFull
          ? `Pinned build outputs fill the project's quota (${formatBytes(pinnedBytes)} of ${formatBytes(quota)}); ${overQuota.length} new output(s) were not archived. Unpin or delete some, or raise the quota.`
          : `The project's build output quota (${formatBytes(quota)}) has no room for ${overQuota.length} more output(s) of this run; the newest ones were archived.`,
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

  private async copyIn(
    run: RunRow,
    output: RunBuildOutput,
    mtime: number,
    now: Date,
    existing: BuildOutputRow | undefined,
    projectRows: BuildOutputRow[],
  ): Promise<BuildOutputRow> {
    const source = await this.verifiedSource(run.worktreePath, output.path);
    const storedPath = existing?.storedPath ?? this.freshStoredPath(run, output, projectRows);
    const dest = this.storedAbs(storedPath);
    if (!(await this.rootIsRealDir({ create: true })))
      throw new Error('the archive directory is not a plain directory');
    await mkdir(path.dirname(dest), { recursive: true });
    const realDir = await realpath(path.dirname(dest));
    if (realDir !== path.dirname(await this.expectedRealPath(storedPath))) {
      throw new Error('the archive directory contains a symbolic link');
    }
    const temp = path.join(realDir, `.${path.basename(dest)}.${randomUUID()}.part`);
    try {
      await copyFile(source, temp);
      // rename replaces the destination entry itself, even if it were a link.
      await rename(temp, dest);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    const values = {
      projectId: run.projectId,
      runId: run.id,
      ticketId: run.ticketId,
      name: output.name,
      sourcePath: output.path,
      storedPath,
      sizeBytes: output.sizeBytes,
      sourceMtime: new Date(mtime),
      archivedAt: now,
    };
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

  /** Removes the row and its file (when it is safely inside the archive). True if the file was there. */
  private async deleteRow(row: BuildOutputRow): Promise<boolean> {
    const abs = await this.verifiedStoredFile(row.storedPath).catch(() => null);
    if (abs) await rm(abs, { force: true });
    this.db.delete(buildOutputs).where(eq(buildOutputs.id, row.id)).run();
    return abs !== null;
  }

  /** Lexically resolves an archive-relative path; anything that leaves the root is refused. */
  private storedAbs(storedPath: string): string {
    const normalized = storedPath.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0'))
      throw badRequest('invalid archive path');
    const abs = path.resolve(this.root, normalized);
    const rel = path.relative(this.root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
      throw badRequest('archive path outside the archive');
    return abs;
  }

  /** Where `storedPath` must resolve to when no component of it is a link. */
  private async expectedRealPath(storedPath: string): Promise<string> {
    const rel = path.relative(this.root, this.storedAbs(storedPath));
    return path.join(await realpath(this.config.workspacesDir), ARCHIVE_DIR_NAME, rel);
  }

  /** The stored file's real path, or null when it does not exist. Throws when a link is involved. */
  private async verifiedStoredFile(storedPath: string): Promise<string | null> {
    const abs = this.storedAbs(storedPath);
    let real: string;
    try {
      real = await realpath(abs);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (real !== (await this.expectedRealPath(storedPath)))
      throw badRequest('archive path outside the archive');
    return real;
  }

  /** True when the archive root is a real directory (created on request), never a link. */
  private async rootIsRealDir(opts: { create?: boolean } = {}): Promise<boolean> {
    const info = await lstat(this.root).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (info) return info.isDirectory();
    if (!opts.create) return false;
    await mkdir(this.root, { recursive: true });
    return (await lstat(this.root)).isDirectory();
  }

  /** The source file's real path: a regular file inside the worktree, reached without links. */
  private async verifiedSource(worktreePath: string, relPath: string): Promise<string> {
    const { abs, rel } = resolveSafeWorktreePath(worktreePath, relPath);
    const [realRoot, realFile] = await Promise.all([realpath(worktreePath), realpath(abs)]);
    if (realFile !== path.join(realRoot, rel)) throw new Error(`${rel} is reached through a symbolic link`);
    if (!(await stat(realFile)).isFile()) throw new Error(`${rel} is not a regular file`);
    return realFile;
  }
}
