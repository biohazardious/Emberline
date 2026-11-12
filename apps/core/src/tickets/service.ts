import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentCreateTicketsPayload,
  AgentCreateTicketsPayload as AgentCreateTicketsPayloadSchema,
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  type BulkTicketBody,
  type BulkTicketResult,
  type CreateRunBody,
  type CreateTicketBody,
  CreateTicketBody as CreateTicketBodySchema,
  type FactoryRequestBody,
  FactoryRequestBody as FactoryRequestBodySchema,
  type FactoryRequestResponse,
  type FactorySettings,
  type ForgeIssue,
  type ForgeProvider,
  type ProjectNotice,
  normalizeTicketRef,
  type Run,
  RUN_PROMPT_MAX,
  type StartTicketBody,
  StartTicketBody as StartTicketBodySchema,
  type Ticket,
  type TicketExport,
  type TicketOverlapWait,
  type TicketStatus,
  type UpdateTicketBody,
  UpdateTicketBody as UpdateTicketBodySchema,
} from '@emberline/protocol';
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, max, ne, or } from 'drizzle-orm';
import { type Db, getSetting, setSetting } from '../db/index.js';
import type { AgentFileRejection } from '../factory/agent-files.js';
import type { HealFailure } from '../factory/conflict-heal.js';
import { runCommit } from '../factory/commit-identity.js';
import { EXISTING_TICKETS_MAX, existingTicketsSection } from './existing-tickets.js';
import {
  factoryWorkingBranch,
  readProjectSettings,
  readWizardTickets,
  writeProjectSettings,
} from '../db/project-settings.js';
import { issueTombstones, projects, runEvents, runs, settings, tickets } from '../db/schema.js';
import { conflict, HttpError, notFound } from '../errors.js';
import {
  buildFactoryOrchestratorPrompt,
  factoryTicketTitle,
  effectiveFactorySettings,
  getFactorySettings,
  committedWithContent,
  ingestAgentTicketsFiles,
  mainWorkspaceBranch,
  persistFactoryAttachments,
  runBranchBase,
  runProducedChanges,
  type TicketsFileHooks,
} from '../factory/service.js';
import { applyBulkTicketAction, liveRun } from './bulk.js';
import { ConflictLadder } from './conflict-ladder.js';
import { buildTicketExport } from './export.js';
import { mapIssueToTicket } from './issue-mapping.js';
import { ACTIVE_RUN_STATES, columnForRun, edgePosition, occupiesTicketSlot } from './columns.js';
import { BranchFootprints, type BusyFootprint, busyFootprint, claimedPaths, overlapWait } from './overlap.js';
import {
  type CreatedDraft,
  dependentIds,
  loadDependencies,
  normalizeTicketTitle,
  replaceDependencies,
  storeDraftDependencies,
  type TicketDependencies,
  unblockedSince,
} from './dependencies.js';
import { clipCodeUnits, clipText } from '../text/control-chars.js';
import { DEPENDENCY_SECTION_MAX, dependencyContextSection } from './dependency-context.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { slugify } from '../routes/projects.js';
import {
  branchMergedBefore,
  continuesHeldWork,
  isAutoFixHold,
  latestDoneEventId,
  pipelineOutcome,
  reviewHoldLiftedIsCurrent,
  reviewUnblockPending,
  stillHeld,
} from '../runs/hold-outcome.js';
import { HOLD_EVENTS } from '../runs/hold-events.js';
import {
  buildGateRequest,
  buildGate,
  criticGate,
  fixCheckOf,
  type GatePass,
  reviewGate,
  slopGate,
  verifyBuild,
  worktreeCommandsGate,
  worktreeYmlGate,
} from '../runs/gates.js';
import { type MergeHeal, mergeRunBranch, mergeTarget } from '../runs/worktree.js';
import { providerAdapter } from '../runs/providers.js';
import { parseRouteTag } from '../runs/route.js';
import type { RunOrigin, RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

type TicketRow = typeof tickets.$inferSelect;

/** A run as overlap-aware dispatch reads it (TicketService.overlapBusyRuns). */
type OverlapRun = Pick<Run, 'id' | 'ticketId' | 'handedOffTo' | 'state' | 'worktreePath'>;

interface TicketServiceEvents {
  ticket: [ticket: Ticket];
  /** The ticket changed column (a person, the pipeline or a run); after its `ticket` event. */
  moved: [ticket: Ticket, from: TicketStatus];
  removed: [ticket: { id: string; projectId: string }];
  /** Something about a project the user should hear, e.g. an agent file core ignored. */
  notice: [notice: ProjectNotice];
}

type Blocker = Ticket['blockedBy'][number];

/** How many imported tickets-file hashes a project remembers (`ingestedTicketFiles`). */
const INGESTED_TICKET_FILES_MAX = 50;

/** Settings key of the projects whose factory chain is on (JSON array of project ids). */
const ACTIVE_CHAINS_KEY = 'factory.activeChains';

/**
 * Settings key of the runs whose completion pipeline is due or going (JSON object: run id -> the
 * mode of its latest pass): set when a finished turn's settle wait or a pass starts, cleared when its
 * pass ends or the wait is dropped. What is left at start-up was cut off by the restart.
 */
const PENDING_PIPELINES_KEY = 'factory.pendingPipelines';

/**
 * Settings key of the upgrade from a version that kept no pipeline marks (0.6.0 or earlier): the
 * runs to hold, as first taken (`{ pending: UpgradeCandidate[] }`), until a start held them; then `done`.
 */
const UPGRADE_HOLDS_KEY = 'factory.upgradeHolds';

/** A run whose checks the upgrade's restart may have cut off, as it was when first taken. */
interface UpgradeCandidate {
  id: string;
  stateChangedAt: string;
}

/**
 * `finalizing`: a dispatch's Review finalization runs the pipeline of a completion whose own pass
 * was cut off (it finalizes the ticket even when the project is not chaining any more).
 * `resumed`: this pass stands in for one a restart cut off; it goes on where that one was.
 */
interface PipelineOptions {
  finalizing?: boolean;
  resumed?: boolean;
}

/** A pipeline marked as due in {@link PENDING_PIPELINES_KEY}, with the mode of its latest pass. */
interface PendingPipeline {
  finalizing: boolean;
}

/**
 * How long a finished turn must stay finished before its gates and merge run (R8): a CLI may wake up
 * again for background work right after its Stop hook, and its next Stop starts the wait over.
 */
export const PIPELINE_SETTLE_MS = 20_000;

export interface TicketServiceOptions {
  /** See {@link PIPELINE_SETTLE_MS}. */
  pipelineSettleMs: number;
}

/** A forge issue a ticket is created from. */
export interface IssueLink {
  source: ForgeProvider;
  externalId: string;
  number: number;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Label sync from an untrusted author: no automatic dispatch until a person triages it. */
  triage?: boolean;
}

/** What a person (a tickets route) did, as opposed to the pipeline or the roadmap. */
export interface ByPerson {
  byPerson?: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/** See {@link TicketService.dispatchNextReadyTicket}. */
interface DispatchOptions {
  only?: ReadonlySet<string>;
  chain?: boolean;
}

export const toTicket = (
  row: TicketRow,
  deps: { dependsOn: string[]; blockedBy: Blocker[] } = { dependsOn: [], blockedBy: [] },
  waitingOn: TicketOverlapWait | null = null,
): Ticket => ({
  id: row.id,
  projectId: row.projectId,
  key: row.key,
  title: row.title,
  body: row.body,
  status: row.status as TicketStatus,
  priority: row.priority,
  persona: (row.persona as AgentPersona) ?? 'coder',
  position: row.position,
  depth: row.depth,
  dependsOn: deps.dependsOn,
  blockedBy: deps.blockedBy,
  completion: row.completion ?? null,
  external:
    row.externalSource && row.externalNumber !== null && row.externalUrl !== null
      ? {
          source: row.externalSource,
          number: row.externalNumber,
          url: row.externalUrl,
          state: row.externalState ?? 'open',
          labels: row.externalLabels ?? [],
          triage: row.externalTriage,
        }
      : null,
  waitingOn,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Settings key of a project's last ticket number. Only grows, so a deleted ticket's key is never
 * given to a new ticket (runs and dependencies name tickets by key).
 */
const ticketSeqKey = (projectId: string) => `tickets.seq.${projectId}`;

/** Ticket key prefix from the project slug: initials of the words ("demo-project" -> "DP"), else 3 letters. */
export function keyPrefix(slug: string): string {
  const words = slug.split('-').filter((w) => /^[a-z]/.test(w));
  const prefix = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  return (prefix.slice(0, 4) || 'T').toUpperCase();
}

/** The task prompt handed to the agent when a ticket starts. */
export function ticketPrompt(ticket: Pick<Ticket, 'key' | 'title' | 'body'>): string {
  const body = ticket.body.trim();
  return body ? `${ticket.key}: ${ticket.title}\n\n${body}` : `${ticket.key}: ${ticket.title}`;
}

export { statusForRunState } from './columns.js';

/**
 * Board tickets. Starting a ticket creates a run on its own branch; afterwards the ticket's
 * column follows the run (working -> In progress, turn finished -> Review) unless the user
 * already moved it to Done.
 */
/** CreateTicketBody's body limit. */
const TICKET_BODY_MAX = 20_000;

/**
 * Closes every gate re-prompt to a run whose agent has the tool: the earlier completion signal no
 * longer counts once the person or a gate spoke.
 */
const COMPLETE_AGAIN = 'When finished, call `ticket_complete` again.';

/** The one automatic prompt to a run that stopped without its completion signal. */
export const COMPLETION_NUDGE =
  'You stopped without calling `ticket_complete`. If the ticket is finished, call it now with a summary and handoff. If something blocks you, call it with `blockers`. If you need an answer from a person, ask the question plainly and stop.';

export { CONFLICT_ATTEMPT_CAP } from './conflict-ladder.js';

/** Holds a gate notes with an automatic request for the agent's fix (`autoFix: true`, the request in `request`). */
const FIX_REQUEST_HOLDS: readonly string[] = [
  'build_gate_failed',
  'secret_guard_blocked',
  'slop_guard_blocked',
  'critic_blocked',
];

/** A fix request kept with its hold: at most this many characters (about 64 KB), marked when cut. */
const FIX_REQUEST_MAX = 64 * 1024;
const FIX_REQUEST_CUT = '\n\n[The rest of this request was cut: it was longer than 64 KB.]';
const storedRequest = (text: string): string =>
  text.length <= FIX_REQUEST_MAX
    ? text
    : `${clipCodeUnits(text, FIX_REQUEST_MAX - FIX_REQUEST_CUT.length)}${FIX_REQUEST_CUT}`;

/** Events by which a prompt reached the agent (typed into its session, or a respawn with it). */
const PROMPT_DELIVERED = ['prompt_sent', 'resumed', 'respawning'];

/** A fix request a gate noted but never sent (a restart cut its pass off in between). */
interface PendingFixRequest {
  /** The hold it was noted with (`completion_nudged` for the completion nudge). */
  type: string;
  /** That note's payload without `autoFix` and `request`. */
  note: Record<string, unknown>;
  request: string;
}

export class TicketService extends EventEmitter<TicketServiceEvents> {
  /** Projects whose factory chain is on; a cache of {@link ACTIVE_CHAINS_KEY}, written through. */
  private readonly autoChainProjects: Set<string>;
  /**
   * One pipeline pass per run at a time: the pass going (and those queued behind it) per run; a later
   * stop's pass waits for it. A pass with none ahead of it starts at once.
   */
  private readonly pipelineTails = new Map<string, Promise<void>>();
  private readonly dispatchLock = new KeyedMutex();
  /** Tickets whose start() is between its active-run check and the run being recorded. */
  private readonly startingTickets = new Set<string>();
  /** Runs whose completion pipeline (gates, merge, move to Done) is in progress, with the number of passes. */
  private readonly pipelineRuns = new Map<string, number>();
  /** Runs whose cut-off pipeline a dispatch already ran again in this process (once each). */
  private readonly resumedPipelines = new Set<string>();
  /** Per chaining project: ticket runs that failed since a ticket last moved to Done. */
  private readonly failedInARow = new Map<string, number>();
  /** Finished runs waiting out the settle window before their pipeline (R8). */
  private readonly settlingRuns = new Map<string, NodeJS.Timeout>();
  private readonly pipelineSettleMs: number;
  /** Files each busy run's branch changed, cached per branch tip (overlap-aware dispatch). */
  private readonly branchFootprints = new BranchFootprints();
  /** Per project: ready tickets a dispatch deferred for overlap -> the ticket they wait for. */
  private readonly overlapDeferred = new Map<string, Map<string, string>>();
  /**
   * After an upgrade from a version that kept no pipeline marks: the runs whose checks the upgrade's
   * restart may have cut off, with their state time. The first start of this version takes them
   * when this service starts (before any run of that start finishes or a dispatch turns a chain
   * off) and stores them; a later start reads them back until one held them (resumeChains). Empty
   * otherwise.
   */
  private readonly upgradeCandidates: UpgradeCandidate[];

  /** Layer 3 of M5: who resolves a conflicting merge (the run's session, a resolver run, a person). */
  readonly conflictLadder: ConflictLadder;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly scheduler: Scheduler,
    options: Partial<TicketServiceOptions> = {},
  ) {
    super();
    this.setMaxListeners(0);
    this.pipelineSettleMs = options.pipelineSettleMs ?? PIPELINE_SETTLE_MS;
    this.autoChainProjects = this.loadActiveChains();
    this.conflictLadder = new ConflictLadder({
      db,
      runs,
      scheduler,
      completionReminder: (run, separator) => this.completionReminder(run, separator),
    });
    this.upgradeCandidates = this.takeUpgradeCandidates();
    // A finished ticket's worktree previews are not needed any more: their stacks go, ports freed.
    this.on('moved', (ticket: Ticket) => {
      if (ticket.status === 'done') void runs.teardownTicketPreviews(ticket.id);
    });
    runs.on('run', (run, stateChanged) => {
      // A handed-off run stopped for quota and a successor continues its work; it finished nothing.
      if (run.handedOffTo) return;
      if (run.ticketId && stateChanged) this.followRun(run.ticketId, run.state);
      if (
        stateChanged &&
        run.state === 'waiting_input' &&
        run.lastEvent === 'Notification' &&
        run.projectId &&
        this.autoChainProjects.has(run.projectId) &&
        !this.runs.hasEvent(run.id, 'auto_nudged')
      ) {
        this.runs.note(run.id, 'auto_nudged', { reason: 'permission_prompt' });
        void this.runs
          .sendPrompt(
            run.id,
            'Autonomous Factory Mode: Proceed automatically using the simplest self-contained local option that satisfies PROJECT.md. Do not wait for user confirmation.',
            { automatic: true },
          )
          .catch(() => undefined);
      }
      if (stateChanged && run.state === 'done' && run.projectId) this.completeRunWhenSettled(run);
      if (
        stateChanged &&
        run.state === 'failed' &&
        run.projectId &&
        run.ticketId &&
        !run.cancelled &&
        this.autoChainProjects.has(run.projectId)
      ) {
        this.ticketRunFailed(run, run.projectId);
      }
      // After the settle wait above was set: a finished turn still counts until merged or held.
      if (stateChanged && run.projectId && !this.busyForOverlap(run)) this.releaseOverlapWaits(run.projectId);
    });
    // A prompt typed into the agent's session that it has not answered yet: the ticket is worked on
    // again. One the CLI took and finished before it was recorded changed the state, which decided.
    runs.on('prompted', (run) => {
      if (!run.handedOffTo && run.ticketId && !run.cancelled) this.followRun(run.ticketId, 'working');
    });
    // RunService stored the agent's completion on the ticket: show it on the Board right away.
    runs.on('note', (run, type) => {
      // The hold is over: a dispatch may run the pipeline of this run again.
      if (type === 'review_unblocked') this.resumedPipelines.delete(run.id);
      if (type !== 'ticket_complete' || !run.ticketId) return;
      const row = this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get();
      if (row) this.publish(row);
    });
  }

  /** Drops pending settle timers (shutdown, tests). */
  dispose(): void {
    for (const timer of this.settlingRuns.values()) clearTimeout(timer);
    for (const id of this.settlingRuns.keys()) this.runs.pipelineBusy(id, false);
    this.settlingRuns.clear();
  }

  /**
   * Runs the completion pipeline once the run has stayed `done` for the settle window (R8). The
   * ticket already moved to Review; only gates and merge wait. A newer `done` of the same run
   * replaces the wait, so one finished turn gets at most one pass. A run whose process is gone
   * cannot wake up again and goes straight on.
   */
  private completeRunWhenSettled(run: Run): void {
    this.stopSettling(run.id);
    this.markPipelinePending(run.id);
    if (this.pipelineSettleMs <= 0 || run.endedAt) {
      this.completeRun(run);
      return;
    }
    const timer = setTimeout(() => {
      if (this.settlingRuns.get(run.id) !== timer) return;
      // The pass below marks the run busy itself before this wait is released.
      try {
        let fresh: Run;
        try {
          fresh = this.runs.getRun(run.id);
        } catch {
          return; // removed meanwhile
        }
        // Woke up again (its next Stop starts a new wait), or finished differently in the meantime.
        if (fresh.state !== 'done' || fresh.stateChangedAt !== run.stateChangedAt || fresh.handedOffTo)
          return;
        this.completeRun(fresh);
      } finally {
        this.stopSettling(run.id);
      }
    }, this.pipelineSettleMs);
    timer.unref();
    this.settlingRuns.set(run.id, timer);
    // Busy from the moment the wait starts, so the idle sweep cannot close the session before the pass.
    this.runs.pipelineBusy(run.id, true);
  }

  /** Ends a pending settle wait, if any, and lifts its busy mark. */
  private stopSettling(runId: string): void {
    const timer = this.settlingRuns.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.settlingRuns.delete(runId);
    this.runs.pipelineBusy(runId, false);
    this.releasePipelinePending(runId);
  }

  /**
   * The runs whose pipeline is due or going, with the mode of their latest pass (`finalizing`: a
   * dispatch's), as stored (see {@link PENDING_PIPELINES_KEY}).
   */
  private pendingPipelineRuns(): Map<string, PendingPipeline> {
    const value = getSetting<unknown>(this.db, PENDING_PIPELINES_KEY);
    const pending = new Map<string, PendingPipeline>();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [runId, mode] of Object.entries(value as Record<string, unknown>)) {
        pending.set(runId, { finalizing: (mode as PendingPipeline | null)?.finalizing === true });
      }
    }
    return pending;
  }

  private savePendingPipelines(pending: Map<string, PendingPipeline>): void {
    setSetting(this.db, PENDING_PIPELINES_KEY, Object.fromEntries(pending));
  }

  /** Marks the run's pipeline as due, in the mode of the pass about to run (a resumed one keeps it). */
  private markPipelinePending(runId: string, { finalizing = false }: PipelineOptions = {}): void {
    const pending = this.pendingPipelineRuns();
    if (pending.get(runId)?.finalizing === finalizing) return;
    pending.set(runId, { finalizing });
    this.savePendingPipelines(pending);
  }

  /** Clears the run's mark unless a settle wait or a pass of it still goes on. */
  private releasePipelinePending(runId: string): void {
    if (this.settlingRuns.has(runId) || this.pipelineRuns.has(runId)) return;
    const pending = this.pendingPipelineRuns();
    if (!pending.delete(runId)) return;
    this.savePendingPipelines(pending);
  }

  /** Runs the completion pipeline in the background; it is best effort per run. */
  private completeRun(run: Run, opts: PipelineOptions = {}): void {
    this.markPipelinePending(run.id, opts);
    this.handleRunCompleted(run, opts).catch((error: unknown) => {
      // Record why it stopped instead of crashing core.
      this.runs.note(run.id, 'pipeline_failed', { message: (error as Error).message?.slice(0, 500) });
    });
  }

  /**
   * A ticket run of a chaining project crashed (a person's stop is not a crash). It frees its slot:
   * the chain goes on with the other tickets, the failed one stays where it is. Unless the failures
   * look systematic (two in a row without a ticket reaching Done, or a run that never got to work,
   * e.g. a CLI that does not start): then the chain pauses instead of burning through the queue.
   */
  private ticketRunFailed(run: Run, projectId: string): void {
    // A lost session (ptyd or core restarted underneath the run) says nothing about the tickets.
    if (!this.sessionLost(run.id)) {
      if (this.countFailure(run, projectId)) return;
    }
    if (getFactorySettings(this.db).autoPickupReady) {
      void this.dispatchNextReadyTicket(projectId).catch(() => undefined);
    }
  }

  /** Counts a real failure; returns true when it paused the chain. */
  private countFailure(run: Run, projectId: string): boolean {
    const inARow = (this.failedInARow.get(projectId) ?? 0) + 1;
    this.failedInARow.set(projectId, inARow);
    const neverWorked = !this.reachedWork(run.id);
    if (inARow >= 2 || neverWorked) {
      this.failedInARow.delete(projectId);
      this.chainOff(projectId);
      this.runs.note(run.id, 'factory_chain_paused', {
        reason: neverWorked ? 'failed_before_working' : 'failed_in_a_row',
        message: neverWorked
          ? 'A ticket run failed before it got to work; the factory paused — fix the cause and click Run pipeline'
          : `${inARow} ticket runs failed in a row; the factory paused — fix the cause and click Run pipeline`,
      });
      return true;
    }
    return false;
  }

  /** Whether the run ended because its session was gone (a ptyd or core restart), not because it crashed. */
  private sessionLost(runId: string): boolean {
    return Boolean(
      this.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'session_lost')))
        .limit(1)
        .get(),
    );
  }

  /** Whether the run ever got to work (or further) before it ended. */
  private reachedWork(runId: string): boolean {
    return Boolean(
      this.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(
          and(eq(runEvents.runId, runId), inArray(runEvents.state, ['working', 'waiting_input', 'done'])),
        )
        .limit(1)
        .get(),
    );
  }

  private loadActiveChains(): Set<string> {
    const value = getSetting<unknown>(this.db, ACTIVE_CHAINS_KEY);
    if (value === undefined) return this.seedActiveChains();
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  }

  /**
   * The first start of a version that remembers chains (an upgrade from 0.1.3, which kept them in
   * memory): a project with a factory ticket and a ticket dispatch could start is taken as chaining,
   * so the factory carries on after the upgrade. Written at once, so later starts never seed again.
   */
  private seedActiveChains(): Set<string> {
    const seeded = new Set<string>();
    const fSettings = getFactorySettings(this.db);
    if (fSettings.autoPickupReady) {
      const startable = new Set<TicketStatus>(fSettings.autoPickupBacklog ? ['ready', 'backlog'] : ['ready']);
      for (const { id } of this.db.select({ id: projects.id }).from(projects).all()) {
        const list = this.list(id);
        if (
          list.some((t) => t.title.startsWith('[Factory]')) &&
          list.some((t) => startable.has(t.status) && t.blockedBy.length === 0 && !t.external?.triage)
        ) {
          seeded.add(id);
        }
      }
    }
    setSetting(this.db, ACTIVE_CHAINS_KEY, [...seeded]);
    return seeded;
  }

  /** A Bootstrap or Deploy ticket of a wizard project whose [Factory] ticket still exists and is not done: the factory plans. */
  private leftToFactory(projectId: string, ticketId: string | undefined): boolean {
    const roles = readWizardTickets(this.db, projectId);
    if (!roles?.factory || !ticketId || (ticketId !== roles.bootstrap && ticketId !== roles.deploy))
      return false;
    const factory = this.db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, roles.factory))
      .get();
    return factory !== undefined && factory.status !== 'done';
  }

  private chainOn(projectId: string): void {
    if (this.autoChainProjects.has(projectId)) return;
    this.autoChainProjects.add(projectId);
    this.saveActiveChains();
  }

  private chainOff(projectId: string): void {
    if (!this.autoChainProjects.delete(projectId)) return;
    this.saveActiveChains();
  }

  private saveActiveChains(): void {
    setSetting(this.db, ACTIVE_CHAINS_KEY, [...this.autoChainProjects]);
  }

  /**
   * After a core restart: runs again, in every project (a hand-started run's too, with the chain on
   * or off), the pipelines the restart cut off, then dispatches every project whose chain was on, so
   * the factory carries on without a person pressing "Run pipeline".
   */
  async resumeChains(): Promise<void> {
    const known = new Set(
      this.db
        .select({ id: projects.id })
        .from(projects)
        .all()
        .map((p) => p.id),
    );
    // After an upgrade from a version that kept no pipeline marks (0.6.0 or earlier): a pass the
    // upgrade's restart cut off cannot be told from one that ended. Its ticket is held for a person
    // instead of being merged without its checks or left unseen; noted as done only once held.
    if (this.upgradeCandidates.length > 0) {
      this.holdUpgradeCandidates();
      setSetting(this.db, UPGRADE_HOLDS_KEY, 'done');
    }
    // Only passes that were due or going when core stopped: one that ended decided already (a run
    // that was no factory step stays in Review for its person, whatever the board shows now). Not as
    // `finalizing`: each pass decides as the cut-off one would have whether the run is a factory step.
    const cutOff = this.pendingPipelineRuns();
    for (const projectId of known) this.finalizeLeftoverReviews(projectId, { cutOff });
    this.resumeTicketlessPasses(cutOff);
    // A cut-off pass not taken up (its run is gone, or its ticket left Review) is dropped.
    for (const runId of cutOff.keys()) this.releasePipelinePending(runId);
    if (!getFactorySettings(this.db).autoPickupReady) return;
    const resumed: Promise<unknown>[] = [];
    for (const projectId of [...this.autoChainProjects]) {
      if (known.has(projectId)) resumed.push(this.dispatchNextReadyTicket(projectId).catch(() => undefined));
      else this.chainOff(projectId);
    }
    await Promise.all(resumed);
  }

  /**
   * The upgrade from a version that kept no pipeline marks (see UPGRADE_HOLDS_KEY): decided on the
   * first start of this version, by the marks not existing yet. That start takes the Review tickets
   * of chaining projects (with auto-merge or auto-Done on) whose latest run finished and whose pass
   * left no outcome: their checks may have been cut off by the upgrade's restart. They are stored, so
   * a start that never got to hold them leaves the same ones to the next start, whatever changed in
   * between. With none to hold, the upgrade is noted as done at once.
   */
  private takeUpgradeCandidates(): UpgradeCandidate[] {
    const state = getSetting<unknown>(this.db, UPGRADE_HOLDS_KEY);
    if (state === 'done') return [];
    const stored = (state as { pending?: unknown } | undefined)?.pending;
    if (Array.isArray(stored)) {
      const candidates = stored.filter(
        (c): c is UpgradeCandidate =>
          typeof (c as UpgradeCandidate | null)?.id === 'string' &&
          typeof (c as UpgradeCandidate).stateChangedAt === 'string',
      );
      // Nothing usable is left to hold: done, so no later start reads the list again.
      if (candidates.length === 0) setSetting(this.db, UPGRADE_HOLDS_KEY, 'done');
      return candidates;
    }
    if (getSetting<unknown>(this.db, PENDING_PIPELINES_KEY) !== undefined) {
      setSetting(this.db, UPGRADE_HOLDS_KEY, 'done');
      return [];
    }
    const candidates: UpgradeCandidate[] = [];
    for (const projectId of this.autoChainProjects) {
      const { autoSyncToMain, autoMoveToDone } = effectiveFactorySettings(this.db, projectId);
      // With neither, a pass that ended leaves its ticket in Review without an outcome too.
      if (!autoSyncToMain && !autoMoveToDone) continue;
      let reviewTickets: Ticket[];
      try {
        reviewTickets = this.list(projectId).filter((t) => t.status === 'review');
      } catch {
        continue; // the project is gone
      }
      for (const reviewTicket of reviewTickets) {
        const run = this.runs.latestRunForTicket(reviewTicket.id);
        if (run && this.mayBeCutOff(run)) candidates.push({ id: run.id, stateChangedAt: run.stateChangedAt });
      }
    }
    setSetting(this.db, UPGRADE_HOLDS_KEY, candidates.length > 0 ? { pending: candidates } : 'done');
    return candidates;
  }

  /** A finished run whose pass left no outcome and that is not resolving a conflict. */
  private mayBeCutOff(run: Run): boolean {
    if (run.state !== 'done' || run.handedOffTo) return false;
    if (this.pipelineOutcome(run.id) !== null) return false;
    // A run still resolving its conflict is finished by its own pipeline when it stops again.
    return !(!run.endedAt && this.conflictLadder.requested(run.id));
  }

  /**
   * Holds each upgrade candidate still in that state, whatever its project's chain does meanwhile: a
   * `pipeline_interrupted` hold shows it in the Inbox, and the agent's next stop runs its checks
   * again. One that worked or finished again since it was taken (its own pass decides) is not.
   */
  private holdUpgradeCandidates(): void {
    const marked = this.pendingPipelineRuns();
    for (const candidate of this.upgradeCandidates) {
      let run: Run;
      try {
        run = this.runs.getRun(candidate.id);
      } catch {
        continue; // removed meanwhile
      }
      if (run.stateChangedAt !== candidate.stateChangedAt) continue;
      const ticket = run.ticketId
        ? this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get()
        : undefined;
      if (ticket?.status !== 'review' || this.runs.latestRunForTicket(ticket.id)?.id !== run.id) continue;
      if (this.pipelineRuns.has(run.id) || this.settlingRuns.has(run.id) || marked.has(run.id)) continue;
      if (!this.mayBeCutOff(run)) continue;
      this.runs.note(run.id, 'pipeline_interrupted', {});
    }
  }

  /**
   * Cut-off passes of runs without a ticket (a run that only reads a tickets file, or one a
   * factory pipeline gates and merges): run again, `resumed`, like a ticket run's. One whose pass
   * decided already (held, or merged) is left as it is; each run at most once per process.
   */
  private resumeTicketlessPasses(cutOff: Map<string, PendingPipeline>): void {
    for (const [runId, mode] of cutOff) {
      let run: Run;
      try {
        run = this.runs.getRun(runId);
      } catch {
        continue; // removed meanwhile
      }
      if (
        run.ticketId ||
        run.state !== 'done' ||
        run.handedOffTo ||
        this.pipelineRuns.has(run.id) ||
        this.settlingRuns.has(run.id) ||
        this.resumedPipelines.has(run.id)
      )
        continue;
      if (!run.endedAt && this.conflictLadder.requested(run.id)) continue;
      const outcome = this.pipelineOutcome(run.id);
      if (outcome === 'merged') continue;
      if (outcome === 'held' && this.pendingFixRequest(run) === null) continue;
      this.resumedPipelines.add(run.id);
      this.completeRun(run, { finalizing: mode.finalizing, resumed: true });
    }
  }

  /**
   * Review tickets whose latest run finished and whose completion pipeline is still owed:
   * - `cutOff` (runs marked in {@link PENDING_PIPELINES_KEY}): a pass that a restart cut off (core went
   *   down mid-way, or inside the settle window). The pipeline runs again, `resumed`, so its gates
   *   apply instead of a merge behind them; one that merged but was cut off before Done moves there
   *   (when tickets move to Done by themselves).
   * - with `liftedHolds`: also a run whose review hold a person lifted since its pass (a dispatch
   *   runs its pipeline again, once per unblock).
   * A run whose pass ended without either is never re-judged: its pass decided (e.g. no factory
   * step, so it stays in Review for its person), whatever the board shows now. Each run at most once
   * per process (an unblock allows one more); the pipelines are not awaited, since a dispatch they
   * start waits for the one calling this.
   */
  private finalizeLeftoverReviews(
    projectId: string,
    {
      finalizing,
      cutOff,
      liftedHolds = false,
    }: { finalizing?: boolean; cutOff: Map<string, PendingPipeline>; liftedHolds?: boolean },
  ): void {
    const { autoMoveToDone } = getFactorySettings(this.db);
    for (const reviewTicket of this.list(projectId).filter((t) => t.status === 'review')) {
      const latestRun = this.runs.latestRunForTicket(reviewTicket.id);
      const wasCutOff = latestRun !== undefined && cutOff.has(latestRun.id);
      // A run whose own pipeline is still going (gates, merge) or waiting to settle is not left over.
      if (
        !latestRun ||
        !(wasCutOff || (liftedHolds && reviewHoldLiftedIsCurrent(this.db, latestRun.id))) ||
        latestRun.state !== 'done' ||
        latestRun.handedOffTo ||
        this.pipelineRuns.has(latestRun.id) ||
        this.settlingRuns.has(latestRun.id)
      ) {
        continue;
      }
      // A run still resolving its conflict is finished by its own pipeline when it stops again.
      if (!latestRun.endedAt && this.conflictLadder.requested(latestRun.id)) continue;
      const outcome = this.pipelineOutcome(latestRun.id);
      // A gate left it here for a person (secret guard, build gate, a merge that failed): not
      // leftover work, and not a merge to retry on every dispatch. Unless the restart cut the pass off
      // between a gate's hold and its request to the agent: the resumed pass sends it.
      if (outcome === 'held' && !(wasCutOff && this.pendingFixRequest(latestRun) !== null)) continue;
      if (outcome === 'merged') {
        // Merged, but the move to Done was cut off.
        if (!autoMoveToDone) continue;
        try {
          this.moveToTop(reviewTicket.id, 'done');
        } catch {
          // ignore
        }
        continue;
      }
      if (this.resumedPipelines.has(latestRun.id)) continue;
      this.resumedPipelines.add(latestRun.id);
      // A resumed pass runs in the mode it was cut off in (a dispatch's rerun after an unblock is `finalizing`).
      this.completeRun(latestRun, {
        finalizing: finalizing || cutOff.get(latestRun.id)?.finalizing === true,
        resumed: wasCutOff,
      });
    }
  }

  /** Tells the project's viewers that an agent file was ignored, and why. */
  noticeProject(projectId: string, rejection: AgentFileRejection): void {
    this.emit('notice', {
      kind: 'agent_file_rejected',
      projectId,
      ...rejection,
      at: new Date().toISOString(),
    });
  }

  factorySettings(): FactorySettings {
    return getFactorySettings(this.db);
  }

  isAutoChainActive(projectId: string): boolean {
    return this.autoChainProjects.has(projectId);
  }

  /** Drops what is kept per project outside its rows (its ticket number sequence) once it is deleted. */
  forgetProject(projectId: string): void {
    this.chainOff(projectId);
    this.db
      .delete(settings)
      .where(eq(settings.key, ticketSeqKey(projectId)))
      .run();
  }

  setAutoChain(projectId: string, enabled: boolean): void {
    if (enabled) this.chainOn(projectId);
    else this.chainOff(projectId);
  }

  /** The `[Factory]` ticket for a request (ready, not started); `submitFactoryRequest` and the wizard share it. */
  createFactoryTicket(
    projectId: string,
    prompt: string,
    opts: {
      autoDispatch?: boolean;
      attachmentContext?: string;
      leadPersona?: AgentPersona;
      body?: string;
    } = {},
  ): Ticket {
    return this.create(projectId, {
      title: factoryTicketTitle(prompt),
      body:
        opts.body ??
        buildFactoryOrchestratorPrompt(
          prompt,
          opts.autoDispatch ?? true,
          opts.attachmentContext ?? '',
          getFactorySettings(this.db).maxParallelTicketsPerProject,
        ),
      persona: opts.leadPersona ?? 'product_owner',
      priority: 3,
      status: 'ready',
    });
  }

  /**
   * Whether the run was already asked to fix this check (the autoFix note survives restarts). The
   * build gate's note names no check; neither did the worktree.yml and worktree-commands ones before
   * 0.5.0, so those are told apart by their text (worktreeCheckOf).
   */
  /**
   * The PO nudge noted in the run's current turn (after its latest switch to `done`), and whether a
   * prompt reached the agent after it; null when this turn has none.
   */
  private nudgeOfThisTurn(runId: string): { delivered: boolean } | null {
    const events = this.eventsOfThisTurn(runId, ['auto_nudged']);
    const nudged = events.find(
      (e) =>
        e.type === 'auto_nudged' && (e.payload as { reason?: string } | null)?.reason === 'no_ticket_drafts',
    );
    if (!nudged) return null;
    return { delivered: events.some((e) => e.id > nudged.id && PROMPT_DELIVERED.includes(e.type)) };
  }

  /**
   * The agent's latest turn of the run: the id of its latest switch to `working` or `done`. A pass is
   * for the turn current when it was asked for; a newer one means the agent worked again since. A
   * switch to another state (a relaunched CLI waiting at its prompt, a quota wait) is no new work.
   */
  private turnOf(runId: string): number | undefined {
    return this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), inArray(runEvents.state, ['working', 'done'])))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get()?.id;
  }

  /** Whether `turn` (a pass's) is still the agent's latest turn of the run (see turnOf). */
  private turnIsCurrent(runId: string, turn: number | undefined): boolean {
    return this.turnOf(runId) === turn;
  }

  /**
   * The run's notes of `types` in its current turn (after its latest switch to `done`), with the
   * events by which a prompt reached the agent (PROMPT_DELIVERED), oldest first.
   */
  private eventsOfThisTurn(
    runId: string,
    types: readonly string[],
  ): Array<{ id: number; type: string; payload: unknown }> {
    return this.db
      .select({ id: runEvents.id, type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          gt(runEvents.id, latestDoneEventId(this.db, runId) ?? 0),
          inArray(runEvents.type, [...types, ...PROMPT_DELIVERED]),
        ),
      )
      .orderBy(asc(runEvents.id))
      .all();
  }

  /**
   * The request for the agent's fix that the run's current turn (after its latest `done`) noted but
   * never sent: its newest hold is a gate's fix request (or the completion nudge) and no prompt
   * reached the agent after it. Null otherwise. A note written before the request was stored with it
   * gets it rebuilt from the note. A request is sent at least once: a crash between typing it and
   * recording `prompt_sent` leaves it looking unsent, and the resumed pass types it again.
   */
  private pendingFixRequest(run: Run): PendingFixRequest | null {
    const events = this.eventsOfThisTurn(run.id, HOLD_EVENTS);
    const hold = events.findLast((e) => HOLD_EVENTS.includes(e.type));
    if (!hold || events.some((e) => e.id > hold.id && PROMPT_DELIVERED.includes(e.type))) return null;
    if (hold.type === 'completion_nudged') return { type: hold.type, note: {}, request: COMPLETION_NUDGE };
    if (!FIX_REQUEST_HOLDS.includes(hold.type) || !isAutoFixHold(hold.payload)) return null;
    const { autoFix: _autoFix, request, ...note } = hold.payload as Record<string, unknown>;
    const text =
      typeof request === 'string' && request !== '' ? request : this.rebuiltFixRequest(run, hold.type, note);
    return text === null ? null : { type: hold.type, note, request: text };
  }

  /** The request of a fix-request hold noted without it (before 0.6.1), from what the note kept. */
  private rebuiltFixRequest(run: Run, type: string, note: Record<string, unknown>): string | null {
    const field = (key: string) => (typeof note[key] === 'string' && note[key] !== '' ? note[key] : null);
    if (type === 'critic_blocked' || type === 'secret_guard_blocked' || type === 'slop_guard_blocked') {
      const text = field(type === 'critic_blocked' ? 'followUpPrompt' : 'autoFixPrompt');
      return text === null ? null : `${text}${this.completionReminder(run, '\n\n')}`;
    }
    if (type !== 'build_gate_failed') return null;
    const text = buildGateRequest(fixCheckOf(note), field('output') ?? '');
    return `${text}${this.completionReminder(run, ' ')}`;
  }

  /**
   * Holds the run for the agent's fix and asks for it: the hold is noted first, with the whole
   * request (should a restart cut the pass off before it went out, the resumed pass sends it), so an
   * undelivered request never lets a later dispatch merge. Should it not arrive, the hold is noted
   * again for a person (`autoFix: false`). Whether it arrived.
   */
  private async requestFix(
    run: Run,
    type: string,
    note: Record<string, unknown>,
    request: string,
  ): Promise<boolean> {
    this.runs.note(run.id, type, { autoFix: true, ...note, request: storedRequest(request) });
    return this.sendFixRequest(run, { type, note, request });
  }

  /** Sends a fix request; should it not arrive, notes the hold again for a person. Whether it arrived. */
  private sendFixRequest(run: Run, { type, note, request }: PendingFixRequest): Promise<boolean> {
    return this.runs.prompt(run.id, request, { automatic: true }).then(
      () => true,
      () => {
        if (type === 'completion_nudged') this.runs.note(run.id, 'completion_missing', {});
        else this.runs.note(run.id, type, { autoFix: false, ...note });
        return false;
      },
    );
  }

  /**
   * The pass a restart cut off between a gate's hold and its request: everything before was done,
   * so the request is sent now, as that pass would have. Undelivered, the hold is a person's, and a
   * worktree config check hands it over as its own pass does.
   */
  private async resumeFixRequest(run: Run, pending: PendingFixRequest): Promise<void> {
    if (await this.sendFixRequest(run, pending)) return;
    if (pending.type === 'build_gate_failed' && fixCheckOf(pending.note) !== 'build') {
      await this.closeAndGoOn(run);
    }
  }

  /** A hold for a person: the run's session is closed (it stays resumable) and the chain goes on. */
  private async closeAndGoOn(run: Run): Promise<void> {
    if (!run.endedAt) await this.runs.closeHeldSession(run.id).catch(() => undefined);
    if (
      this.autoChainProjects.has(run.projectId) &&
      effectiveFactorySettings(this.db, run.projectId).autoPickupReady
    ) {
      await this.dispatchNextReadyTicket(run.projectId).catch(() => undefined);
    }
  }

  /**
   * High-level AI Coding Factory request: creates a Lead Persona (e.g. Product Owner) ticket
   * that refines the user's request, writes `.emberline/new-tickets.json` for specialist personas
   * (`coder`, `ui_ux`, `dba`, `qa`), and chains them automatically.
   */
  async submitFactoryRequest(projectId: string, input: FactoryRequestBody): Promise<FactoryRequestResponse> {
    const projectRow = this.project(projectId);
    const body = FactoryRequestBodySchema.parse(input);
    // Refused before anything is written (attachments, ticket, auto-chain). The lead run's route tag
    // comes from the ticket body, the text generated around the request (which may carry a tag too).
    const maxParallel = getFactorySettings(this.db).maxParallelTicketsPerProject;
    const leadBody = (attachments: string) =>
      buildFactoryOrchestratorPrompt(body.prompt, body.autoDispatch, attachments, maxParallel);
    const tag = parseRouteTag(leadBody(''));
    this.runs.assertStartable({
      projectId,
      prompt: body.prompt,
      permissionMode: body.permissionMode,
      persona: body.leadPersona,
      ...(tag ? { agent: tag.agent as AgentId, model: tag.model as AgentModelId } : {}),
    });
    const attachmentContext =
      body.attachments && body.attachments.length > 0
        ? await persistFactoryAttachments(projectRow.path, body.attachments)
        : '';
    const ticket = this.createFactoryTicket(projectId, body.prompt, {
      autoDispatch: body.autoDispatch,
      attachmentContext,
      leadPersona: body.leadPersona,
      body: leadBody(attachmentContext),
    });
    if (body.autoDispatch) {
      this.chainOn(projectId);
    }
    return this.start(ticket.id, {
      permissionMode: body.permissionMode,
      persona: body.leadPersona,
    });
  }

  /**
   * Starts or returns an active single-flight AI Brainstorming run for `projectId`
   * WITHOUT creating a Kanban ticket or triggering `.emberline/new-tickets.json` creation.
   */
  async startBrainstormRun(
    projectId: string,
    opts: { prompt: string; persona?: AgentPersona },
  ): Promise<Run> {
    this.project(projectId);
    const existing = this.runs
      .list()
      .find(
        (r) =>
          r.projectId === projectId &&
          !r.endedAt &&
          r.state !== 'done' &&
          r.state !== 'failed' &&
          Boolean(r.title?.includes('[Brainstorm]')),
      );
    if (existing) {
      return existing;
    }

    return this.scheduler.submit(
      {
        projectId,
        persona: opts.persona ?? 'product_owner',
        model: 'fable',
        prompt: opts.prompt,
        permissionMode: 'auto',
      },
      {
        title: '[Brainstorm] Feature & Roadmap Ideation',
      },
    );
  }

  /**
   * Creates 1..N specialist tickets delegated through `POST /api/projects/:id/delegate-tickets`,
   * orders them like an ingested drafts file (refs/dependsOn, else the default tiers) and
   * optionally starts the dependency-aware dispatch.
   */
  async createDelegatedTickets(projectId: string, payload: AgentCreateTicketsPayload): Promise<Ticket[]> {
    this.project(projectId);
    const parsed = AgentCreateTicketsPayloadSchema.parse(payload);
    const created: { draft: (typeof parsed.tickets)[number]; ticket: Ticket }[] = [];
    for (const draft of parsed.tickets) {
      let body = draft.body ?? '';
      if ((draft.preferredAgent || draft.preferredModel) && !body.includes('[Preferred Agent:')) {
        const agentStr = draft.preferredAgent ?? 'claude';
        const modelStr = draft.preferredModel ?? 'auto';
        body = `${body}\n\n[Preferred Agent: ${agentStr} · Model: ${modelStr}]`.trim();
      }
      created.push({
        draft,
        ticket: this.create(projectId, {
          title: draft.title,
          body,
          persona: draft.persona,
          priority: draft.priority,
          status: 'ready',
        }),
      });
    }
    // No run to note the outcome on: the response's dependsOn/blockedBy show it.
    this.applyDraftDependencies(null, projectId, created);
    if (parsed.autoDispatch && created.length > 0) {
      this.chainOn(projectId);
      await this.dispatchNextReadyTicket(projectId);
    }
    return created.map(({ ticket }) => this.find(ticket.id) ?? ticket);
  }

  /**
   * Starts every unblocked `ready` (then `backlog`, when `autoPickupBacklog` is enabled) ticket of
   * `projectId`, highest priority first, until the project has `maxParallelTicketsPerProject`
   * ticket runs active. Returns what it started (empty when nothing).
   *
   * Internal option: `only` limits the candidates to those tickets and skips finalizing Review
   * tickets; `chain: false` leaves the project's auto-chain as it is (a person's board change must
   * not turn the factory on).
   */
  dispatchNextReadyTicket(
    projectId: string,
    opts: DispatchOptions = {},
  ): Promise<{ ticket: Ticket; run: Run }[]> {
    // Check-then-start spans several awaits; two completions (or a click) must not both dispatch.
    return this.dispatchLock.run(projectId, () => this.dispatchNextReadyTicketUnlocked(projectId, opts));
  }

  /**
   * `ticketIds` may have just lost their last blocker through a person's change: a chaining project
   * dispatches its queue, any other project starts only those tickets.
   */
  private dispatchUnblocked(projectId: string, ticketIds: string[]): void {
    if (!getFactorySettings(this.db).autoPickupReady) return;
    const opts: DispatchOptions = this.autoChainProjects.has(projectId)
      ? {}
      : { only: new Set(ticketIds), chain: false };
    if (opts.only?.size === 0) return;
    void this.dispatchNextReadyTicket(projectId, opts).catch(() => undefined);
  }

  /** Active runs working on one of the project's tickets; ticket-less runs never count. */
  private busyTicketRuns(projectId: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, projectId),
            isNotNull(runs.ticketId),
            isNull(runs.handedOffTo),
            inArray(runs.state, [...ACTIVE_RUN_STATES]),
          ),
        )
        .get()?.n ?? 0
    );
  }

  private async dispatchNextReadyTicketUnlocked(
    projectId: string,
    { only, chain = true }: DispatchOptions,
  ): Promise<{ ticket: Ticket; run: Run }[]> {
    const fSettings = getFactorySettings(this.db);
    if (this.busyTicketRuns(projectId) >= fSettings.maxParallelTicketsPerProject) return [];

    this.project(projectId); // 404 for an unknown project

    // S16: a daily run budget per project stops an auto-chaining factory from draining the quota.
    if (this.dailyBudgetExhausted(projectId, fSettings.maxAutoRunsPerProjectPerDay)) {
      this.chainOff(projectId);
      return [];
    }

    // Finalize any tickets left in 'review' with a completed run (e.g. if core restarted mid-pipeline)
    if (fSettings.autoMoveToDone && !only) {
      this.finalizeLeftoverReviews(projectId, {
        finalizing: true,
        cutOff: this.pendingPipelineRuns(),
        liftedHolds: true,
      });
    }

    // Read after the finalization above: tickets it moved to Done may unblock others.
    // An untrusted issue import waits for a person (external.triage); no automatic path starts it.
    const allTickets = this.list(projectId).filter((t) => (!only || only.has(t.id)) && !t.external?.triage);
    const byPriority = (a: Ticket, b: Ticket) => b.priority - a.priority || a.position - b.position;
    const queue = [
      ...allTickets.filter((t) => t.status === 'ready').sort(byPriority),
      ...(fSettings.autoPickupBacklog
        ? allTickets.filter((t) => t.status === 'backlog').sort(byPriority)
        : []),
    ];
    if (queue.length === 0) {
      // The chain ends only once its last ticket run is through: a parallel sibling still working
      // must be merged and moved to Done by its own pipeline when it finishes.
      if (chain && this.busyTicketRuns(projectId) === 0) this.chainOff(projectId);
      return [];
    }
    if (chain) this.chainOn(projectId);

    const started: { ticket: Ticket; run: Run }[] = [];
    const serialize = fSettings.serializeOverlappingTickets;
    if (serialize) await this.refreshBranchFootprints(projectId);
    // Read once, and again only after a start was tried: nothing awaits between two deferrals, so
    // the busy runs cannot change there, and a run started in this pass counts with its claims.
    let footprints = serialize ? this.overlapFootprints(projectId) : [];
    for (const next of queue) {
      if (next.blockedBy.length > 0) continue;
      if (this.busyTicketRuns(projectId) >= fSettings.maxParallelTicketsPerProject) break;
      // The budget counts every run started in this pass too.
      if (this.dailyBudgetExhausted(projectId, fSettings.maxAutoRunsPerProjectPerDay)) {
        this.chainOff(projectId);
        break;
      }
      if (this.runs.activeRunForTicket(next.id) || this.startingTickets.has(next.id)) continue;
      // M5 layer 1: wait for a busy run that edits the same files; a lower-priority ticket may fill the slot.
      const wait = serialize ? overlapWait(next, footprints) : null;
      if (wait) {
        this.deferForOverlap(next, wait.ticketId);
        continue;
      }
      try {
        started.push(
          await this.start(next.id, { permissionMode: 'auto', persona: next.persona }, { unattended: true }),
        );
      } catch (error) {
        // Someone started it by hand in the meantime: take the next one.
        if (!(error instanceof HttpError && error.statusCode === 409)) throw error;
      } finally {
        if (serialize) footprints = this.overlapFootprints(projectId);
      }
    }
    return started;
  }

  /**
   * Records an imported tickets file's sha256 for the project; false when that content was imported
   * before. Synchronous, so two pipelines cannot both claim the same content.
   */
  private claimTicketsFile(projectId: string, sha256: string): boolean {
    const stored = readProjectSettings(this.db, projectId).ingestedTicketFiles;
    const seen = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [];
    if (seen.includes(sha256)) return false;
    writeProjectSettings(this.db, projectId, {
      ingestedTicketFiles: [...seen, sha256].slice(-INGESTED_TICKET_FILES_MAX),
    });
    return true;
  }

  private async handleRunCompleted(run: Run, opts: PipelineOptions = {}): Promise<void> {
    // With parallel tickets another run's dispatch may finalize Review tickets meanwhile; it must
    // not merge this run before its gates have passed.
    // Counted: an overlapping pass for the same run must not lift the guard while one is still going.
    this.pipelineRuns.set(run.id, (this.pipelineRuns.get(run.id) ?? 0) + 1);
    this.runs.pipelineBusy(run.id, true);
    // The agent's turn this pass is for. Passes of one run go one at a time; one whose turn is no
    // longer the latest when it gets to go (or at any later step) stands down: the pass of the newer
    // turn decides on its own checks.
    const turn = this.turnOf(run.id);
    const go = async (): Promise<void> => {
      if (!this.turnIsCurrent(run.id, turn)) return;
      let fresh: Run;
      try {
        fresh = this.runs.getRun(run.id);
      } catch {
        return; // removed meanwhile
      }
      await this.runPipeline(fresh, opts, turn);
    };
    const ahead = this.pipelineTails.get(run.id);
    const pass = ahead ? ahead.then(go) : go();
    const tail = pass.catch(() => undefined);
    this.pipelineTails.set(run.id, tail);
    try {
      await pass;
    } finally {
      if (this.pipelineTails.get(run.id) === tail) this.pipelineTails.delete(run.id);
      this.runs.pipelineBusy(run.id, false);
      const left = (this.pipelineRuns.get(run.id) ?? 1) - 1;
      if (left > 0) this.pipelineRuns.set(run.id, left);
      else this.pipelineRuns.delete(run.id);
      this.releasePipelinePending(run.id);
      // Merged or held: the tickets that waited for its files may start now.
      if (run.projectId && !this.overlapBusyRuns(run.projectId).some((r) => r.id === run.id)) {
        this.releaseOverlapWaits(run.projectId);
      }
    }
  }

  private async runPipeline(
    run: Run,
    { finalizing = false, resumed = false }: PipelineOptions,
    turn: number | undefined,
  ): Promise<void> {
    if (!run.projectId) return;
    // Checked right before each step that notes, asks or merges (see handleRunCompleted).
    const stale = () => !this.turnIsCurrent(run.id, turn);
    let projectRow;
    try {
      projectRow = this.project(run.projectId);
    } catch {
      return;
    }

    // 0. If this was a standalone Brainstorming run, copy any worktree brainstorm output to main,
    //    close the idle CLI process, and return immediately without triggering Kanban ticket pipelines.
    if (run.title?.includes('[Brainstorm]')) {
      if (run.worktreePath && run.worktreePath !== projectRow.path) {
        const wtBrainstorm = path.join(run.worktreePath, '.emberline', 'brainstorm-suggestions.json');
        const mainBrainstorm = path.join(projectRow.path, '.emberline', 'brainstorm-suggestions.json');
        if (existsSync(wtBrainstorm) && !existsSync(mainBrainstorm)) {
          await mkdir(path.dirname(mainBrainstorm), { recursive: true }).catch(() => undefined);
          await cp(wtBrainstorm, mainBrainstorm, { force: true }).catch(() => undefined);
        }
      }
      if (!run.endedAt) {
        await this.runs
          .stop(run.id, { source: 'system', reason: 'brainstorm_finished' })
          .catch(() => undefined);
      }
      return;
    }

    // The pass a restart cut off had held the run for a gate's request to the agent but not sent it
    // yet: this one only sends it, and the agent's next stop is the next pass.
    const pendingRequest = resumed ? this.pendingFixRequest(run) : null;
    if (pendingRequest) {
      if (stale()) return;
      await this.resumeFixRequest(run, pendingRequest);
      return;
    }

    const ticketRow = run.ticketId
      ? this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get()
      : undefined;

    // 1. Check if the agent wrote `.emberline/new-tickets.json` (or `tickets.json`, both are read) in
    //    its worktree or main workspace. A file committed where the run's branch started came from
    //    main, not from this run, and a content imported before is not imported again: either would
    //    recreate the same tickets.
    const projectId = run.projectId;
    const inherited: string[] = [];
    let duplicate = false;
    const hooksFor = (baseRef: () => Promise<string>, where: string): TicketsFileHooks => ({
      onRejected: (rejection) => {
        this.runs.note(run.id, 'tickets_file_rejected', {
          message: `${rejection.file}: ${rejection.issue}`.slice(0, 500),
          rejectedAs: rejection.rejectedAs,
        });
        this.noticeProject(projectId, rejection);
      },
      isInherited: async (relPath, raw) => committedWithContent(where, await baseRef(), relPath, raw),
      claim: (sha256) => this.claimTicketsFile(projectId, sha256),
      onSkipped: (reason, file, sha256) => {
        if (reason === 'inherited') {
          inherited.push(file);
          return;
        }
        duplicate = true;
        this.runs.note(run.id, 'tickets_file_duplicate', { file, sha256 });
      },
      // A pass whose turn is over leaves the files to the newer turn's pass (each is consumed when read).
      proceed: () => !stale(),
    });
    const worktreePath = run.worktreePath;
    const fromWorktree = worktreePath
      ? await ingestAgentTicketsFiles(
          worktreePath,
          hooksFor(
            // A detached main checkout has no branch: the project's default branch is main then.
            async () =>
              runBranchBase(
                worktreePath,
                (await mainWorkspaceBranch(projectRow.path)) ?? projectRow.defaultBranch,
              ),
            worktreePath,
          ),
        )
      : [];
    const fromMain =
      fromWorktree.length === 0 && projectRow.path !== run.worktreePath
        ? await ingestAgentTicketsFiles(
            projectRow.path,
            hooksFor(async () => 'HEAD', projectRow.path),
          )
        : [];
    const batches = fromWorktree.length > 0 ? fromWorktree : fromMain;
    if (inherited.length > 0)
      this.runs.note(run.id, 'tickets_file_inherited', { files: [...new Set(inherited)] });

    const draftDepth = (ticketRow?.depth ?? 0) + 1;
    const fSettingsForDepth = getFactorySettings(this.db);
    for (const ingested of batches) {
      if (ingested.tickets.length > 0 && this.leftToFactory(projectId, ticketRow?.id)) {
        this.runs.note(run.id, 'tickets_file_left_to_factory', { drafts: ingested.tickets.length });
      } else if (ingested.tickets.length > 0 && draftDepth > fSettingsForDepth.maxTicketDepth) {
        // S16: agent tickets spawning agent tickets must not grow without bound.
        this.runs.note(run.id, 'ticket_depth_limit', {
          drafts: ingested.tickets.length,
          depth: draftDepth,
          maxTicketDepth: fSettingsForDepth.maxTicketDepth,
        });
      } else if (ingested.tickets.length > 0) {
        const created: { draft: (typeof ingested.tickets)[number]; ticket: Ticket }[] = [];
        // Open tickets by normalized title; a done ticket with the same title does not block a new one.
        const byTitle = new Map<string, string>();
        for (const r of this.db
          .select({ key: tickets.key, title: tickets.title, status: tickets.status })
          .from(tickets)
          .where(eq(tickets.projectId, run.projectId))
          .all()) {
          const k = normalizeTicketTitle(r.title);
          if (r.status !== 'done' && !byTitle.has(k)) byTitle.set(k, r.key);
        }
        const refKey = (ref: string) => normalizeTicketRef(ref) ?? ref.toLowerCase();
        const skippedRefs = new Map<string, string>(); // skipped draft's ref -> key of the ticket that stands in for it
        for (const draft of ingested.tickets) {
          const titleKey = normalizeTicketTitle(draft.title);
          const existing = byTitle.get(titleKey);
          if (existing) {
            this.runs.note(run.id, 'ticket_draft_duplicate', { title: draft.title.slice(0, 200), existing });
            if (draft.ref) skippedRefs.set(refKey(draft.ref), existing);
            continue;
          }
          let body = draft.body ?? '';
          if ((draft.preferredAgent || draft.preferredModel) && !body.includes('[Preferred Agent:')) {
            const agentStr = draft.preferredAgent ?? 'claude';
            const modelStr = draft.preferredModel ?? 'auto';
            const routeTag = `[Preferred Agent: ${agentStr} · Model: ${modelStr}]`;
            // Keep the tag inside the body limit even for drafts that already use all of it.
            body = `${body.slice(0, TICKET_BODY_MAX - routeTag.length - 2)}\n\n${routeTag}`.trim();
          }
          try {
            const ticket = this.create(
              run.projectId,
              {
                title: draft.title,
                body,
                persona: draft.persona,
                priority: draft.priority,
                status: 'ready',
              },
              draftDepth,
            );
            created.push({ draft, ticket });
            byTitle.set(titleKey, ticket.key);
          } catch (error) {
            // The drafts file is already consumed: skip the bad draft, keep the others.
            this.runs.note(run.id, 'ticket_draft_rejected', {
              title: draft.title.slice(0, 200),
              message: (error as Error).message.slice(0, 500),
            });
          }
        }
        // Board work, even without a code change: remembered on the run, so a later pass of it (a
        // re-pass after a gate's prompt, finalization after a restart) does not hold it as empty.
        if (created.length > 0) {
          this.runs.note(run.id, 'tickets_imported', {
            count: created.length,
            tickets: created.map((c) => c.ticket.key),
          });
        }
        const repointed = created.map((c) => ({
          ...c,
          draft: {
            ...c.draft,
            ...(c.draft.dependsOn
              ? { dependsOn: c.draft.dependsOn.map((d) => skippedRefs.get(refKey(d)) ?? d) }
              : {}),
          },
        }));
        this.applyDraftDependencies(run.id, run.projectId, repointed);
        if (ingested.autoDispatch) {
          this.chainOn(run.projectId);
        }
      }
    }

    const isFactoryOrchestratorTicket = Boolean(
      ticketRow?.title.startsWith('[Factory]') && run.persona === 'product_owner',
    );

    // If a Factory Orchestrator (PO) stopped to ask a clarifying question without writing
    // `.emberline/new-tickets.json`, automatically reply once so it writes the tickets immediately.
    if (
      isFactoryOrchestratorTicket &&
      batches.length === 0 &&
      !duplicate &&
      (!run.endedAt || run.resumable)
    ) {
      const nudge = () =>
        this.runs
          .prompt(
            run.id,
            'Autonomous Factory Mode: Do not ask clarifying questions or wait for user confirmation. Choose the simplest self-contained local option (e.g., localStorage / existing stack in PROJECT.md), update PROJECT.md, and write .emberline/new-tickets.json now so the specialist pipeline can start.',
            { automatic: true },
          )
          .catch(() => undefined);
      if (stale()) return;
      if (!this.runs.hasEvent(run.id, 'auto_nudged')) {
        this.runs.note(run.id, 'auto_nudged', { reason: 'no_ticket_drafts' });
        await nudge();
        return;
      }
      // The pass a restart cut off was this turn's nudge: it goes on as that one would have. The
      // prompt is sent if it never went out; either way the agent's next stop is the next pass.
      const thisTurn = resumed ? this.nudgeOfThisTurn(run.id) : null;
      if (thisTurn) {
        if (!thisTurn.delivered) await nudge();
        return;
      }
    }

    const fSettings = effectiveFactorySettings(this.db, run.projectId);
    const projectTickets = this.db.select().from(tickets).where(eq(tickets.projectId, run.projectId)).all();
    const hasFactoryPipeline =
      fSettings.autoPickupReady &&
      projectTickets.some((t) => t.title.startsWith('[Factory]') || t.status === 'ready');

    // A run an earlier pass left held stays a factory run: its next stop lifts the hold even when
    // the chain ended meanwhile (a dispatch with an empty queue does not count a held, `done` run).
    // So does one whose review hold a person lifted since, until another outcome decides it, and any
    // successor of a held run (a `continued after a hold` one or any other handoff, also several
    // handoffs on): it carries that run's work on.
    const isFactoryRun =
      finalizing ||
      this.autoChainProjects.has(run.projectId) ||
      batches.length > 0 ||
      isFactoryOrchestratorTicket ||
      hasFactoryPipeline ||
      (ticketRow?.status !== 'done' &&
        (this.stillHeld(run.id) ||
          reviewUnblockPending(this.db, run.id) ||
          continuesHeldWork(this.db, run.id)));
    if (!isFactoryRun) return;

    // The gates, the merge and Done apply to every factory-looking run, but only the factory itself
    // turns the chain on: its orchestrator ticket (unless its tickets file asked not to dispatch) or
    // a chaining dispatch (already on). A ticket a person started, or one a narrow dispatch started
    // because a person's change unblocked it, does not start the rest of the queue when it finishes.
    if (stale()) return;
    if (fSettings.autoPickupReady && isFactoryOrchestratorTicket && batches.every((b) => b.autoDispatch)) {
      this.chainOn(run.projectId);
    }

    // 1b. The agent's completion signal: a stop is not "done" unless the agent said so. Only for a
    //     run whose agent has the tool (its `emberline-mcp` checked in): a runner image without it,
    //     or a session started before the upgrade, advances the old way instead of stalling.
    if (stale()) return;
    if (
      fSettings.requireCompletionSignal &&
      ticketRow &&
      !isFactoryOrchestratorTicket &&
      this.hasCompletionTool(run) &&
      !(await this.completionGatePasses(run))
    ) {
      return;
    }

    // 1c. A run that changed nothing and did not say why (no completion of this turn) is not done:
    //     its branch is already in main, so the merge would find nothing and the ticket would reach
    //     Done empty. It is held for a person instead, its session closed like other holds', and the
    //     rest of the queue goes on. Left out: the Factory orchestrator and any run whose tickets file
    //     created tickets, in this pass or an earlier one (board work, in a scratch file), a run
    //     working in the main workspace itself, and a branch merged before (a fast-forward by hand
    //     puts its commits on main's line).
    if (
      ticketRow &&
      !isFactoryOrchestratorTicket &&
      !this.runs.hasEvent(run.id, 'tickets_imported') &&
      run.worktreePath &&
      run.worktreePath !== projectRow.path &&
      !this.runs.latestCompletion(run.id) &&
      !branchMergedBefore(this.db, run.id) &&
      !(await runProducedChanges(run.worktreePath, projectRow.path))
    ) {
      if (stale()) return;
      this.runs.note(run.id, 'no_changes', { autoFix: false });
      if (!run.endedAt) await this.runs.closeHeldSession(run.id).catch(() => undefined);
      if (this.autoChainProjects.has(run.projectId) && fSettings.autoPickupReady) {
        await this.dispatchNextReadyTicket(run.projectId).catch(() => undefined);
      }
      return;
    }

    // 1d–2d. The gates, in order: the run's worktree.yml must stay usable on main, an Auto Bootstrap
    //     must write its worktree commands, then the build/lint/test gate, the secret and anti-slop
    //     guard, the cross-provider critic and open blocking review feedback (runs/gates.ts). A gate
    //     that asked the agent for a fix or handed the hold to a person ends this pass: the agent's
    //     next stop runs the pipeline again (see HOLD_EVENTS). The secret guard and review feedback
    //     only block the merge; the rest of the pass (and the queue) goes on.
    const gatePass: GatePass = {
      db: this.db,
      run,
      projectPath: projectRow.path,
      settings: fSettings,
      ticket: ticketRow,
      orchestrator: isFactoryOrchestratorTicket,
      stale,
      note: (type, payload) => this.runs.note(run.id, type, payload),
      requestFix: (type, note, request) => this.requestFix(run, type, note, request),
      closeAndGoOn: () => this.closeAndGoOn(run),
      completionReminder: (separator) => this.completionReminder(run, separator),
      dockerEnv: () => this.runs.dockerEnvFor(run),
    };
    const blockedBy = new Set<'secret_guard' | 'review'>();
    for (const gate of [worktreeYmlGate, worktreeCommandsGate, buildGate, slopGate, criticGate]) {
      const outcome = await gate(gatePass);
      if (outcome.kind === 'halt') return;
      if (outcome.kind === 'merge_blocked') blockedBy.add(outcome.by);
    }

    // The agent worked again while this pass ran its checks: they looked at an older tree, so the
    // pass of its newer turn decides (one merge, after that turn's own checks).
    if (stale()) return;

    const review = reviewGate(gatePass);
    if (review.kind === 'merge_blocked') blockedBy.add(review.by);
    const reviewBlocked = blockedBy.has('review');

    // 3. Auto-merge the worktree into the main workspace so subsequent specialist personas branch off
    //    the updated codebase and Live Demo stays current — UNLESS Secret Guard blocked a credential leak!
    let mergeBlocked = blockedBy.size > 0;
    if (
      !mergeBlocked &&
      fSettings.autoSyncToMain &&
      run.worktreePath &&
      run.worktreePath !== projectRow.path
    ) {
      // Layer 2 (M5): additive conflicts are healed in the run's worktree and checked again first.
      const heal: MergeHeal | undefined = fSettings.autoResolveAdditiveConflicts
        ? {
            defaultBranch: projectRow.defaultBranch,
            verify: () => verifyBuild(gatePass),
            note: (type, payload) => this.runs.note(run.id, type, payload),
          }
        : undefined;
      const merged = await this.mergeRunIntoMain(run, projectRow.path, ticketRow?.key ?? null, stale, heal);
      // The agent worked again before the merge began: nothing was merged, its newer turn's pass decides.
      if (!merged) return;
      // It worked again during the merge: what was merged is the commit these checks passed (the merge
      // took that one, not later ones); the rest (Done, a conflict, the session) is for that turn's pass.
      if (stale()) return;
      mergeBlocked = !merged.ok;
      // Layer 3 (M5): the agent's own session, or a resolver run on the same branch, takes the
      // conflict and the ticket stays in Review meanwhile. Otherwise the hold is for a person.
      if (!merged.ok && merged.autoFix) {
        const { resolution } = await this.conflictLadder.escalate({
          run,
          conflicts: merged.conflicts,
          mainHead: merged.mainHead,
          ...(merged.healFailure ? { healFailure: merged.healFailure } : {}),
          project: projectRow,
        });
        if (resolution !== 'manual') return;
        this.runs.note(run.id, 'merge_failed', {
          summary: merged.summary,
          conflicts: merged.conflicts,
          autoFix: false,
        });
      }
    }

    // Read again after the merge: the session may have ended meanwhile.
    try {
      run = this.runs.getRun(run.id);
    } catch {
      return; // removed meanwhile
    }

    // 4. Auto-move completed factory ticket to Done when enabled (keep it in Review when the merge was
    //    blocked by Secret Guard or refused because of conflicts, so a human resolves it).
    let movedToDone = false;
    if (!mergeBlocked && fSettings.autoMoveToDone && run.ticketId) {
      try {
        this.moveToTop(run.ticketId, 'done');
        movedToDone = true;
      } catch {
        // ignore if ticket was removed
      }
    }

    // 5. Close the idle interactive CLI process for this completed factory step so it does not
    //    linger at the `>` prompt or fire idle notifications. A run held for review feedback keeps
    //    its session: the person's next step is usually a request for changes to it. A run held for
    //    anything else (merge conflict, secret guard) is closed but stays resumable, so a person can
    //    continue it later instead of finding it cancelled.
    if (!run.endedAt && !reviewBlocked) {
      const held = mergeBlocked || this.pipelineOutcome(run.id) === 'held';
      await (
        held
          ? this.runs.closeHeldSession(run.id)
          : this.runs.stop(run.id, { source: 'system', reason: 'factory_step_finished' })
      ).catch(() => undefined);
    }

    // 6. Dispatch the next specialist ticket in the project's queue if auto-chaining is active;
    //    otherwise start only the tickets that were waiting for this one (like a manual move to Done).
    if (this.autoChainProjects.has(run.projectId) && fSettings.autoPickupReady) {
      await this.dispatchNextReadyTicket(run.projectId).catch(() => undefined);
    } else if (movedToDone && run.ticketId) {
      this.dispatchUnblocked(run.projectId, dependentIds(this.db, run.ticketId));
    }
  }

  /**
   * Whether the run's agent has the `ticket_complete` tool: a Claude CLI whose `emberline-mcp`
   * checked in. Secondary CLIs never have it; neither has a Claude run on an older runner image.
   */
  private hasCompletionTool(run: Run): boolean {
    return (
      providerAdapter(run.agent).completionSignal === 'tool' &&
      this.runs.hasEvent(run.id, 'completion_tool_ready')
    );
  }

  /**
   * {@link COMPLETE_AGAIN} after `separator`, for a run whose agent has the tool; empty otherwise.
   * Every prompt that asks for more work ends with it (the gates here, a person's review feedback).
   */
  completionReminder(run: Run, separator: string): string {
    return this.hasCompletionTool(run) ? `${separator}${COMPLETE_AGAIN}` : '';
  }

  /**
   * A signal of this turn without blockers lets the pipeline go on. Blockers, or a second stop
   * without a signal, hold the ticket in Review for a person (HOLD_EVENTS, paged by
   * NotificationService); the first stop without one gets a single automatic nudge. Holds are lifted
   * by the agent's next stop like every other gate's.
   */
  private async completionGatePasses(run: Run): Promise<boolean> {
    const signal = this.runs.latestCompletion(run.id);
    if (signal && signal.blockers.length === 0) {
      // Ends an earlier hold of this gate (stillHeld) even when no merge follows.
      this.runs.note(run.id, 'completion_accepted', {});
      return true;
    }
    if (signal) {
      this.runs.note(run.id, 'completion_blocked', { blockers: signal.blockers });
      return false;
    }
    if (!this.runs.hasEvent(run.id, 'completion_nudged') && (!run.endedAt || run.resumable)) {
      // Noted first (a hold): a dispatch must not finalize the ticket while the agent answers.
      this.runs.note(run.id, 'completion_nudged', {});
      // Undelivered, no next stop will come: it waits for a person now (`completion_missing`).
      await this.sendFixRequest(run, { type: 'completion_nudged', note: {}, request: COMPLETION_NUDGE });
      return false;
    }
    this.runs.note(run.id, 'completion_missing', {});
    return false;
  }

  /**
   * Merges a finished run's worktree into the main workspace. Failures are recorded on the run
   * (`merge_failed`) instead of thrown; returns whether the work landed in main, and `autoFix` when
   * the conflict ladder takes the conflicts (the note says so: not yet a person's).
   */
  private async mergeRunIntoMain(
    run: Run,
    mainWorkspacePath: string,
    ticketKey: string | null,
    stale: () => boolean,
    heal?: MergeHeal,
  ): Promise<{
    ok: boolean;
    conflicts: string[];
    summary: string;
    autoFix: boolean;
    mainHead: string | null;
    healFailure?: HealFailure;
  } | null> {
    const ticket = run.ticketId
      ? (this.db
          .select({ key: tickets.key, title: tickets.title })
          .from(tickets)
          .where(eq(tickets.id, run.ticketId))
          .get() ?? null)
      : null;
    const commit = runCommit(this.db, run, ticket);
    const workingBranch = () => {
      const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
      return project ? factoryWorkingBranch(this.db, project.id, project.defaultBranch) : null;
    };
    const res = await mergeRunBranch({
      run,
      mainWorkspacePath,
      ticketKey,
      stale,
      heal,
      commit,
      workingBranch,
    });
    // Refused before merging, or nothing new to merge for a pass whose turn is over: nothing to note.
    if (res === null || (res.alreadyMerged && stale())) return null;
    // Main's head as the merge saw it, read under its lock: a change queued behind it does not count.
    const head = res.ok ? null : res.mainHead;
    const autoFix = !res.ok && res.conflicts.length > 0 && this.conflictLadder.plan(run, head) !== 'manual';
    this.runs.note(run.id, res.ok ? 'merged_to_main' : 'merge_failed', {
      summary: res.summary,
      // The merge commit in main (the issue write-back quotes it).
      ...(res.ok && res.commitSha ? { commitSha: res.commitSha } : {}),
      // Its full id: Keep main pushed publishes only this exact commit.
      ...(res.ok && res.commitOid ? { commitOid: res.commitOid } : {}),
      // Main changed during the merge: its commit was not recorded for pushing.
      ...(res.ok && res.commitUnverified ? { commitUnverified: true } : {}),
      ...(res.conflicts.length > 0 ? { conflicts: res.conflicts } : {}),
      ...(autoFix ? { autoFix } : {}),
    });
    return {
      ok: res.ok,
      conflicts: res.conflicts,
      summary: res.summary,
      autoFix,
      mainHead: head,
      ...(res.healFailure ? { healFailure: res.healFailure } : {}),
    };
  }

  /**
   * What the run's latest completion pipeline (the one after its latest switch to `done`) decided:
   * `held` when it left the ticket in Review for a person (a HOLD_EVENTS note; a later turn of the
   * agent lifts it), `merged` when the work landed in main, null when it never got that far.
   */
  private pipelineOutcome(runId: string): 'held' | 'merged' | null {
    return pipelineOutcome(this.db, runId);
  }

  /**
   * Whether an earlier pipeline pass of this run left it held (see hold-outcome.ts). A hold that was
   * later merged, or whose agent later signalled completion (no merge follows when auto-sync and
   * auto-Done are off), does not count.
   */
  private stillHeld(runId: string): boolean {
    return stillHeld(this.db, runId);
  }

  list(projectId: string): Ticket[] {
    this.project(projectId);
    const rows = this.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(asc(tickets.position))
      .all();
    return this.withDependencies(rows);
  }

  /** The board as an export document; `statuses` narrows the rows, counts always cover every column. */
  exportBoard(projectId: string, statuses: readonly TicketStatus[], now = new Date()): TicketExport {
    const project = this.project(projectId);
    return buildTicketExport(project, this.list(projectId), statuses, now);
  }

  /** One action over several tickets of the board; see `applyBulkTicketAction`. */
  bulk(projectId: string, body: BulkTicketBody): BulkTicketResult {
    return applyBulkTicketAction(this.db, this, projectId, body);
  }

  get(id: string): Ticket {
    return this.withDependencies([this.row(id)])[0] as Ticket;
  }

  /** Dependencies of the given tickets with one query; `blockedBy` holds those not yet `done`. */
  dependenciesOf(ids: string[]): Map<string, TicketDependencies> {
    return loadDependencies(this.db, ids);
  }

  private withDependencies(rows: TicketRow[]): Ticket[] {
    const deps = this.dependenciesOf(rows.map((r) => r.id));
    const waits = this.overlapWaits(rows, deps);
    return rows.map((row) => toTicket(row, deps.get(row.id), waits.get(row.id) ?? null));
  }

  /**
   * `waitingOn` of the unblocked `ready` rows: the first busy ticket whose footprint their claims
   * overlap. Uses the cached branch footprints only, so a list call never runs git.
   */
  private overlapWaits(
    rows: TicketRow[],
    deps: Map<string, TicketDependencies>,
  ): Map<string, TicketOverlapWait> {
    const waits = new Map<string, TicketOverlapWait>();
    const candidates = rows.filter(
      (r) => r.status === 'ready' && (deps.get(r.id)?.blockedBy.length ?? 0) === 0,
    );
    if (candidates.length === 0 || !getFactorySettings(this.db).serializeOverlappingTickets) return waits;
    const busyByProject = new Map<string, BusyFootprint[]>();
    for (const row of candidates) {
      let busy = busyByProject.get(row.projectId);
      if (!busy) {
        busy = this.overlapFootprints(row.projectId);
        busyByProject.set(row.projectId, busy);
      }
      const wait = overlapWait(row, busy);
      if (wait) waits.set(row.id, wait);
    }
    return waits;
  }

  /**
   * Whether the run still counts for overlap: it holds a slot, or its finished turn is still settling
   * or going through the pipeline (its branch is not merged or held yet).
   */
  private busyForOverlap(run: Pick<Run, 'id' | 'ticketId' | 'handedOffTo' | 'state'>): boolean {
    if (!run.ticketId || run.handedOffTo) return false;
    return occupiesTicketSlot(run.state) || this.settlingRuns.has(run.id) || this.pipelineRuns.has(run.id);
  }

  /**
   * The project's runs that count for overlap, newest first: the run columns overlap reads, from the
   * slot-holding states and the runs settling or in the pipeline only (no events, telemetry or
   * attention, which a full run list loads for every run of every project).
   */
  private overlapBusyRuns(projectId: string): OverlapRun[] {
    const pending = [...this.settlingRuns.keys(), ...this.pipelineRuns.keys()];
    const busyState = inArray(runs.state, [...ACTIVE_RUN_STATES]);
    return this.db
      .select({
        id: runs.id,
        ticketId: runs.ticketId,
        handedOffTo: runs.handedOffTo,
        state: runs.state,
        worktreePath: runs.worktreePath,
      })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          isNotNull(runs.ticketId),
          isNull(runs.handedOffTo),
          pending.length > 0 ? or(busyState, inArray(runs.id, pending)) : busyState,
        ),
      )
      .orderBy(desc(runs.createdAt))
      .all()
      .map((row) => ({ ...row, state: row.state as Run['state'] }))
      .filter((run) => this.busyForOverlap(run));
  }

  /** The busy runs' footprints: their tickets' claims ∪ the cached files their branches changed. */
  private overlapFootprints(projectId: string): BusyFootprint[] {
    const busy = this.overlapBusyRuns(projectId);
    if (busy.length === 0) return [];
    const ids = [...new Set(busy.map((r) => r.ticketId as string))];
    const byId = new Map(
      this.db
        .select({ id: tickets.id, key: tickets.key, body: tickets.body })
        .from(tickets)
        .where(inArray(tickets.id, ids))
        .all()
        .map((row) => [row.id, row]),
    );
    const footprints: BusyFootprint[] = [];
    for (const run of busy) {
      const ticket = byId.get(run.ticketId as string);
      if (!ticket) continue;
      const paths = busyFootprint(claimedPaths(ticket.body), this.branchFootprints.changed(run.id));
      footprints.push({ ticketId: ticket.id, key: ticket.key, paths });
    }
    return footprints;
  }

  /** Reads what each busy run's branch changed against the merge target (cached per branch tip). */
  private async refreshBranchFootprints(projectId: string): Promise<void> {
    const busy = this.overlapBusyRuns(projectId);
    this.branchFootprints.retain(new Set(busy.map((r) => r.id)));
    const projectRow = this.project(projectId);
    const inWorktree = busy.filter((r) => r.worktreePath && r.worktreePath !== projectRow.path);
    if (inWorktree.length === 0) return;
    const target = await mergeTarget(projectRow).catch(() => projectRow.defaultBranch);
    await Promise.all(inWorktree.map((r) => this.branchFootprints.refresh(r, target)));
  }

  /** Notes the deferral and shows it on the card (once per ticket waited for). */
  private deferForOverlap(ticket: Ticket, waitsFor: string): void {
    let deferred = this.overlapDeferred.get(ticket.projectId);
    if (!deferred) {
      deferred = new Map();
      this.overlapDeferred.set(ticket.projectId, deferred);
    }
    if (deferred.get(ticket.id) === waitsFor) return;
    deferred.set(ticket.id, waitsFor);
    this.publishTickets([ticket.id]);
  }

  /**
   * A busy run of the project was merged, held or ended: tickets deferred for overlap get another
   * dispatch (only those, unless the project chains) and their cards drop or update `waitingOn`.
   */
  private releaseOverlapWaits(projectId: string): void {
    const deferred = this.overlapDeferred.get(projectId);
    if (!deferred || deferred.size === 0) return;
    const ids = [...deferred.keys()];
    this.overlapDeferred.delete(projectId);
    this.publishTickets(ids);
    this.dispatchUnblocked(projectId, ids);
  }

  /** Resolves the batch's refs/keys (or the default tiers), stores the edges and notes the outcome on the run (if any). */
  private applyDraftDependencies(
    runId: string | null,
    projectId: string,
    created: (CreatedDraft & { ticket: Ticket })[],
  ): void {
    if (created.length === 0) return;
    const note = (type: string, payload: Record<string, unknown>) => {
      if (runId) this.runs.note(runId, type, payload);
    };
    try {
      const { edges, dropped, keyById } = storeDraftDependencies(this.db, projectId, created);
      for (const d of dropped) {
        note('dependency_dropped', {
          ticket: keyById.get(d.ticketId) ?? d.ticketId,
          ref: d.ref,
          reason: d.reason,
        });
      }
      for (const { ticket } of created) {
        const next = this.find(ticket.id);
        if (next) this.emit('ticket', next);
      }
      if (edges.length > 0) {
        note('dependencies_applied', {
          edges: edges.map((e) => ({
            ticket: keyById.get(e.ticketId) ?? e.ticketId,
            dependsOn: keyById.get(e.dependsOnId) ?? e.dependsOnId,
          })),
          message: `${edges.length} ticket dependenc${edges.length === 1 ? 'y' : 'ies'} applied`,
        });
      }
    } catch (error) {
      note('dependency_error', { message: (error as Error).message.slice(0, 500) });
    }
  }

  /** Runs created for the project in the last 24 hours. */
  runsLast24h(projectId: string): number {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    return (
      this.db
        .select({ n: count() })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), isNull(runs.predecessorRunId), gte(runs.createdAt, since)))
        .get()?.n ?? 0
    );
  }

  dailyBudgetExhausted(
    projectId: string,
    max = getFactorySettings(this.db).maxAutoRunsPerProjectPerDay,
  ): boolean {
    return max > 0 && this.runsLast24h(projectId) >= max;
  }

  /** Like {@link get}, but `undefined` instead of a 404 for a deleted ticket. */
  find(id: string): Ticket | undefined {
    const row = this.db.select().from(tickets).where(eq(tickets.id, id)).get();
    return row ? this.withDependencies([row])[0] : undefined;
  }

  /**
   * `depth` is set by the factory for agent-created tickets; people always create depth 0.
   * `external` links the ticket to a forge issue in the same insert; the unique index on
   * (project, source, id) throws if that issue already has a ticket.
   */
  create(projectId: string, input: CreateTicketBody, depth = 0, external?: IssueLink): Ticket {
    const project = this.project(projectId);
    const body = CreateTicketBodySchema.parse(input);
    const now = new Date();
    const row = this.db.transaction((tx) => {
      const seqKey = ticketSeqKey(projectId);
      const stored = tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, seqKey))
        .get()?.value;
      // The highest number in use too: a project from before the sequence starts after its tickets.
      const last = tx
        .select({ n: max(tickets.number) })
        .from(tickets)
        .where(eq(tickets.projectId, projectId))
        .get();
      const number = Math.max(typeof stored === 'number' ? stored : 0, last?.n ?? 0) + 1;
      tx.insert(settings)
        .values({ key: seqKey, value: number })
        .onConflictDoUpdate({ target: settings.key, set: { value: number } })
        .run();
      return tx
        .insert(tickets)
        .values({
          id: randomUUID(),
          projectId,
          number,
          key: `${keyPrefix(project.slug)}-${number}`,
          title: body.title,
          body: body.body,
          status: body.status,
          priority: body.priority,
          persona: body.persona,
          position: edgePosition(this.db, projectId, body.status, 'bottom'),
          depth,
          ...(external
            ? {
                externalSource: external.source,
                externalId: external.externalId,
                externalNumber: external.number,
                externalUrl: external.url,
                externalState: external.state,
                externalLabels: external.labels,
                externalSyncedAt: now,
                externalTriage: external.triage ?? false,
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    });
    return this.publish(row);
  }

  /** The tickets already linked to these issues of the provider, by the issue's external id. */
  linkedTickets(projectId: string, source: ForgeProvider, externalIds: string[]): Map<string, Ticket> {
    const out = new Map<string, Ticket>();
    if (externalIds.length === 0) return out;
    const rows = this.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.projectId, projectId),
          eq(tickets.externalSource, source),
          inArray(tickets.externalId, externalIds),
        ),
      )
      .all();
    for (const [i, ticket] of this.withDependencies(rows).entries())
      out.set(rows[i]!.externalId as string, ticket);
    return out;
  }

  /** The issues among these whose imported ticket was deleted (label sync skips them). */
  tombstonedIssues(projectId: string, source: ForgeProvider, externalIds: string[]): Set<string> {
    if (externalIds.length === 0) return new Set();
    const rows = this.db
      .select({ externalId: issueTombstones.externalId })
      .from(issueTombstones)
      .where(
        and(
          eq(issueTombstones.projectId, projectId),
          eq(issueTombstones.externalSource, source),
          inArray(issueTombstones.externalId, externalIds),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.externalId));
  }

  /**
   * One ticket per issue. An issue that already has a ticket (also one created a moment ago by a
   * concurrent import) yields that ticket in `existing`; a second one is never created. The lookup
   * runs synchronously right before the insert, so within this process it is the guard; the unique
   * index is the backstop (another process, or a lookup that missed) and resolves to the winner.
   * Every ticket is mapped and validated first, so a bad issue creates nothing.
   */
  importIssues(
    projectId: string,
    source: ForgeProvider,
    issues: ForgeIssue[],
    status: 'backlog' | 'ready',
    { triage = false }: { triage?: boolean } = {},
  ): { created: Ticket[]; existing: Ticket[] } {
    const mapped = issues.map((issue) => ({
      issue,
      input: CreateTicketBodySchema.parse(mapIssueToTicket(issue, source, status)),
    }));
    const created: Ticket[] = [];
    const existing: Ticket[] = [];
    for (const { issue, input } of mapped) {
      const link = (): Ticket | undefined =>
        this.linkedTickets(projectId, source, [issue.externalId]).get(issue.externalId);
      const already = link();
      if (already) {
        existing.push(already);
        continue;
      }
      try {
        // Importing an issue again (a person chose it) lifts its tombstone.
        this.db
          .delete(issueTombstones)
          .where(
            and(
              eq(issueTombstones.projectId, projectId),
              eq(issueTombstones.externalSource, source),
              eq(issueTombstones.externalId, issue.externalId),
            ),
          )
          .run();
        created.push(
          this.create(projectId, input, 0, {
            source,
            externalId: issue.externalId,
            number: issue.number,
            url: issue.url,
            state: issue.state,
            labels: issue.labels,
            triage,
          }),
        );
      } catch (err) {
        const winner = isUniqueViolation(err) ? link() : undefined;
        if (!winner) throw err;
        existing.push(winner);
      }
    }
    return { created, existing };
  }

  /**
   * Refreshes the issue link of linked tickets from the forge: state, labels and the sync time. It
   * never moves, edits or deletes a ticket (a closed issue only shows as closed). Tickets whose
   * state or labels changed are published; returns them.
   */
  syncIssueLinks(
    projectId: string,
    source: ForgeProvider,
    issues: { externalId: string; state: 'open' | 'closed'; labels: string[] }[],
    at = new Date(),
  ): Ticket[] {
    const linked = this.linkedTickets(
      projectId,
      source,
      issues.map((i) => i.externalId),
    );
    const changed: string[] = [];
    for (const issue of issues) {
      const ticket = linked.get(issue.externalId);
      if (!ticket) continue;
      const before = ticket.external;
      // Labels are a set: the forge's order is no change.
      const sorted = (labels: string[]) => [...labels].sort().join('\n');
      const same = before?.state === issue.state && sorted(before.labels) === sorted(issue.labels);
      this.db
        .update(tickets)
        .set({ externalState: issue.state, externalLabels: issue.labels, externalSyncedAt: at })
        .where(eq(tickets.id, ticket.id))
        .run();
      if (!same) changed.push(ticket.id);
    }
    if (changed.length === 0) return [];
    this.publishTickets(changed);
    return changed.map((id) => this.get(id));
  }

  /**
   * `byPerson`: a tickets route, so a move or an edit is the person's triage of an untrusted issue
   * import (a reorder inside its column is not). The pipeline and the roadmap never clear it.
   */
  update(id: string, input: UpdateTicketBody, { byPerson = false }: ByPerson = {}): Ticket {
    const current = this.row(id);
    const { dependsOn, ...patch } = UpdateTicketBodySchema.parse(input);
    const blockedBefore = dependsOn ? this.dependenciesOf([id]) : undefined;
    if (dependsOn) replaceDependencies(this.db, current, dependsOn);
    const set: Partial<TicketRow> = { ...patch, updatedAt: new Date() };
    const reorderOnly =
      dependsOn === undefined &&
      Object.entries(patch).every(
        ([k, v]) => v === undefined || k === 'position' || (k === 'status' && v === current.status),
      );
    if (byPerson && current.externalTriage && !reorderOnly) set.externalTriage = false;
    // Moved to another column without an explicit slot: append at the bottom.
    if (patch.status && patch.status !== current.status && patch.position === undefined) {
      set.position = edgePosition(this.db, current.projectId, patch.status, 'bottom');
    }
    const ticket = this.publish(this.db.update(tickets).set(set).where(eq(tickets.id, id)).returning().get());
    if ((patch.status && patch.status !== current.status) || (patch.title && patch.title !== current.title)) {
      this.publishDependents(id);
    }
    if (patch.status && patch.status !== current.status)
      this.emit('moved', ticket, current.status as TicketStatus);
    // A person closed a ticket by hand: the tickets waiting for it may start now (the whole queue
    // when the factory already chains this project); a plain board move starts nothing else.
    if (patch.status === 'done' && current.status !== 'done') {
      this.failedInARow.delete(current.projectId);
      this.dispatchUnblocked(current.projectId, dependentIds(this.db, id));
    } else if (blockedBefore && ticket.status !== 'done') {
      const freed = unblockedSince(this.db, [id], blockedBefore);
      if (freed.length > 0) this.dispatchUnblocked(current.projectId, freed);
    }
    return ticket;
  }

  /** `blockedBy` of the tickets waiting for `id` shows its status and title: republish them. */
  private publishDependents(id: string): void {
    this.publishTickets(dependentIds(this.db, id));
  }

  private publishTickets(ids: string[]): void {
    if (ids.length === 0) return;
    const rows = this.db.select().from(tickets).where(inArray(tickets.id, ids)).all();
    for (const ticket of this.withDependencies(rows)) this.emit('ticket', ticket);
  }

  /** Refused (`run_active`) while an agent is still working on the ticket, as the bulk delete refuses it. */
  remove(id: string): void {
    const row = this.row(id);
    const live = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.ticketId, id), liveRun()))
      .get();
    if (live) throw conflict(`an agent is still working on ${row.key}; stop its run first`, 'run_active');
    const waiting = dependentIds(this.db, id);
    const blockedBefore = this.dependenciesOf(waiting);
    // Its runs outlive it (ticketId goes null); a hold they had is nobody's to answer any more.
    for (const run of this.db.select({ id: runs.id }).from(runs).where(eq(runs.ticketId, id)).all()) {
      this.runs.note(run.id, 'ticket_removed', { key: row.key });
    }
    this.db.transaction((tx) => {
      tx.delete(tickets).where(eq(tickets.id, id)).run();
      // A person removed an imported ticket: label sync must not bring the issue back.
      if (row.externalSource && row.externalId) {
        tx.insert(issueTombstones)
          .values({
            projectId: row.projectId,
            externalSource: row.externalSource,
            externalId: row.externalId,
            createdAt: new Date(),
          })
          .onConflictDoNothing()
          .run();
      }
    });
    this.emit('removed', { id, projectId: row.projectId });
    // Their edge to it went with it (ON DELETE CASCADE).
    this.publishTickets(waiting);
    const freed = unblockedSince(this.db, waiting, blockedBefore);
    if (freed.length > 0) this.dispatchUnblocked(row.projectId, freed);
  }

  /**
   * Queues a run for the ticket on branch `emberline/<key>-<slug>`; the scheduler starts it when
   * a slot and quota are available. One live run per ticket.
   */
  async start(
    id: string,
    input: StartTicketBody,
    opts: {
      unattended?: boolean;
      /**
       * Appended after the dependency context (e.g. review feedback on an earlier run). A string is
       * clipped to fit the prompt limit; a function gets the room left and builds a section that
       * fits (it may throw to refuse the start).
       */
      extraPromptSection?: string | ((room: number) => string);
      /** The ticket's active run may be one of these when it is idle: it is stopped (system, `reason`) and replaced. */
      replaceIdleRun?: { ids: string[]; reason: string };
    } & ByPerson = {},
  ): Promise<{ ticket: Ticket; run: Run }> {
    const ticket = this.get(id);
    if (this.startingTickets.has(id)) throw conflict('this ticket already has a running agent');
    const active = this.runs.activeRunForTicket(id);
    if (active) {
      if (!opts.replaceIdleRun?.ids.includes(active.id))
        throw conflict('this ticket already has a running agent');
      if (active.state === 'rate_limited')
        throw conflict('the run is waiting for its quota — stop it or wait');
      if (active.state !== 'done' && active.state !== 'waiting_input') {
        throw conflict('the run is still working — stop it or wait');
      }
    }
    // Built before anything changes: a section that cannot be built refuses the start cleanly.
    const prompt = this.startPrompt(ticket, opts.extraPromptSection ?? '');
    // So is a mode the run's agent cannot honour (before an idle run is replaced).
    const request = this.runRequest(ticket, input, opts.unattended, prompt);
    this.runs.assertStartable(request.body, request.origin);
    // A person starting it is its triage; an unattended start never is.
    if (opts.byPerson && !opts.unattended && ticket.external?.triage) {
      this.db.update(tickets).set({ externalTriage: false }).where(eq(tickets.id, id)).run();
    }
    this.startingTickets.add(id);
    try {
      if (active && opts.replaceIdleRun)
        await this.runs.stop(active.id, { source: 'system', reason: opts.replaceIdleRun.reason });
      return await this.startUnguarded(ticket, input, opts.unattended, prompt);
    } finally {
      this.startingTickets.delete(id);
    }
  }

  private async startUnguarded(
    ticket: Ticket,
    input: StartTicketBody,
    unattended = false,
    prompt = this.startPrompt(ticket, ''),
  ): Promise<{ ticket: Ticket; run: Run }> {
    const id = ticket.id;
    const request = this.runRequest(ticket, input, unattended, prompt);
    const run = await this.scheduler.submit(request.body, request.origin);
    // A fresh run must signal again; the old completion would hand stale work to dependents. A
    // handoff successor or a resumed session continues the same work and does not come here.
    // moveToTop bumps updatedAt and broadcasts the ticket.
    if (ticket.completion) this.db.update(tickets).set({ completion: null }).where(eq(tickets.id, id)).run();
    return { ticket: this.moveToTop(id, 'in_progress'), run };
  }

  /** The run a ticket start submits. */
  private runRequest(
    ticket: Ticket,
    input: StartTicketBody,
    unattended: boolean | undefined,
    prompt: string,
  ): { body: CreateRunBody; origin: RunOrigin } {
    const { permissionMode, persona } = StartTicketBodySchema.parse(input);
    const tag = parseRouteTag(ticket.body ?? '');
    const slug = slugify(ticket.title).slice(0, 40).replace(/-+$/, '');
    return {
      body: {
        projectId: ticket.projectId,
        prompt,
        permissionMode,
        persona: persona ?? ticket.persona,
        ...(tag ? { agent: tag.agent as AgentId, model: tag.model as AgentModelId } : {}),
      },
      origin: {
        ticketId: ticket.id,
        ...(unattended ? { unattended: 'factory' as const } : {}),
        branch: `emberline/${ticket.key.toLowerCase()}${slug ? `-${slug}` : ''}`,
        title: `${ticket.key} ${ticket.title}`,
      },
    };
  }

  /**
   * The ticket prompt, what its finished direct dependencies handed over, then `extra` (review
   * feedback for a fresh attempt). Kept within the run prompt limit: `extra` is a person's direct
   * feedback, so it gets its room before the dependency context. A string is clipped (never
   * refused); a function builds its section for the room it is given.
   */
  private startPrompt(ticket: Ticket, extra: string | ((room: number) => string)): string {
    const base = this.promptWithExistingTickets(ticket, ticketPrompt(ticket));
    const extraRoom = Math.max(0, RUN_PROMPT_MAX - base.length - 2);
    const built = (typeof extra === 'function' ? extra(extraRoom) : extra).trim();
    const section = built && extraRoom > 1 ? clipText(built, extraRoom) : '';
    const reserved = section ? section.length + 2 : 0;
    const withDeps = this.promptWithDependencyContext(ticket, base, RUN_PROMPT_MAX - reserved);
    return section ? `${withDeps}\n\n${section}` : withDeps;
  }

  /** A planning (`product_owner`) ticket's prompt plus the project's other tickets, so it writes no duplicates. */
  private promptWithExistingTickets(ticket: Ticket, base: string): string {
    if (ticket.persona !== 'product_owner') return base;
    const rows = this.db
      .select({ key: tickets.key, title: tickets.title, status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.projectId, ticket.projectId), ne(tickets.id, ticket.id)))
      .orderBy(desc(tickets.createdAt))
      .all();
    const room = Math.min(EXISTING_TICKETS_MAX, RUN_PROMPT_MAX - base.length - 2);
    const section = room > 0 ? existingTicketsSection(rows, room) : '';
    return section ? `${base}\n\n${section}` : base;
  }

  /**
   * The ticket prompt plus what its finished direct dependencies handed over (summary, handoff),
   * for every agent. Kept within `max` (the run prompt limit).
   */
  private promptWithDependencyContext(ticket: Ticket, base: string, max: number): string {
    if (ticket.dependsOn.length === 0) return base;
    const finished = this.db
      .select({ key: tickets.key, title: tickets.title, completion: tickets.completion })
      .from(tickets)
      .where(inArray(tickets.id, ticket.dependsOn))
      .all()
      .flatMap((dep) =>
        dep.completion ? [{ key: dep.key, title: dep.title, completion: dep.completion }] : [],
      );
    const room = Math.min(DEPENDENCY_SECTION_MAX, max - base.length - 2);
    const section = room > 0 ? dependencyContextSection(finished, room) : '';
    return section ? `${base}\n\n${section}` : base;
  }

  /**
   * Sends a follow-up prompt (Review -> In progress): typed into the live session, or, when the
   * latest run's process has ended, delivered by resuming its Claude session.
   */
  async prompt(id: string, text: string): Promise<{ ticket: Ticket; run: Run }> {
    const ticket = this.get(id);
    const active = this.runs.activeRunForTicket(id);
    let run: Run;
    if (active && !active.endedAt && active.state !== 'queued') {
      // Typed into the live session, or a one-shot CLI that has exited is respawned with it.
      run = await this.runs.prompt(active.id, text);
    } else if (active?.state === 'queued') {
      throw conflict('the agent has not started yet; it is queued');
    } else if (active) {
      // Rate limited with its process gone: continue it now with this prompt.
      run = await this.runs.resume(active.id, text);
    } else {
      const latest = this.runs.latestRunForTicket(id);
      if (!latest?.resumable) throw conflict('no agent session to continue for this ticket; start a new run');
      run = await this.runs.resume(latest.id, text);
    }
    return { ticket: ticket.status === 'in_progress' ? ticket : this.moveToTop(id, 'in_progress'), run };
  }

  private followRun(ticketId: string, state: Run['state']): void {
    const row = this.db.select().from(tickets).where(eq(tickets.id, ticketId)).get();
    const target = row ? columnForRun(row.status as TicketStatus, state) : null;
    if (target) this.moveToTop(ticketId, target);
  }

  private moveToTop(id: string, status: TicketStatus): Ticket {
    const row = this.row(id);
    const position = edgePosition(this.db, row.projectId, status, 'top');
    const ticket = this.publish(
      this.db
        .update(tickets)
        .set({ status, position, updatedAt: new Date() })
        .where(eq(tickets.id, id))
        .returning()
        .get(),
    );
    if (status !== row.status) this.publishDependents(id);
    if (status === 'done') this.failedInARow.delete(row.projectId);
    if (status !== row.status) this.emit('moved', ticket, row.status as TicketStatus);
    return ticket;
  }

  private publish(row: TicketRow): Ticket {
    const ticket = this.withDependencies([row])[0] as Ticket;
    this.emit('ticket', ticket);
    return ticket;
  }

  private row(id: string): TicketRow {
    const row = this.db.select().from(tickets).where(eq(tickets.id, id)).get();
    if (!row) throw notFound('no such ticket');
    return row;
  }

  private project(id: string) {
    const project = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) throw notFound('no such project');
    return project;
  }
}
