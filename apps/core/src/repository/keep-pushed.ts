/**
 * Project settings → Repository → Keep main pushed: after each merge into main (the pipeline's or a
 * person's), push main the way Push main does. One push per project at a time; merges that land
 * meanwhile coalesce into one more push. The push that has not run yet is kept in the project's
 * settings (`pendingMainPush`), so a restart resumes it. A failure never undoes or blocks the
 * merge: it is noted on the run (`main_push_failed`, redacted reason) and kept for the Repository
 * block. A push the runner could not run is kept, and the Repository block says it waits for the
 * runner.
 */
import { randomUUID } from 'node:crypto';
import type { Run } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { MERGE_NOTES } from '../factory/post-merge.js';
import type { RunService } from '../runs/service.js';
import {
  MERGE_UNVERIFIED_MESSAGE,
  ORIGIN_CHANGED_MESSAGE,
  remoteUrlForDisplay,
  RUNNER_WAITING_MESSAGE,
} from './git.js';
import type { RepositoryService } from './service.js';

/** A runner that did not answer is asked again after this long (no reconnect may come). */
export const RUNNER_RETRY_MS = 30_000;

interface Job {
  /** The stored pending push changed since it was last read: read it again. */
  again: boolean;
  done: Promise<void>;
}

export class KeepMainPushed {
  private readonly jobs = new Map<string, Job>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly log: (message: string) => void;
  private readonly retryMs: number;
  private started = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly repository: Pick<RepositoryService, 'pushMainQuietly'>,
    options: { log?: (message: string) => void; retryMs?: number } = {},
  ) {
    this.log = options.log ?? (() => undefined);
    this.retryMs = options.retryMs ?? RUNNER_RETRY_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.runs.on('note', this.onNote);
  }

  /**
   * Runs each project's stored push: one noted before a restart, or kept while the runner was away
   * (only its recorded commit is ever pushed). Called once core listens and the runner is connected
   * (git runs in the runner, and with an account it reaches the forge through core's gateway).
   */
  resumePending(): void {
    if (!this.started || this.stopped) return;
    for (const { id } of this.db.select({ id: projects.id }).from(projects).all()) {
      if (readRepositorySettings(this.db, id).pendingMainPush) this.kick(id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.started) this.runs.off('note', this.onNote);
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await this.idle();
  }

  /** A merge into main landed; `commitOid` is the full id of the commit it made (only that commit is ever pushed). */
  enqueue(projectId: string, runId: string | null, commitOid: string | null, unverified = false): void {
    try {
      if (!readRepositorySettings(this.db, projectId).keepMainPushed) return;
      writeRepositorySettings(this.db, projectId, {
        pendingMainPush: {
          id: randomUUID(),
          runId,
          commitOid,
          unverified,
          queuedAt: new Date().toISOString(),
          origin: this.connectedRepository(projectId),
        },
      });
    } catch {
      return; // the project was deleted
    }
    // Stopping: the push is kept and runs after the next start.
    if (!this.stopped) this.kick(projectId);
  }

  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  private readonly onNote = (run: Run, type: string, payload?: unknown): void => {
    if (!MERGE_NOTES.includes(type)) return;
    // Only the full id: a short sha (older notes) is never resolved, so it is never pushed automatically.
    const fields = (payload ?? {}) as { commitOid?: unknown; commitUnverified?: unknown };
    this.enqueue(
      run.projectId,
      run.id,
      typeof fields.commitOid === 'string' ? fields.commitOid : null,
      fields.commitUnverified === true,
    );
  };

  /** Nothing is pushed; the reason is kept for the Repository block like a failed push's. */
  private unverified(projectId: string): { ok: false; reason: string } {
    try {
      writeRepositorySettings(this.db, projectId, { lastMainPushError: MERGE_UNVERIFIED_MESSAGE });
    } catch {
      // the project was deleted meanwhile
    }
    return { ok: false, reason: MERGE_UNVERIFIED_MESSAGE };
  }

  /** projects.repoUrl as shown (no credentials); null when none is connected. */
  private connectedRepository(projectId: string): string | null {
    const row = this.db
      .select({ repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    return row?.repoUrl ? remoteUrlForDisplay(row.repoUrl).url : null;
  }

  /** The project connected another repository since the merge: nothing is pushed, and it says why. */
  private originChanged(projectId: string): { ok: false; reason: string } {
    try {
      writeRepositorySettings(this.db, projectId, { lastMainPushError: ORIGIN_CHANGED_MESSAGE });
    } catch {
      // the project was deleted meanwhile
    }
    return { ok: false, reason: ORIGIN_CHANGED_MESSAGE };
  }

  /** The Repository block says the push waits for the runner (it stays until the push is decided). */
  private waitForRunner(projectId: string): void {
    try {
      writeRepositorySettings(this.db, projectId, { lastMainPushError: RUNNER_WAITING_MESSAGE });
    } catch {
      // the project was deleted meanwhile
    }
  }

  /** The push was decided another way (pushed, superseded, switched off): the waiting note goes. */
  private doneWaiting(projectId: string): void {
    try {
      if (readRepositorySettings(this.db, projectId).lastMainPushError === RUNNER_WAITING_MESSAGE)
        writeRepositorySettings(this.db, projectId, { lastMainPushError: null });
    } catch {
      // the project was deleted meanwhile
    }
  }

  /** A runner that is connected but did not answer brings no reconnect: the push is tried again shortly. */
  private retrySoon(projectId: string): void {
    if (this.stopped || this.retries.has(projectId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(projectId);
      if (!this.stopped) this.kick(projectId);
    }, this.retryMs);
    timer.unref();
    this.retries.set(projectId, timer);
  }

  private kick(projectId: string): void {
    const job = this.jobs.get(projectId);
    if (job) {
      job.again = true;
      return;
    }
    const fresh: Job = { again: true, done: Promise.resolve() };
    this.jobs.set(projectId, fresh);
    fresh.done = this.drain(projectId, fresh);
  }

  private async drain(projectId: string, job: Job): Promise<void> {
    // Never inside the merge that noted it.
    await Promise.resolve();
    try {
      while (job.again && !this.stopped) {
        job.again = false;
        const settings = readRepositorySettings(this.db, projectId);
        const pending = settings.pendingMainPush;
        if (!pending) continue;
        if (!settings.keepMainPushed) {
          this.clear(projectId, pending.id);
          this.doneWaiting(projectId);
          continue;
        }
        // `origin` absent: queued by 0.5.0, which recorded none, so it is never compared. `null` (no
        // repository connected then) is compared like a URL.
        const res = pending.unverified
          ? this.unverified(projectId)
          : pending.origin !== undefined && pending.origin !== this.connectedRepository(projectId)
            ? this.originChanged(projectId)
            : await this.repository.pushMainQuietly(projectId, pending.commitOid);
        if (!res.ok && 'runnerUnavailable' in res) {
          // Kept as it is: the next runner connection runs it (resumePending), or the retry when the
          // runner is still connected but did not answer.
          this.waitForRunner(projectId);
          if (res.runnerUnavailable === 'timeout') this.retrySoon(projectId);
          this.log(`keep main pushed: project ${projectId}: waiting for the runner (${res.reason})`);
          break;
        }
        // A merge noted meanwhile replaced it (and set `again`): that one runs next.
        this.clear(projectId, pending.id);
        if (res.ok) this.doneWaiting(projectId);
        if (!res.ok) {
          this.log(`keep main pushed: project ${projectId}: ${res.reason}`);
          try {
            if (pending.runId) this.runs.note(pending.runId, 'main_push_failed', { reason: res.reason });
          } catch {
            // the run went away: a merge queued meanwhile is still pushed
          }
        }
      }
    } catch (error) {
      this.log(
        `keep main pushed: project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.jobs.delete(projectId);
    }
  }

  /** Clears the pending push only if it is still the one just handled (synchronous: no write comes between). */
  private clear(projectId: string, id: string): void {
    try {
      if (readRepositorySettings(this.db, projectId).pendingMainPush?.id === id)
        writeRepositorySettings(this.db, projectId, { pendingMainPush: null });
    } catch {
      // the project was deleted meanwhile
    }
  }
}
