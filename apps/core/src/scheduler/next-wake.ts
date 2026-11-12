import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { quotaWindows, runs } from '../db/schema.js';

/** setTimeout's ceiling (about 24.8 days); a later wake re-arms when this one fires. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The next time a waiting run may become dispatchable, read from SQLite: the soonest future
 * `resume_at` of an open quota window, or the soonest automatic retry of a rate-limited run.
 * Undefined when nothing waits on a clock.
 */
export function nextWakeAt(db: Db, now: Date): number | undefined {
  const window = db
    .select({ at: sql<number | null>`min(${quotaWindows.resumeAt})` })
    .from(quotaWindows)
    .where(and(isNull(quotaWindows.resumedAt), gt(quotaWindows.resumeAt, now)))
    .get()?.at;
  const retry = db
    .select({ at: sql<number | null>`min(${runs.autoRetryAt})` })
    .from(runs)
    .where(and(eq(runs.state, 'rate_limited'), isNull(runs.handedOffTo), gt(runs.autoRetryAt, now)))
    .get()?.at;
  const times = [window, retry].filter((at): at is number => typeof at === 'number');
  return times.length > 0 ? Math.min(...times) : undefined;
}
