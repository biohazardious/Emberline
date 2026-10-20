import { existsSync } from 'node:fs';
import type { Run, RunRecovery } from '@emberline/protocol';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, reviewComments, runEvents, runs, tickets } from '../db/schema.js';
import { findSuperseding, type MergeProbeResult, probeMerge } from '../factory/merge-probe.js';
import { mainWorkspaceBranch } from '../factory/merge.js';
import { CHAIN_MAX } from '../review/blocking.js';
import { currentHold } from './hold-outcome.js';
import { buildRecovery, type RecoveryInput } from './recovery.js';
import type { RunService } from './service.js';

/** The pipeline's own stop of a finished factory step: the only cancel a successor may continue. */
export const FINISHED_STEP_STOP = 'factory_step_finished';

export interface RecoveryServiceOptions {
  /** What ends a prompt asking the run for more work (TicketService.completionReminder; injected to avoid a cycle). */
  completionReminder: (run: Run) => string;
}

/** Attention reasons a hold note leaves (a `completion_blocked` hold reads as `blocked`). */
const isHeld = (run: Run) => run.attention?.reason === 'held' || run.attention?.reason === 'blocked';

/**
 * Why a held run is held, what a person can do about it, and how a prompt would reach an agent.
 * Reads the run's current hold note, its ticket and project, and dry-runs the merge for merge holds.
 */
export class RecoveryService {
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly opts: RecoveryServiceOptions,
  ) {}

  /** The run's recovery, or null when nothing holds it for a person (any more). */
  async get(runId: string): Promise<RunRecovery | null> {
    const run = this.runs.getRun(runId);
    if (!isHeld(run)) return null;
    const hold = currentHold(this.runs.loadAttentionFacts([run.id]).get(run.id)?.pipeline ?? []);
    if (!hold) return null;

    const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    const ticket = run.ticketId
      ? this.db.select({ key: tickets.key }).from(tickets).where(eq(tickets.id, run.ticketId)).get()
      : undefined;
    const ticketKey = ticket?.key ?? null;

    let mainBranch = project?.defaultBranch ?? 'main';
    let probe: MergeProbeResult | null = null;
    let superseding: RecoveryInput['superseding'] = null;
    if (hold.type === 'merge_failed' && project) {
      mainBranch = (await mainWorkspaceBranch(project.path)) ?? project.defaultBranch;
      probe = run.branch
        ? await probeMerge(project.path, mainBranch, run.branch)
        : { ok: false, error: 'the run has no branch' };
      if (probe.ok && probe.conflicts.length > 0) {
        const found = await findSuperseding(project.path, mainBranch, probe.conflicts, ticketKey);
        if (found) {
          const other = this.db
            .select({ status: tickets.status })
            .from(tickets)
            .where(and(eq(tickets.projectId, run.projectId), eq(tickets.key, found.key)))
            .get();
          superseding = { ...found, of: probe.conflicts.length, done: other?.status === 'done' };
        }
      }
    }

    const recovery = buildRecovery({
      hold: { type: hold.type, payload: hold.payload },
      ticketKey,
      mainBranch,
      worktreePath: run.worktreePath,
      probe,
      superseding,
      reviewComments: hold.type === 'review_blocked' ? this.openBlockingComments(run) : [],
      completeAgain: this.opts.completionReminder(run),
    });
    return { ...recovery, delivery: this.deliveryFor(run) };
  }

  /** The first prompt suggestion of the run's recovery: what an empty Resume of a held run sends. */
  async holdPrompt(runId: string): Promise<string | null> {
    const recovery = await this.get(runId);
    return recovery?.suggestions.find((s) => s.kind === 'prompt')?.prompt ?? null;
  }

  /**
   * How a prompt reaches an agent: its own session while it is live or resumable; a successor on
   * the same worktree for a held run whose only cancel was the pipeline's finished-step stop (from
   * before held runs stayed resumable); otherwise not at all. A person's stop stays final.
   */
  deliveryFor(run: Run): RunRecovery['delivery'] {
    if ((!run.endedAt && !run.cancelled) || run.resumable) return 'session';
    if (
      isHeld(run) &&
      run.cancelled &&
      !run.handedOffTo &&
      Boolean(run.worktreePath) &&
      existsSync(run.worktreePath) &&
      this.onlyFinishedStepStops(run.id)
    ) {
      return 'successor';
    }
    return 'none';
  }

  /** Whether the run was cancelled by the pipeline's finished-step stops alone. */
  private onlyFinishedStepStops(runId: string): boolean {
    const stops = this.db
      .select({ source: runEvents.source, payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), inArray(runEvents.type, ['stop_requested', 'cancelled'])))
      .all();
    return (
      stops.length > 0 &&
      stops.every((s) => s.source === 'system' && (s.payload as { reason?: unknown } | null)?.reason === FINISHED_STEP_STOP)
    );
  }

  /** Open blocking review comments on the run and the runs it took over from, one line each. */
  private openBlockingComments(run: Run): string[] {
    const chain = [run.id];
    let prev = run.predecessorRunId;
    while (prev && chain.length < CHAIN_MAX && !chain.includes(prev)) {
      chain.push(prev);
      prev = this.db.select({ p: runs.predecessorRunId }).from(runs).where(eq(runs.id, prev)).get()?.p ?? null;
    }
    return this.db
      .select({ filePath: reviewComments.filePath, line: reviewComments.line, body: reviewComments.body })
      .from(reviewComments)
      .where(and(inArray(reviewComments.runId, chain), eq(reviewComments.priority, 'blocking'), ne(reviewComments.status, 'resolved')))
      .orderBy(asc(reviewComments.createdAt))
      .all()
      .map((c) => `${c.filePath}${c.line === null ? '' : `:${c.line}`}: ${c.body.trim()}`);
  }
}
