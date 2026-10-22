import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runEvents, runs } from '../db/schema.js';
import { predecessorChain } from './handoff-chain.js';
import { HOLD_ENDING_EVENTS, HOLD_EVENTS } from './hold-events.js';

/** Notes the completion pipeline writes after a run's switch to `done`; they decide its outcome. */
export const PIPELINE_OUTCOME_EVENTS: readonly string[] = [...HOLD_EVENTS, 'merged_to_main', 'review_unblocked', 'ticket_removed'];

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
  // The run's ticket was deleted: whatever was held there is no longer anyone's to answer.
  if (all.some((e) => e.type === 'ticket_removed')) return null;
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

/**
 * Whether a person lifted a review hold of an earlier pass and nothing has decided the run since: of
 * the HOLD/ending notes before the run's latest switch to `done` (unfiltered), the newest is
 * `review_unblocked` and the newest other one is `review_blocked`. A merge, a person's merge or an
 * accepted completion signal after the unblock ends it.
 */
export function reviewUnblockPending(db: Db, runId: string): boolean {
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
  if (types.at(-1) !== 'review_unblocked') return false;
  return types.filter((type) => type !== 'review_unblocked').at(-1) === 'review_blocked';
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

/** The run and the runs it took over from by handoff, the run first (see handoff-chain.ts). */
export const handoffChain = predecessorChain;

/**
 * Whether the run carries on held work: the nearest run it took over from (by handoff, any number
 * of steps back) whose pipeline decided anything decided `held`. Runs between them that never got
 * that far (a quota handoff of a successor, for example) pass the work on unchanged.
 */
export function continuesHeldWork(db: Db, runId: string): boolean {
  for (const id of handoffChain(db, runId).slice(1)) {
    const outcome = pipelineOutcome(db, id);
    if (outcome !== null) return outcome === 'held';
  }
  return false;
}

/** Notes by which a run's branch landed in main: the pipeline's merge, or a person's. Protected from pruning (HOLD_ENDING_EVENTS). */
const MERGE_NOTES = ['merged_to_main', 'merged_by_person'];

/**
 * Whether the run's branch was merged into main before: a merge note on the run, or on a run it took
 * over from that works on the same branch. Its commits may then sit on main's first-parent line (a
 * fast-forward outside Emberline), where they look like no work at all.
 */
export function branchMergedBefore(db: Db, runId: string): boolean {
  const chain = db
    .select({ id: runs.id, branch: runs.branch })
    .from(runs)
    .where(inArray(runs.id, handoffChain(db, runId)))
    .all();
  const branch = chain.find((r) => r.id === runId)?.branch ?? null;
  const ids = chain.filter((r) => r.id === runId || (branch !== null && r.branch === branch)).map((r) => r.id);
  if (ids.length === 0) return false;
  return Boolean(
    db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, ids), inArray(runEvents.type, MERGE_NOTES)))
      .limit(1)
      .get(),
  );
}
