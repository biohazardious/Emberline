/**
 * Project settings → Repository → Keep main pushed: after each merge into main (the pipeline's or a
 * person's), push main the way Push main does. One push per project at a time; merges that land
 * meanwhile coalesce into one more push. A failure never undoes or blocks the merge: it is noted
 * on the run (`main_push_failed`, redacted reason) and kept for the Repository block.
 */
import type { Run } from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { MERGE_NOTES } from '../factory/post-merge.js';
import type { RunService } from '../runs/service.js';
import { MERGE_UNVERIFIED_MESSAGE } from './git.js';
import type { RepositoryService } from './service.js';

/** A merge into main: its run (the failure note goes there) and the full id of the commit it made. */
interface Merge {
  runId: string | null;
  commitOid: string | null;
  /** Main changed during the merge: Emberline did not record its commit, so it is never pushed. */
  unverified: boolean;
}

interface Job {
  /** The latest merge that is not pushed yet; undefined: none waiting. */
  next: Merge | undefined;
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.started) this.runs.off('note', this.onNote);
    await this.idle();
  }

  /** A merge into main landed; `commitOid` is the full id of the commit it made (only that commit is ever pushed). */
  enqueue(projectId: string, runId: string | null, commitOid: string | null, unverified = false): void {
    if (this.stopped) return;
    const merge: Merge = { runId, commitOid, unverified };
    const job = this.jobs.get(projectId);
    if (job) {
      job.next = merge;
      return;
    }
    const fresh: Job = { next: merge, done: Promise.resolve() };
    this.jobs.set(projectId, fresh);
    fresh.done = this.drain(projectId, fresh);
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

  private async drain(projectId: string, job: Job): Promise<void> {
    // Never inside the merge that noted it.
    await Promise.resolve();
    try {
      while (job.next !== undefined && !this.stopped) {
        const { runId, commitOid, unverified } = job.next;
        job.next = undefined;
        if (!readRepositorySettings(this.db, projectId).keepMainPushed) continue;
        const res = unverified
          ? this.unverified(projectId)
          : await this.repository.pushMainQuietly(projectId, commitOid);
        if (!res.ok) {
          this.log(`keep main pushed: project ${projectId}: ${res.reason}`);
          try {
            if (runId) this.runs.note(runId, 'main_push_failed', { reason: res.reason });
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
}
