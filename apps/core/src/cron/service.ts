import { randomUUID } from 'node:crypto';
import {
  type CreateScheduledJobBody,
  CreateScheduledJobBody as CreateScheduledJobBodySchema,
  type PermissionMode,
  type Run,
  type ScheduledJob,
  type UpdateScheduledJobBody,
  UpdateScheduledJobBody as UpdateScheduledJobBodySchema,
} from '@emberline/protocol';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, scheduledJobs } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

type ScheduledJobRow = typeof scheduledJobs.$inferSelect;

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseCronField(field: string, min: number, max: number, label: string): Set<number> {
  const result = new Set<number>();
  const parts = field.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) throw badRequest(`invalid cron ${label} field: "${field}"`);

    const [rangePart, stepPart] = trimmed.split('/');
    if (trimmed.split('/').length > 2) {
      throw badRequest(`invalid cron step syntax in ${label}: "${trimmed}"`);
    }
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw badRequest(`invalid cron step in ${label}: "${trimmed}"`);
    }

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart!.includes('-')) {
        const [a, b] = rangePart!.split('-').map((n) => Number(n));
        if (!Number.isInteger(a) || !Number.isInteger(b) || a! < min || b! > max || a! > b!) {
          throw badRequest(`invalid cron range in ${label}: "${trimmed}"`);
        }
        start = a!;
        end = b!;
      } else {
        const val = Number(rangePart);
        if (!Number.isInteger(val) || val < min || val > max) {
          throw badRequest(`invalid cron value in ${label}: "${trimmed}"`);
        }
        start = val;
        end = stepPart !== undefined ? max : val;
      }
    }

    for (let v = start; v <= end; v += step) {
      result.add(label === 'dayOfWeek' && v === 7 ? 0 : v);
    }
  }
  if (result.size === 0) throw badRequest(`empty cron field ${label}`);
  return result;
}

export function parseCronExpression(expr: string): ParsedCron {
  const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw badRequest('cron expression must have 5 fields (minute hour day-of-month month day-of-week) or a @daily/@hourly alias');
  }
  return {
    minutes: parseCronField(fields[0]!, 0, 59, 'minute'),
    hours: parseCronField(fields[1]!, 0, 23, 'hour'),
    daysOfMonth: parseCronField(fields[2]!, 1, 31, 'dayOfMonth'),
    months: parseCronField(fields[3]!, 1, 12, 'month'),
    daysOfWeek: parseCronField(fields[4]!, 0, 7, 'dayOfWeek'),
  };
}

/**
 * Computes the next matching timestamp strictly after `fromDate` (rounded to the next minute).
 */
export function computeNextCronDate(cronExpr: string, fromDate: Date = new Date()): Date {
  const parsed = parseCronExpression(cronExpr);
  const candidate = new Date(fromDate.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Search up to 366 days ahead (527,040 minutes)
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getUTCMonth() + 1;
    if (!parsed.months.has(month)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    if (!parsed.daysOfMonth.has(dom) || !parsed.daysOfWeek.has(dow)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hour = candidate.getUTCHours();
    if (!parsed.hours.has(hour)) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = candidate.getUTCMinutes();
    if (!parsed.minutes.has(minute)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return candidate;
  }

  throw badRequest(`unable to find next run time for cron expression "${cronExpr}" within 1 year`);
}

function toScheduledJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    cronExpr: row.cronExpr,
    prompt: row.prompt,
    permissionMode: row.permissionMode as PermissionMode,
    enabled: row.enabled,
    lastRunId: row.lastRunId,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class CronService {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly scheduler?: Scheduler,
  ) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  list(projectId?: string): ScheduledJob[] {
    const rows = projectId
      ? this.db
          .select()
          .from(scheduledJobs)
          .where(eq(scheduledJobs.projectId, projectId))
          .orderBy(asc(scheduledJobs.createdAt))
          .all()
      : this.db.select().from(scheduledJobs).orderBy(asc(scheduledJobs.createdAt)).all();
    return rows.map(toScheduledJob);
  }

  create(rawBody: unknown, now: Date = new Date()): ScheduledJob {
    const parsed = CreateScheduledJobBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body: CreateScheduledJobBody = parsed.data;
    const project = this.db.select().from(projects).where(eq(projects.id, body.projectId)).get();
    if (!project) throw notFound('no such project');

    const nextRunAt = computeNextCronDate(body.cronExpr, now);
    const id = randomUUID();
    const row: ScheduledJobRow = {
      id,
      projectId: body.projectId,
      name: body.name,
      cronExpr: body.cronExpr,
      prompt: body.prompt,
      permissionMode: body.permissionMode ?? 'auto',
      enabled: body.enabled ?? true,
      lastRunId: null,
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
    };
    this.db.insert(scheduledJobs).values(row).run();
    return toScheduledJob(row);
  }

  update(id: string, rawBody: unknown, now: Date = new Date()): ScheduledJob {
    const existing = this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get();
    if (!existing) throw notFound('no such scheduled job');

    const parsed = UpdateScheduledJobBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body: UpdateScheduledJobBody = parsed.data;
    const nextCron = body.cronExpr ?? existing.cronExpr;
    const nextEnabled = body.enabled ?? existing.enabled;

    let nextRunAt = existing.nextRunAt;
    if (body.cronExpr !== undefined || (body.enabled === true && !existing.enabled)) {
      nextRunAt = computeNextCronDate(nextCron, now);
    }

    const patch: Partial<ScheduledJobRow> = {
      name: body.name ?? existing.name,
      cronExpr: nextCron,
      prompt: body.prompt ?? existing.prompt,
      permissionMode: body.permissionMode ?? existing.permissionMode,
      enabled: nextEnabled,
      nextRunAt,
    };

    this.db.update(scheduledJobs).set(patch).where(eq(scheduledJobs.id, id)).run();
    const updated = this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get()!;
    return toScheduledJob(updated);
  }

  remove(id: string): void {
    const existing = this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get();
    if (!existing) throw notFound('no such scheduled job');
    this.db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).run();
  }

  async triggerNow(id: string, now: Date = new Date()): Promise<{ job: ScheduledJob; run: Run }> {
    const row = this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get();
    if (!row) throw notFound('no such scheduled job');
    const run = await this.dispatchJobRun(row, now);
    const updated = this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get()!;
    return { job: toScheduledJob(updated), run };
  }

  /**
   * Evaluates all enabled scheduled jobs whose `nextRunAt <= now` and spawns agent runs
   * unless a subscription quota window is currently active.
   */
  async tick(now: Date = new Date()): Promise<Run[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const spawned: Run[] = [];
    try {
      // Respect active quota pause window
      if (this.scheduler && this.scheduler.state().window !== null) {
        return [];
      }

      const rows = this.db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.enabled, true))
        .orderBy(asc(scheduledJobs.nextRunAt))
        .all();

      for (const row of rows) {
        if (row.nextRunAt.getTime() > now.getTime()) continue;
        try {
          const run = await this.dispatchJobRun(row, now);
          spawned.push(run);
        } catch {
          // Advance nextRunAt even if spawning failed (e.g. missing repo) so we don't spin every tick
          const nextRunAt = computeNextCronDate(row.cronExpr, now);
          this.db
            .update(scheduledJobs)
            .set({ nextRunAt })
            .where(eq(scheduledJobs.id, row.id))
            .run();
        }
      }
    } finally {
      this.ticking = false;
    }
    return spawned;
  }

  private async dispatchJobRun(row: ScheduledJobRow, now: Date): Promise<Run> {
    const input = {
      projectId: row.projectId,
      prompt: row.prompt,
      permissionMode: row.permissionMode as PermissionMode,
    };
    const run = this.scheduler ? await this.scheduler.submit(input) : await this.runs.enqueue(input);
    const nextRunAt = computeNextCronDate(row.cronExpr, now);
    this.db
      .update(scheduledJobs)
      .set({
        lastRunId: run.id,
        lastRunAt: now,
        nextRunAt,
      })
      .where(eq(scheduledJobs.id, row.id))
      .run();
    return run;
  }
}
