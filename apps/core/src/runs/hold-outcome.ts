import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents } from '../db/schema.js';
import { HOLD_ENDING_EVENTS, HOLD_EVENTS } from './hold-events.js';

/** Notes the completion pipeline writes after a run's switch to `done`; they decide its outcome. */
export const PIPELINE_OUTCOME_EVENTS: readonly string[] = [...HOLD_EVENTS, 'merged_to_main', 'review_unblocked'];

export type PipelineOutcome = 'held' | 'merged';

/** `review_blocked` holds that a later `review_unblocked` lifted no longer count (the other notes stay). */
export function withoutUnblocked<T>(items: readonly T[], typeOf: (item: T) => string = (item) => item as string): readonly T[] {
  let lifted = false;
  const kept: T[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const type = typeOf(items[i] as T);
    if (type === 'review_unblocked') lifted = true;
    else if (type === 'review_blocked' && lifted) continue;
    kept.unshift(items[i] as T);
  }
  return kept;
}

/**
 * What the pipeline notes recorded after a run's latest switch to `done` decided: `held` when any is
 * a HOLD_EVENTS note (a later turn of the agent lifts it), `merged` when the work landed in main,
 * null when it never got that far.
 */
export function decidePipelineOutcome(types: readonly string[]): PipelineOutcome | null {
  types = withoutUnblocked(types);
  if (types.some((type) => HOLD_EVENTS.includes(type))) return 'held';
  return types.includes('merged_to_main') ? 'merged' : null;
}

/**
 * Whether a hold note went out together with an automatic fix request (payload `autoFix: true`):
 * the agent is working on it. Should the request not arrive, the gate notes the hold again without it.
 */
export function isAutoFixHold(payload: unknown): boolean {
  return Boolean(payload && typeof payload === 'object' && (payload as { autoFix?: unknown }).autoFix === true);
}

/**
 * The hold a person has to look at, among the notes after the latest `done` (ascending ids): the
 * newest HOLD_EVENTS note except those the agent is answering (`completion_nudged`, and holds noted
 * with an automatic fix request). Null when the outcome is not a hold or nothing is left for a
 * person. Attention only: the pipeline outcome (and so dispatch and merge) still counts every hold.
 */
export function currentHold<T extends { type: string; payload?: unknown }>(all: readonly T[]): T | null {
  const events = withoutUnblocked(all, (e) => e.type);
  if (decidePipelineOutcome(events.map((e) => e.type)) !== 'held') return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as T;
    if (HOLD_EVENTS.includes(event.type) && event.type !== 'completion_nudged' && !isAutoFixHold(event.payload)) return event;
  }
  return null;
}

/** Whether the newest pass outcome before a run's latest `done` (a type among HOLD/ending notes) is a hold. */
export function isHoldType(newestType: string | undefined): boolean {
  return Boolean(newestType && HOLD_EVENTS.includes(newestType));
}

/** Id of the event of the run's latest switch to `done`. */
export function latestDoneEventId(db: Db, runId: string): number | undefined {
  return db
    .select({ id: runEvents.id })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.state, 'done')))
    .orderBy(desc(runEvents.id))
    .limit(1)
    .get()?.id;
}

/** The outcome of the run's latest completion pipeline (the one after its latest switch to `done`). */
export function pipelineOutcome(db: Db, runId: string): PipelineOutcome | null {
  const lastDone = latestDoneEventId(db, runId);
  const types = db
    .select({ type: runEvents.type })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        gt(runEvents.id, lastDone ?? 0),
        inArray(runEvents.type, [...PIPELINE_OUTCOME_EVENTS]),
      ),
    )
    .all()
    .map((e) => e.type);
  return decidePipelineOutcome(types);
}

/**
 * Whether an earlier pipeline pass of this run left it held: of the pass outcomes recorded before
 * the run's latest switch to `done` (the current pass's own notes come after it), the newest is a
 * HOLD_EVENTS note, not a merge or an accepted completion signal.
 */
export function stillHeld(db: Db, runId: string): boolean {
  const lastDone = latestDoneEventId(db, runId);
  if (lastDone === undefined) return false;
  const types = db
    .select({ type: runEvents.type })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        lt(runEvents.id, lastDone),
        inArray(runEvents.type, [...HOLD_EVENTS, ...HOLD_ENDING_EVENTS]),
      ),
    )
    .orderBy(runEvents.id)
    .all()
    .map((e) => e.type);
  // An unblock only lifts a review_blocked hold; the newest of what is left decides.
  const left = withoutUnblocked(types).filter((type) => type !== 'review_unblocked');
  return isHoldType(left.at(-1));
}

/** Whether the run's current pipeline pass (after its latest `done`) stands on a `review_blocked` hold. */
export function reviewBlockedIsCurrent(db: Db, runId: string): boolean {
  const newest = db
    .select({ type: runEvents.type })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        gt(runEvents.id, latestDoneEventId(db, runId) ?? 0),
        inArray(runEvents.type, ['review_blocked', 'review_unblocked']),
      ),
    )
    .orderBy(desc(runEvents.id))
    .limit(1)
    .get();
  return newest?.type === 'review_blocked';
}
