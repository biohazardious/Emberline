import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEventCompactions } from '../db/schema.js';
import type { TranscriptUsage } from './transcript-usage.js';

/** Runs compacted per pass; each is one transaction, so a pass never holds the writer for long. */
export const COMPACT_RUNS_PER_PASS = 50;

const DAY_MS = 86_400_000;

/** Kinds kept beyond the caller's protected list: the successor's handoff note. */
const RETAINED_TYPES = ['handoff_from'] as const;

export interface CompactionCandidate {
  id: string;
  transcriptPath: string | null;
}

export interface EventRetentionOptions {
  /** Days a `done` run keeps every event; 0 disables retention. */
  retentionDays: number;
  /** Event kinds logic reads back (PRUNE_PROTECTED_EVENT_TYPES); never removed. */
  protectedTypes: readonly string[];
  /** The run's transcript token totals, recorded before its tool events go; null when unreadable. */
  usageOf: (run: CompactionCandidate) => TranscriptUsage | null;
  now?: number;
  maxRuns?: number;
}

export interface CompactionResult {
  runs: number;
  eventsRemoved: number;
  /** More runs are past the limit than this pass took. */
  more: boolean;
}

/** Totals kept for a compacted run, read back by telemetry. */
export type RunEventCompaction = typeof runEventCompactions.$inferSelect;

const typeList = (types: readonly string[]) =>
  sql.join(
    types.map((t) => sql`${t}`),
    sql`, `,
  );

/**
 * Compacts the event logs of `done` runs whose last state change is older than the retention
 * limit. It keeps every state-changing event (attention bounds, reachedWork, pipelineOutcome), the
 * protected kinds (summary in `ticket_complete`, hold and merge notes, `last_screen`), the handoff
 * note and the newest `Stop`, and records the removed tool calls and the transcript's token totals
 * in `run_event_compactions` so telemetry reports the same usage afterwards. A run that was resumed
 * after its last pass is compacted again once it ages out.
 */
export function compactExpiredRunEvents(db: Db, options: EventRetentionOptions): CompactionResult {
  const { retentionDays } = options;
  if (retentionDays <= 0) return { runs: 0, eventsRemoved: 0, more: false };
  const now = options.now ?? Date.now();
  const maxRuns = options.maxRuns ?? COMPACT_RUNS_PER_PASS;
  const cutoff = now - retentionDays * DAY_MS;
  const keptTypes = typeList([...options.protectedTypes, ...RETAINED_TYPES]);

  // runs_state_changed_idx (state, state_changed_at) bounds the scan to old `done` runs.
  const candidates = db.all<{ id: string; transcript_path: string | null }>(sql`
    SELECT r.id, r.transcript_path FROM runs r
    LEFT JOIN run_event_compactions c ON c.run_id = r.id
    WHERE r.state = 'done' AND r.ended_at IS NOT NULL AND r.state_changed_at < ${cutoff}
      AND (SELECT MAX(e.id) FROM run_events e WHERE e.run_id = r.id) > COALESCE(c.through_event_id, 0)
    ORDER BY r.state_changed_at
    LIMIT ${maxRuns + 1}`);

  let eventsRemoved = 0;
  for (const run of candidates.slice(0, maxRuns)) {
    const usage = options.usageOf({ id: run.id, transcriptPath: run.transcript_path });
    eventsRemoved += db.transaction((tx) => {
      const through =
        tx.get<{ id: number | null } | undefined>(
          sql`SELECT MAX(id) AS id FROM run_events WHERE run_id = ${run.id}`,
        )?.id ?? null;
      if (through === null) return 0;
      const removable = sql`run_id = ${run.id} AND id <= ${through}
        AND state IS NULL AND type NOT IN (${keptTypes})
        AND id IS NOT (SELECT MAX(id) FROM run_events WHERE run_id = ${run.id} AND type = 'Stop')`;
      const toolCalls =
        tx.get<{ n: number } | undefined>(
          sql`SELECT COUNT(*) AS n FROM run_events WHERE ${removable} AND type = 'PreToolUse'`,
        )?.n ?? 0;
      const removed = tx.run(sql`DELETE FROM run_events WHERE ${removable}`).changes;
      const previous = tx
        .select()
        .from(runEventCompactions)
        .where(eq(runEventCompactions.runId, run.id))
        .get();
      const row: RunEventCompaction = {
        runId: run.id,
        compactedAt: new Date(now),
        throughEventId: through,
        eventsRemoved: (previous?.eventsRemoved ?? 0) + removed,
        toolCalls: (previous?.toolCalls ?? 0) + toolCalls,
        inputTokens: usage?.inputTokens ?? previous?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? previous?.outputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? previous?.cachedTokens ?? null,
      };
      tx.insert(runEventCompactions)
        .values(row)
        .onConflictDoUpdate({ target: runEventCompactions.runId, set: row })
        .run();
      return removed;
    });
  }
  return {
    runs: Math.min(candidates.length, maxRuns),
    eventsRemoved,
    more: candidates.length > maxRuns,
  };
}

/** Compaction totals of every compacted run (the run list). */
export function allCompactions(db: Db): Map<string, RunEventCompaction> {
  return new Map(
    db
      .select()
      .from(runEventCompactions)
      .all()
      .map((r) => [r.runId, r]),
  );
}

/** Compaction totals of one run; undefined while it has its full event log. */
export function compactionOf(db: Db, runId: string): RunEventCompaction | undefined {
  return db.select().from(runEventCompactions).where(eq(runEventCompactions.runId, runId)).get();
}

/** The token totals a compaction recorded; null when the transcript was not readable then. */
export function storedUsage(compaction: RunEventCompaction | undefined): TranscriptUsage | null {
  if (!compaction) return null;
  const { inputTokens, outputTokens, cachedTokens } = compaction;
  if (inputTokens === null || outputTokens === null || cachedTokens === null) return null;
  return { inputTokens, outputTokens, cachedTokens };
}
