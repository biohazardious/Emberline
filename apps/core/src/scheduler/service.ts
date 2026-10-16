import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { type RateLimitInfo, rateLimitFromScreen } from '@emberline/adapter-claude';
import {
  type CreateRunBody,
  type Lane,
  laneCovers,
  laneOf,
  MAX_HANDOFFS,
  PROVIDER_RUNTIME,
  type QuotaWindow,
  type ResetSource,
  type Route,
  type Run,
  type SchedulerState,
  sameRoute,
  type UpdateSchedulerBody,
  UpdateSchedulerBody as UpdateSchedulerBodySchema,
} from '@emberline/protocol';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { quotaWindows, runs, settings, tickets } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { getQuotaPolicy, routeUsable } from '../factory/settings.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import { currentRoute, runRoutes } from '../runs/route.js';
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

/** Runs a person may hand to another route: stuck on a limit, failed, or waiting for an answer. */
const MANUAL_HANDOFF_STATES: ReadonlySet<string> = new Set(['rate_limited', 'failed', 'waiting_input']);
const DEFAULT_MAX_CONCURRENCY = 2;

const toWindow = (row: WindowRow): QuotaWindow => ({
  id: row.id,
  agent: row.agent,
  credential: row.credential,
  pool: row.pool,
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
 * Quota-aware dispatcher with one quota lane per (agent, credential, pool) (PROJECT.md §5.5).
 *
 * - Runs start `queued`; a slot is free while fewer than `maxConcurrentRuns` runs are busy
 *   (starting / working, or spawned with a prompt that hasn't been submitted yet).
 * - A rate limit in a run opens a quota window for that run's lane only, until `resumeAt`
 *   (reset + jitter, or a 15-min probe when the reset time is unknown). Pool `*` closes every
 *   pool of the agent + credential; other lanes keep dispatching.
 * - Policy `newRuns`: a queued run whose lane is closed waits, or (`fallback`) starts on the first
 *   route of its chain whose lane is open. Policy `inFlight`: a limited run waits, or (`fallback`)
 *   is handed off to such a route in the same worktree, at most `MAX_HANDOFFS` times automatically.
 * - When a window closes, its lane's rate-limited runs resume first (by ticket priority), then the
 *   queue; handed-off successors go before other queued runs.
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
  /** `runId|route` pairs already noted as `route_skipped`. */
  private readonly skipped = new Set<string>();
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
    runs.on('rateLimited', (run, info) => {
      // A failure (e.g. the DB) is noted on the run instead of escaping as an unhandled rejection.
      this.onRateLimited(run, info).catch((error: unknown) =>
        this.runs.note(run.id, 'rate_limit_failed', { message: error instanceof Error ? error.message : String(error) }),
      );
    });
    runs.on('run', (run, stateChanged) => {
      if (run.endedAt) this.forgetSkipped(run.id);
      if (stateChanged) this.kick();
    });
    runs.on('removed', (id) => {
      this.forgetSkipped(id);
      this.kick();
    });
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
    const windows = this.openWindows().map(toWindow);
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
      window: windows[0] ?? null,
      windows,
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

  /**
   * User override: end the pause of the lanes matching `lane` now (every lane when empty); the
   * next limit hit simply re-opens the window.
   */
  async resumeNow(lane: Partial<Lane> = {}): Promise<SchedulerState> {
    for (const w of this.openWindows()) {
      if (
        (lane.agent && w.agent !== lane.agent) ||
        (lane.credential && w.credential !== lane.credential) ||
        (lane.pool && w.pool !== lane.pool)
      ) {
        continue;
      }
      this.db.update(quotaWindows).set({ resumeAt: new Date() }).where(eq(quotaWindows.id, w.id)).run();
    }
    await this.tick();
    return this.publish(true);
  }

  /**
   * A person hands a waiting run to another route. Refused (before the run is touched) unless the
   * run is waiting (limited, failed or waiting for input) in a worktree that still exists, when the
   * agent cannot sign in that way, when an API-key route has no key saved, or while that route is
   * out of quota too.
   */
  async handOff(runId: string, route: Route): Promise<Run> {
    const run = this.runs.getRun(runId); // 404 for an unknown run first
    if (!MANUAL_HANDOFF_STATES.has(run.state)) {
      throw new HttpError(409, 'run_not_waiting', `a ${run.state} run cannot be handed off; only a waiting, failed or limited one`);
    }
    if (!existsSync(run.worktreePath)) {
      throw new HttpError(409, 'worktree_missing', "this run's worktree was removed; start a new run instead");
    }
    if (!PROVIDER_RUNTIME[route.agent]?.credentials.includes(route.credential)) {
      throw new HttpError(400, 'route_unsupported', `${route.agent} cannot run with credential ${route.credential}`);
    }
    if (!routeUsable(this.db, route)) {
      throw new HttpError(409, 'route_unusable', `${route.agent} (${route.model}) needs an API key; none is saved`);
    }
    if (this.laneClosed(laneOf(route), this.openWindows())) {
      throw new HttpError(409, 'lane_exhausted', `${route.agent} (${route.model}) is out of quota too`);
    }
    const successor = await this.runs.handOff(runId, route, { reason: 'handed off by you', source: 'user', automatic: false });
    await this.tick();
    return this.runs.getRun(successor.id);
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
    this.closeExpired(new Date());
    if (this.ptyd.status !== 'connected') return;

    const policy = getQuotaPolicy(this.db);
    let slots = this.maxConcurrentRuns() - this.busyCount();
    for (const candidate of this.candidates()) {
      if (slots <= 0) break;
      // Re-read: a limit hit by a run we just started closes its lane synchronously.
      const closed = this.openWindows();
      const row = this.db.select().from(runs).where(eq(runs.id, candidate.id)).get();
      if (!row || row.handedOffTo) continue;
      if (this.laneClosed(laneOf(currentRoute(row)), closed)) {
        // Rate-limited runs wait for their own lane; a queued run may start on a fallback route.
        if (candidate.state !== 'queued' || policy.newRuns !== 'fallback') continue;
        const index = runRoutes(row).findIndex((r) => this.routeOpen(row.id, r, closed));
        if (index < 0) continue;
        try {
          this.runs.bindRoute(row.id, index);
        } catch {
          continue; // stopped meanwhile
        }
      }
      slots--;
      try {
        if (candidate.state === 'queued') await this.runs.launch(candidate.id);
        else await this.runs.resume(candidate.id);
      } catch {
        // Recorded on the run (spawn_failed / resume_failed); move on to the next one.
      }
    }
  }

  /**
   * Rate-limited runs first, then the queue (handed-off successors before other queued runs);
   * each by ticket priority, oldest first.
   */
  private candidates(): { id: string; state: string }[] {
    const priority = sql<number>`coalesce(${tickets.priority}, 1)`;
    const successor = sql<number>`${runs.predecessorRunId} is not null`;
    const select = (state: string, order: typeof runs.createdAt | typeof runs.stateChangedAt, successorsFirst: boolean) =>
      this.db
        .select({ id: runs.id, state: runs.state })
        .from(runs)
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .where(
          and(
            eq(runs.state, state),
            isNull(runs.handedOffTo),
            // An automatic retry waits for its own time, independent of quota windows.
            or(isNull(runs.autoRetryAt), lte(runs.autoRetryAt, new Date())),
          ),
        )
        .orderBy(...(successorsFirst ? [desc(successor)] : []), desc(priority), asc(order))
        .all();
    return [...select('rate_limited', runs.stateChangedAt, false), ...select('queued', runs.createdAt, true)];
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

  /** Every window not yet marked resumed, the soonest-resuming first. */
  private openWindows(): WindowRow[] {
    return this.db
      .select()
      .from(quotaWindows)
      .where(isNull(quotaWindows.resumedAt))
      .orderBy(asc(quotaWindows.resumeAt))
      .all();
  }

  /** Marks windows whose resume time has come; returns the ones still closed. */
  private closeExpired(now: Date): WindowRow[] {
    const open = this.openWindows();
    const due = open.filter((w) => w.resumeAt.getTime() <= now.getTime());
    for (const w of due) this.db.update(quotaWindows).set({ resumedAt: now }).where(eq(quotaWindows.id, w.id)).run();
    return open.filter((w) => w.resumeAt.getTime() > now.getTime());
  }

  /** Whether an open window (resume time still ahead) blocks work on `lane`. */
  private laneClosed(lane: Lane, closed: readonly WindowRow[]): boolean {
    const now = Date.now();
    return closed.some((w) => w.resumeAt.getTime() > now && laneCovers(w, lane));
  }

  /** A fallback route can take work: its lane has quota and, for an API-key route, the key still exists. */
  private routeOpen(runId: string, route: Route, closed: readonly WindowRow[]): boolean {
    if (this.laneClosed(laneOf(route), closed)) return false;
    if (routeUsable(this.db, route)) return true;
    // Once per run and route: dispatch re-checks queued runs on every pass.
    const key = `${runId}|${route.agent}|${route.model}|${route.credential}`;
    if (!this.skipped.has(key)) {
      this.skipped.add(key);
      this.runs.note(runId, 'route_skipped', { route, message: `Skipped ${route.agent} (${route.model}): no API key saved` });
    }
    return false;
  }

  /** Drops a finished or removed run's `route_skipped` memory so the set stays bounded. */
  private forgetSkipped(runId: string): void {
    for (const key of this.skipped) if (key.startsWith(`${runId}|`)) this.skipped.delete(key);
  }

  private async onRateLimited(run: Run, fromHook: RateLimitInfo | undefined): Promise<void> {
    const lane: Lane = { agent: run.agent, credential: run.credential, pool: fromHook?.pool ?? '*' };
    // Synchronously, so no dispatch pass can resume this run before the window exists.
    this.recordLimit(run.id, lane, fromHook, 'hook');
    void this.maybeHandOff(run, fromHook).catch(() => undefined);
    if (fromHook?.resetsAt) return;
    // The hook didn't say when; the banner on screen usually does.
    await new Promise((resolve) => setTimeout(resolve, this.options.screenSettleMs));
    if (this.disposed) return;
    const screen = await this.runs.screen(run.id).catch(() => undefined);
    if (this.disposed) return;
    const onScreen = screen
      ? rateLimitFromScreen(screen, new Date(), this.config.timeZone, { agent: run.agent, model: run.model })
      : undefined;
    if (onScreen?.resetsAt) this.recordLimit(run.id, { ...lane, pool: onScreen.pool }, onScreen, 'screen', lane.pool);
  }

  /** Policy `inFlight = fallback`: move the limited run to the first route whose lane is open. */
  private async maybeHandOff(run: Run, info: RateLimitInfo | undefined): Promise<void> {
    if (getQuotaPolicy(this.db).inFlight !== 'fallback') return;
    const row = this.db.select().from(runs).where(eq(runs.id, run.id)).get();
    if (!row || row.cancelledAt || row.handedOffTo || row.handoffCount >= MAX_HANDOFFS) return;
    const closed = this.openWindows();
    const current = currentRoute(row);
    const next = runRoutes(row).find((r) => !sameRoute(r, current) && this.routeOpen(row.id, r, closed));
    if (!next) return;
    try {
      await this.runs.handOff(row.id, next, { reason: info?.message ?? 'usage limit reached', source: 'system', automatic: true });
    } catch (error) {
      this.runs.note(row.id, 'handoff_failed', { message: (error as Error).message });
    }
    this.kick();
  }

  /** Opens (or refines / re-opens) the quota window of `lane` for a limit hit. */
  private recordLimit(
    runId: string,
    lane: Lane,
    info: RateLimitInfo | undefined,
    source: ResetSource,
    /** Pool of the window the hook opened, when the screen refines it (possibly to a narrower pool). */
    refinePool?: string,
  ): void {
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

    const sameLane = and(
      eq(quotaWindows.agent, lane.agent),
      eq(quotaWindows.credential, lane.credential),
      eq(quotaWindows.pool, lane.pool),
    );
    const open = this.db.select().from(quotaWindows).where(and(sameLane, isNull(quotaWindows.resumedAt))).get();
    if (!open && known && refinePool !== undefined && refinePool !== lane.pool) {
      // The hook opened a window without a reset (pool `*`); the banner names a narrower pool: narrow it in place.
      const probe = this.db
        .select()
        .from(quotaWindows)
        .where(
          and(
            eq(quotaWindows.agent, lane.agent),
            eq(quotaWindows.credential, lane.credential),
            eq(quotaWindows.pool, refinePool),
            isNull(quotaWindows.resumedAt),
            isNull(quotaWindows.resetsAt),
          ),
        )
        .get();
      if (probe) {
        this.db.update(quotaWindows).set({ ...fields, pool: lane.pool }).where(eq(quotaWindows.id, probe.id)).run();
        this.publish(true);
        return;
      }
    }
    if (open) {
      // Already paused: only a better (known) reset time changes anything.
      if (known && !open.resetsAt) {
        this.db.update(quotaWindows).set(fields).where(eq(quotaWindows.id, open.id)).run();
      }
      this.publish(true);
      return;
    }

    const latest = this.db.select().from(quotaWindows).where(sameLane).orderBy(desc(quotaWindows.exhaustedAt)).get();
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
        .values({ id: randomUUID(), exhaustedAt: now, runId, agent: lane.agent, credential: lane.credential, pool: lane.pool, ...fields })
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
