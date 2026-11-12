/** API contracts: live events (`/api/events` WebSocket). */
import { z } from 'zod';
import { Run } from './runs.js';
import { SchedulerState } from './scheduler.js';
import { Ticket } from './tickets.js';

/** An agent wrote a factory file core could not use; it is kept as `rejectedAs` for a look. */
export const ProjectNotice = z.object({
  kind: z.literal('agent_file_rejected'),
  projectId: z.string(),
  /** Workspace-relative path the agent wrote, e.g. `.emberline/roadmap-generated.json`. */
  file: z.string(),
  rejectedAs: z.string(),
  /** Why: the first validation issue, or the JSON syntax error. */
  issue: z.string(),
  at: z.string(),
});
export type ProjectNotice = z.infer<typeof ProjectNotice>;

/** Core -> browser push channel. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), run: Run }),
  z.object({ type: z.literal('run_removed'), id: z.string() }),
  z.object({ type: z.literal('ticket'), ticket: Ticket }),
  z.object({ type: z.literal('ticket_removed'), id: z.string(), projectId: z.string() }),
  z.object({ type: z.literal('scheduler'), scheduler: SchedulerState }),
  z.object({ type: z.literal('project_notice'), notice: ProjectNotice }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Browser -> core on the same socket: whether this client is looking, and at which run. */
export const ClientPresenceMessage = z.object({
  type: z.literal('presence'),
  visible: z.boolean(),
  runId: z.string().min(1).nullable(),
});
export type ClientPresenceMessage = z.infer<typeof ClientPresenceMessage>;
