import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentCreateTicketsPayload,
  AgentCreateTicketsPayload as AgentCreateTicketsPayloadSchema,
  type AgentId,
  type AgentModelId,
  type AgentPersona,
  type CreateTicketBody,
  CreateTicketBody as CreateTicketBodySchema,
  type FactoryRequestBody,
  FactoryRequestBody as FactoryRequestBodySchema,
  type FactoryRequestResponse,
  type FactorySettings,
  type Run,
  type StartTicketBody,
  StartTicketBody as StartTicketBodySchema,
  type Ticket,
  type TicketStatus,
  type UpdateTicketBody,
  UpdateTicketBody as UpdateTicketBodySchema,
} from '@emberline/protocol';
import { and, asc, desc, eq, gt, inArray, lt, max, min } from 'drizzle-orm';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { projects, runEvents, settings, ticketDependencies, tickets } from '../db/schema.js';
import { conflict, HttpError, notFound } from '../errors.js';
import {
  auditWorktreeSlop,
  buildFactoryOrchestratorPrompt,
  buildWorkspaceDemo,
  conflictResolutionPrompt,
  getFactorySettings,
  ingestAgentTicketsFile,
  mainWorkspaceBranch,
  persistFactoryAttachments,
  runCrossProviderCritic,
  syncWorktreeToMainWorkspace,
} from '../factory/service.js';
import { type Edge, resolveBatchDependencies, wouldCreateCycle } from './dependencies.js';
import { DEPENDENCY_SECTION_MAX, dependencyContextSection } from './dependency-context.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { slugify } from '../routes/projects.js';
import { HOLD_ENDING_EVENTS, HOLD_EVENTS } from '../runs/hold-events.js';
import { providerAdapter } from '../runs/providers.js';
import { parseRouteTag } from '../runs/route.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

type TicketRow = typeof tickets.$inferSelect;

interface TicketServiceEvents {
  ticket: [ticket: Ticket];
  removed: [ticket: { id: string; projectId: string }];
}

/** Gap between neighbours so most moves need a single row update. */
const POSITION_STEP = 1024;

/** Run states that occupy one of a project's parallel ticket slots. */
const ACTIVE_RUN_STATES = new Set<Run['state']>(['queued', 'starting', 'working', 'waiting_input', 'rate_limited']);

type Blocker = Ticket['blockedBy'][number];

/** Settings key of the projects whose factory chain is on (JSON array of project ids). */
const ACTIVE_CHAINS_KEY = 'factory.activeChains';

/**
 * `finalizing`: a dispatch's Review finalization runs the pipeline of a completion whose own pass
 * was cut off (it finalizes the ticket even when the project is not chaining any more).
 */
interface PipelineOptions {
  finalizing?: boolean;
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

/** See {@link TicketService.dispatchNextReadyTicket}. */
interface DispatchOptions {
  only?: ReadonlySet<string>;
  chain?: boolean;
}

export const toTicket = (
  row: TicketRow,
  deps: { dependsOn: string[]; blockedBy: Blocker[] } = { dependsOn: [], blockedBy: [] },
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

/** Where a ticket belongs while its run is in `state`; null leaves it where it is. */
export function statusForRunState(state: Run['state']): TicketStatus | null {
  if (state === 'done') return 'review';
  if (
    state === 'queued' ||
    state === 'starting' ||
    state === 'working' ||
    state === 'waiting_input' ||
    state === 'rate_limited'
  ) {
    return 'in_progress';
  }
  return null; // failed: stays put and shows the failed run
}

function hasVerifiableBuildTarget(workspacePath: string): boolean {
  const pkgPath = path.join(workspacePath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const hasValidTest =
        typeof pkg.scripts?.test === 'string' && !pkg.scripts.test.includes('no test specified');
      if (
        pkg.scripts?.build ||
        pkg.scripts?.typecheck ||
        pkg.scripts?.check ||
        pkg.scripts?.lint ||
        hasValidTest
      ) {
        return true;
      }
    } catch {
      // ignore invalid package.json
    }
  }
  return (
    existsSync(path.join(workspacePath, 'Cargo.toml')) ||
    existsSync(path.join(workspacePath, 'go.mod')) ||
    existsSync(path.join(workspacePath, 'pyproject.toml')) ||
    existsSync(path.join(workspacePath, 'requirements.txt')) ||
    existsSync(path.join(workspacePath, 'setup.py')) ||
    existsSync(path.join(workspacePath, 'platformio.ini')) ||
    existsSync(path.join(workspacePath, 'src-tauri', 'Cargo.toml')) ||
    existsSync(path.join(workspacePath, 'pubspec.yaml')) ||
    existsSync(path.join(workspacePath, 'gradlew')) ||
    existsSync(path.join(workspacePath, 'android', 'gradlew')) ||
    existsSync(path.join(workspacePath, 'Makefile'))
  );
}

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

/** CreateRunBody's prompt limit: a ticket prompt plus its dependency context must stay within it. */
const RUN_PROMPT_MAX = 20_000;

export class TicketService extends EventEmitter<TicketServiceEvents> {
  /** Projects whose factory chain is on; a cache of {@link ACTIVE_CHAINS_KEY}, written through. */
  private readonly autoChainProjects: Set<string>;
  private readonly selfHealedRuns = new Set<string>();
  private readonly slopHealedRuns = new Set<string>();
  private readonly criticReviewedRuns = new Set<string>();
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
    runs.on('run', (run, stateChanged) => {
      // A handed-off run stopped for quota and a successor continues its work; it finished nothing.
      if (run.handedOffTo) return;
      if (run.ticketId) {
        if (stateChanged) this.followRun(run.ticketId, run.state);
        else if (run.lastEvent === 'prompt_sent') this.followRun(run.ticketId, 'working');
      }
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
    });
    // RunService stored the agent's completion on the ticket: show it on the Board right away.
    runs.on('note', (run, type) => {
      if (type !== 'ticket_complete' || !run.ticketId) return;
      const row = this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get();
      if (row) this.publish(row);
    });
  }

  /** Drops pending settle timers (shutdown, tests). */
  dispose(): void {
    for (const timer of this.settlingRuns.values()) clearTimeout(timer);
    this.settlingRuns.clear();
  }

  /**
   * Runs the completion pipeline once the run has stayed `done` for the settle window (R8). The
   * ticket already moved to Review; only gates and merge wait. A newer `done` of the same run
   * replaces the wait, so one finished turn gets at most one pass. A run whose process is gone
   * cannot wake up again and goes straight on.
   */
  private completeRunWhenSettled(run: Run): void {
    clearTimeout(this.settlingRuns.get(run.id));
    this.settlingRuns.delete(run.id);
    if (this.pipelineSettleMs <= 0 || run.endedAt) {
      this.completeRun(run);
      return;
    }
    const timer = setTimeout(() => {
      if (this.settlingRuns.get(run.id) !== timer) return;
      this.settlingRuns.delete(run.id);
      let fresh: Run;
      try {
        fresh = this.runs.getRun(run.id);
      } catch {
        return; // removed meanwhile
      }
      // Woke up again (its next Stop starts a new wait), or finished differently in the meantime.
      if (fresh.state !== 'done' || fresh.stateChangedAt !== run.stateChangedAt || fresh.handedOffTo) return;
      this.completeRun(fresh);
    }, this.pipelineSettleMs);
    timer.unref();
    this.settlingRuns.set(run.id, timer);
  }

  /** Runs the completion pipeline in the background; it is best effort per run. */
  private completeRun(run: Run, opts: PipelineOptions = {}): void {
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
        .where(and(eq(runEvents.runId, runId), inArray(runEvents.state, ['working', 'waiting_input', 'done'])))
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
          list.some((t) => startable.has(t.status) && t.blockedBy.length === 0)
        ) {
          seeded.add(id);
        }
      }
    }
    setSetting(this.db, ACTIVE_CHAINS_KEY, [...seeded]);
    return seeded;
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
   * After a core restart: dispatches every project whose chain was on, so the factory carries on
   * (and finalizes Review tickets a pipeline left behind) without a person pressing "Run pipeline".
   */
  async resumeChains(): Promise<void> {
    if (!getFactorySettings(this.db).autoPickupReady) return;
    const known = new Set(this.db.select({ id: projects.id }).from(projects).all().map((p) => p.id));
    const resumed: Promise<unknown>[] = [];
    for (const projectId of [...this.autoChainProjects]) {
      if (known.has(projectId)) resumed.push(this.dispatchNextReadyTicket(projectId).catch(() => undefined));
      else this.chainOff(projectId);
    }
    await Promise.all(resumed);
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
    this.db.delete(settings).where(eq(settings.key, ticketSeqKey(projectId))).run();
  }

  setAutoChain(projectId: string, enabled: boolean): void {
    if (enabled) this.chainOn(projectId);
    else this.chainOff(projectId);
  }

  /**
   * High-level AI Coding Factory request: creates a Lead Persona (e.g. Product Owner) ticket
   * that refines the user's request, writes `.emberline/new-tickets.json` for specialist personas
   * (`coder`, `ui_ux`, `dba`, `qa`), and chains them automatically.
   */
  async submitFactoryRequest(projectId: string, input: FactoryRequestBody): Promise<FactoryRequestResponse> {
    const projectRow = this.project(projectId);
    const body = FactoryRequestBodySchema.parse(input);
    const attachmentContext =
      body.attachments && body.attachments.length > 0
        ? await persistFactoryAttachments(projectRow.path, body.attachments)
        : '';
    const firstLine = body.prompt.split('\n')[0]?.trim().slice(0, 120) || 'Feature Request';
    const ticket = this.create(projectId, {
      title: `[Factory] ${firstLine}`,
      body: buildFactoryOrchestratorPrompt(
        body.prompt,
        body.autoDispatch,
        attachmentContext,
        getFactorySettings(this.db).maxParallelTicketsPerProject,
      ),
      persona: body.leadPersona,
      priority: 3,
      status: 'ready',
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
    const existing = this.runs.list().find(
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
  dispatchNextReadyTicket(projectId: string, opts: DispatchOptions = {}): Promise<{ ticket: Ticket; run: Run }[]> {
    // Check-then-start spans several awaits; two completions (or a click) must not both dispatch.
    return this.dispatchLock.run(projectId, () => this.dispatchNextReadyTicketUnlocked(projectId, opts));
  }

  /**
   * `ticketIds` may have just lost their last blocker through a person's change: a chaining project
   * dispatches its queue, any other project starts only those tickets.
   */
  private dispatchUnblocked(projectId: string, ticketIds: string[]): void {
    if (!getFactorySettings(this.db).autoPickupReady) return;
    const opts: DispatchOptions = this.autoChainProjects.has(projectId) ? {} : { only: new Set(ticketIds), chain: false };
    if (opts.only?.size === 0) return;
    void this.dispatchNextReadyTicket(projectId, opts).catch(() => undefined);
  }

  /** Of `ids`, those blocked in `before` that nothing blocks any more. */
  private nowUnblocked(ids: string[], before: Map<string, { blockedBy: Ticket['blockedBy'] }>): string[] {
    const after = this.dependenciesOf(ids);
    return ids.filter((id) => (before.get(id)?.blockedBy.length ?? 0) > 0 && after.get(id)?.blockedBy.length === 0);
  }

  /** Active runs working on one of the project's tickets; ticket-less runs never count. */
  private busyTicketRuns(projectId: string): number {
    return this.runs
      .list()
      .filter((r) => r.projectId === projectId && r.ticketId && !r.handedOffTo && ACTIVE_RUN_STATES.has(r.state)).length;
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
      for (const reviewTicket of this.list(projectId).filter((t) => t.status === 'review')) {
        const latestRun = this.runs.latestRunForTicket(reviewTicket.id);
        // A run whose own pipeline is still going (gates, merge) or waiting to settle is not left over.
        if (
          !latestRun ||
          latestRun.state !== 'done' ||
          latestRun.handedOffTo ||
          this.pipelineRuns.has(latestRun.id) ||
          this.settlingRuns.has(latestRun.id)
        ) {
          continue;
        }
        // A run still resolving its conflict is finished by its own pipeline when it stops again.
        if (!latestRun.endedAt && this.conflictResolutionRequested(latestRun.id)) continue;
        const outcome = this.pipelineOutcome(latestRun.id);
        // A gate left it here for a person (secret guard, build gate, a merge that failed): not
        // leftover work, and not a merge to retry on every dispatch.
        if (outcome === 'held') continue;
        if (outcome === 'merged') {
          // Merged, but the move to Done was cut off.
          try {
            this.moveToTop(reviewTicket.id, 'done');
          } catch {
            // ignore
          }
          continue;
        }
        // The pipeline of this completion never got to its end (e.g. core went down mid-way): run it
        // again so its gates apply instead of merging behind them. Once per process; not awaited,
        // since its own dispatch waits for this one.
        if (this.resumedPipelines.has(latestRun.id)) continue;
        this.resumedPipelines.add(latestRun.id);
        this.completeRun(latestRun, { finalizing: true });
      }
    }

    // Read after the finalization above: tickets it moved to Done may unblock others.
    const allTickets = this.list(projectId).filter((t) => !only || only.has(t.id));
    const byPriority = (a: Ticket, b: Ticket) => b.priority - a.priority || a.position - b.position;
    const queue = [
      ...allTickets.filter((t) => t.status === 'ready').sort(byPriority),
      ...(fSettings.autoPickupBacklog ? allTickets.filter((t) => t.status === 'backlog').sort(byPriority) : []),
    ];
    if (queue.length === 0) {
      // The chain ends only once its last ticket run is through: a parallel sibling still working
      // must be merged and moved to Done by its own pipeline when it finishes.
      if (chain && this.busyTicketRuns(projectId) === 0) this.chainOff(projectId);
      return [];
    }
    if (chain) this.chainOn(projectId);

    const started: { ticket: Ticket; run: Run }[] = [];
    for (const next of queue) {
      if (next.blockedBy.length > 0) continue;
      if (this.busyTicketRuns(projectId) >= fSettings.maxParallelTicketsPerProject) break;
      // The budget counts every run started in this pass too.
      if (this.dailyBudgetExhausted(projectId, fSettings.maxAutoRunsPerProjectPerDay)) {
        this.chainOff(projectId);
        break;
      }
      if (this.runs.activeRunForTicket(next.id) || this.startingTickets.has(next.id)) continue;
      try {
        started.push(await this.start(next.id, { permissionMode: 'auto', persona: next.persona }, { unattended: true }));
      } catch (error) {
        // Someone started it by hand in the meantime: take the next one.
        if (error instanceof HttpError && error.statusCode === 409) continue;
        throw error;
      }
    }
    return started;
  }

  private async handleRunCompleted(run: Run, opts: PipelineOptions = {}): Promise<void> {
    // With parallel tickets another run's dispatch may finalize Review tickets meanwhile; it must
    // not merge this run before its gates have passed.
    // Counted: an overlapping pass for the same run must not lift the guard while one is still going.
    this.pipelineRuns.set(run.id, (this.pipelineRuns.get(run.id) ?? 0) + 1);
    try {
      await this.runPipeline(run, opts);
    } finally {
      const left = (this.pipelineRuns.get(run.id) ?? 1) - 1;
      if (left > 0) this.pipelineRuns.set(run.id, left);
      else this.pipelineRuns.delete(run.id);
    }
  }

  private async runPipeline(run: Run, { finalizing = false }: PipelineOptions): Promise<void> {
    if (!run.projectId) return;
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
        await this.runs.stop(run.id, { source: 'system', reason: 'brainstorm_finished' }).catch(() => undefined);
      }
      return;
    }

    const ticketRow = run.ticketId
      ? this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get()
      : undefined;

    // 1. Check if the agent wrote `.emberline/new-tickets.json` in its worktree or main workspace
    const rejected = (message: string) => this.runs.note(run.id, 'tickets_file_rejected', { message });
    const fromWorktree = run.worktreePath ? await ingestAgentTicketsFile(run.worktreePath, rejected) : null;
    const fromMain =
      !fromWorktree && projectRow.path !== run.worktreePath
        ? await ingestAgentTicketsFile(projectRow.path, rejected)
        : null;
    const ingested = fromWorktree ?? fromMain;

    const draftDepth = (ticketRow?.depth ?? 0) + 1;
    const fSettingsForDepth = getFactorySettings(this.db);
    if (ingested && ingested.tickets.length > 0 && draftDepth > fSettingsForDepth.maxTicketDepth) {
      // S16: agent tickets spawning agent tickets must not grow without bound.
      this.runs.note(run.id, 'ticket_depth_limit', {
        drafts: ingested.tickets.length,
        depth: draftDepth,
        maxTicketDepth: fSettingsForDepth.maxTicketDepth,
      });
    } else if (ingested && ingested.tickets.length > 0) {
      const created: { draft: (typeof ingested.tickets)[number]; ticket: Ticket }[] = [];
      for (const draft of ingested.tickets) {
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
        } catch (error) {
          // The drafts file is already consumed: skip the bad draft, keep the others.
          this.runs.note(run.id, 'ticket_draft_rejected', {
            title: draft.title.slice(0, 200),
            message: (error as Error).message.slice(0, 500),
          });
        }
      }
      this.applyDraftDependencies(run.id, run.projectId, created);
      if (ingested.autoDispatch) {
        this.chainOn(run.projectId);
      }
    }

    const isFactoryOrchestratorTicket = Boolean(
      ticketRow?.title.startsWith('[Factory]') && run.persona === 'product_owner',
    );

    // If a Factory Orchestrator (PO) stopped to ask a clarifying question without writing
    // `.emberline/new-tickets.json`, automatically reply once so it writes the tickets immediately.
    if (
      isFactoryOrchestratorTicket &&
      !ingested &&
      !this.runs.hasEvent(run.id, 'auto_nudged') &&
      (!run.endedAt || run.resumable)
    ) {
      this.runs.note(run.id, 'auto_nudged', { reason: 'no_ticket_drafts' });
      await this.runs
        .prompt(
          run.id,
          'Autonomous Factory Mode: Do not ask clarifying questions or wait for user confirmation. Choose the simplest self-contained local option (e.g., localStorage / existing stack in PROJECT.md), update PROJECT.md, and write .emberline/new-tickets.json now so the specialist pipeline can start.',
          { automatic: true },
        )
        .catch(() => undefined);
      return;
    }

    const fSettings = getFactorySettings(this.db);
    const projectTickets = this.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, run.projectId))
      .all();
    const hasFactoryPipeline =
      fSettings.autoPickupReady &&
      projectTickets.some((t) => t.title.startsWith('[Factory]') || t.status === 'ready');

    // A run an earlier pass left held stays a factory run: its next stop lifts the hold even when
    // the chain ended meanwhile (a dispatch with an empty queue does not count a held, `done` run).
    const isFactoryRun =
      finalizing ||
      this.autoChainProjects.has(run.projectId) ||
      Boolean(ingested) ||
      isFactoryOrchestratorTicket ||
      hasFactoryPipeline ||
      (ticketRow?.status !== 'done' && this.stillHeld(run.id));
    if (!isFactoryRun) return;

    // The gates, the merge and Done apply to every factory-looking run, but only the factory itself
    // turns the chain on: its orchestrator ticket (unless its tickets file asked not to dispatch) or
    // a chaining dispatch (already on). A ticket a person started, or one a narrow dispatch started
    // because a person's change unblocked it, does not start the rest of the queue when it finishes.
    if (fSettings.autoPickupReady && isFactoryOrchestratorTicket && ingested?.autoDispatch !== false) {
      this.chainOn(run.projectId);
    }

    // 1b. The agent's completion signal: a stop is not "done" unless the agent said so. Only for a
    //     run whose agent has the tool (its `emberline-mcp` checked in): a runner image without it,
    //     or a session started before the upgrade, advances the old way instead of stalling.
    if (
      fSettings.requireCompletionSignal &&
      ticketRow &&
      !isFactoryOrchestratorTicket &&
      this.hasCompletionTool(run) &&
      !(await this.completionGatePasses(run))
    ) {
      return;
    }

    // 2. Polyglot Self-Healing Build, Lint & Unit Test Gate: if enabled and the workspace has a
    //    verifiable build, lint, or test target (Node/TS, Python, Go, Rust, PlatformIO, or Makefile),
    //    verify it before syncing or moving to Done. If verification fails, resume the agent with the error log.
    if (
      fSettings.selfHealingBuildGate &&
      !this.selfHealedRuns.has(run.id) &&
      (!run.endedAt || run.resumable) &&
      run.worktreePath &&
      hasVerifiableBuildTarget(run.worktreePath)
    ) {
      this.selfHealedRuns.add(run.id);
      const buildRes = await buildWorkspaceDemo({
        projectId: run.projectId,
        targetId: run.id,
        workspacePath: run.worktreePath,
      }).catch((error: unknown) => {
        this.runs.note(run.id, 'build_gate_error', { message: (error as Error).message?.slice(0, 500) });
        return null;
      });
      // B17: a gate that could not run is not a pass; leave the ticket for a person.
      if (!buildRes) return;
      if (!buildRes.ok) {
        // Held for the agent's fix: its next stop runs the pipeline again (see HOLD_EVENTS).
        this.runs.note(run.id, 'build_gate_failed', {});
        const errorExcerpt = buildRes.output.slice(-2_400);
        await this.runs
          .prompt(
            run.id,
            `[Self-Healing Build, Lint & Test Gate] Automated verification (build / lint / unit tests) failed:\n\n\`\`\`\n${errorExcerpt}\n\`\`\`\n\nPlease fix the compiler, linter, or unit test failures above and verify all checks pass cleanly before finishing.${this.completeAgain(run, ' ')}`,
            { automatic: true },
          )
          .catch(() => undefined);
        return;
      }
    }

    // 2b. Layer 2 — Deterministic Anti-AI-Slop & Pre-Commit Secret Guard Gate:
    //     Scans git diff for leaked API keys/tokens/.env files, type evasion (`: any`, `@ts-ignore`),
    //     unfinished TODO/FIXME stubs, skipped tests, debug leftovers, and vibe-coding UI clichés.
    let secretGuardBlockedMerge = false;
    if (run.worktreePath && !isFactoryOrchestratorTicket) {
      const slopReport = await auditWorktreeSlop({
        runId: run.id,
        workspacePath: run.worktreePath,
      }).catch(() => null);

      const hasSecretViolation = Boolean(
        fSettings.secretGuardGate && slopReport && !slopReport.secretGuardPassed,
      );
      const hasSlopViolation = Boolean(
        fSettings.antiSlopGate &&
          slopReport &&
          slopReport.addedLinesAudited > 0 &&
          !slopReport.passed,
      );

      // Held first, also while the agent is asked to clean up: should the request not arrive, a
      // later dispatch must not merge the leak. The agent's next stop lifts the hold.
      if (hasSecretViolation) {
        this.runs.note(run.id, 'secret_guard_blocked', { secretLeakCount: slopReport?.secretLeakCount ?? 0 });
      }

      if (
        (hasSecretViolation || hasSlopViolation) &&
        slopReport?.autoFixPrompt &&
        !this.slopHealedRuns.has(run.id) &&
        (!run.endedAt || run.resumable)
      ) {
        this.slopHealedRuns.add(run.id);
        // Held before asking, like the secret guard: an undelivered request must not let a later merge through.
        if (!hasSecretViolation) this.runs.note(run.id, 'slop_guard_blocked', {});
        await this.runs.prompt(run.id, `${slopReport.autoFixPrompt}${this.completeAgain(run, '\n\n')}`, { automatic: true }).catch(() => undefined);
        return;
      }

      if (hasSecretViolation) secretGuardBlockedMerge = true;
    }

    // 2c. Layer 3 — Cross-Provider AI Critic (e.g. Claude codes -> Antigravity critiques, or vice versa):
    if (
      fSettings.crossProviderCritic &&
      run.worktreePath &&
      !isFactoryOrchestratorTicket &&
      !this.criticReviewedRuns.has(run.id)
    ) {
      this.criticReviewedRuns.add(run.id);
      const criticRes = await runCrossProviderCritic({
        run,
        ticketTitle: ticketRow?.title ?? run.title,
        ticketBody: ticketRow?.body ?? null,
        workspacePath: run.worktreePath,
        settings: fSettings,
      }).catch(() => null);

      if (
        criticRes &&
        criticRes.verdict === 'NEEDS_FIX' &&
        criticRes.followUpPrompt &&
        (!run.endedAt || run.resumable)
      ) {
        this.runs.note(run.id, 'critic_blocked', {});
        await this.runs.prompt(run.id, `${criticRes.followUpPrompt}${this.completeAgain(run, '\n\n')}`, { automatic: true }).catch(() => undefined);
        return;
      }
    }

    // 3. Auto-merge the worktree into the main workspace so subsequent specialist personas branch off
    //    the updated codebase and Live Demo stays current — UNLESS Secret Guard blocked a credential leak!
    let mergeBlocked = secretGuardBlockedMerge;
    if (
      !secretGuardBlockedMerge &&
      fSettings.autoSyncToMain &&
      run.worktreePath &&
      run.worktreePath !== projectRow.path
    ) {
      const merged = await this.mergeRunIntoMain(run, projectRow.path, ticketRow?.key ?? null);
      mergeBlocked = !merged.ok;
      // The agent gets one attempt to resolve the conflict itself; it is still alive and keeps the
      // ticket in Review. A later conflict (or a run that cannot take a prompt) falls through.
      if (
        !merged.ok &&
        merged.conflicts.length > 0 &&
        !run.endedAt &&
        !this.conflictResolutionRequested(run.id) &&
        (await this.requestConflictResolution(run, merged.conflicts, projectRow))
      ) {
        return;
      }
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
    //    linger at the `>` prompt or fire idle notifications.
    if (!run.endedAt) {
      await this.runs.stop(run.id, { source: 'system', reason: 'factory_step_finished' }).catch(() => undefined);
    }

    // 6. Dispatch the next specialist ticket in the project's queue if auto-chaining is active;
    //    otherwise start only the tickets that were waiting for this one (like a manual move to Done).
    if (this.autoChainProjects.has(run.projectId) && fSettings.autoPickupReady) {
      await this.dispatchNextReadyTicket(run.projectId).catch(() => undefined);
    } else if (movedToDone && run.ticketId) {
      this.dispatchUnblocked(run.projectId, this.dependentIds(run.ticketId));
    }
  }

  /**
   * Whether the run's agent has the `ticket_complete` tool: a Claude CLI whose `emberline-mcp`
   * checked in. Secondary CLIs never have it; neither has a Claude run on an older runner image.
   */
  private hasCompletionTool(run: Run): boolean {
    return providerAdapter(run.agent).claudeNative && this.runs.hasEvent(run.id, 'completion_tool_ready');
  }

  /** {@link COMPLETE_AGAIN} after `separator`, for a run whose agent has the tool; empty otherwise. */
  private completeAgain(run: Run, separator: string): string {
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
      const sent = await this.runs.prompt(run.id, COMPLETION_NUDGE, { automatic: true }).then(
        () => true,
        () => false,
      );
      // Undelivered, no next stop will come: it waits for a person now.
      if (!sent) this.runs.note(run.id, 'completion_missing', {});
      return false;
    }
    this.runs.note(run.id, 'completion_missing', {});
    return false;
  }

  /**
   * Merges a finished run's worktree into the main workspace. Failures are recorded on the run
   * (`merge_failed`) instead of thrown; returns whether the work landed in main.
   */
  private async mergeRunIntoMain(
    run: Run,
    mainWorkspacePath: string,
    ticketKey: string | null,
  ): Promise<{ ok: boolean; conflicts: string[] }> {
    const res = await syncWorktreeToMainWorkspace({
      worktreePath: run.worktreePath,
      mainWorkspacePath,
      ticketKey,
      runId: run.id,
    }).catch((error: unknown) => ({ ok: false, summary: (error as Error).message, conflicts: [] as string[] }));
    this.runs.note(run.id, res.ok ? 'merged_to_main' : 'merge_failed', {
      summary: res.summary,
      ...(res.conflicts.length > 0 ? { conflicts: res.conflicts } : {}),
    });
    return { ok: res.ok, conflicts: res.conflicts };
  }

  /**
   * What the run's latest completion pipeline (the one after its latest switch to `done`) decided:
   * `held` when it left the ticket in Review for a person (a HOLD_EVENTS note; a later turn of the
   * agent lifts it), `merged` when the work landed in main, null when it never got that far.
   */
  private pipelineOutcome(runId: string): 'held' | 'merged' | null {
    const lastDone = this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.state, 'done')))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    const types = this.db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          gt(runEvents.id, lastDone?.id ?? 0),
          inArray(runEvents.type, [...HOLD_EVENTS, 'merged_to_main']),
        ),
      )
      .all()
      .map((e) => e.type);
    if (types.some((type) => HOLD_EVENTS.includes(type))) return 'held';
    return types.includes('merged_to_main') ? 'merged' : null;
  }

  /**
   * Whether an earlier pipeline pass of this run left it held: of the pass outcomes recorded before
   * the run's latest switch to `done` (the current pass's own notes come after it), the newest is a
   * HOLD_EVENTS note, not a merge or an accepted completion signal. A hold that was later merged, or
   * whose agent later signalled completion (no merge follows when auto-sync and auto-Done are off),
   * does not count.
   */
  private stillHeld(runId: string): boolean {
    const lastDone = this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.state, 'done')))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    if (!lastDone) return false;
    const newest = this.db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          lt(runEvents.id, lastDone.id),
          inArray(runEvents.type, [...HOLD_EVENTS, ...HOLD_ENDING_EVENTS]),
        ),
      )
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    return Boolean(newest && HOLD_EVENTS.includes(newest.type));
  }

  /** Whether the run already got its one automatic conflict-resolution attempt (survives a restart). */
  private conflictResolutionRequested(runId: string): boolean {
    return Boolean(
      this.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'conflict_resolution_requested')))
        .limit(1)
        .get(),
    );
  }

  /** Types the conflict follow-up into the live session; false when the run cannot take a prompt. */
  private async requestConflictResolution(
    run: Run,
    conflicts: string[],
    project: { path: string; defaultBranch: string },
  ): Promise<boolean> {
    // The merge goes into whatever the main workspace has checked out; the column is the fallback.
    const branch = (await mainWorkspaceBranch(project.path)) ?? project.defaultBranch;
    const text = `${conflictResolutionPrompt(branch, conflicts)}${this.completeAgain(run, ' ')}`;
    try {
      await this.runs.sendPrompt(run.id, text, { automatic: true });
    } catch (error) {
      this.runs.note(run.id, 'conflict_resolution_failed', { conflicts, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    this.runs.note(run.id, 'conflict_resolution_requested', { conflicts });
    return true;
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

  get(id: string): Ticket {
    return this.withDependencies([this.row(id)])[0] as Ticket;
  }

  /** Dependencies of the given tickets with one query; `blockedBy` holds those not yet `done`. */
  dependenciesOf(ids: string[]): Map<string, { dependsOn: string[]; blockedBy: Ticket['blockedBy'] }> {
    const result = new Map<string, { dependsOn: string[]; blockedBy: Ticket['blockedBy'] }>();
    for (const id of ids) result.set(id, { dependsOn: [], blockedBy: [] });
    if (ids.length === 0) return result;
    const rows = this.db
      .select({
        ticketId: ticketDependencies.ticketId,
        id: tickets.id,
        key: tickets.key,
        title: tickets.title,
        status: tickets.status,
      })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.dependsOnId))
      .where(inArray(ticketDependencies.ticketId, ids))
      .orderBy(asc(ticketDependencies.createdAt), asc(tickets.number))
      .all();
    for (const r of rows) {
      const entry = result.get(r.ticketId);
      if (!entry) continue;
      entry.dependsOn.push(r.id);
      if (r.status !== 'done') {
        entry.blockedBy.push({ id: r.id, key: r.key, title: r.title, status: r.status as TicketStatus });
      }
    }
    return result;
  }

  private withDependencies(rows: TicketRow[]): Ticket[] {
    const deps = this.dependenciesOf(rows.map((r) => r.id));
    return rows.map((row) => toTicket(row, deps.get(row.id)));
  }

  private allEdges(projectId: string): Edge[] {
    return this.db
      .select({ ticketId: ticketDependencies.ticketId, dependsOnId: ticketDependencies.dependsOnId })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.ticketId))
      .where(eq(tickets.projectId, projectId))
      .all();
  }

  /** Resolves the batch's refs/keys (or the default tiers), stores the edges and notes the outcome on the run (if any). */
  private applyDraftDependencies(
    runId: string | null,
    projectId: string,
    created: { draft: { ref?: string; dependsOn?: string[] }; ticket: Ticket }[],
  ): void {
    if (created.length === 0) return;
    const note = (type: string, payload: Record<string, unknown>) => {
      if (runId) this.runs.note(runId, type, payload);
    };
    try {
      const batchIds = new Set(created.map((c) => c.ticket.id));
      const projectKeys = new Map<string, string>();
      for (const r of this.db.select({ id: tickets.id, key: tickets.key }).from(tickets).where(eq(tickets.projectId, projectId)).all()) {
        if (!batchIds.has(r.id)) projectKeys.set(r.key.toUpperCase(), r.id);
      }
      const { edges, dropped } = resolveBatchDependencies(
        created.map(({ draft, ticket }) => ({
          id: ticket.id,
          key: ticket.key,
          persona: ticket.persona,
          ...(draft.ref ? { ref: draft.ref } : {}),
          ...(draft.dependsOn ? { dependsOn: draft.dependsOn } : {}),
        })),
        projectKeys,
        this.allEdges(projectId),
      );
      const now = new Date();
      if (edges.length > 0) {
        this.db
          .insert(ticketDependencies)
          .values(edges.map((e) => ({ ticketId: e.ticketId, dependsOnId: e.dependsOnId, createdAt: now })))
          .onConflictDoNothing()
          .run();
      }
      const keyById = new Map<string, string>(created.map((c) => [c.ticket.id, c.ticket.key]));
      for (const r of this.db.select({ id: tickets.id, key: tickets.key }).from(tickets).where(eq(tickets.projectId, projectId)).all()) {
        keyById.set(r.id, r.key);
      }
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
    const since = Date.now() - 24 * 60 * 60_000;
    return this.runs.list().filter((r) => r.projectId === projectId && !r.predecessorRunId && Date.parse(r.createdAt) >= since).length;
  }

  dailyBudgetExhausted(projectId: string, max = getFactorySettings(this.db).maxAutoRunsPerProjectPerDay): boolean {
    return max > 0 && this.runsLast24h(projectId) >= max;
  }

  /** Like {@link get}, but `undefined` instead of a 404 for a deleted ticket. */
  find(id: string): Ticket | undefined {
    const row = this.db.select().from(tickets).where(eq(tickets.id, id)).get();
    return row ? this.withDependencies([row])[0] : undefined;
  }

  /** `depth` is set by the factory for agent-created tickets; people always create depth 0. */
  create(projectId: string, input: CreateTicketBody, depth = 0): Ticket {
    const project = this.project(projectId);
    const body = CreateTicketBodySchema.parse(input);
    const now = new Date();
    const row = this.db.transaction((tx) => {
      const seqKey = ticketSeqKey(projectId);
      const stored = tx.select({ value: settings.value }).from(settings).where(eq(settings.key, seqKey)).get()?.value;
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
          position: this.edgePosition(projectId, body.status, 'bottom'),
          depth,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    });
    return this.publish(row);
  }

  update(id: string, input: UpdateTicketBody): Ticket {
    const current = this.row(id);
    const { dependsOn, ...patch } = UpdateTicketBodySchema.parse(input);
    const blockedBefore = dependsOn ? this.dependenciesOf([id]) : undefined;
    if (dependsOn) this.replaceDependencies(current, dependsOn);
    const set: Partial<TicketRow> = { ...patch, updatedAt: new Date() };
    // Moved to another column without an explicit slot: append at the bottom.
    if (patch.status && patch.status !== current.status && patch.position === undefined) {
      set.position = this.edgePosition(current.projectId, patch.status, 'bottom');
    }
    const ticket = this.publish(this.db.update(tickets).set(set).where(eq(tickets.id, id)).returning().get());
    if ((patch.status && patch.status !== current.status) || (patch.title && patch.title !== current.title)) {
      this.publishDependents(id);
    }
    // A person closed a ticket by hand: the tickets waiting for it may start now (the whole queue
    // when the factory already chains this project); a plain board move starts nothing else.
    if (patch.status === 'done' && current.status !== 'done') {
      this.failedInARow.delete(current.projectId);
      this.dispatchUnblocked(current.projectId, this.dependentIds(id));
    } else if (blockedBefore && ticket.status !== 'done') {
      const freed = this.nowUnblocked([id], blockedBefore);
      if (freed.length > 0) this.dispatchUnblocked(current.projectId, freed);
    }
    return ticket;
  }

  /** `blockedBy` of the tickets waiting for `id` shows its status and title: republish them. */
  private publishDependents(id: string): void {
    this.publishTickets(this.dependentIds(id));
  }

  private dependentIds(id: string): string[] {
    return this.db
      .select({ ticketId: ticketDependencies.ticketId })
      .from(ticketDependencies)
      .where(eq(ticketDependencies.dependsOnId, id))
      .all()
      .map((r) => r.ticketId);
  }

  private publishTickets(ids: string[]): void {
    if (ids.length === 0) return;
    const rows = this.db.select().from(tickets).where(inArray(tickets.id, ids)).all();
    for (const ticket of this.withDependencies(rows)) this.emit('ticket', ticket);
  }

  /** Replaces the ticket's dependency set; validates everything before writing anything. */
  private replaceDependencies(current: TicketRow, refs: string[]): void {
    const siblings = this.db.select().from(tickets).where(eq(tickets.projectId, current.projectId)).all();
    const ids = new Set<string>();
    for (const ref of refs) {
      const hit = siblings.find((t) => t.id === ref) ?? siblings.find((t) => t.key.toUpperCase() === ref.toUpperCase());
      if (!hit) throw new HttpError(400, 'unknown_dependency', `no ticket "${ref}" in this project`);
      ids.add(hit.id);
    }
    const others = this.allEdges(current.projectId).filter((e) => e.ticketId !== current.id);
    const accepted: Edge[] = [];
    for (const dependsOnId of ids) {
      const edge = { ticketId: current.id, dependsOnId };
      if (wouldCreateCycle([...others, ...accepted], edge)) {
        throw new HttpError(409, 'dependency_cycle', 'a ticket cannot depend on itself, directly or through other tickets');
      }
      accepted.push(edge);
    }
    const now = new Date();
    this.db.transaction((tx) => {
      tx.delete(ticketDependencies).where(eq(ticketDependencies.ticketId, current.id)).run();
      if (accepted.length > 0) {
        tx.insert(ticketDependencies).values(accepted.map((e) => ({ ...e, createdAt: now }))).run();
      }
    });
  }

  remove(id: string): void {
    const row = this.row(id);
    const waiting = this.dependentIds(id);
    const blockedBefore = this.dependenciesOf(waiting);
    this.db.delete(tickets).where(eq(tickets.id, id)).run();
    this.emit('removed', { id, projectId: row.projectId });
    // Their edge to it went with it (ON DELETE CASCADE).
    this.publishTickets(waiting);
    const freed = this.nowUnblocked(waiting, blockedBefore);
    if (freed.length > 0) this.dispatchUnblocked(row.projectId, freed);
  }

  /**
   * Queues a run for the ticket on branch `emberline/<key>-<slug>`; the scheduler starts it when
   * a slot and quota are available. One live run per ticket.
   */
  async start(
    id: string,
    input: StartTicketBody,
    opts: { unattended?: boolean } = {},
  ): Promise<{ ticket: Ticket; run: Run }> {
    const ticket = this.get(id);
    if (this.runs.activeRunForTicket(id) || this.startingTickets.has(id)) {
      throw conflict('this ticket already has a running agent');
    }
    this.startingTickets.add(id);
    try {
      return await this.startUnguarded(ticket, input, opts.unattended);
    } finally {
      this.startingTickets.delete(id);
    }
  }

  private async startUnguarded(ticket: Ticket, input: StartTicketBody, unattended = false): Promise<{ ticket: Ticket; run: Run }> {
    const id = ticket.id;
    const { permissionMode, persona } = StartTicketBodySchema.parse(input);
    const effectivePersona = persona ?? ticket.persona;
    const tag = parseRouteTag(ticket.body ?? '');
    const slug = slugify(ticket.title).slice(0, 40).replace(/-+$/, '');
    const run = await this.scheduler.submit(
      {
        projectId: ticket.projectId,
        prompt: this.promptWithDependencyContext(ticket),
        permissionMode,
        persona: effectivePersona,
        ...(tag ? { agent: tag.agent as AgentId, model: tag.model as AgentModelId } : {}),
      },
      {
        ticketId: id,
        ...(unattended ? { unattended: 'factory' as const } : {}),
        branch: `emberline/${ticket.key.toLowerCase()}${slug ? `-${slug}` : ''}`,
        title: `${ticket.key} ${ticket.title}`,
      },
    );
    // A fresh run must signal again; the old completion would hand stale work to dependents. A
    // handoff successor or a resumed session continues the same work and does not come here.
    // moveToTop bumps updatedAt and broadcasts the ticket.
    if (ticket.completion) this.db.update(tickets).set({ completion: null }).where(eq(tickets.id, id)).run();
    return { ticket: this.moveToTop(id, 'in_progress'), run };
  }

  /**
   * The ticket prompt plus what its finished direct dependencies handed over (summary, handoff),
   * for every agent. Kept within the run prompt limit.
   */
  private promptWithDependencyContext(ticket: Ticket): string {
    const base = ticketPrompt(ticket);
    if (ticket.dependsOn.length === 0) return base;
    const finished = this.db
      .select({ key: tickets.key, title: tickets.title, completion: tickets.completion })
      .from(tickets)
      .where(inArray(tickets.id, ticket.dependsOn))
      .all()
      .flatMap((dep) => (dep.completion ? [{ key: dep.key, title: dep.title, completion: dep.completion }] : []));
    const room = Math.min(DEPENDENCY_SECTION_MAX, RUN_PROMPT_MAX - base.length - 2);
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
      run = await this.runs.sendPrompt(active.id, text);
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
    if (!row || row.status === 'done') return;
    const target = statusForRunState(state);
    if (target && target !== row.status) this.moveToTop(ticketId, target);
  }

  private moveToTop(id: string, status: TicketStatus): Ticket {
    const row = this.row(id);
    const position = this.edgePosition(row.projectId, status, 'top');
    const ticket = this.publish(
      this.db.update(tickets).set({ status, position, updatedAt: new Date() }).where(eq(tickets.id, id)).returning().get(),
    );
    if (status !== row.status) this.publishDependents(id);
    if (status === 'done') this.failedInARow.delete(row.projectId);
    return ticket;
  }

  private edgePosition(projectId: string, status: TicketStatus, edge: 'top' | 'bottom'): number {
    const where = and(eq(tickets.projectId, projectId), eq(tickets.status, status));
    if (edge === 'top') {
      const first = this.db.select({ p: min(tickets.position) }).from(tickets).where(where).get();
      return first?.p == null ? POSITION_STEP : first.p - POSITION_STEP;
    }
    const last = this.db.select({ p: max(tickets.position) }).from(tickets).where(where).get();
    return last?.p == null ? POSITION_STEP : last.p + POSITION_STEP;
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
