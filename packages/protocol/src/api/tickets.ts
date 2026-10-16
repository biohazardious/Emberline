/** API contracts: tickets / board. */
import { z } from 'zod';
import { AgentPersona, PermissionMode } from './projects.js';

/**
 * Board columns. A ticket with an active run sits in `in_progress` and shows the run's live
 * state (working / needs you / failed); `queued` arrives with the quota scheduler (M5).
 */
export const TicketStatus = z.enum(['backlog', 'ready', 'in_progress', 'review', 'done']);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** 0 = low ... 3 = urgent. */
export const TicketPriority = z.number().int().min(0).max(3);

export const Ticket = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Human key, e.g. "EMB-12"; stable once assigned. */
  key: z.string(),
  title: z.string(),
  body: z.string(),
  persona: AgentPersona,
  status: TicketStatus,
  priority: TicketPriority,
  /** Sort order inside a column (ascending). */
  position: z.number(),
  /** 0 for tickets people create; agent-created tickets are one deeper than the ticket that spawned them. */
  depth: z.number().int(),
  /** Ids of the tickets this one waits for. */
  dependsOn: z.array(z.string()).default([]),
  /** Dependencies that are not done yet. */
  blockedBy: z
    .array(z.object({ id: z.string(), key: z.string(), title: z.string(), status: TicketStatus }))
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const CreateTicketBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  persona: AgentPersona.default('coder'),
  priority: TicketPriority.default(1),
  status: TicketStatus.default('backlog'),
});
export type CreateTicketBody = z.input<typeof CreateTicketBody>;

export const UpdateTicketBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000),
    persona: AgentPersona,
    priority: TicketPriority,
    status: TicketStatus,
    position: z.number().finite(),
    /** Ticket ids or keys. */
    dependsOn: z.array(z.string().trim().min(1).max(60)).max(20),
  })
  .partial();
export type UpdateTicketBody = z.input<typeof UpdateTicketBody>;

export const StartTicketBody = z.object({
  permissionMode: PermissionMode.default('default'),
  persona: AgentPersona.optional(),
});
export type StartTicketBody = z.input<typeof StartTicketBody>;

/** Follow-up prompt typed into the ticket's live run. */
export const TicketPromptBody = z.object({ text: z.string().trim().min(1).max(20_000) });
export type TicketPromptBody = z.input<typeof TicketPromptBody>;
