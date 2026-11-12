import {
  type BulkTicketBody,
  type BulkTicketFailure,
  type BulkTicketResult,
  type Ticket,
  TicketStatus,
  type UpdateTicketBody,
} from '@emberline/protocol';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';
import { HttpError } from '../errors.js';

/** The ticket operations a bulk action is made of (TicketService). */
export interface BulkTicketBoard {
  list(projectId: string): Ticket[];
  get(id: string): Ticket;
  update(id: string, input: UpdateTicketBody, opts: { byPerson: boolean }): Ticket;
  remove(id: string): void;
}

interface RunFacts {
  live: boolean;
  branch: boolean;
}

const COLUMN_ORDER = new Map(TicketStatus.options.map((status, index) => [status, index]));
const boardOrder = (a: Ticket, b: Ticket) =>
  (COLUMN_ORDER.get(a.status) ?? 0) - (COLUMN_ORDER.get(b.status) ?? 0) || a.position - b.position;

function runFacts(db: Db, ticketIds: string[]): Map<string, RunFacts> {
  const facts = new Map<string, RunFacts>();
  if (ticketIds.length === 0) return facts;
  const rows = db
    .select({ ticketId: runs.ticketId, branch: runs.branch, endedAt: runs.endedAt })
    .from(runs)
    .where(inArray(runs.ticketId, ticketIds))
    .all();
  for (const row of rows) {
    if (!row.ticketId) continue;
    const seen = facts.get(row.ticketId) ?? { live: false, branch: false };
    facts.set(row.ticketId, {
      live: seen.live || row.endedAt === null,
      branch: seen.branch || Boolean(row.branch),
    });
  }
  return facts;
}

type Outcome = { kind: 'unchanged' } | { kind: 'refused'; failure: Omit<BulkTicketFailure, 'id' | 'key'> };

/** Whether `ticket` may take the action, before anything is written. */
function precheck(body: BulkTicketBody, ticket: Ticket, facts: RunFacts | undefined): Outcome | null {
  const live = facts?.live ?? false;
  switch (body.action) {
    case 'move':
      if (ticket.status === body.status) return { kind: 'unchanged' };
      if (live)
        return {
          kind: 'refused',
          failure: { code: 'run_active', message: `an agent is still working on ${ticket.key}` },
        };
      if (body.status === 'done' && facts?.branch)
        return {
          kind: 'refused',
          failure: {
            code: 'merge_required',
            message: `${ticket.key} has a run branch; accept it from its drawer so its work merges`,
          },
        };
      return null;
    case 'priority':
      return ticket.priority === body.priority ? { kind: 'unchanged' } : null;
    case 'persona':
      return ticket.persona === body.persona ? { kind: 'unchanged' } : null;
    case 'delete':
      return live
        ? {
            kind: 'refused',
            failure: { code: 'run_active', message: `an agent is still working on ${ticket.key}` },
          }
        : null;
  }
}

function patchOf(body: Exclude<BulkTicketBody, { action: 'delete' }>): UpdateTicketBody {
  switch (body.action) {
    case 'move':
      return { status: body.status };
    case 'priority':
      return { priority: body.priority };
    case 'persona':
      return { persona: body.persona };
  }
}

/**
 * Applies one action to several tickets of a project, each through the same path a single edit
 * takes (dependents republished, unblocked tickets dispatched). Tickets go in board order, so a
 * move keeps their relative order at the bottom of the target column.
 */
export function applyBulkTicketAction(
  db: Db,
  board: BulkTicketBoard,
  projectId: string,
  body: BulkTicketBody,
): BulkTicketResult {
  const all = board.list(projectId);
  const byRef = new Map<string, Ticket>();
  for (const ticket of all) {
    byRef.set(ticket.id, ticket);
    byRef.set(ticket.key.toUpperCase(), ticket);
  }

  const failed: BulkTicketFailure[] = [];
  const picked = new Map<string, Ticket>();
  for (const ref of body.ids) {
    const ticket = byRef.get(ref) ?? byRef.get(ref.toUpperCase());
    if (ticket) picked.set(ticket.id, ticket);
    else if (!failed.some((f) => f.id === ref))
      failed.push({ id: ref, key: null, code: 'not_found', message: `no ticket "${ref}" in this project` });
  }
  const targets = [...picked.values()].sort(boardOrder);
  const facts = runFacts(
    db,
    targets.map((t) => t.id),
  );

  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const ticket of targets) {
    const outcome = precheck(body, ticket, facts.get(ticket.id));
    if (outcome?.kind === 'unchanged') {
      unchanged.push(ticket.id);
      continue;
    }
    if (outcome?.kind === 'refused') {
      failed.push({ id: ticket.id, key: ticket.key, ...outcome.failure });
      continue;
    }
    try {
      if (body.action === 'delete') {
        board.remove(ticket.id);
        removed.push(ticket.id);
      } else {
        board.update(ticket.id, patchOf(body), { byPerson: true });
        changed.push(ticket.id);
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      failed.push({ id: ticket.id, key: ticket.key, code: 'rejected', message: error.message });
    }
  }

  // Later changes can touch earlier tickets (a dependency closed), so read them back at the end.
  return {
    action: body.action,
    updated: changed.map((id) => board.get(id)),
    removed,
    unchanged,
    failed,
  };
}
