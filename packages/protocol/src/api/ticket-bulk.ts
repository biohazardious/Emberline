/** API contracts: one action applied to several tickets of a board at once. */
import { z } from 'zod';
import { AgentPersona } from './projects.js';
import { Ticket, TicketPriority, TicketStatus } from './tickets.js';

/** Most tickets one bulk request may name; the board's selection stops at the same number. */
export const BULK_TICKET_LIMIT = 100;

const BulkTicketIds = z.array(z.string().trim().min(1).max(60)).min(1).max(BULK_TICKET_LIMIT);

/**
 * `POST /api/projects/:projectId/tickets/bulk`. Each ticket is applied on its own: one that cannot
 * take the action lands in `failed` and leaves the others untouched.
 */
export const BulkTicketBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), ids: BulkTicketIds, status: TicketStatus }).strict(),
  z.object({ action: z.literal('priority'), ids: BulkTicketIds, priority: TicketPriority }).strict(),
  z.object({ action: z.literal('persona'), ids: BulkTicketIds, persona: AgentPersona }).strict(),
  z.object({ action: z.literal('delete'), ids: BulkTicketIds }).strict(),
]);
export type BulkTicketBody = z.infer<typeof BulkTicketBody>;
export type BulkTicketAction = BulkTicketBody['action'];

/**
 * Why a ticket was left as it was:
 * - `not_found`: no such ticket in this project;
 * - `run_active`: an agent is still working on it (stop the run first);
 * - `merge_required`: closing it would skip the merge of its run's branch (accept it from its drawer);
 * - `rejected`: the board refused the change (the message says why).
 */
export const BulkTicketFailureCode = z.enum(['not_found', 'run_active', 'merge_required', 'rejected']);
export type BulkTicketFailureCode = z.infer<typeof BulkTicketFailureCode>;

export const BulkTicketFailure = z.object({
  id: z.string(),
  /** Null when the id names no ticket of the project. */
  key: z.string().nullable(),
  code: BulkTicketFailureCode,
  message: z.string(),
});
export type BulkTicketFailure = z.infer<typeof BulkTicketFailure>;

export const BulkTicketResult = z.object({
  action: z.enum(['move', 'priority', 'persona', 'delete']),
  /** Tickets as they are after the change. */
  updated: z.array(Ticket),
  /** Ids of the deleted tickets. */
  removed: z.array(z.string()),
  /** Ids of tickets that already had the requested value. */
  unchanged: z.array(z.string()),
  failed: z.array(BulkTicketFailure),
});
export type BulkTicketResult = z.infer<typeof BulkTicketResult>;
