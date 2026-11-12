import type { Run, TicketStatus } from '@emberline/protocol';
import { and, eq, max, min } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tickets } from '../db/schema.js';

/** Gap between neighbours so most moves need a single row update. */
export const POSITION_STEP = 1024;

/** Run states that occupy one of a project's parallel ticket slots. */
const ACTIVE_RUN_STATES: ReadonlySet<Run['state']> = new Set<Run['state']>([
  'queued',
  'starting',
  'working',
  'waiting_input',
  'rate_limited',
]);

/** Whether a run in `state` occupies one of its project's parallel ticket slots. */
export const occupiesTicketSlot = (state: Run['state']): boolean => ACTIVE_RUN_STATES.has(state);

/** Where a ticket belongs while its run is in `state`; null leaves it where it is. */
export function statusForRunState(state: Run['state']): TicketStatus | null {
  if (state === 'done') return 'review';
  if (occupiesTicketSlot(state)) return 'in_progress';
  return null; // failed: stays put and shows the failed run
}

/**
 * The column a ticket in `current` moves to when its run reaches `state`, or null when it stays:
 * a ticket a person (or the pipeline) closed never leaves Done because of a run.
 */
export function columnForRun(current: TicketStatus, state: Run['state']): TicketStatus | null {
  if (current === 'done') return null;
  const target = statusForRunState(state);
  return target && target !== current ? target : null;
}

/** A position above every ticket of the column (`top`) or below every one (`bottom`). */
export function edgePosition(
  db: Db,
  projectId: string,
  status: TicketStatus,
  edge: 'top' | 'bottom',
): number {
  const where = and(eq(tickets.projectId, projectId), eq(tickets.status, status));
  if (edge === 'top') {
    const first = db
      .select({ p: min(tickets.position) })
      .from(tickets)
      .where(where)
      .get();
    return first?.p == null ? POSITION_STEP : first.p - POSITION_STEP;
  }
  const last = db
    .select({ p: max(tickets.position) })
    .from(tickets)
    .where(where)
    .get();
  return last?.p == null ? POSITION_STEP : last.p + POSITION_STEP;
}
