/** API contracts: scheduled / cron agent jobs (Phase 2.2). */
import { z } from 'zod';
import { PermissionMode } from './projects.js';

/**
 * What a due job does while its previous run is still going: `skip` this occurrence (default) or
 * `queue` another run anyway.
 */
export const CronOverlapPolicy = z.enum(['skip', 'queue']);
export type CronOverlapPolicy = z.infer<typeof CronOverlapPolicy>;

/** Nobody watches a scheduled run, so it may never stop on a permission prompt. */
export const CronPermissionMode = z.enum(['auto', 'bypassPermissions']);
export type CronPermissionMode = z.infer<typeof CronPermissionMode>;

const TimeZoneName = z.string().trim().min(1).max(64);

export const ScheduledJob = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  cronExpr: z.string(),
  prompt: z.string(),
  permissionMode: PermissionMode,
  enabled: z.boolean(),
  /** IANA zone the expression is evaluated in. */
  timeZone: z.string(),
  overlapPolicy: CronOverlapPolicy,
  lastRunId: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
  createdAt: z.string(),
  /**
   * Set when the job is paused because its stored permission mode is not allowed for scheduled runs
   * (older versions allowed any mode). Re-enabling it needs `auto` or `bypassPermissions`.
   */
  pausedReason: z.string().nullable(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const CreateScheduledJobBody = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  cronExpr: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  permissionMode: CronPermissionMode.default('auto'),
  enabled: z.boolean().default(true),
  /** Defaults to core's zone (`EMBERLINE_TIMEZONE` / `TZ`). */
  timeZone: TimeZoneName.optional(),
  overlapPolicy: CronOverlapPolicy.default('skip'),
});
export type CreateScheduledJobBody = z.input<typeof CreateScheduledJobBody>;

export const UpdateScheduledJobBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    cronExpr: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(20_000),
    permissionMode: CronPermissionMode,
    enabled: z.boolean(),
    timeZone: TimeZoneName,
    overlapPolicy: CronOverlapPolicy,
  })
  .partial();
export type UpdateScheduledJobBody = z.input<typeof UpdateScheduledJobBody>;

export const CronPreviewBody = z.object({
  cronExpr: z.string().trim().min(1).max(100),
  timeZone: TimeZoneName.optional(),
});
export type CronPreviewBody = z.input<typeof CronPreviewBody>;

export const CronPreviewResponse = z.object({
  timeZone: z.string(),
  nextRuns: z.array(z.string()),
});
export type CronPreviewResponse = z.infer<typeof CronPreviewResponse>;
