import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type RateLimitInfo, rateLimitFromScreen } from '@emberline/adapter-claude';
import {
  type CreateRunBody,
  type QuotaWindow,
  type ResetSource,
  type Run,
  type SchedulerState,
  type UpdateSchedulerBody,
  UpdateSchedulerBody as UpdateSchedulerBodySchema,
} from '@emberline/protocol';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { quotaWindows, runs, settings, tickets } from '../db/schema.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import type { RunOrigin, RunService } from '../runs/service.js';

type WindowRow = typeof quotaWindows.$inferSelect;

export interface SchedulerOptions {
  /** Next attempt when the reset time is unknown (PROJECT.md §5.5: 15 min). */
  probeMs: number;
  /** Random delay added after the reset time, so we don't hit the limit edge. */
  jitterMinMs: number;
  jitterMaxMs: number;
  /** A limit hit this soon after resuming re-opens the same window instead of a new one. */
  reopenWithinMs: number;
  tickMs: number;
  /** Wait before reading the screen after a limit hook, so the banner has been rendered. */
  screenSettleMs: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  probeMs: 15 * 60_000,
  jitterMinMs: 30_000,
  jitterMaxMs: 120_000,
  reopenWithinMs: 5 * 60_000,
  tickMs: 5_000,
  screenSettleMs: 1_500,
};

const MAX_CONCURRENCY_KEY = 'scheduler.maxConcurrentRuns';
const DEFAULT_MAX_CONCURRENCY = 2;

const toWindow = (row: WindowRow): QuotaWindow => ({
  id: row.id,
  exhaustedAt: row.exhaustedAt.toISOString(),
  resetsAt: row.resetsAt?.toISOString() ?? null,
  resumeAt: row.resumeAt.toISOString(),
  resetSource: row.source as ResetSource,
  message: row.message,
  resumedAt: row.resumedAt?.toISOString() ?? null,
});

interface SchedulerEvents {
  state: [state: SchedulerState];
}

/**
 * Quota-aware dispatcher for the single subscription lane (PROJECT.md §5.5).
 *
 * - Runs start `queued`; a slot is free while fewer than `maxConcurrentRuns` runs are busy
 *   (starting / working, or spawned with a prompt that hasn't been submitted yet).
 * - A rate limit in any run opens a quota window: dispatch pauses until `resumeAt`
 *   (reset + jitter, or a 15-min probe when the reset time is unknown).
 * - When the window closes, rate-limited runs resume first (by ticket priority), then the queue.
 * - A run hit by a temporary provider error also waits as `rate_limited`, without opening a window,
 *   and is retried once its own `autoRetryAt` has passed.
 * All state lives in SQLite; `tick()` derives everything from it, so restarts lose nothing.
 */
export class Scheduler extends EventEmitter<SchedulerEvents> {
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private ticking?: Promise<void>;
  private tickAgain = false;
  private lastPublished = '';
  private readonly options: SchedulerOptions;

  constructor(
    private readonly db: Db,
    private readonly runs: RunService,
    private readonly ptyd: PtydBridge,
    private readonly config: CoreConfig,
    options: Partial<SchedulerOptions> = {},
  ) {
    super();
    this.setMaxListeners(0);
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
    runs.on('rateLimited', (run, info) => void this.onRateLimited(run, info));
    runs.on('run', (_run, stateChanged) => {
      if (stateChanged) this.kick();
    });
    runs.on('removed', () => this.kick());
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), this.options.tickMs);
    this.timer.unref();
    this.kick();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }

  /** Enqueues a run and dispatches immediately when a slot and quota are available. */
  async submit(input: CreateRunBody, origin?: RunOrigin): Promise<Run> {
    const run = await this.runs.enqueue(input, origin);
    await this.tick();
    return this.runs.getRun(run.id);
  }

  state(): SchedulerState {
    const open = this.openWindow();
    const counts = this.db
      .select({ state: runs.state, n: sql<number>`count(*)` })
      .from(runs)
      .where(isNull(runs.endedAt))
      .groupBy(runs.state)
      .all();
    const count = (state: string) => counts.find((c) => c.state === state)?.n ?? 0;
    return {
      maxConcurrentRuns: this.maxConcurrentRuns(),
      busy: this.busyCount(),
      queued: count('queued'),
      // Rate-limited runs may have lost their process (endedAt set) and still wait to resume.
      rateLimited:
        this.db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.state, 'rate_limited')).get()?.n ?? 0,
      window: open ? toWindow(open) : null,
    };
  }

  update(input: UpdateSchedulerBody): SchedulerState {
    const { maxConcurrentRuns } = UpdateSchedulerBodySchema.parse(input);
    this.db
      .insert(settings)
      .values({ key: MAX_CONCURRENCY_KEY, value: maxConcurrentRuns })
      .onConflictDoUpdate({ target: settings.key, set: { value: maxConcurrentRuns } })
      .run();
    this.kick();
    return this.publish(true);
  }

  /** User override: end the pause now (the next limit hit simply re-opens the window). */
  async resumeNow(): Promise<SchedulerState> {
    const open = this.openWindow();
    if (open) {
      this.db.update(quotaWindows).set({ resumeAt: new Date() }).where(eq(quotaWindows.id, open.id)).run();
    }
    await this.tick();
    return this.publish(true);
  }

  /** Serialized dispatch pass; concurrent calls coalesce into one extra pass. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.dispatch();
        } while (this.tickAgain);
      } finally {
        this.ticking = undefined;
        this.publish();
      }
    })();
    return this.ticking;
  }

  /** Schedules a pass on the next turn, after every synchronous listener of the current event ran. */
  private kick(): void {
    setImmediate(() => {
      if (!this.disposed) void this.tick().catch(() => undefined);
    });
  }

  private async dispatch(): Promise<void> {
    const now = new Date();
    const open = this.openWindow();
    if (open && open.resumeAt.getTime() <= now.getTime()) {
      this.db.update(quotaWindows).set({ resumedAt: now }).where(eq(quotaWindows.id, open.id)).run();
    } else if (open) {
      return; // paused until the window resets
    }
    if (this.ptyd.status !== 'connected') return;

    let slots = this.maxConcurrentRuns() - this.busyCount();
    for (const candidate of this.candidates()) {
      if (slots <= 0) break;
      // A limit hit by a run we just resumed pauses everything again.
      if (this.openWindow()) break;
      slots--;
      try {
        if (candidate.state === 'queued') await this.runs.launch(candidate.id);
        else await this.runs.resume(candidate.id);
      } catch {
        // Recorded on the run (spawn_failed / resume_failed); move on to the next one.
      }
    }
  }

  /** Rate-limited runs first, then the queue; each by ticket priority, oldest first. */
  private candidates(): { id: string; state: string }[] {
    const priority = sql<number>`coalesce(${tickets.priority}, 1)`;
    const select = (state: string, order: typeof runs.createdAt | typeof runs.stateChangedAt) =>
      this.db
        .select({ id: runs.id, state: runs.state })
        .from(runs)
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .where(
          and(
            eq(runs.state, state),
            // An automatic retry waits for its own time, independent of quota windows.
            or(isNull(runs.autoRetryAt), lte(runs.autoRetryAt, new Date())),
          ),
        )
        .orderBy(desc(priority), asc(order))
        .all();
    return [...select('rate_limited', runs.stateChangedAt), ...select('queued', runs.createdAt)];
  }

  private busyCount(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(
        and(
          isNull(runs.endedAt),
          sql`(${runs.state} in ('starting', 'working') or (${runs.state} = 'waiting_input' and ${runs.lastEvent} = 'SessionStart' and ${runs.prompt} != ''))`,
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  private maxConcurrentRuns(): number {
    const row = this.db.select().from(settings).where(eq(settings.key, MAX_CONCURRENCY_KEY)).get();
    return typeof row?.value === 'number' ? row.value : DEFAULT_MAX_CONCURRENCY;
  }

  private openWindow(): WindowRow | undefined {
    return this.db
      .select()
      .from(quotaWindows)
      .where(isNull(quotaWindows.resumedAt))
      .orderBy(desc(quotaWindows.exhaustedAt))
      .get();
  }

  private async onRateLimited(run: Run, fromHook: RateLimitInfo | undefined): Promise<void> {
    // Synchronously, so no dispatch pass can resume this run before the window exists.
    this.recordLimit(run.id, fromHook, 'hook');
    if (fromHook?.resetsAt) return;
    // The hook didn't say when; the banner on screen usually does.
    await new Promise((resolve) => setTimeout(resolve, this.options.screenSettleMs));
    if (this.disposed) return;
    const screen = await this.runs.screen(run.id).catch(() => undefined);
    if (this.disposed) return;
    const onScreen = screen ? rateLimitFromScreen(screen, new Date(), this.config.timeZone) : undefined;
    if (onScreen?.resetsAt) this.recordLimit(run.id, onScreen, 'screen');
  }

  /** Opens (or refines / re-opens) the quota window for a limit hit. */
  private recordLimit(runId: string, info: RateLimitInfo | undefined, source: ResetSource): void {
    const now = new Date();
    const known = info?.resetsAt && info.resetsAt.getTime() > now.getTime() ? info.resetsAt : undefined;
    const effectiveSource: ResetSource = known ? source : 'probe';
    const resumeAt = known
      ? new Date(known.getTime() + this.jitter())
      : new Date(now.getTime() + this.options.probeMs);
    const fields = {
      resetsAt: known ?? null,
      startedAt: known ? new Date(known.getTime() - 5 * 3_600_000) : null,
      resumeAt,
      source: effectiveSource,
      message: info?.message ?? null,
    };

    const open = this.openWindow();
    if (open) {
      // Already paused: only a better (known) reset time changes anything.
      if (known && !open.resetsAt) {
        this.db.update(quotaWindows).set(fields).where(eq(quotaWindows.id, open.id)).run();
      }
      this.publish(true);
      return;
    }

    const latest = this.db.select().from(quotaWindows).orderBy(desc(quotaWindows.exhaustedAt)).get();
    if (latest?.resumedAt && now.getTime() - latest.resumedAt.getTime() < this.options.reopenWithinMs) {
      // The resume (or probe) came too early: same window, try again later.
      this.db
        .update(quotaWindows)
        .set({ ...fields, resumedAt: null })
        .where(eq(quotaWindows.id, latest.id))
        .run();
    } else {
      this.db
        .insert(quotaWindows)
        .values({ id: randomUUID(), exhaustedAt: now, runId, ...fields })
        .run();
    }
    this.publish(true);
  }

  private jitter(): number {
    const { jitterMinMs, jitterMaxMs } = this.options;
    return jitterMinMs + Math.random() * Math.max(0, jitterMaxMs - jitterMinMs);
  }

  private publish(force = false): SchedulerState {
    const state = this.state();
    const json = JSON.stringify(state);
    if (force || json !== this.lastPublished) {
      this.lastPublished = json;
      this.emit('state', state);
    }
    return state;
  }
}
