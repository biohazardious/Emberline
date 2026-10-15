/** API contracts: scheduled / cron agent jobs (Phase 2.2). */
import { z } from 'zod';
import { PermissionMode } from './projects.js';

export const ScheduledJob = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  cronExpr: z.string(),
  prompt: z.string(),
  permissionMode: PermissionMode,
  enabled: z.boolean(),
  lastRunId: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
  createdAt: z.string(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const CreateScheduledJobBody = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  cronExpr: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  permissionMode: PermissionMode.default('auto'),
  enabled: z.boolean().default(true),
});
export type CreateScheduledJobBody = z.input<typeof CreateScheduledJobBody>;

export const UpdateScheduledJobBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    cronExpr: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(20_000),
    permissionMode: PermissionMode,
    enabled: z.boolean(),
  })
  .partial();
export type UpdateScheduledJobBody = z.input<typeof UpdateScheduledJobBody>;
