import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents } from '../db/schema.js';
import { HOLD_ENDING_EVENTS, HOLD_EVENTS } from './hold-events.js';

/** Notes the completion pipeline writes after a run's switch to `done`; they decide its outcome. */
export const PIPELINE_OUTCOME_EVENTS: readonly string[] = [...HOLD_EVENTS, 'merged_to_main'];

export type PipelineOutcome = 'held' | 'merged';

/**
 * What the pipeline notes recorded after a run's latest switch to `done` decided: `held` when any is
 * a HOLD_EVENTS note (a later turn of the agent lifts it), `merged` when the work landed in main,
 * null when it never got that far.
 */
export function decidePipelineOutcome(types: readonly string[]): PipelineOutcome | null {
  if (types.some((type) => HOLD_EVENTS.includes(type))) return 'held';
  return types.includes('merged_to_main') ? 'merged' : null;
}

/**
 * The hold a person has to look at, among the notes after the latest `done` (ascending ids): the
 * newest HOLD_EVENTS note except `completion_nudged` (the agent is answering that nudge). Null when
 * the outcome is not a hold.
 */
export function currentHold<T extends { type: string }>(events: readonly T[]): T | null {
  if (decidePipelineOutcome(events.map((e) => e.type)) !== 'held') return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as T;
    if (HOLD_EVENTS.includes(event.type) && event.type !== 'completion_nudged') return event;
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
  const newest = db
    .select({ type: runEvents.type })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        lt(runEvents.id, lastDone),
        inArray(runEvents.type, [...HOLD_EVENTS, ...HOLD_ENDING_EVENTS]),
      ),
    )
    .orderBy(desc(runEvents.id))
    .limit(1)
    .get();
  return isHoldType(newest?.type);
}
