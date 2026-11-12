import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from './db/index.js';
import { compactExpiredRunEvents, compactionOf } from './runs/event-retention.js';
import { PRUNE_PROTECTED_EVENT_TYPES } from './runs/service.js';
import { seedRunEvents } from './test-seed-events.js';
import { rmTemp } from './test-rm.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'db-'));
});
afterEach(() => {
  rmTemp(dir);
});

const backups = () => readdirSync(dir).filter((name) => name.includes('.pre-migration-'));

/** A database migrated with every migration except the newest one. */
function createOutdatedDb(file: string): void {
  const older = path.join(dir, 'older-migrations');
  cpSync(MIGRATIONS_DIR, older, { recursive: true });
  const journalFile = path.join(older, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: unknown[] };
  journal.entries.pop();
  writeFileSync(journalFile, JSON.stringify(journal));
  const sqlite = new Database(file);
  migrate(drizzle({ client: sqlite }), { migrationsFolder: older });
  sqlite.prepare(`insert into settings (key, value) values ('marker', '"kept"')`).run();
  sqlite.close();
}

describe('openDb', () => {
  it('0013: runs and quota windows get route and lane columns with legacy-safe defaults', () => {
    const db = openDb(':memory:');
    const defaults = (table: string) =>
      Object.fromEntries(
        (
          db.db.all(sql.raw(`pragma table_info(${table})`)) as { name: string; dflt_value: string | null }[]
        ).map((c) => [c.name, c.dflt_value]),
      );
    const run = defaults('runs');
    expect(run).toMatchObject({
      credential: "'login'",
      routes: "'[]'",
      route_index: '0',
      handoff_count: '0',
    });
    expect(Object.keys(run)).toEqual(
      expect.arrayContaining(['model', 'predecessor_run_id', 'handed_off_to']),
    );
    expect(defaults('quota_windows')).toMatchObject({
      agent: "'claude'",
      credential: "'login'",
      pool: "'*'",
    });
    db.close();
  });

  it('0014: ticket_dependencies exists and deleting a ticket removes its edges both ways', () => {
    const db = openDb(':memory:');
    const run = (query: string) => db.db.run(sql.raw(query));
    run(`insert into projects (id, name, slug, path, created_at) values ('p', 'P', 'p', '/p', 0)`);
    for (const [id, n] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      run(
        `insert into tickets (id, project_id, number, key, title, status, position, created_at, updated_at) values ('${id}', 'p', ${n}, 'P-${n}', '${id}', 'ready', ${n}, 0, 0)`,
      );
    }
    run(
      `insert into ticket_dependencies (ticket_id, depends_on_id, created_at) values ('b', 'a', 0), ('c', 'b', 0)`,
    );
    const count = () =>
      (db.db.all(sql.raw('select count(*) as n from ticket_dependencies')) as { n: number }[])[0]?.n;
    expect(count()).toBe(2);
    run(`delete from tickets where id = 'b'`);
    expect(count()).toBe(0);
    db.close();
  });

  it('0019: ticket issue links are unique per project and source, and project_settings cascades', () => {
    const db = openDb(':memory:');
    const run = (query: string) => db.db.run(sql.raw(query));
    for (const id of ['p', 'q'])
      run(
        `insert into projects (id, name, slug, path, created_at) values ('${id}', '${id}', '${id}', '/${id}', 0)`,
      );
    const ticket = (
      id: string,
      project: string,
      n: number,
      source: string | null,
      externalId: string | null,
    ) =>
      run(
        `insert into tickets (id, project_id, number, key, title, status, position, created_at, updated_at, external_source, external_id) values ('${id}', '${project}', ${n}, 'K-${n}', 't', 'ready', ${n}, 0, 0, ${source ? `'${source}'` : 'null'}, ${externalId ? `'${externalId}'` : 'null'})`,
      );
    // Board tickets carry NULLs, which never collide.
    ticket('n1', 'p', 1, null, null);
    ticket('n2', 'p', 2, null, null);
    ticket('g1', 'p', 3, 'github', '1');
    let failure: unknown;
    try {
      ticket('g2', 'p', 4, 'github', '1');
    } catch (err) {
      failure = err;
    }
    // drizzle wraps the driver error: the UNIQUE message is on the cause.
    expect(`${(failure as Error).message} ${(failure as { cause?: Error }).cause?.message}`).toMatch(
      /UNIQUE/i,
    );
    ticket('g3', 'q', 1, 'github', '1');
    ticket('l1', 'p', 5, 'gitlab', '1');
    run(`insert into project_settings (project_id, settings) values ('p', '{"issueSync":{}}')`);
    const count = () =>
      (db.db.all(sql.raw('select count(*) as n from project_settings')) as { n: number }[])[0]?.n;
    expect(count()).toBe(1);
    run(`delete from projects where id = 'p'`);
    expect(count()).toBe(0);
    db.close();
  });

  it('0020: an issue tombstone is unique per project, source and id, and goes with its project', () => {
    const db = openDb(':memory:');
    const run = (query: string) => db.db.run(sql.raw(query));
    run(`insert into projects (id, name, slug, path, created_at) values ('p', 'p', 'p', '/p', 0)`);
    const tomb = (source: string, id: string) =>
      run(
        `insert into issue_tombstones (project_id, external_source, external_id, created_at) values ('p', '${source}', '${id}', 0)`,
      );
    tomb('github', '1');
    tomb('gitlab', '1');
    expect(() => tomb('github', '1')).toThrow();
    const count = () =>
      (db.db.all(sql.raw('select count(*) as n from issue_tombstones')) as { n: number }[])[0]?.n;
    expect(count()).toBe(2);
    run(`delete from projects where id = 'p'`);
    expect(count()).toBe(0);
    db.close();
  });

  it('0021: tickets get external_triage, false for existing and new rows', () => {
    const db = openDb(':memory:');
    const run = (query: string) => db.db.run(sql.raw(query));
    run(`insert into projects (id, name, slug, path, created_at) values ('p', 'p', 'p', '/p', 0)`);
    run(
      `insert into tickets (id, project_id, number, key, title, status, position, created_at, updated_at) values ('a', 'p', 1, 'P-1', 'a', 'backlog', 1, 0, 0)`,
    );
    run(
      `insert into tickets (id, project_id, number, key, title, status, position, created_at, updated_at, external_triage) values ('b', 'p', 2, 'P-2', 'b', 'backlog', 2, 0, 0, 1)`,
    );
    expect(db.db.all(sql.raw('select id, external_triage as triage from tickets order by id'))).toEqual([
      { id: 'a', triage: 0 },
      { id: 'b', triage: 1 },
    ]);
    expect(() => run(`update tickets set external_triage = null where id = 'a'`)).toThrow();
    db.close();
  });

  it('does not back up a fresh or up-to-date database', () => {
    const file = path.join(dir, 'emberline.db');
    openDb(file).close();
    openDb(file).close();
    expect(backups()).toEqual([]);
  });

  it('snapshots the database before applying pending migrations', () => {
    const file = path.join(dir, 'emberline.db');
    createOutdatedDb(file);
    openDb(file).close();

    const [backup] = backups();
    expect(backup).toMatch(/^emberline\.db\.pre-migration-\d+\.bak$/);
    const snapshot = new Database(path.join(dir, backup!), { readonly: true });
    expect(snapshot.prepare(`select value from settings where key = 'marker'`).get()).toEqual({
      value: '"kept"',
    });
    snapshot.close();

    // Now up to date: the next start takes no further backup.
    openDb(file).close();
    expect(backups()).toHaveLength(1);
  });

  it('0029: open quota pauses from before the migration survive it, in the database and its pre-migration backup', () => {
    const file = path.join(dir, 'emberline.db');
    createOutdatedDb(file);
    const resumeAt = Date.now() + 3_600_000;
    const old = new Database(file);
    old
      .prepare(
        `insert into quota_windows (id, agent, credential, pool, exhausted_at, resets_at, resume_at, source, message, run_id)
         values ('w-open', 'claude', 'login', '*', ?, ?, ?, 'hook', 'resets 11:59pm', 'r1')`,
      )
      .run(Date.now(), resumeAt - 60_000, resumeAt);
    old.close();

    const indexes = (db: Db) =>
      (
        db.$client
          .prepare(
            `select name from sqlite_master where type = 'index' and tbl_name = 'quota_windows' and name not like 'sqlite_%'`,
          )
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .sort();
    const openPause = (db: Db) =>
      db.$client
        .prepare(
          `select id, resume_at as resumeAt from quota_windows where resumed_at is null order by resume_at`,
        )
        .all();

    const migrated = openDb(file);
    expect(openPause(migrated.db)).toEqual([{ id: 'w-open', resumeAt }]);
    expect(indexes(migrated.db)).toEqual(['quota_windows_lane_idx', 'quota_windows_open_idx']);
    const plan = (
      migrated.db.$client
        .prepare(`explain query plan select * from quota_windows where resumed_at is null order by resume_at`)
        .all() as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan).toEqual(['SEARCH quota_windows USING INDEX quota_windows_open_idx (resumed_at=?)']);
    migrated.close();

    // The snapshot taken before 0029 is an older database that still opens and migrates.
    const [backup] = backups();
    const restored = path.join(dir, 'restored.db');
    cpSync(path.join(dir, backup!), restored);
    const fromBackup = openDb(restored);
    expect(openPause(fromBackup.db)).toEqual([{ id: 'w-open', resumeAt }]);
    expect(indexes(fromBackup.db)).toEqual(['quota_windows_lane_idx', 'quota_windows_open_idx']);
    fromBackup.close();
  });

  it('0022: review comments keep their rows, gain typed defaults and accept file-level (null line) comments', () => {
    const file = path.join(dir, 'emberline.db');
    createOutdatedDb(file);
    const old = new Database(file);
    old.pragma('foreign_keys = OFF');
    old.exec(`insert into projects (id, name, slug, path, created_at) values ('p', 'P', 'p', '/p', 0)`);
    const cols = (
      old.prepare(`pragma table_info(runs)`).all() as { name: string; notnull: number; dflt_value: unknown }[]
    )
      .filter((c) => c.notnull && c.dflt_value === null && c.name !== 'id')
      .map((c) => c.name);
    old
      .prepare(
        `insert into runs (id, ${cols.join(', ')}) values ('r', ${cols.map((c) => (/_at$/.test(c) ? '0' : "'x'")).join(', ')})`,
      )
      .run();
    old.exec(
      `insert into review_comments (id, run_id, file_path, line, side, body, status, created_at, sent_at, resolved_at) values ('c1', 'r', 'a.ts', 4, 'original', 'old', 'sent', 5, 7, 9)`,
    );
    old.close();

    const db = openDb(file);
    const row = db.db.all(sql.raw(`select * from review_comments where id = 'c1'`))[0] as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      id: 'c1',
      run_id: 'r',
      file_path: 'a.ts',
      line: 4,
      side: 'original',
      body: 'old',
      status: 'sent',
      created_at: 5,
      sent_at: 7,
      resolved_at: 9,
      intent: 'fix',
      priority: 'important',
      round: 0,
      anchor_text: null,
      anchor_hash: null,
      verified_at: null,
      carried_to: null,
    });
    db.db.run(
      sql.raw(
        `insert into review_comments (id, run_id, file_path, line, side, body, created_at) values ('c2', 'r', 'a.ts', null, 'modified', 'file', 6)`,
      ),
    );
    expect(db.db.all(sql.raw(`select line from review_comments where id = 'c2'`))).toEqual([{ line: null }]);
    db.close();
  });

  it('0028: hot board, inbox and scheduler lookups have composite indexes', () => {
    const db = openDb(':memory:');
    const indexes = (table: string) =>
      (db.db.all(sql.raw(`pragma index_list(${table})`)) as { name: string }[]).map((i) => i.name);
    expect(indexes('runs')).toEqual(
      expect.arrayContaining([
        'runs_project_created_idx',
        'runs_ticket_created_idx',
        'runs_state_changed_idx',
      ]),
    );
    expect(indexes('runs')).not.toContain('runs_project_idx');
    expect(indexes('tickets')).toContain('tickets_project_position_idx');
    expect(indexes('run_event_compactions')).toEqual(
      expect.arrayContaining([expect.stringContaining('autoindex')]),
    );
    db.close();
  });
});

const DAY = 86_400_000;
const SEEDED_AT = Date.UTC(2026, 0, 1);

describe('event retention', () => {
  let opened: ReturnType<typeof openDb>;
  let db: Db;
  const shape = { projects: 1, ticketsPerProject: 1, runsPerTicket: 5, eventsPerRun: 40 };
  const eventsOf = (runId: string) =>
    db.$client
      .prepare(`select type, state, payload from run_events where run_id = ? order by id`)
      .all(runId) as { type: string; state: string | null; payload: string | null }[];
  const compact = (retentionDays: number, now = SEEDED_AT + 100 * DAY) =>
    compactExpiredRunEvents(db, {
      retentionDays,
      protectedTypes: PRUNE_PROTECTED_EVENT_TYPES,
      usageOf: () => null,
      now,
    });

  beforeEach(() => {
    opened = openDb(':memory:');
    db = opened.db;
    seedRunEvents(db, shape, SEEDED_AT);
    // A successor's handoff note and the ticket's completion, as a quota handoff and ticket_complete leave them.
    db.$client
      .prepare(
        `insert into run_events (run_id, ts, source, type, payload) values (?, ?, 'system', 'handoff_from', ?)`,
      )
      .run('p0-t0-r0', SEEDED_AT, JSON.stringify({ from: 'p0-t0-r9', note: 'Continue the migration' }));
    db.$client
      .prepare(`update tickets set completion = ? where id = 'p0-t0'`)
      .run(JSON.stringify({ runId: 'p0-t0-r0', summary: 'S', handoff: 'H', blockers: [], at: '2026-01-01' }));
  });
  afterEach(() => opened.close());

  it('compacts old done runs but keeps the summary, handoff note, state events and the last Stop', () => {
    const before = eventsOf('p0-t0-r0');
    const toolCalls = before.filter((e) => e.type === 'PreToolUse').length;
    expect(toolCalls).toBeGreaterThan(0);

    const result = compact(90);
    // r0, r1, r2 are done; r3 failed and r4 waits for input.
    expect(result).toMatchObject({ runs: 3, more: false });

    const after = eventsOf('p0-t0-r0');
    expect(after.map((e) => e.type)).toEqual([
      'queued',
      'PostToolUse',
      'ticket_complete',
      'Stop',
      'handoff_from',
    ]);
    expect(after.find((e) => e.type === 'ticket_complete')?.payload).toContain('Handoff of p0-t0-r0');
    expect(after.find((e) => e.type === 'handoff_from')?.payload).toContain('Continue the migration');
    expect(after.filter((e) => e.state !== null).map((e) => e.state)).toEqual(['queued', 'working', 'done']);
    expect(result.eventsRemoved).toBe(3 * (before.length - after.length));

    expect(compactionOf(db, 'p0-t0-r0')).toMatchObject({
      toolCalls,
      eventsRemoved: before.length - after.length,
      inputTokens: null,
    });
    const completion = db.$client.prepare(`select completion from tickets where id = 'p0-t0'`).get() as {
      completion: string;
    };
    expect(JSON.parse(completion.completion)).toMatchObject({ summary: 'S', handoff: 'H' });
  });

  it('leaves young, failed and unfinished runs alone, and a second pass is a no-op', () => {
    const failed = eventsOf('p0-t0-r3').length;
    const waiting = eventsOf('p0-t0-r4').length;
    expect(compact(90, SEEDED_AT + 30 * DAY)).toEqual({ runs: 0, eventsRemoved: 0, more: false });

    compact(90);
    expect(eventsOf('p0-t0-r3')).toHaveLength(failed);
    expect(eventsOf('p0-t0-r4')).toHaveLength(waiting);
    expect(compact(90)).toEqual({ runs: 0, eventsRemoved: 0, more: false });
  });

  it('is off at 0 days and works through a backlog in bounded passes', () => {
    expect(compact(0)).toEqual({ runs: 0, eventsRemoved: 0, more: false });
    const options = {
      retentionDays: 90,
      protectedTypes: PRUNE_PROTECTED_EVENT_TYPES,
      usageOf: () => ({ inputTokens: 10, outputTokens: 5, cachedTokens: 1 }),
      now: SEEDED_AT + 100 * DAY,
      maxRuns: 2,
    };
    expect(compactExpiredRunEvents(db, options)).toMatchObject({ runs: 2, more: true });
    expect(compactExpiredRunEvents(db, options)).toMatchObject({ runs: 1, more: false });
    expect(compactionOf(db, 'p0-t0-r2')).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedTokens: 1 });
  });

  it('compacts a resumed run again, adding to its totals, and drops them with the run', () => {
    compact(90);
    const first = compactionOf(db, 'p0-t0-r0');
    const insert = db.$client.prepare(
      `insert into run_events (run_id, ts, source, type, state) values ('p0-t0-r0', ?, 'hook', ?, ?)`,
    );
    insert.run(SEEDED_AT + DAY, 'PreToolUse', null);
    insert.run(SEEDED_AT + DAY, 'PreToolUse', null);
    insert.run(SEEDED_AT + DAY, 'Notification', null);
    // A Stop without a transition: kept only as the newest one, the run's last turn.
    insert.run(SEEDED_AT + DAY, 'Stop', null);
    compact(90);
    expect(compactionOf(db, 'p0-t0-r0')).toMatchObject({
      toolCalls: (first?.toolCalls ?? 0) + 2,
      eventsRemoved: (first?.eventsRemoved ?? 0) + 3,
    });
    expect(eventsOf('p0-t0-r0').filter((e) => e.type === 'Stop')).toEqual([
      expect.objectContaining({ state: 'done' }),
      expect.objectContaining({ state: null }),
    ]);

    db.$client.prepare(`delete from runs where id = 'p0-t0-r0'`).run();
    expect(compactionOf(db, 'p0-t0-r0')).toBeUndefined();
  });
});
