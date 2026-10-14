import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type AgentCreateTicketsPayload,
  AgentCreateTicketsPayload as AgentCreateTicketsPayloadSchema,
  type AgentPersona,
  type CreateTicketBody,
  CreateTicketBody as CreateTicketBodySchema,
  type FactoryRequestBody,
  FactoryRequestBody as FactoryRequestBodySchema,
  type FactoryRequestResponse,
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
  buildFactoryOrchestratorPrompt,
  ingestAgentTicketsFile,
  syncWorktreeToMainWorkspace,
} from '../factory/service.js';
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

/**
 * Board tickets. Starting a ticket creates a run on its own branch; afterwards the ticket's
 * column follows the run (working -> In progress, turn finished -> Review) unless the user
 * already moved it to Done.
 */
export class TicketService extends EventEmitter<TicketServiceEvents> {
  private readonly autoChainProjects = new Set<string>();

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
      if (stateChanged && run.state === 'done' && run.projectId) {
        void this.handleRunCompleted(run);
      }
    });
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
    this.project(projectId);
    const body = FactoryRequestBodySchema.parse(input);
    const firstLine = body.prompt.split('\n')[0]?.trim().slice(0, 120) || 'Feature Request';
    const ticket = this.create(projectId, {
      title: `[Factory] ${firstLine}`,
      body: buildFactoryOrchestratorPrompt(body.prompt, body.autoDispatch),
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
   * Creates 1..N specialist tickets delegated by an agent (via `.emberline/new-tickets.json`
   * or `POST /api/internal/agent/tickets`) and optionally starts the sequential pipeline.
   */
  async createDelegatedTickets(projectId: string, payload: AgentCreateTicketsPayload): Promise<Ticket[]> {
    this.project(projectId);
    const parsed = AgentCreateTicketsPayloadSchema.parse(payload);
    const created: Ticket[] = [];
    for (const draft of parsed.tickets) {
      created.push(
        this.create(projectId, {
          title: draft.title,
          body: draft.body,
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
   * Starts the highest-priority `ready` ticket for `projectId` if no run is currently active on the project.
   */
  async dispatchNextReadyTicket(projectId: string): Promise<{ ticket: Ticket; run: Run } | null> {
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

    const readyTickets = this.list(projectId)
      .filter((t) => t.status === 'ready')
      .sort((a, b) => b.priority - a.priority || a.position - b.position);

    const next = readyTickets[0];
    if (!next) {
      this.autoChainProjects.delete(projectId);
      return null;
    }

    this.autoChainProjects.add(projectId);
    return this.start(next.id, {
      permissionMode: 'acceptEdits',
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

    // 1. Check if the agent wrote `.emberline/new-tickets.json` in its worktree or main workspace
    const fromWorktree = run.worktreePath ? await ingestAgentTicketsFile(run.worktreePath) : null;
    const fromMain =
      !fromWorktree && projectRow.path !== run.worktreePath
        ? await ingestAgentTicketsFile(projectRow.path)
        : null;
    const ingested = fromWorktree ?? fromMain;

    if (ingested && ingested.tickets.length > 0) {
      for (const draft of ingested.tickets) {
        this.create(run.projectId, {
          title: draft.title,
          body: draft.body,
          persona: draft.persona,
          priority: draft.priority,
          status: 'ready',
        });
      }
      if (ingested.autoDispatch) {
        this.autoChainProjects.add(run.projectId);
      }
    }

    // 2. If auto-chaining is active (or agent spawned sub-tickets), sync worktree into main workspace
    //    so subsequent specialist personas branch off the updated codebase and Live Demo stays current!
    if (this.autoChainProjects.has(run.projectId) || Boolean(ingested)) {
      if (run.worktreePath && run.worktreePath !== projectRow.path) {
        const ticketRow = run.ticketId
          ? this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).get()
          : undefined;
        await syncWorktreeToMainWorkspace({
          worktreePath: run.worktreePath,
          mainWorkspacePath: projectRow.path,
          ticketKey: ticketRow?.key ?? null,
          runId: run.id,
        }).catch(() => undefined);
      }
    }

    // 3. Dispatch the next specialist ticket in the project's Ready queue if auto-chaining is active
    if (this.autoChainProjects.has(run.projectId)) {
      await this.dispatchNextReadyTicket(run.projectId).catch(() => undefined);
    }
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

  create(projectId: string, input: CreateTicketBody): Ticket {
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
    if (this.runs.activeRunForTicket(id)) throw conflict('this ticket already has a running agent');
    const { permissionMode, persona } = StartTicketBodySchema.parse(input);
    const slug = slugify(ticket.title).slice(0, 40).replace(/-+$/, '');
    const run = await this.scheduler.submit(
      {
        projectId: ticket.projectId,
        prompt: ticketPrompt(ticket),
        permissionMode,
        persona: persona ?? ticket.persona,
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
    if (active && active.state !== 'queued') {
      run = await this.runs.sendPrompt(active.id, text);
    } else if (active) {
      throw conflict('the agent has not started yet; it is queued');
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
