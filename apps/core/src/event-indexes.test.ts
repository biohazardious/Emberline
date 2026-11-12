import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LARGE_SEED, seedRunEvents } from './test-seed-events.js';
import { createTestApp, type TestApp } from './test-utils.js';

const BUDGET_MS = 50;
const DAY = 86_400_000;

let t: TestApp;
let runIds: string[];
beforeAll(async () => {
  t = await createTestApp();
  ({ runIds } = seedRunEvents(t.db, LARGE_SEED));
}, 60_000);
afterAll(async () => {
  await t.close();
});

/**
 * Fastest of `rounds` calls after one warm-up (statement caches, JIT): the cost of the queries
 * themselves, without the stalls of the other test workers sharing the machine.
 */
function bestMs(fn: () => unknown, rounds = 9): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** The plan's detail lines, without table statistics (core never runs ANALYZE). */
const plan = (query: string): string[] =>
  (t.db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail);

describe('a 100k-event database', () => {
  it('is seeded with 100k events', () => {
    const row = t.db.$client.prepare('select count(*) as n from run_events').get() as { n: number };
    expect(row.n).toBe(100_000);
  });

  it(`answers the inbox (run list with attention) under ${BUDGET_MS} ms`, () => {
    expect(t.runs.list()).toHaveLength(runIds.length);
    expect(bestMs(() => t.runs.list())).toBeLessThan(BUDGET_MS);
  });

  it(`answers the board (tickets and their latest runs) under ${BUDGET_MS} ms`, () => {
    const board = () => {
      const tickets = t.tickets.list('p0');
      return tickets.map((ticket) => t.runs.latestRunForTicket(ticket.id));
    };
    expect(board()).toHaveLength(LARGE_SEED.ticketsPerProject);
    expect(bestMs(board)).toBeLessThan(BUDGET_MS);
  });

  it('plans the hot lookups as index searches, not table scans or sorts', () => {
    expect(plan(`select * from tickets where project_id = 'p0' order by position`)).toEqual([
      'SEARCH tickets USING INDEX tickets_project_position_idx (project_id=?)',
    ]);
    expect(plan(`select * from runs where ticket_id = 'x' order by created_at desc limit 1`)).toEqual([
      'SEARCH runs USING INDEX runs_ticket_created_idx (ticket_id=?)',
    ]);
    expect(plan(`select * from runs where project_id = 'x' and created_at >= 0`)).toEqual([
      'SEARCH runs USING INDEX runs_project_created_idx (project_id=? AND created_at>?)',
    ]);
    expect(plan(`select state, count(*) from runs group by state`)).toEqual([
      'SCAN runs USING COVERING INDEX runs_state_changed_idx',
    ]);
    // The run inspector's timeline: the newest events of one run.
    expect(plan(`select * from run_events where run_id = 'x' order by id desc limit 200`)).toEqual([
      'SEARCH run_events USING INDEX run_events_run_idx (run_id=?)',
    ]);
    // Attention: the state bounds per run, then only the events after each run's bound.
    expect(
      plan(`select run_id, max(id) from run_events
        where state is not null and run_id in (select value from json_each('["a","b"]')) group by run_id`),
    ).toContain('SEARCH run_events USING INDEX run_events_state_idx (run_id=?)');
    expect(
      plan(`with b(run_id, entered) as (select value ->> 0, value ->> 1 from json_each('[["a",1],["b",2]]'))
        select e.id, e.payload from b cross join run_events e
          where e.run_id = b.run_id and e.id >= coalesce(b.entered, 0) and +e.type in ('Notification', 'Stop')`),
    ).toContain('SEARCH e USING INDEX run_events_run_idx (run_id=? AND id>?)');
  });

  it('keeps attention and telemetry of every run through event retention', () => {
    const before = t.runs.list();
    const compactedRun = before.find((r) => r.state === 'done');
    expect(compactedRun).toBeDefined();
    const telemetryBefore = t.runs.getTelemetry(compactedRun?.id ?? '');

    t.config.eventRetentionDays = 90;
    const now = Date.UTC(2026, 0, 1) + 400 * DAY;
    let compacted = 0;
    let removed = 0;
    for (let more = true; more;) {
      const pass = t.runs.compactExpiredEvents(now);
      compacted += pass.runs;
      removed += pass.eventsRemoved;
      more = pass.more;
    }
    t.config.eventRetentionDays = 0;
    expect(compacted).toBe(before.filter((r) => r.state === 'done').length);
    expect(removed).toBeGreaterThan(50_000);

    expect(t.runs.getTelemetry(compactedRun?.id ?? '')).toEqual(telemetryBefore);
    const after = t.runs.list();
    // An unfinished run's duration runs on with the clock; everything else must be unchanged.
    const view = (list: typeof before) =>
      list.map((r) => ({
        id: r.id,
        attention: r.attention,
        reviewReady: r.reviewReady,
        telemetry: r.endedAt ? r.telemetry : { ...r.telemetry, durationSec: 0 },
      }));
    expect(view(after)).toEqual(view(before));
  });
});
