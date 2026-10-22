/**
 * Project settings → Repository → Keep main pushed: after each merge into main (the pipeline's or a
 * person's), push main the way Push main does. One push per project at a time; merges that land
 * meanwhile coalesce into one more push. A failure never undoes or blocks the merge: it is noted
 * on the run (`main_push_failed`, redacted reason) and kept for the Repository block.
 */
import type { Run } from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { readRepositorySettings } from '../db/project-settings.js';
import { MERGE_NOTES } from '../factory/post-merge.js';
import type { RunService } from '../runs/service.js';
import type { RepositoryService } from './service.js';

interface Job {
  /** The run of the latest merge that is not pushed yet (its note gets a failure); undefined: none waiting. */
  next: string | null | undefined;
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

  enqueue(projectId: string, runId: string | null): void {
    if (this.stopped) return;
    const job = this.jobs.get(projectId);
    if (job) {
      job.next = runId;
      return;
    }
    const fresh: Job = { next: runId, done: Promise.resolve() };
    this.jobs.set(projectId, fresh);
    fresh.done = this.drain(projectId, fresh);
  }

  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  private readonly onNote = (run: Run, type: string): void => {
    if (MERGE_NOTES.includes(type)) this.enqueue(run.projectId, run.id);
  };

  private async drain(projectId: string, job: Job): Promise<void> {
    // Never inside the merge that noted it.
    await Promise.resolve();
    try {
      while (job.next !== undefined && !this.stopped) {
        const runId = job.next;
        job.next = undefined;
        if (!readRepositorySettings(this.db, projectId).keepMainPushed) continue;
        const res = await this.repository.pushMainQuietly(projectId);
        if (!res.ok) {
          this.log(`keep main pushed: project ${projectId}: ${res.reason}`);
          if (runId) this.runs.note(runId, 'main_push_failed', { reason: res.reason });
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
