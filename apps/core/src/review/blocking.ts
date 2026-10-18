import { and, count, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { reviewComments } from '../db/schema.js';

/** Ids per statement; far below SQLite's variable limit. */
const CHUNK = 500;

const openBlocking = and(eq(reviewComments.priority, 'blocking'), ne(reviewComments.status, 'resolved'));

/** Open blocking feedback of a run: blocking comments not resolved yet (outdated ones included). */
export function openBlockingCount(db: Db, runId: string): number {
  return db.select({ n: count() }).from(reviewComments).where(and(eq(reviewComments.runId, runId), openBlocking)).get()?.n ?? 0;
}

/** The same for many runs, in one grouped query per chunk; runs with none are absent. */
export function openBlockingCounts(db: Db, runIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const rows = db
      .select({ runId: reviewComments.runId, n: count() })
      .from(reviewComments)
      .where(and(inArray(reviewComments.runId, runIds.slice(i, i + CHUNK)), openBlocking))
      .groupBy(reviewComments.runId)
      .all();
    for (const r of rows) counts.set(r.runId, r.n);
  }
  return counts;
}
