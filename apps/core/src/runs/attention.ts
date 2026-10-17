import { HOLD_LABELS, type Run, type RunAttention } from '@emberline/protocol';
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs, tickets } from '../db/schema.js';
import { currentHold, decidePipelineOutcome, PIPELINE_OUTCOME_EVENTS } from './hold-outcome.js';

/** A failure stays in front of a person this long after the run ended. */
export const FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** One stored run event, as far as attention reads it. */
export interface AttentionEvent {
  id: number;
  ts: Date;
  type: string;
  payload: Record<string, unknown> | null;
}

/** The few latest events of one run that decide its attention. */
export interface AttentionFacts {
  /** Id of the event that moved the run into its current state (the newest one carrying a state). */
  enteredId: number | null;
  /** Notification / stall_detected events from that moment on, ascending. */
  waiting: AttentionEvent[];
  /** Pipeline notes (holds, merged_to_main) after the run's latest switch to `done`, ascending. */
  pipeline: AttentionEvent[];
  /** The event of the run's latest switch to `failed`. */
  failure: AttentionEvent | null;
}

type AttentionRun = Pick<Run, 'id' | 'state' | 'lastEvent' | 'autoRetry' | 'cancelled' | 'handedOffTo' | 'endedAt' | 'stateChangedAt'>;

const WAITING_TYPES = ['Notification', 'stall_detected'];
/** States whose attention needs the run's events. */
const FACT_STATES: ReadonlySet<string> = new Set(['waiting_input', 'rate_limited', 'failed', 'done']);
/** Ids per statement; far below SQLite's variable limit. */
const CHUNK = 500;

const message = (event: AttentionEvent | undefined): string | null => {
  const value = event?.payload?.message;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** The permission-prompt test the Claude adapter applies to a Notification hook. */
function isPermissionPrompt(payload: Record<string, unknown> | null): boolean {
  const type = payload?.notification_type;
  if (typeof type === 'string' && type) return type === 'permission_prompt';
  const text = payload?.message;
  return typeof text === 'string' && /permission/i.test(text);
}

const make = (run: AttentionRun, reason: RunAttention['reason'], detail: string | null, since: string, eventId: number | null) => ({
  reason,
  detail,
  since,
  occurrence: `${run.id}:${reason}:${eventId ?? 0}`,
});

/** Blockers of a `completion_blocked` note, joined into one text. */
function blockersOf(event: AttentionEvent): string | null {
  const raw = event.payload?.blockers;
  const list = Array.isArray(raw) ? raw.filter((b): b is string => typeof b === 'string' && b.length > 0) : [];
  return list.length > 0 ? list.join('\n') : null;
}

/** What the run needs from a person, in the spec's rule order; null when nothing. Pure. */
export function computeAttention(run: AttentionRun, facts: AttentionFacts | undefined, now = Date.now()): RunAttention | null {
  switch (run.state) {
    case 'waiting_input': {
      if (run.lastEvent === 'SessionStart') return null;
      const waiting = facts?.waiting ?? [];
      const first = waiting[0];
      if (first?.type === 'stall_detected') {
        return make(run, 'stalled', message(first), first.ts.toISOString(), first.id);
      }
      const latest = [...waiting].reverse().find((e) => e.type === 'Notification');
      if (!latest) return make(run, 'question', null, run.stateChangedAt, facts?.enteredId ?? null);
      return make(
        run,
        isPermissionPrompt(latest.payload) ? 'permission' : 'question',
        message(latest),
        latest.ts.toISOString(),
        latest.id,
      );
    }
    case 'rate_limited':
      return run.autoRetry ? null : make(run, 'rate_limited', null, run.stateChangedAt, facts?.enteredId ?? null);
    case 'failed': {
      if (run.cancelled || run.handedOffTo) return null;
      const failure = facts?.failure ?? null;
      const endedAt = Date.parse(run.endedAt ?? failure?.ts.toISOString() ?? run.stateChangedAt);
      if (now - endedAt > FAILURE_WINDOW_MS) return null;
      return make(run, 'failed', failure?.type ?? null, failure?.ts.toISOString() ?? run.endedAt ?? run.stateChangedAt, failure?.id ?? facts?.enteredId ?? null);
    }
    case 'done': {
      const hold = currentHold(facts?.pipeline ?? []);
      if (!hold) return null;
      const since = hold.ts.toISOString();
      if (hold.type === 'completion_blocked') return make(run, 'blocked', blockersOf(hold), since, hold.id);
      return make(run, 'held', HOLD_LABELS[hold.type] ?? hold.type, since, hold.id);
    }
    default:
      return null;
  }
}

/** Whether a done run's pipeline left it with no hold (a nudge in flight counts as held). */
const pipelineClear = (facts: AttentionFacts | undefined): boolean =>
  decidePipelineOutcome((facts?.pipeline ?? []).map((e) => e.type)) !== 'held';

interface Bounds {
  run_id: string;
  entered: number | null;
}

interface EventRow {
  id: number;
  run_id: string;
  ts: number;
  type: string;
  payload: string | null;
}

const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

const parse = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The events behind the attention of every given run, in a fixed number of statements however many
 * runs there are (two per chunk of 500): the state bounds per run, then the relevant events after them.
 */
export function loadAttentionFacts(db: Db, runIds: string[]): Map<string, AttentionFacts> {
  const facts = new Map<string, AttentionFacts>();
  const blank = (): AttentionFacts => ({ enteredId: null, waiting: [], pipeline: [], failure: null });
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const ids = runIds.slice(i, i + CHUNK);
    const list = idList(ids);
    const bounds = sql`SELECT run_id,
        MAX(CASE WHEN state IS NOT NULL THEN id END) AS entered,
        MAX(CASE WHEN state = 'done' THEN id END) AS last_done,
        MAX(CASE WHEN state = 'failed' THEN id END) AS last_failed
      FROM run_events WHERE run_id IN (${list}) GROUP BY run_id`;
    const boundRows = db.all<Bounds>(sql`SELECT run_id, entered FROM (${bounds})`);
    for (const b of boundRows) facts.set(b.run_id, { ...blank(), enteredId: b.entered });
    const outcomeTypes = sql.join(PIPELINE_OUTCOME_EVENTS.map((t) => sql`${t}`), sql`, `);
    const waitingTypes = sql.join(WAITING_TYPES.map((t) => sql`${t}`), sql`, `);
    const rows = db.all<EventRow & { entered: number | null; last_done: number | null; last_failed: number | null }>(sql`
      WITH b AS (${bounds})
      SELECT e.id, e.run_id, e.ts, e.type, e.payload, b.entered, b.last_done, b.last_failed
      FROM run_events e JOIN b ON b.run_id = e.run_id
      WHERE (e.type IN (${waitingTypes}) AND e.id >= COALESCE(b.entered, 0))
         OR (e.type IN (${outcomeTypes}) AND e.id > COALESCE(b.last_done, 0))
         OR e.id = b.last_failed
      ORDER BY e.id`);
    for (const r of rows) {
      const f = facts.get(r.run_id);
      if (!f) continue;
      const event: AttentionEvent = { id: r.id, ts: new Date(r.ts), type: r.type, payload: parse(r.payload) };
      if (r.id === r.last_failed) f.failure = event;
      if (WAITING_TYPES.includes(r.type) && r.id >= (r.entered ?? 0)) f.waiting.push(event);
      if (PIPELINE_OUTCOME_EVENTS.includes(r.type) && r.id > (r.last_done ?? 0)) f.pipeline.push(event);
    }
  }
  return facts;
}

/**
 * Adds `attention` and `reviewReady` to the given runs with batched reads: one facts load for all
 * of them, one ticket lookup, one lookup of each ticket's latest run.
 */
export function attachAttention(
  db: Db,
  list: Run[],
  load: (ids: string[]) => Map<string, AttentionFacts> = (ids) => loadAttentionFacts(db, ids),
  now = Date.now(),
): Run[] {
  const needing = list.filter((r) => FACT_STATES.has(r.state)).map((r) => r.id);
  const facts = needing.length > 0 ? load(needing) : new Map<string, AttentionFacts>();

  const ticketIds = [...new Set(list.filter((r) => r.state === 'done' && r.ticketId).map((r) => r.ticketId as string))];
  const status = new Map<string, string>();
  const latestRun = new Map<string, string>();
  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const ids = ticketIds.slice(i, i + CHUNK);
    for (const t of db.select({ id: tickets.id, status: tickets.status }).from(tickets).where(inArray(tickets.id, ids)).all()) {
      status.set(t.id, t.status);
    }
    const rows = db
      .select({ id: runs.id, ticketId: runs.ticketId, createdAt: runs.createdAt })
      .from(runs)
      .where(inArray(runs.ticketId, ids))
      .all();
    const best = new Map<string, { id: string; at: number }>();
    for (const r of rows) {
      const cur = best.get(r.ticketId as string);
      if (!cur || r.createdAt.getTime() > cur.at || (r.createdAt.getTime() === cur.at && r.id > cur.id)) {
        best.set(r.ticketId as string, { id: r.id, at: r.createdAt.getTime() });
      }
    }
    for (const [ticketId, v] of best) latestRun.set(ticketId, v.id);
  }

  return list.map((run) => {
    const f = facts.get(run.id);
    return {
      ...run,
      attention: computeAttention(run, f, now),
      reviewReady:
        run.state === 'done' &&
        run.ticketId !== null &&
        status.get(run.ticketId) === 'review' &&
        latestRun.get(run.ticketId) === run.id &&
        pipelineClear(f),
    };
  });
}

