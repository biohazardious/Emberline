import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LARGE_SEED, seedRunEvents } from './test-seed-events.js';
import { createTestApp, type TestApp } from './test-utils.js';

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

interface Executed {
  sql: string;
  params: unknown[];
}

/**
 * Every statement `fn` runs on the database, with its parameters: prepare() is wrapped so each
 * statement records its all/get/run/iterate calls (raw() and friends return the same wrapper).
 */
function statementsOf(fn: () => unknown): Executed[] {
  const client = t.db.$client;
  const seen: Executed[] = [];
  const prepare = client.prepare.bind(client);
  const spy = vi.spyOn(client, 'prepare').mockImplementation(((source: string) => {
    const statement = prepare(source);
    const recorded: object = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (key === 'all' || key === 'get' || key === 'run' || key === 'iterate') {
            seen.push({ sql: source, params: args });
          }
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? recorded : out;
        };
      },
    });
    return recorded;
  }) as never);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

/**
 * The plan lines of `executed` that read run_events (100k rows here; by its name or any alias the
 * statement gives it) by a full scan instead of an index search.
 */
function eventTableScans(executed: Executed[]): string[] {
  const offenders: string[] = [];
  for (const { sql, params } of new Map(executed.map((e) => [e.sql, e])).values()) {
    const aliases = [...sql.matchAll(/\brun_events"?\s+(?:as\s+)?"?(\w+)/gi)].map((m) => m[1]);
    const names = new Set(['run_events', ...aliases]);
    const lines = (
      t.db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]
    ).map((r) => r.detail);
    for (const line of lines) {
      const scanned = /^SCAN (\S+)(.*)$/.exec(line);
      if (scanned && names.has(scanned[1] ?? '') && !/USING (?:COVERING )?INDEX/.test(scanned[2] ?? '')) {
        offenders.push(`${line} in: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
  return offenders;
}

/** The plan's detail lines, without table statistics (core never runs ANALYZE). */
const plan = (query: string): string[] =>
  (t.db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail);

describe('a 100k-event database', () => {
  it('is seeded with 100k events', () => {
    const row = t.db.$client.prepare('select count(*) as n from run_events').get() as { n: number };
    expect(row.n).toBe(100_000);
  });

  // Deterministic stand-ins for wall-clock budgets: a fixed number of statements however many runs
  // there are (no query per run), and none of them scans the events table.
  it('answers the inbox (run list with attention) in a few statements, none scanning run_events', () => {
    const executed = statementsOf(() => expect(t.runs.list()).toHaveLength(runIds.length));
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.length).toBeLessThan(20);
    expect(eventTableScans(executed)).toEqual([]);
  });

  it('answers the board (tickets and their latest runs) in a fixed number of statements per ticket', () => {
    const tickets = statementsOf(() =>
      expect(t.tickets.list('p0')).toHaveLength(LARGE_SEED.ticketsPerProject),
    );
    expect(tickets.length).toBeLessThan(10);
    const latest = t.tickets
      .list('p0')
      .map((ticket) => statementsOf(() => expect(t.runs.latestRunForTicket(ticket.id)).toBeDefined()));
    expect(new Set(latest.map((executed) => executed.length)).size).toBe(1);
    expect(latest[0]?.length ?? 0).toBeLessThan(6);
    expect(eventTableScans([...tickets, ...latest.flat()])).toEqual([]);
  });

  it('notices a statement that scans run_events', () => {
    const executed = statementsOf(() =>
      t.db.$client.prepare("select count(*) from run_events e where e.payload like '%x%'").get(),
    );
    expect(eventTableScans(executed)).toEqual([expect.stringMatching(/^SCAN e in: /)]);
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
