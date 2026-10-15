/** API contracts: live events (`/api/events` WebSocket). */
import { z } from 'zod';
import { Run } from './runs.js';
import { SchedulerState } from './scheduler.js';
import { Ticket } from './tickets.js';

/** Core -> browser push channel. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), run: Run }),
  z.object({ type: z.literal('run_removed'), id: z.string() }),
  z.object({ type: z.literal('ticket'), ticket: Ticket }),
  z.object({ type: z.literal('ticket_removed'), id: z.string(), projectId: z.string() }),
  z.object({ type: z.literal('scheduler'), scheduler: SchedulerState }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
