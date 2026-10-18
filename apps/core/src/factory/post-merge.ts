/**
 * Background work after a merge into a project's main workspace (by the pipeline or a person):
 * rebuild main's demo with the approved setup and checks, then any steps other features register
 * (the main preview refresh). One job per project at a time, at most one pending: merges that land
 * while a job runs coalesce into the next one. Jobs never block or fail the merge that started them.
 */
import type { Run } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects } from '../db/schema.js';
import type { RunService } from '../runs/service.js';
import { approvedChecks } from '../worktree-config/load.js';
import { buildDemoTarget, hasVerifiableBuildTarget } from './demo.js';

/** Run notes of work merged into main: by the pipeline, or by a person (sync-worktree). */
export const MERGE_NOTES: readonly string[] = ['merged_to_main', 'merged_by_person'];

export interface PostMergeContext {
  projectId: string;
  /** The project's main workspace. */
  mainPath: string;
}

/** One step of a post-merge job. A step that throws is logged; the next step still runs. */
export type PostMergeStep = (ctx: PostMergeContext) => Promise<void>;

export interface NamedPostMergeStep {
  /** Shown in log lines. */
  name: string;
  run: PostMergeStep;
}

export interface PostMergeOptions {
  /** The built-in steps; defaults to rebuilding main's demo ({@link rebuildMainDemoStep}). */
  steps?: NamedPostMergeStep[];
  log?: (message: string, err?: unknown) => void;
}

interface JobState {
  /** Another merge landed after the running job started: run once more when it ends. */
  pending: boolean;
  done: Promise<void>;
}

/**
 * Rebuilds main's demo the way Run Build & Verify does (approved setup, checks and Docker
 * variables; recorded under `demoBuilds`), when main has something the build gate would verify.
 */
export function rebuildMainDemoStep(
  db: Db,
  runs: Pick<RunService, 'get' | 'dockerEnvFor' | 'dockerEnvForMain'>,
  log: (message: string, err?: unknown) => void,
): NamedPostMergeStep {
  return {
    name: 'rebuild main demo',
    run: async ({ projectId, mainPath }) => {
      if (!hasVerifiableBuildTarget(mainPath, approvedChecks(db, projectId))) return;
      const res = await buildDemoTarget({ db, runs }, { id: projectId, path: mainPath }, 'main');
      log(
        res.ok
          ? `post-merge: rebuilt main of project ${projectId}`
          : `post-merge: rebuild of main failed for project ${projectId}: ${res.output.slice(-300)}`,
      );
    },
  };
}

export class PostMergeJobs {
  private readonly steps: NamedPostMergeStep[];
  private readonly jobs = new Map<string, JobState>();
  private readonly log: (message: string, err?: unknown) => void;
  private started = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    options: PostMergeOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
    this.steps = [...(options.steps ?? [rebuildMainDemoStep(db, runs, this.log)])];
  }

  /** Adds a step that runs after the built-in ones in every later job (e.g. refresh main's preview). */
  registerPostMergeStep(name: string, run: PostMergeStep): void {
    this.steps.push({ name, run });
  }

  /** Listens for merge notes. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.runs.on('note', this.onNote);
  }

  /** Stops listening and waits for running jobs; pending ones are dropped. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.started) this.runs.off('note', this.onNote);
    await this.idle();
  }

  /** Queues a job for the project; returns at once. */
  enqueue(projectId: string): void {
    if (this.stopped) return;
    const job = this.jobs.get(projectId);
    if (job) {
      job.pending = true;
      return;
    }
    const state: JobState = { pending: false, done: Promise.resolve() };
    this.jobs.set(projectId, state);
    state.done = this.drain(projectId, state);
  }

  /** Whether a post-merge job of the project is running or pending. */
  isRebuilding(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  /** Resolves once no job runs (also those queued while waiting). */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.all([...this.jobs.values()].map((j) => j.done));
    }
  }

  private readonly onNote = (run: Run, type: string): void => {
    if (MERGE_NOTES.includes(type)) this.enqueue(run.projectId);
  };

  private async drain(projectId: string, state: JobState): Promise<void> {
    // Never inside the merge that noted it: its pipeline goes on first.
    await Promise.resolve();
    try {
      do {
        state.pending = false;
        await this.runJob(projectId);
      } while (state.pending && !this.stopped);
    } finally {
      this.jobs.delete(projectId);
    }
  }

  private async runJob(projectId: string): Promise<void> {
    const row = this.db
      .select({ path: projects.path })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!row) return;
    const ctx: PostMergeContext = { projectId, mainPath: row.path };
    for (const step of this.steps) {
      try {
        await step.run(ctx);
      } catch (error) {
        this.log(
          `post-merge: ${step.name} failed for project ${projectId}: ${(error as Error)?.message ?? String(error)}`,
          error,
        );
      }
    }
  }
}
