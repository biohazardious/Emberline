import { existsSync } from 'node:fs';
import { NEEDS_PERSON_INPUT, type RecoverResponse, type Run, type RunRecovery } from '@emberline/protocol';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, reviewComments, tickets } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { mainMoversFor, type MergeProbeResult, probeMerge, supersedingFor } from '../factory/merge-probe.js';
import { mainWorkspaceBranch } from '../factory/merge.js';
import { KeyedMutex } from '../keyed-mutex.js';
import type { Scheduler } from '../scheduler/service.js';
import { currentHold, handoffChain } from './hold-outcome.js';
import { buildRecovery, type RecoveryInput } from './recovery.js';
import { isHeldRun, type RunService } from './service.js';

/** The handoff reason of a held run that continues in a successor. */
export const CONTINUED_AFTER_HOLD = 'continued after a hold';

/** States in which an agent is about to work or working: a prompt now would land mid-start or mid-turn. */
const BUSY_STATES: ReadonlySet<string> = new Set(['queued', 'starting', 'working']);

const busy = (run: Run) =>
  new HttpError(409, 'run_busy', `the agent is ${run.state}; send your prompt once it is waiting`);

export interface RecoveryServiceOptions {
  /** What ends a prompt asking the run for more work (TicketService.completionReminder; injected to avoid a cycle). */
  completionReminder: (run: Run) => string;
}

/**
 * Why a held run is held, what a person can do about it, and how a prompt would reach an agent.
 * Reads the run's current hold note, its ticket and project, and dry-runs the merge for merge holds.
 */
export class RecoveryService {
  /** One delivery per run at a time: a double click starts one successor. */
  private readonly delivering = new KeyedMutex();

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly scheduler: Scheduler,
    private readonly opts: RecoveryServiceOptions,
  ) {}

  /** The run's recovery, or null when nothing holds it for a person (any more). */
  async get(runId: string): Promise<RunRecovery | null> {
    const run = this.runs.getRun(runId);
    if (!isHeldRun(run)) return null;
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
    let movedBy: string[] = [];
    if (hold.type === 'merge_failed' && project) {
      mainBranch = (await mainWorkspaceBranch(project.path)) ?? project.defaultBranch;
      probe = run.branch
        ? await probeMerge(project.path, mainBranch, run.branch)
        : { ok: false, error: 'the run has no branch' };
      if (probe.ok && probe.conflicts.length > 0) {
        movedBy = await mainMoversFor(project.path, probe, ticketKey);
        const found = await supersedingFor(project.path, probe, ticketKey);
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
      movedBy,
      reviewComments: hold.type === 'review_blocked' ? this.openBlockingComments(run) : [],
      completionReminder: this.opts.completionReminder(run),
    });
    return { ...recovery, delivery: this.deliveryFor(run) };
  }

  /**
   * The first prompt suggestion of the run's recovery that can go as it is: what an empty Resume of
   * a held run sends. Null (the plain continue) when only a form for the person's answer fits.
   */
  async holdPrompt(runId: string): Promise<string | null> {
    const recovery = await this.get(runId);
    return (
      recovery?.suggestions.find((s) => s.kind === 'prompt' && !NEEDS_PERSON_INPUT.has(s.id))?.prompt ?? null
    );
  }

  /**
   * How a prompt reaches an agent: its own session while it is live or resumable; a successor on
   * the same worktree for a held run whose only cancel was the pipeline's finished-step stop (from
   * before held runs stayed resumable); otherwise (also without its worktree) not at all. A person's
   * stop stays final.
   */
  deliveryFor(run: Run): RunRecovery['delivery'] {
    if (!run.worktreePath || !existsSync(run.worktreePath)) return 'none';
    if ((!run.endedAt && !run.cancelled) || run.resumable) return 'session';
    return this.runs.continuesInSuccessor(run) ? 'successor' : 'none';
  }

  /**
   * Throws recover()'s refusal when a prompt could not reach the held run now, so a caller can
   * refuse before doing anything else (the Answer dialog writes attachments first).
   */
  assertDeliverable(run: Run): void {
    if (BUSY_STATES.has(run.state)) throw busy(run);
    if (!isHeldRun(run)) throw new HttpError(409, 'not_held', 'nothing holds this run any more');
    const delivery = this.deliveryFor(run);
    if (delivery === 'none') throw this.refusal(run);
    if (delivery === 'successor') this.scheduler.assertRouteOpen(this.runs.currentRoute(run.id));
  }

  /**
   * Delivers a person's prompt to a held run (`deliveryFor`): into its own session, or as the prompt
   * of a successor on the same worktree, branch and route. Refusals are 409s with a code.
   */
  async recover(runId: string, text: string): Promise<RecoverResponse> {
    return this.delivering.run(runId, async () => {
      const run = this.runs.getRun(runId);
      if (BUSY_STATES.has(run.state)) throw busy(run);
      if (!isHeldRun(run)) throw new HttpError(409, 'not_held', 'nothing holds this run any more');
      const delivery = this.deliveryFor(run);
      if (delivery === 'session')
        return { delivery, run: await this.runs.prompt(run.id, text, { automatic: false }) };
      if (delivery === 'none') throw this.refusal(run);
      const route = this.runs.currentRoute(run.id);
      this.scheduler.assertRouteOpen(route);
      const successor = await this.runs.handOff(run.id, route, {
        reason: CONTINUED_AFTER_HOLD,
        source: 'user',
        automatic: false,
        extraPrompt: text,
        allowSystemFinishedCancel: true,
      });
      await this.scheduler.tick();
      return { delivery, run: this.runs.getRun(successor.id) };
    });
  }

  /** Why a held run cannot take a prompt at all. */
  private refusal(run: Run): HttpError {
    if (run.handedOffTo)
      return new HttpError(409, 'not_held', 'this run was handed off; its successor continues the work');
    if (run.cancelled && !this.runs.cancelledOnlyByFinishedStep(run.id)) {
      return new HttpError(409, 'run_stopped_by_you', 'this run was stopped; start a new run or discard it');
    }
    if (!run.worktreePath || !existsSync(run.worktreePath)) {
      return new HttpError(
        409,
        'worktree_missing',
        "this run's worktree was removed; start a new run or discard it",
      );
    }
    return new HttpError(
      409,
      'no_session',
      'this run has no agent session to continue; start a new run or discard it',
    );
  }

  /** Open blocking review comments on the run and the runs it took over from, one line each. */
  private openBlockingComments(run: Run): string[] {
    const chain = handoffChain(this.db, run.id);
    return this.db
      .select({ filePath: reviewComments.filePath, line: reviewComments.line, body: reviewComments.body })
      .from(reviewComments)
      .where(
        and(
          inArray(reviewComments.runId, chain),
          eq(reviewComments.priority, 'blocking'),
          ne(reviewComments.status, 'resolved'),
        ),
      )
      .orderBy(asc(reviewComments.createdAt))
      .all()
      .map((c) => `${c.filePath}${c.line === null ? '' : `:${c.line}`}: ${c.body.trim()}`);
  }
}
