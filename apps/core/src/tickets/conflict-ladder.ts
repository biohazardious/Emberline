import { existsSync } from 'node:fs';
import type { Run, SyncWorktreeResolution } from '@emberline/protocol';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents, runs, tickets } from '../db/schema.js';
import type { HealFailure } from '../factory/conflict-heal.js';
import { conflictResolutionPrompt, type SyncWorktreeResult } from '../factory/merge.js';
import { effectiveFactorySettings } from '../factory/settings.js';
import { verifyBuild } from '../runs/gates.js';
import type { RunService } from '../runs/service.js';
import { healThenMerge, mergeTarget, type RunMerge } from '../runs/worktree.js';
import type { Scheduler } from '../scheduler/service.js';
import { clipText } from '../text/control-chars.js';
import { occupiesTicketSlot } from './columns.js';

/** Automatic conflict requests into one run's own session (each after main moved again). */
export const CONFLICT_ATTEMPT_CAP = 3;

/** Resolver runs one ticket gets in all; after that a conflict is a person's. */
export const RESOLVER_RUN_CAP = 2;

/** The handoff reason of a conflict resolver run (its `handoff_from` note says it). */
export const RESOLVER_REASON = 'resolving merge conflicts';

/** Room for the ticket's summary and a heal's gate output in a prompt. */
const SUMMARY_MAX = 1_500;
const GATE_OUTPUT_MAX = 2_400;

/** A person's merge with the heal that was tried on it, if any. */
type HealedMerge = SyncWorktreeResult & Pick<RunMerge, 'healFailure'>;

export type LadderResolution = Exclude<SyncWorktreeResolution, 'auto_resolved'>;

/** Who took a conflict up the ladder, and the resolver run when one was started. */
export interface LadderOutcome {
  resolution: LadderResolution;
  resolverRunId: string | null;
}

/** One conflicting merge to escalate (after the deterministic heal, layer 2, did not land it). */
export interface ConflictEscalation {
  run: Run;
  conflicts: string[];
  /** Main's head as the failed merge saw it; null when unknown. */
  mainHead: string | null;
  /** The heal that was tried and undone, if any: its gate's failure goes into the prompt. */
  healFailure?: HealFailure;
  project: { path: string; defaultBranch: string };
}

export interface ConflictLadderDeps {
  db: Db;
  runs: RunService;
  scheduler: Pick<Scheduler, 'tick'>;
  /** TicketService.completionReminder: what ends a prompt to an agent that has the completion tool. */
  completionReminder: (run: Run, separator: string) => string;
}

/** What the gate said about the healed tree, for the agent that resolves by hand now. */
function healSection(branch: string, failure: HealFailure | undefined): string {
  if (!failure?.gateFailure) return '';
  return `\n\nEmberline merged ${branch} into your branch and resolved the additive conflicts itself, but the project's checks failed on that result, so it was undone. Their output ended with:\n\n\`\`\`\n${failure.gateFailure.slice(-GATE_OUTPUT_MAX)}\n\`\`\``;
}

/**
 * Layer 3 of PROJECT.md §6 M5: a conflicting merge goes to the run's own session while it can take
 * a prompt (up to CONFLICT_ATTEMPT_CAP, a new request only after main moved); a session that ended
 * and cannot resume, or one whose attempts are spent while main keeps moving, gets a resolver run
 * on the same ticket, worktree and branch (a handoff: the held run is superseded and never merged
 * itself). At most one resolver per ticket and main head, RESOLVER_RUN_CAP per ticket; otherwise
 * the hold is a person's.
 */
export class ConflictLadder {
  constructor(private readonly deps: ConflictLadderDeps) {}

  /** The main heads of the run's delivered conflict requests, oldest first (null: an old event without one). */
  attempts(runId: string): Array<string | null> {
    return this.deps.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'conflict_resolution_requested')))
      .orderBy(asc(runEvents.id))
      .all()
      .map((row) => (row.payload as { mainHead?: string | null } | null)?.mainHead ?? null);
  }

  /** Whether the run already got an automatic conflict-resolution attempt (survives a restart). */
  requested(runId: string): boolean {
    return this.attempts(runId).length > 0;
  }

  /**
   * Whether the agent may be asked to resolve a conflict again: the first time, and later only when
   * main moved since the last request (the conflict is a new one), up to CONFLICT_ATTEMPT_CAP.
   */
  attemptAllowed(runId: string, mainHead: string | null): boolean {
    const attempts = this.attempts(runId);
    if (attempts.length >= CONFLICT_ATTEMPT_CAP) return false;
    if (attempts.length === 0) return true;
    const last = attempts[attempts.length - 1] ?? null;
    return mainHead !== null && last !== mainHead;
  }

  /** The main heads of the resolver runs started for a ticket, oldest first. */
  resolverHeads(ticketId: string): Array<string | null> {
    const ticketRuns = this.deps.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.ticketId, ticketId))
      .all()
      .map((r) => r.id);
    if (ticketRuns.length === 0) return [];
    return this.deps.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, ticketRuns), eq(runEvents.type, 'conflict_resolver_started')))
      .orderBy(asc(runEvents.id))
      .all()
      .map((row) => (row.payload as { mainHead?: string | null } | null)?.mainHead ?? null);
  }

  /** Which rung takes this conflict: the run's own session, a resolver run, or a person. */
  plan(run: Run, mainHead: string | null): 'agent' | 'resolver' | 'manual' {
    if (run.handedOffTo) return 'manual';
    // A person's stop stays final.
    if (run.cancelled && !this.deps.runs.cancelledOnlyByFinishedStep(run.id)) return 'manual';
    const canPrompt = !run.endedAt || run.resumable;
    if (canPrompt && this.attemptAllowed(run.id, mainHead)) return 'agent';
    const attempts = this.attempts(run.id);
    const capSpentWhileMoving =
      attempts.length >= CONFLICT_ATTEMPT_CAP && mainHead !== null && attempts.at(-1) !== mainHead;
    if (!canPrompt || capSpentWhileMoving) return this.resolverAllowed(run, mainHead) ? 'resolver' : 'manual';
    return 'manual';
  }

  private resolverAllowed(run: Run, mainHead: string | null): boolean {
    if (!run.ticketId || !run.worktreePath || !existsSync(run.worktreePath)) return false;
    const heads = this.resolverHeads(run.ticketId);
    if (heads.length >= RESOLVER_RUN_CAP) return false;
    return mainHead === null || !heads.includes(mainHead);
  }

  /**
   * Takes the conflict up the ladder; `manual` when nothing automatic took it (the caller holds it).
   * `resolverRunId`: the resolver run it started, for `resolver_started`.
   */
  async escalate(e: ConflictEscalation): Promise<LadderOutcome> {
    const manual = { resolution: 'manual', resolverRunId: null } as const;
    if (e.conflicts.length === 0) return manual;
    const rung = this.plan(e.run, e.mainHead);
    if (rung === 'agent') {
      return (await this.askAgent(e)) ? { resolution: 'agent_resolving', resolverRunId: null } : manual;
    }
    if (rung === 'resolver') {
      const resolverRunId = await this.startResolver(e);
      return resolverRunId ? { resolution: 'resolver_started', resolverRunId } : manual;
    }
    return manual;
  }

  /** Types the conflict follow-up into the live session; false when the run cannot take a prompt. */
  private async askAgent({
    run,
    conflicts,
    mainHead,
    healFailure,
    project,
  }: ConflictEscalation): Promise<boolean> {
    // The merge goes into whatever the main workspace has checked out; the column is the fallback.
    const branch = await mergeTarget(project);
    const text = `${conflictResolutionPrompt(branch, conflicts)}${healSection(branch, healFailure)}${this.deps.completionReminder(run, ' ')}`;
    try {
      // prompt() resumes a session the idle sweep closed meanwhile (the checks can outlast its TTL).
      await this.deps.runs.prompt(run.id, text, { automatic: true });
    } catch (error) {
      this.deps.runs.note(run.id, 'conflict_resolution_failed', {
        conflicts,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.deps.runs.note(run.id, 'conflict_resolution_requested', { conflicts, mainHead });
    return true;
  }

  /** The resolver run's own instructions, after the handoff context. */
  private async resolverPrompt({
    run,
    conflicts,
    healFailure,
    project,
  }: ConflictEscalation): Promise<string> {
    const branch = await mergeTarget(project);
    const ticket = run.ticketId
      ? this.deps.db
          .select({ key: tickets.key, title: tickets.title, completion: tickets.completion })
          .from(tickets)
          .where(eq(tickets.id, run.ticketId))
          .get()
      : undefined;
    const summary = ticket?.completion?.summary?.trim();
    const about = ticket
      ? `\n\nThe ticket is ${ticket.key} "${ticket.title}".${summary ? ` The previous run reported:\n\n> ${clipText(summary, SUMMARY_MAX).split('\n').join('\n> ')}` : ''}`
      : '';
    return `You are the conflict resolver for this ticket. Its work is done and committed on this branch, but ${conflictResolutionPrompt(branch, conflicts)}${healSection(branch, healFailure)}${about}${this.deps.completionReminder(run, '\n\n')}`;
  }

  /** Starts the resolver run (a handoff on the same worktree and branch); its id, null when it could not start. */
  private async startResolver(e: ConflictEscalation): Promise<string | null> {
    const { run, conflicts, mainHead } = e;
    let successorId: string;
    try {
      const successor = await this.deps.runs.handOff(run.id, this.deps.runs.currentRoute(run.id), {
        reason: RESOLVER_REASON,
        source: 'system',
        automatic: false,
        extraPrompt: await this.resolverPrompt(e),
        allowSystemFinishedCancel: true,
        persona: 'coder',
        unattended: 'factory',
      });
      this.deps.runs.note(run.id, 'conflict_resolver_started', { runId: successor.id, conflicts, mainHead });
      successorId = successor.id;
    } catch (error) {
      this.deps.runs.note(run.id, 'conflict_resolver_failed', {
        conflicts,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    await this.deps.scheduler.tick().catch(() => undefined);
    return successorId;
  }

  /** Whether an agent may be working in the worktree: a run there holds a ticket slot (handoffs share it). */
  private worktreeBusy(worktreePath: string): boolean {
    return this.deps.db
      .select({ state: runs.state })
      .from(runs)
      .where(eq(runs.worktreePath, worktreePath))
      .all()
      .some((r) => occupiesTicketSlot(r.state as Run['state']));
  }

  /** The latest switch to `working` or `done` of any run in the worktree: its agents' current turn. */
  private worktreeTurn(worktreePath: string): number | undefined {
    const inWorktree = this.deps.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.worktreePath, worktreePath));
    return this.deps.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, inWorktree), inArray(runEvents.state, ['working', 'done'])))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get()?.id;
  }

  /**
   * A person's close (`POST /api/projects/:id/sync-worktree`) whose merge conflicted: the same ladder
   * as the pipeline's, the deterministic heal first (when the factory setting is on). `merge` merges
   * again once the heal landed. Returns the final merge (with the resolver run it started, if any)
   * and who resolves it.
   */
  async afterPersonMerge(p: {
    run: Run;
    first: SyncWorktreeResult;
    project: { path: string; defaultBranch: string };
    ticketKey: string | null;
    merge: () => Promise<SyncWorktreeResult>;
  }): Promise<{ result: SyncWorktreeResult; resolution: SyncWorktreeResolution }> {
    const { run, first, project, ticketKey } = p;
    const settings = effectiveFactorySettings(this.deps.db, run.projectId);
    // The heal holds a merge in the worktree while the checks run (minutes) and resets it away when
    // they fail: never under an agent that may be editing there. A busy worktree skips the heal (the
    // heal itself refuses uncommitted changes); one an agent takes up meanwhile is stale, and its
    // heal is undone only when the agent left the tree untouched, as on the pipeline's path.
    const turn = this.worktreeTurn(run.worktreePath);
    const stale = () => this.worktreeBusy(run.worktreePath) || this.worktreeTurn(run.worktreePath) !== turn;
    const healed =
      settings.autoResolveAdditiveConflicts && !stale()
        ? await healThenMerge<HealedMerge>({
            run,
            mainWorkspacePath: project.path,
            ticketKey,
            stale,
            heal: {
              defaultBranch: project.defaultBranch,
              verify: () =>
                verifyBuild({
                  db: this.deps.db,
                  run,
                  settings,
                  dockerEnv: () => this.deps.runs.dockerEnvFor(run),
                }),
              note: (type, payload) => this.deps.runs.note(run.id, type, payload),
            },
            first,
            merge: p.merge,
          })
        : null;
    const result: HealedMerge = healed ?? first;
    if (result.ok) return { result, resolution: result.resolution ?? 'auto_resolved' };
    const { resolution, resolverRunId } = await this.escalate({
      run: this.deps.runs.getRun(run.id),
      conflicts: result.conflicts,
      mainHead: result.mainHead,
      ...(result.healFailure ? { healFailure: result.healFailure } : {}),
      project,
    });
    const { healFailure: _healFailure, ...plain } = result;
    return { result: { ...plain, resolverRunId }, resolution };
  }
}
