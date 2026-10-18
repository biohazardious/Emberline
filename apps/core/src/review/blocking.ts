import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';

/** Ids per statement; far below SQLite's variable limit. */
const CHUNK = 500;
/** How many handoff predecessors count (like ReviewService's chain). */
export const CHAIN_MAX = 20;

/**
 * Blocking feedback a fresh run of the ticket carried in its prompt (payload `{ count, fromRun }`).
 * The comments were resolved on the earlier run, so the marker stands for them until a person
 * verifies the new attempt ({@link CARRIED_VERIFIED_EVENT}, see ReviewService.verifyCarried).
 */
export const CARRIED_BLOCKING_EVENT = 'review_carried_blocking';
/** A person checked the new attempt: the carried markers before it in the chain no longer count. */
export const CARRIED_VERIFIED_EVENT = 'review_carried_verified';

/** The run and the predecessors it took over from by handoff, per root (bounded by CHAIN_MAX). */
const chainCte = (ids: ReturnType<typeof sql.join>) => sql`
  WITH RECURSIVE chain(root, id, depth) AS (
    SELECT id, id, 1 FROM runs WHERE id IN (${ids})
    UNION
    SELECT chain.root, r.predecessor_run_id, chain.depth + 1
    FROM chain JOIN runs r ON r.id = chain.id
    WHERE r.predecessor_run_id IS NOT NULL AND chain.depth < ${CHAIN_MAX}
  ),
  -- Carried markers in the chain no later verification in the chain has answered.
  carried AS (
    SELECT DISTINCT chain.root AS root, e.id AS event_id, e.run_id AS run_id,
      COALESCE(CAST(json_extract(e.payload, '$.count') AS INTEGER), 0) AS n,
      json_extract(e.payload, '$.fromRun') AS from_run
    FROM chain JOIN run_events e ON e.run_id = chain.id AND e.type = ${CARRIED_BLOCKING_EVENT}
    WHERE NOT EXISTS (
      SELECT 1 FROM chain c2 JOIN run_events u ON u.run_id = c2.id AND u.type = ${CARRIED_VERIFIED_EVENT}
      WHERE c2.root = chain.root AND u.id > e.id
    )
  )`;

const chunks = (runIds: string[]) => {
  const out: ReturnType<typeof sql.join>[] = [];
  for (let i = 0; i < runIds.length; i += CHUNK) out.push(sql.join(runIds.slice(i, i + CHUNK).map((id) => sql`${id}`), sql`, `));
  return out;
};

/**
 * Open blocking feedback of runs: blocking comments not resolved yet (outdated ones included) on the
 * run or on the predecessors it took over from by handoff, plus the blocking items a carried marker
 * stands for. One recursive query per chunk of runs; runs with none are absent.
 */
export function openBlockingCounts(db: Db, runIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ids of chunks(runIds)) {
    const rows = db.all<{ root: string; n: number }>(sql`
      ${chainCte(ids)}
      SELECT root, SUM(n) AS n FROM (
        SELECT chain.root AS root, COUNT(DISTINCT c.id) AS n
        FROM chain JOIN review_comments c ON c.run_id = chain.id
        WHERE c.priority = 'blocking' AND c.status != 'resolved'
        GROUP BY chain.root
        UNION ALL
        SELECT root, SUM(n) AS n FROM carried GROUP BY root
      )
      GROUP BY root
      HAVING SUM(n) > 0`);
    for (const r of rows) counts.set(r.root, r.n);
  }
  return counts;
}

/** Open blocking feedback of one run and its handoff predecessors. */
export const openBlockingCount = (db: Db, runId: string): number => openBlockingCounts(db, [runId]).get(runId) ?? 0;

/** The carried blocking feedback still waiting for a person's check on this run (or its predecessors); null when none. */
export function openCarriedBlocking(db: Db, runId: string): { count: number; fromRun: string | null } | null {
  const [ids] = chunks([runId]);
  const rows = db.all<{ n: number; from_run: string | null }>(sql`
    ${chainCte(ids!)}
    SELECT n, from_run FROM carried ORDER BY event_id DESC`);
  const count = rows.reduce((sum, r) => sum + r.n, 0);
  return count > 0 ? { count, fromRun: rows[0]?.from_run ?? null } : null;
}
