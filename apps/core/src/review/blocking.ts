import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';

/** Ids per statement; far below SQLite's variable limit. */
const CHUNK = 500;
/** How many handoff predecessors count (like ReviewService's chain). */
export const CHAIN_MAX = 20;

/**
 * Open blocking feedback of runs: blocking comments not resolved yet (outdated ones included) on the
 * run or on the predecessors it took over from by handoff. One recursive query per chunk of runs;
 * runs with none are absent.
 */
export function openBlockingCounts(db: Db, runIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const ids = sql.join(runIds.slice(i, i + CHUNK).map((id) => sql`${id}`), sql`, `);
    const rows = db.all<{ root: string; n: number }>(sql`
      WITH RECURSIVE chain(root, id, depth) AS (
        SELECT id, id, 1 FROM runs WHERE id IN (${ids})
        UNION
        SELECT chain.root, r.predecessor_run_id, chain.depth + 1
        FROM chain JOIN runs r ON r.id = chain.id
        WHERE r.predecessor_run_id IS NOT NULL AND chain.depth < ${CHAIN_MAX}
      )
      SELECT chain.root AS root, COUNT(DISTINCT c.id) AS n
      FROM chain JOIN review_comments c ON c.run_id = chain.id
      WHERE c.priority = 'blocking' AND c.status != 'resolved'
      GROUP BY chain.root`);
    for (const r of rows) counts.set(r.root, r.n);
  }
  return counts;
}

/** Open blocking feedback of one run and its handoff predecessors. */
export const openBlockingCount = (db: Db, runId: string): number => openBlockingCounts(db, [runId]).get(runId) ?? 0;
