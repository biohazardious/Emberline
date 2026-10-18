import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
        (db.db.all(sql.raw(`pragma table_info(${table})`)) as { name: string; dflt_value: string | null }[]).map(
          (c) => [c.name, c.dflt_value],
        ),
      );
    const run = defaults('runs');
    expect(run).toMatchObject({ credential: "'login'", routes: "'[]'", route_index: '0', handoff_count: '0' });
    expect(Object.keys(run)).toEqual(expect.arrayContaining(['model', 'predecessor_run_id', 'handed_off_to']));
    expect(defaults('quota_windows')).toMatchObject({ agent: "'claude'", credential: "'login'", pool: "'*'" });
    db.close();
  });

  it('0014: ticket_dependencies exists and deleting a ticket removes its edges both ways', () => {
    const db = openDb(':memory:');
    const run = (query: string) => db.db.run(sql.raw(query));
    run(`insert into projects (id, name, slug, path, created_at) values ('p', 'P', 'p', '/p', 0)`);
    for (const [id, n] of [['a', 1], ['b', 2], ['c', 3]] as const) {
      run(`insert into tickets (id, project_id, number, key, title, status, position, created_at, updated_at) values ('${id}', 'p', ${n}, 'P-${n}', '${id}', 'ready', ${n}, 0, 0)`);
    }
    run(`insert into ticket_dependencies (ticket_id, depends_on_id, created_at) values ('b', 'a', 0), ('c', 'b', 0)`);
    const count = () => (db.db.all(sql.raw('select count(*) as n from ticket_dependencies')) as { n: number }[])[0]?.n;
    expect(count()).toBe(2);
    run(`delete from tickets where id = 'b'`);
    expect(count()).toBe(0);
    db.close();
  });

  it('0019: ticket issue links are unique per project and source, and project_settings cascades', () => {
    const db = openDb(':memory:');
    const run = (query: string) => db.db.run(sql.raw(query));
    for (const id of ['p', 'q']) run(`insert into projects (id, name, slug, path, created_at) values ('${id}', '${id}', '${id}', '/${id}', 0)`);
    const ticket = (id: string, project: string, n: number, source: string | null, externalId: string | null) =>
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
    expect(`${(failure as Error).message} ${((failure as { cause?: Error }).cause)?.message}`).toMatch(/UNIQUE/i);
    ticket('g3', 'q', 1, 'github', '1');
    ticket('l1', 'p', 5, 'gitlab', '1');
    run(`insert into project_settings (project_id, settings) values ('p', '{"issueSync":{}}')`);
    const count = () => (db.db.all(sql.raw('select count(*) as n from project_settings')) as { n: number }[])[0]?.n;
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
      run(`insert into issue_tombstones (project_id, external_source, external_id, created_at) values ('p', '${source}', '${id}', 0)`);
    tomb('github', '1');
    tomb('gitlab', '1');
    expect(() => tomb('github', '1')).toThrow();
    const count = () => (db.db.all(sql.raw('select count(*) as n from issue_tombstones')) as { n: number }[])[0]?.n;
    expect(count()).toBe(2);
    run(`delete from projects where id = 'p'`);
    expect(count()).toBe(0);
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
    expect(snapshot.prepare(`select value from settings where key = 'marker'`).get()).toEqual({ value: '"kept"' });
    snapshot.close();

    // Now up to date: the next start takes no further backup.
    openDb(file).close();
    expect(backups()).toHaveLength(1);
  });
});
