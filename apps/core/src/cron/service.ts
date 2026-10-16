import { randomUUID } from 'node:crypto';
import {
  type CreateScheduledJobBody,
  CreateScheduledJobBody as CreateScheduledJobBodySchema,
  type CronOverlapPolicy,
  CronPreviewBody,
  type CronPreviewResponse,
  type PermissionMode,
  type Run,
  type ScheduledJob,
  type UpdateScheduledJobBody,
  UpdateScheduledJobBody as UpdateScheduledJobBodySchema,
} from '@emberline/protocol';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, runs as runsTable, scheduledJobs } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { assertTimeZone, computeNextCronDate, previewCronRuns } from './schedule.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';

type ScheduledJobRow = typeof scheduledJobs.$inferSelect;

export { computeNextCronDate, parseCronExpression } from './schedule.js';

function toScheduledJob(row: ScheduledJobRow, defaultTimeZone: string): ScheduledJob {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    cronExpr: row.cronExpr,
    prompt: row.prompt,
    permissionMode: row.permissionMode as PermissionMode,
    enabled: row.enabled,
    timeZone: row.timeZone ?? defaultTimeZone,
    overlapPolicy: row.overlapPolicy as CronOverlapPolicy,
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
    /** Zone for jobs without their own (core's EMBERLINE_TIMEZONE / TZ). */
    private readonly defaultTimeZone = 'UTC',
  ) {}

  private zoneOf(row: Pick<ScheduledJobRow, 'timeZone'>): string {
    return row.timeZone ?? this.defaultTimeZone;
  }

  private next(row: Pick<ScheduledJobRow, 'cronExpr' | 'timeZone'>, from: Date): Date {
    return computeNextCronDate(row.cronExpr, from, this.zoneOf(row));
  }

  /** The next fire times of an expression, for the editor's preview. */
  preview(rawBody: unknown, now: Date = new Date()): CronPreviewResponse {
    const parsed = CronPreviewBody.safeParse(rawBody);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    const timeZone = parsed.data.timeZone ?? this.defaultTimeZone;
    return {
      timeZone,
      nextRuns: previewCronRuns(parsed.data.cronExpr, timeZone, 5, now).map((d) => d.toISOString()),
    };
  }

  /**
   * Re-plans upcoming occurrences, e.g. after an upgrade changed how expressions are evaluated.
   * Occurrences already due are left alone so the next tick still fires them.
   */
  replan(now: Date = new Date()): void {
    for (const row of this.db.select().from(scheduledJobs).where(eq(scheduledJobs.enabled, true)).all()) {
      if (row.nextRunAt.getTime() <= now.getTime()) continue;
      try {
        const nextRunAt = this.next(row, now);
        if (nextRunAt.getTime() !== row.nextRunAt.getTime()) {
          this.db.update(scheduledJobs).set({ nextRunAt }).where(eq(scheduledJobs.id, row.id)).run();
        }
      } catch {
        // An expression that no longer parses keeps its old time; editing the job fixes it.
      }
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.replan();
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
    return rows.map((row) => toScheduledJob(row, this.defaultTimeZone));
  }

  create(rawBody: unknown, now: Date = new Date()): ScheduledJob {
    const parsed = CreateScheduledJobBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body: CreateScheduledJobBody = parsed.data;
    const project = this.db.select().from(projects).where(eq(projects.id, body.projectId)).get();
    if (!project) throw notFound('no such project');

    if (body.timeZone) assertTimeZone(body.timeZone);
    const timeZone = body.timeZone ?? null;
    const nextRunAt = computeNextCronDate(body.cronExpr, now, timeZone ?? this.defaultTimeZone);
    const id = randomUUID();
    const row: ScheduledJobRow = {
      id,
      projectId: body.projectId,
      name: body.name,
      cronExpr: body.cronExpr,
      prompt: body.prompt,
      permissionMode: body.permissionMode ?? 'auto',
      enabled: body.enabled ?? true,
      timeZone,
      overlapPolicy: body.overlapPolicy ?? 'skip',
      lastRunId: null,
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
    };
    this.db.insert(scheduledJobs).values(row).run();
    return toScheduledJob(row, this.defaultTimeZone);
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
    if (body.timeZone) assertTimeZone(body.timeZone);
    const timeZone = body.timeZone ?? existing.timeZone;

    let nextRunAt = existing.nextRunAt;
    if (body.cronExpr !== undefined || body.timeZone !== undefined || (body.enabled === true && !existing.enabled)) {
      nextRunAt = this.next({ cronExpr: nextCron, timeZone }, now);
    }

    const patch: Partial<ScheduledJobRow> = {
      name: body.name ?? existing.name,
      cronExpr: nextCron,
      prompt: body.prompt ?? existing.prompt,
      permissionMode: body.permissionMode ?? existing.permissionMode,
      enabled: nextEnabled,
      timeZone,
      overlapPolicy: body.overlapPolicy ?? existing.overlapPolicy,
      nextRunAt,
    };

    this.db.update(scheduledJobs).set(patch).where(eq(scheduledJobs.id, id)).run();
    const updated = this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get()!;
    return toScheduledJob(updated, this.defaultTimeZone);
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
    return { job: toScheduledJob(updated, this.defaultTimeZone), run };
  }

  /**
   * Evaluates all enabled scheduled jobs whose `nextRunAt <= now` and submits their runs. Quota is
   * the scheduler's business: a run whose lane is exhausted waits queued there (other providers
   * keep running), and the `skip` overlap policy sees that queued run as still going.
   */
  async tick(now: Date = new Date()): Promise<Run[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const spawned: Run[] = [];
    try {
      const rows = this.db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.enabled, true))
        .orderBy(asc(scheduledJobs.nextRunAt))
        .all();

      for (const row of rows) {
        if (row.nextRunAt.getTime() > now.getTime()) continue;
        if (row.overlapPolicy === 'skip' && this.previousRunStillGoing(row)) {
          // B13: a long run must not pile up new worktrees every interval.
          this.db
            .update(scheduledJobs)
            .set({ nextRunAt: this.next(row, now) })
            .where(eq(scheduledJobs.id, row.id))
            .run();
          continue;
        }
        try {
          const run = await this.dispatchJobRun(row, now);
          spawned.push(run);
        } catch {
          // Advance nextRunAt even if spawning failed (e.g. missing repo) so we don't spin every tick
          const nextRunAt = this.next(row, now);
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

  /** The job's last run is queued or its agent is still working (not ended, not finished). */
  private previousRunStillGoing(row: ScheduledJobRow): boolean {
    if (!row.lastRunId) return false;
    const last = this.db.select().from(runsTable).where(eq(runsTable.id, row.lastRunId)).get();
    return Boolean(last && !last.endedAt && last.state !== 'done' && last.state !== 'failed');
  }

  private async dispatchJobRun(row: ScheduledJobRow, now: Date): Promise<Run> {
    const input = {
      projectId: row.projectId,
      prompt: row.prompt,
      permissionMode: row.permissionMode as PermissionMode,
    };
    const run = this.scheduler ? await this.scheduler.submit(input) : await this.runs.enqueue(input);
    const nextRunAt = this.next(row, now);
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
