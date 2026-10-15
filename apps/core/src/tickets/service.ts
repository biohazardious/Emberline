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
import { and, asc, eq, max, min } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, tickets } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import {
  auditWorktreeSlop,
  buildFactoryOrchestratorPrompt,
  buildWorkspaceDemo,
  getFactorySettings,
  ingestAgentTicketsFile,
  persistFactoryAttachments,
  resolveAgentForPersona,
  runCrossProviderCritic,
  syncWorktreeToMainWorkspace,
} from '../factory/service.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { slugify } from '../routes/projects.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

type TicketRow = typeof tickets.$inferSelect;

interface TicketServiceEvents {
  ticket: [ticket: Ticket];
  removed: [ticket: { id: string; projectId: string }];
}

/** Gap between neighbours so most moves need a single row update. */
const POSITION_STEP = 1024;

export const toTicket = (row: TicketRow): Ticket => ({
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
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

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

export class TicketService extends EventEmitter<TicketServiceEvents> {
  private readonly autoChainProjects = new Set<string>();
  private readonly selfHealedRuns = new Set<string>();
  private readonly slopHealedRuns = new Set<string>();
  private readonly criticReviewedRuns = new Set<string>();
  private readonly autoNudgedRuns = new Set<string>();
  private readonly dispatchLock = new KeyedMutex();
  /** Tickets whose start() is between its active-run check and the run being recorded. */
  private readonly startingTickets = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly scheduler: Scheduler,
  ) {
    super();
    this.setMaxListeners(0);
    runs.on('run', (run, stateChanged) => {
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
        !this.autoNudgedRuns.has(run.id)
      ) {
        this.autoNudgedRuns.add(run.id);
        void this.runs
          .sendPrompt(
            run.id,
            'Autonomous Factory Mode: Proceed automatically using the simplest self-contained local option that satisfies PROJECT.md. Do not wait for user confirmation.',
          )
          .catch(() => undefined);
      }
      if (stateChanged && run.state === 'done' && run.projectId) {
        this.handleRunCompleted(run).catch((error: unknown) => {
          // The pipeline is best effort per run; record why it stopped instead of crashing core.
          this.runs.note(run.id, 'pipeline_failed', { message: (error as Error).message?.slice(0, 500) });
        });
      }
    });
  }

  factorySettings(): FactorySettings {
    return getFactorySettings(this.db);
  }

  isAutoChainActive(projectId: string): boolean {
    return this.autoChainProjects.has(projectId);
  }

  setAutoChain(projectId: string, enabled: boolean): void {
    if (enabled) this.autoChainProjects.add(projectId);
    else this.autoChainProjects.delete(projectId);
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
      body: buildFactoryOrchestratorPrompt(body.prompt, body.autoDispatch, attachmentContext),
      persona: body.leadPersona,
      priority: 3,
      status: 'ready',
    });
    if (body.autoDispatch) {
      this.autoChainProjects.add(projectId);
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
   * Creates 1..N specialist tickets delegated by an agent (via `.emberline/new-tickets.json`
   * or `POST /api/internal/agent/tickets`) and optionally starts the sequential pipeline.
   */
  async createDelegatedTickets(projectId: string, payload: AgentCreateTicketsPayload): Promise<Ticket[]> {
    this.project(projectId);
    const parsed = AgentCreateTicketsPayloadSchema.parse(payload);
    const created: Ticket[] = [];
    for (const draft of parsed.tickets) {
      let body = draft.body ?? '';
      if ((draft.preferredAgent || draft.preferredModel) && !body.includes('[Preferred Agent:')) {
        const agentStr = draft.preferredAgent ?? 'claude';
        const modelStr = draft.preferredModel ?? 'auto';
        body = `${body}\n\n[Preferred Agent: ${agentStr} · Model: ${modelStr}]`.trim();
      }
      created.push(
        this.create(projectId, {
          title: draft.title,
          body,
          persona: draft.persona,
          priority: draft.priority,
          status: 'ready',
        }),
      );
    }
    if (parsed.autoDispatch && created.length > 0) {
      this.autoChainProjects.add(projectId);
      await this.dispatchNextReadyTicket(projectId);
    }
    return created;
  }

  /**
   * Starts the highest-priority `ready` (or `backlog` when `autoPickupBacklog` is enabled) ticket
   * for `projectId` if no run is currently active on the project.
   */
  dispatchNextReadyTicket(projectId: string): Promise<{ ticket: Ticket; run: Run } | null> {
    // Check-then-start spans several awaits; two completions (or a click) must not both dispatch.
    return this.dispatchLock.run(projectId, () => this.dispatchNextReadyTicketUnlocked(projectId));
  }

  private async dispatchNextReadyTicketUnlocked(projectId: string): Promise<{ ticket: Ticket; run: Run } | null> {
    const projectRuns = this.runs.list().filter((r) => r.projectId === projectId);
    const hasActive = projectRuns.some(
      (r) =>
        r.state === 'queued' ||
        r.state === 'starting' ||
        r.state === 'working' ||
        r.state === 'waiting_input' ||
        r.state === 'rate_limited',
    );
    if (hasActive) return null;

    const fSettings = getFactorySettings(this.db);
    const projectRow = this.project(projectId);
    const allTickets = this.list(projectId);

    // S16: a daily run budget per project stops an auto-chaining factory from draining the quota.
    if (this.dailyBudgetExhausted(projectId, fSettings.maxAutoRunsPerProjectPerDay)) {
      this.autoChainProjects.delete(projectId);
      return null;
    }

    // Finalize any tickets left in 'review' with a completed run (e.g. if core restarted mid-pipeline)
    if (fSettings.autoMoveToDone) {
      for (const reviewTicket of allTickets.filter((t) => t.status === 'review')) {
        const latestRun = this.runs.latestRunForTicket(reviewTicket.id);
        if (latestRun && latestRun.state === 'done') {
          if (
            fSettings.autoSyncToMain &&
            latestRun.worktreePath &&
            latestRun.worktreePath !== projectRow.path
          ) {
            const merged = await this.mergeRunIntoMain(latestRun, projectRow.path, reviewTicket.key);
            if (!merged) continue;
          }
          try {
            this.moveToTop(reviewTicket.id, 'done');
          } catch {
            // ignore
          }
        }
      }
    }

    const readyTickets = allTickets
      .filter((t) => t.status === 'ready')
      .sort((a, b) => b.priority - a.priority || a.position - b.position);

    let next = readyTickets[0];
    if (!next && fSettings.autoPickupBacklog) {
      const backlogTickets = allTickets
        .filter((t) => t.status === 'backlog')
        .sort((a, b) => b.priority - a.priority || a.position - b.position);
      next = backlogTickets[0];
    }

    if (!next) {
      this.autoChainProjects.delete(projectId);
      return null;
    }

    this.autoChainProjects.add(projectId);
    return this.start(next.id, {
      permissionMode: 'auto',
      persona: next.persona,
    });
  }

  private async handleRunCompleted(run: Run): Promise<void> {
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
        await this.runs.stop(run.id).catch(() => undefined);
      }
      return;
    }

    const ticketRow = run.ticketId
      ? this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get()
      : undefined;

    // 1. Check if the agent wrote `.emberline/new-tickets.json` in its worktree or main workspace
    const fromWorktree = run.worktreePath ? await ingestAgentTicketsFile(run.worktreePath) : null;
    const fromMain =
      !fromWorktree && projectRow.path !== run.worktreePath
        ? await ingestAgentTicketsFile(projectRow.path)
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
          this.create(
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
        } catch (error) {
          // The drafts file is already consumed: skip the bad draft, keep the others.
          this.runs.note(run.id, 'ticket_draft_rejected', {
            title: draft.title.slice(0, 200),
            message: (error as Error).message.slice(0, 500),
          });
        }
      }
      if (ingested.autoDispatch) {
        this.autoChainProjects.add(run.projectId);
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
      !this.autoNudgedRuns.has(run.id) &&
      (!run.endedAt || run.resumable)
    ) {
      this.autoNudgedRuns.add(run.id);
      await this.runs
        .prompt(
          run.id,
          'Autonomous Factory Mode: Do not ask clarifying questions or wait for user confirmation. Choose the simplest self-contained local option (e.g., localStorage / existing stack in PROJECT.md), update PROJECT.md, and write .emberline/new-tickets.json now so the specialist pipeline can start.',
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

    const isFactoryRun =
      this.autoChainProjects.has(run.projectId) ||
      Boolean(ingested) ||
      isFactoryOrchestratorTicket ||
      hasFactoryPipeline;
    if (!isFactoryRun) return;

    if (fSettings.autoPickupReady) {
      this.autoChainProjects.add(run.projectId);
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
        const errorExcerpt = buildRes.output.slice(-2_400);
        await this.runs
          .prompt(
            run.id,
            `[Self-Healing Build, Lint & Test Gate] Automated verification (build / lint / unit tests) failed:\n\n\`\`\`\n${errorExcerpt}\n\`\`\`\n\nPlease fix the compiler, linter, or unit test failures above and verify all checks pass cleanly before finishing.`,
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

      if (
        (hasSecretViolation || hasSlopViolation) &&
        slopReport?.autoFixPrompt &&
        !this.slopHealedRuns.has(run.id) &&
        (!run.endedAt || run.resumable)
      ) {
        this.slopHealedRuns.add(run.id);
        await this.runs.prompt(run.id, slopReport.autoFixPrompt).catch(() => undefined);
        return;
      }

      if (hasSecretViolation) {
        secretGuardBlockedMerge = true;
      }
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
        await this.runs.prompt(run.id, criticRes.followUpPrompt).catch(() => undefined);
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
      mergeBlocked = !(await this.mergeRunIntoMain(run, projectRow.path, ticketRow?.key ?? null));
    }

    // 4. Auto-move completed factory ticket to Done when enabled (keep it in Review when the merge was
    //    blocked by Secret Guard or refused because of conflicts, so a human resolves it).
    if (!mergeBlocked && fSettings.autoMoveToDone && run.ticketId) {
      try {
        this.moveToTop(run.ticketId, 'done');
      } catch {
        // ignore if ticket was removed
      }
    }

    // 5. Close the idle interactive CLI process for this completed factory step so it does not
    //    linger at the `>` prompt or fire idle notifications.
    if (!run.endedAt) {
      await this.runs.stop(run.id).catch(() => undefined);
    }

    // 6. Dispatch the next specialist ticket in the project's queue if auto-chaining is active
    if (this.autoChainProjects.has(run.projectId) && fSettings.autoPickupReady) {
      await this.dispatchNextReadyTicket(run.projectId).catch(() => undefined);
    }
  }

  /**
   * Merges a finished run's worktree into the main workspace. Failures are recorded on the run
   * (`merge_failed`) instead of thrown; returns whether the work landed in main.
   */
  private async mergeRunIntoMain(run: Run, mainWorkspacePath: string, ticketKey: string | null): Promise<boolean> {
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
    return res.ok;
  }

  list(projectId: string): Ticket[] {
    this.project(projectId);
    return this.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(asc(tickets.position))
      .all()
      .map(toTicket);
  }

  get(id: string): Ticket {
    return toTicket(this.row(id));
  }

  /** Runs created for the project in the last 24 hours. */
  runsLast24h(projectId: string): number {
    const since = Date.now() - 24 * 60 * 60_000;
    return this.runs.list().filter((r) => r.projectId === projectId && Date.parse(r.createdAt) >= since).length;
  }

  dailyBudgetExhausted(projectId: string, max = getFactorySettings(this.db).maxAutoRunsPerProjectPerDay): boolean {
    return max > 0 && this.runsLast24h(projectId) >= max;
  }

  /** Like {@link get}, but `undefined` instead of a 404 for a deleted ticket. */
  find(id: string): Ticket | undefined {
    const row = this.db.select().from(tickets).where(eq(tickets.id, id)).get();
    return row ? toTicket(row) : undefined;
  }

  /** `depth` is set by the factory for agent-created tickets; people always create depth 0. */
  create(projectId: string, input: CreateTicketBody, depth = 0): Ticket {
    const project = this.project(projectId);
    const body = CreateTicketBodySchema.parse(input);
    const now = new Date();
    const row = this.db.transaction((tx) => {
      const last = tx
        .select({ n: max(tickets.number) })
        .from(tickets)
        .where(eq(tickets.projectId, projectId))
        .get();
      const number = (last?.n ?? 0) + 1;
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
    const patch = UpdateTicketBodySchema.parse(input);
    const set: Partial<TicketRow> = { ...patch, updatedAt: new Date() };
    // Moved to another column without an explicit slot: append at the bottom.
    if (patch.status && patch.status !== current.status && patch.position === undefined) {
      set.position = this.edgePosition(current.projectId, patch.status, 'bottom');
    }
    return this.publish(this.db.update(tickets).set(set).where(eq(tickets.id, id)).returning().get());
  }

  remove(id: string): void {
    const row = this.row(id);
    this.db.delete(tickets).where(eq(tickets.id, id)).run();
    this.emit('removed', { id, projectId: row.projectId });
  }

  /**
   * Queues a run for the ticket on branch `emberline/<key>-<slug>`; the scheduler starts it when
   * a slot and quota are available. One live run per ticket.
   */
  async start(id: string, input: StartTicketBody): Promise<{ ticket: Ticket; run: Run }> {
    const ticket = this.get(id);
    if (this.runs.activeRunForTicket(id) || this.startingTickets.has(id)) {
      throw conflict('this ticket already has a running agent');
    }
    this.startingTickets.add(id);
    try {
      return await this.startUnguarded(ticket, input);
    } finally {
      this.startingTickets.delete(id);
    }
  }

  private async startUnguarded(ticket: Ticket, input: StartTicketBody): Promise<{ ticket: Ticket; run: Run }> {
    const id = ticket.id;
    const { permissionMode, persona } = StartTicketBodySchema.parse(input);
    const effectivePersona = persona ?? ticket.persona;
    const routeTagMatch = /\[Preferred Agent:\s*([a-z0-9_-]+)\s*·\s*Model:\s*([a-z0-9_-]+)\]/i.exec(
      ticket.body ?? '',
    );
    const preferredAgent = routeTagMatch?.[1] as AgentId | undefined;
    const preferredModel = routeTagMatch?.[2] as AgentModelId | undefined;
    const slug = slugify(ticket.title).slice(0, 40).replace(/-+$/, '');
    const run = await this.scheduler.submit(
      {
        projectId: ticket.projectId,
        prompt: ticketPrompt(ticket),
        permissionMode,
        persona: effectivePersona,
        agent: resolveAgentForPersona(this.db, effectivePersona, preferredAgent),
        model: preferredModel,
      },
      {
        ticketId: id,
        branch: `emberline/${ticket.key.toLowerCase()}${slug ? `-${slug}` : ''}`,
        title: `${ticket.key} ${ticket.title}`,
      },
    );
    return { ticket: this.moveToTop(id, 'in_progress'), run };
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
    return this.publish(
      this.db.update(tickets).set({ status, position, updatedAt: new Date() }).where(eq(tickets.id, id)).returning().get(),
    );
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
    const ticket = toTicket(row);
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
