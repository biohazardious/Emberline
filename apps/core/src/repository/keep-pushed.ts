/**
 * Project settings → Repository → Keep main pushed: after each merge into main (the pipeline's or a
 * person's), push main the way Push main does. One push per project at a time; merges that land
 * meanwhile coalesce into one more push. The push that has not run yet is kept in the project's
 * settings (`pendingMainPush`), so a restart resumes it. A failure never undoes or blocks the
 * merge: it is noted on the run (`main_push_failed`, redacted reason) and kept for the Repository
 * block.
 */
import { randomUUID } from 'node:crypto';
import type { Run } from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import { MERGE_NOTES } from '../factory/post-merge.js';
import type { RunService } from '../runs/service.js';
import { MERGE_UNVERIFIED_MESSAGE } from './git.js';
import type { RepositoryService } from './service.js';

interface Job {
  /** The stored pending push changed since it was last read: read it again. */
  again: boolean;
  done: Promise<void>;
}

export class KeepMainPushed {
  private readonly jobs = new Map<string, Job>();
  private readonly log: (message: string) => void;
  private started = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly repository: Pick<RepositoryService, 'pushMainQuietly'>,
    options: { log?: (message: string) => void } = {},
  ) {
    this.log = options.log ?? (() => undefined);
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
          continue;
        }
        const res = pending.unverified
          ? this.unverified(projectId)
          : await this.repository.pushMainQuietly(projectId, pending.commitOid);
        if (!res.ok && 'runnerUnavailable' in res) {
          // Kept as it is: the next runner connection runs it (resumePending).
          this.log(`keep main pushed: project ${projectId}: waiting for the runner (${res.reason})`);
          break;
        }
        // A merge noted meanwhile replaced it (and set `again`): that one runs next.
        this.clear(projectId, pending.id);
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
