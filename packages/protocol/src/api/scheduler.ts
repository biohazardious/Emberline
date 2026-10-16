/** API contracts: quota scheduler. */
import { z } from 'zod';

/** How the reset time of an exhausted window was determined. */
export const ResetSource = z.enum(['hook', 'screen', 'probe']);
export type ResetSource = z.infer<typeof ResetSource>;

export const QuotaWindow = z.object({
  id: z.string(),
  /** The lane this window blocks; pool `*` blocks every pool of the agent + credential. */
  agent: z.string(),
  credential: z.string(),
  pool: z.string(),
  exhaustedAt: z.string(),
  /** When the usage window resets; null while unknown (probing). */
  resetsAt: z.string().nullable(),
  /** When the scheduler resumes work (reset + jitter, or the next probe). */
  resumeAt: z.string(),
  resetSource: ResetSource,
  /** The limit message as shown by the CLI. */
  message: z.string().nullable(),
  resumedAt: z.string().nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const MAX_CONCURRENCY = 8;

export const SchedulerState = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(MAX_CONCURRENCY),
  /** Runs currently holding a slot (starting / working). */
  busy: z.number().int(),
  queued: z.number().int(),
  rateLimited: z.number().int(),
  /** @deprecated: the open window that resumes first; use `windows`. */
  window: QuotaWindow.nullable(),
  /** Every exhausted lane; work on other lanes keeps running. */
  windows: z.array(QuotaWindow),
});
export type SchedulerState = z.infer<typeof SchedulerState>;

/** Ends the pause of one lane (or of every lane when empty); a given field must not be blank. */
export const ResumeSchedulerBody = z
  .object({ agent: z.string().min(1), credential: z.string().min(1), pool: z.string().min(1) })
  .partial();
export type ResumeSchedulerBody = z.input<typeof ResumeSchedulerBody>;

export const UpdateSchedulerBody = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(MAX_CONCURRENCY),
});
export type UpdateSchedulerBody = z.input<typeof UpdateSchedulerBody>;
