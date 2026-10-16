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
