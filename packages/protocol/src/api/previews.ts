/** API contracts: per-worktree preview environments (Phase 2.3). */
import { z } from 'zod';

export const RunPreviewStatus = z.object({
  runId: z.string(),
  status: z.enum(['stopped', 'running', 'exited']),
  terminalId: z.string().nullable(),
  command: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  detectedCommand: z.string().nullable(),
});
export type RunPreviewStatus = z.infer<typeof RunPreviewStatus>;

export const StartPreviewBody = z.object({
  command: z.string().trim().min(1).max(500).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
});
export type StartPreviewBody = z.input<typeof StartPreviewBody>;
