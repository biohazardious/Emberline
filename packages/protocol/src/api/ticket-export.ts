/** API contracts: board export (`GET /api/projects/:projectId/tickets/export`). */
import { z } from 'zod';
import { AgentPersona } from './projects.js';
import { TicketPriority, TicketStatus } from './tickets.js';

export const TicketExportFormat = z.enum(['csv', 'json']);
export type TicketExportFormat = z.infer<typeof TicketExportFormat>;

/**
 * `?status=ready,review` narrows the export to those columns (repeats are dropped, order follows
 * the board); omitted or empty exports every column. Unknown query keys are rejected so a typo
 * never silently exports the whole board.
 */
export const TicketExportQuery = z
  .object({
    format: TicketExportFormat.default('json'),
    status: z
      .string()
      .max(200)
      .optional()
      .transform((raw, ctx): TicketStatus[] => {
        const parts = (raw ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const statuses: TicketStatus[] = [];
        for (const part of parts) {
          const parsed = TicketStatus.safeParse(part);
          if (!parsed.success) {
            ctx.addIssue({
              code: 'custom',
              message: `unknown status "${part.slice(0, 40)}": use ${TicketStatus.options.join(', ')}`,
            });
            return z.NEVER;
          }
          statuses.push(parsed.data);
        }
        return TicketStatus.options.filter((s) => statuses.includes(s));
      }),
  })
  .strict();
export type TicketExportQuery = z.input<typeof TicketExportQuery>;

/** Tickets per board column; every column is present, zero included. */
export const TicketStatusCounts = z.object({
  backlog: z.number().int().min(0),
  ready: z.number().int().min(0),
  in_progress: z.number().int().min(0),
  review: z.number().int().min(0),
  done: z.number().int().min(0),
});
export type TicketStatusCounts = z.infer<typeof TicketStatusCounts>;

/** One exported ticket: dependencies by key, so the file reads without the database. */
export const TicketExportRow = z.object({
  key: z.string(),
  title: z.string(),
  status: TicketStatus,
  priority: TicketPriority,
  persona: AgentPersona,
  depth: z.number().int(),
  dependsOn: z.array(z.string()),
  blockedBy: z.array(z.string()),
  completionSummary: z.string().nullable(),
  completionBlockers: z.array(z.string()),
  issueUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  body: z.string(),
});
export type TicketExportRow = z.infer<typeof TicketExportRow>;

export const TicketExport = z.object({
  project: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  exportedAt: z.string(),
  /** The columns the export covers (all five when unfiltered). */
  statuses: z.array(TicketStatus),
  /** Counts of the whole board, not only the exported columns. */
  counts: TicketStatusCounts,
  /** Share of the board that is done, 0..1 (0 for an empty board). */
  doneRatio: z.number().min(0).max(1),
  tickets: z.array(TicketExportRow),
});
export type TicketExport = z.infer<typeof TicketExport>;

/** CSV column order; the header row uses these names. */
export const TICKET_EXPORT_COLUMNS = [
  'key',
  'title',
  'status',
  'priority',
  'persona',
  'depth',
  'dependsOn',
  'blockedBy',
  'completionSummary',
  'completionBlockers',
  'issueUrl',
  'createdAt',
  'updatedAt',
  'body',
] as const satisfies readonly (keyof TicketExportRow)[];
