import { isPermissionNotification } from '@emberline/adapter-sdk';
import { HOLD_LABELS, holdLabelOf, type Run, type RunAttention } from '@emberline/protocol';
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs, tickets } from '../db/schema.js';
import { openBlockingCounts } from '../review/blocking.js';
import { currentHold, decidePipelineOutcome, PIPELINE_OUTCOME_EVENTS } from './hold-outcome.js';

/** A failure stays in front of a person this long after the run ended. */
export const FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/** A hold of a run without a ticket (no Review column to leave) stays this long after it was noted. */
export const HOLD_WINDOW_MS = 24 * 60 * 60_000;

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

type AttentionRun = Pick<
  Run,
  'id' | 'state' | 'lastEvent' | 'autoRetry' | 'cancelled' | 'handedOffTo' | 'endedAt' | 'stateChangedAt'
> & {
  ticketId?: string | null;
};

/** Where a ticket run's ticket stands: a hold is attention only for its latest run while it is in Review. */
export interface AttentionTicket {
  inReview: boolean;
  /** Whether this run is the ticket's latest. */
  latest: boolean;
}

const WAITING_TYPES = ['Notification', 'stall_detected'];
/** States whose attention needs the run's events. */
const FACT_STATES: ReadonlySet<string> = new Set(['waiting_input', 'rate_limited', 'failed', 'done']);
/** Ids per statement; far below SQLite's variable limit. */
const CHUNK = 500;

const message = (event: AttentionEvent | undefined): string | null => {
  const value = event?.payload?.message;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * The occurrence names the triggering event; without one (a run that never logged its state change)
 * it falls back to the state's time, which is just as stable across reads.
 */
const make = (
  run: AttentionRun,
  reason: RunAttention['reason'],
  detail: string | null,
  since: string,
  eventId: number | null,
) => ({
  reason,
  detail,
  since,
  occurrence: `${run.id}:${reason}:${eventId === null ? `t${Date.parse(run.stateChangedAt)}` : eventId}`,
});

/** Blockers of a `completion_blocked` note, joined into one text. */
function blockersOf(event: AttentionEvent): string | null {
  const raw = event.payload?.blockers;
  const list = Array.isArray(raw)
    ? raw.filter((b): b is string => typeof b === 'string' && b.length > 0)
    : [];
  return list.length > 0 ? list.join('\n') : null;
}

/**
 * What the run needs from a person, in the spec's rule order; null when nothing. Pure. `ticket` is
 * the run's ticket (unknown: the hold does not count) and only matters for a run with one.
 */
export function computeAttention(
  run: AttentionRun,
  facts: AttentionFacts | undefined,
  now = Date.now(),
  ticket?: AttentionTicket,
): RunAttention | null {
  switch (run.state) {
    case 'waiting_input': {
      if (run.lastEvent === 'SessionStart') return null;
      // One wait is one occurrence, anchored at the event that entered it (a Notification, a stall, a
      // StopFailure…): whatever arrives later in the same wait only decides the reason and the detail.
      const enteredId = facts?.enteredId ?? null;
      const waiting = facts?.waiting ?? [];
      const entered = waiting.find((e) => e.id === enteredId);
      // stateChangedAt is written with the entering event, so it is that event's time.
      const since = entered?.ts.toISOString() ?? run.stateChangedAt;
      const at = (reason: RunAttention['reason'], detail: string | null) =>
        make(run, reason, detail, since, enteredId);
      const latest = waiting.at(-1);
      // A stall enters its own wait (from working); a later Notification of that wait takes over.
      if (latest?.type === 'stall_detected') return at('stalled', message(latest));
      const notifications = waiting.filter((e) => e.type === 'Notification');
      // A permission prompt anywhere in the wait makes it a permission.
      const permission = notifications.find((e) => isPermissionNotification(e.payload ?? {}));
      if (permission) return at('permission', message(permission));
      // Claude's idle reminders say nothing new: the detail is the agent's own question, or the text
      // of the Notification that entered the wait.
      const asked = notifications.find((e) => e.payload?.notification_type !== 'idle_prompt' && message(e));
      return at('question', message(asked ?? (entered?.type === 'Notification' ? entered : undefined)));
    }
    case 'rate_limited':
      return run.autoRetry
        ? null
        : make(run, 'rate_limited', null, run.stateChangedAt, facts?.enteredId ?? null);
    case 'failed': {
      if (run.cancelled || run.handedOffTo) return null;
      const failure = facts?.failure ?? null;
      const endedAt = Date.parse(run.endedAt ?? failure?.ts.toISOString() ?? run.stateChangedAt);
      if (now - endedAt > FAILURE_WINDOW_MS) return null;
      return make(
        run,
        'failed',
        failure?.type ?? null,
        failure?.ts.toISOString() ?? run.endedAt ?? run.stateChangedAt,
        failure?.id ?? facts?.enteredId ?? null,
      );
    }
    case 'done': {
      const hold = currentHold(facts?.pipeline ?? []);
      if (!hold) return null;
      // A hold waits in Review: once the ticket moved on, or a newer run took it over, nobody is
      // asked any more. Without a ticket, it fades like a failure.
      if (run.ticketId ? !(ticket?.inReview && ticket.latest) : now - hold.ts.getTime() > HOLD_WINDOW_MS)
        return null;
      const since = hold.ts.toISOString();
      if (hold.type === 'completion_blocked') return make(run, 'blocked', blockersOf(hold), since, hold.id);
      return make(
        run,
        'held',
        Object.hasOwn(HOLD_LABELS, hold.type) ? holdLabelOf(hold.type, hold.payload) : hold.type,
        since,
        hold.id,
      );
    }
    default:
      return null;
  }
}

/** Whether a done run's pipeline left it with no hold (a nudge in flight counts as held). */
const pipelineClear = (facts: AttentionFacts | undefined): boolean =>
  decidePipelineOutcome((facts?.pipeline ?? []).map((e) => e.type)) !== 'held';

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

interface Bounds {
  run_id: string;
  entered: number | null;
  last_done: number | null;
  last_failed: number | null;
}

/**
 * Per run: the newest state-changing event, the newest switch to `done` and to `failed`. Reads only
 * `state IS NOT NULL` events, through the partial index `run_events_state_idx`.
 */
export const attentionBoundsQuery = (runIds: string[]) => sql`SELECT run_id,
    MAX(id) AS entered,
    MAX(CASE WHEN state = 'done' THEN id END) AS last_done,
    MAX(CASE WHEN state = 'failed' THEN id END) AS last_failed
  FROM run_events
  WHERE state IS NOT NULL AND run_id IN (${idList(runIds)}) GROUP BY run_id`;

interface EventRow {
  id: number;
  run_id: string;
  ts: number;
  type: string;
  payload: string | null;
}

const parse = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
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
    const boundRows = db.all<Bounds>(attentionBoundsQuery(ids));
    if (boundRows.length === 0) continue;
    for (const b of boundRows) facts.set(b.run_id, { ...blank(), enteredId: b.entered });
    // The bounds travel back as values, so they are computed once.
    const values = sql.join(
      boundRows.map((b) => sql`(${b.run_id}, ${b.entered}, ${b.last_done}, ${b.last_failed})`),
      sql`, `,
    );
    const outcomeTypes = sql.join(
      PIPELINE_OUTCOME_EVENTS.map((t) => sql`${t}`),
      sql`, `,
    );
    const waitingTypes = sql.join(
      WAITING_TYPES.map((t) => sql`${t}`),
      sql`, `,
    );
    const rows = db.all<
      EventRow & { entered: number | null; last_done: number | null; last_failed: number | null }
    >(sql`
      WITH b(run_id, entered, last_done, last_failed) AS (VALUES ${values})
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

  const ticketIds = [
    ...new Set(list.filter((r) => r.state === 'done' && r.ticketId).map((r) => r.ticketId as string)),
  ];
  const status = new Map<string, string>();
  const latestRun = new Map<string, string>();
  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const ids = ticketIds.slice(i, i + CHUNK);
    for (const t of db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(inArray(tickets.id, ids))
      .all()) {
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

  // Blocking review feedback keeps a run from being review-ready: one grouped query for all candidates.
  const candidates = list.filter((r) => r.state === 'done' && r.ticketId).map((r) => r.id);
  const blocking = candidates.length > 0 ? openBlockingCounts(db, candidates) : new Map<string, number>();

  return list.map((run) => {
    const f = facts.get(run.id);
    const ticket: AttentionTicket | undefined = run.ticketId
      ? { inReview: status.get(run.ticketId) === 'review', latest: latestRun.get(run.ticketId) === run.id }
      : undefined;
    return {
      ...run,
      attention: computeAttention(run, f, now, ticket),
      reviewReady:
        run.state === 'done' &&
        ticket !== undefined &&
        ticket.inReview &&
        ticket.latest &&
        pipelineClear(f) &&
        !blocking.has(run.id),
    };
  });
}
