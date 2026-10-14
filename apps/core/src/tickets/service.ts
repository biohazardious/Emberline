import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type CreateTicketBody,
  CreateTicketBody as CreateTicketBodySchema,
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
  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly scheduler: Scheduler,
  ) {
    super();
    this.setMaxListeners(0);
    runs.on('run', (run, stateChanged) => {
      if (!run.ticketId) return;
      if (stateChanged) this.followRun(run.ticketId, run.state);
      else if (run.lastEvent === 'prompt_sent') this.followRun(run.ticketId, 'working');
    });
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
    const { permissionMode } = StartTicketBodySchema.parse(input);
    const slug = slugify(ticket.title).slice(0, 40).replace(/-+$/, '');
    const run = await this.scheduler.submit(
      { projectId: ticket.projectId, prompt: ticketPrompt(ticket), permissionMode },
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
