import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/** Same relative location from src/db (dev/tests) and dist/db (production). */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface OpenedDb {
  db: Db;
  close(): void;
}

/** Opens (or creates) the database and applies pending migrations. Pass `:memory:` for tests. */
export function openDb(file: string): OpenedDb {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle({ client: sqlite, schema });
  if (file !== ':memory:') backupBeforeMigrations(sqlite, file);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => sqlite.close() };
}

const KEPT_MIGRATION_BACKUPS = 3;

/** Newest applied migration timestamp, or null for a database that has never been migrated. */
function lastAppliedMigration(sqlite: Database.Database): number | null {
  const table = sqlite
    .prepare(`select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'`)
    .get();
  if (!table) return null;
  const row = sqlite.prepare('select max(created_at) as last from __drizzle_migrations').get() as {
    last: number | null;
  };
  return row.last;
}

/**
 * Snapshots an existing database (`VACUUM INTO`, consistent under WAL) before pending migrations
 * run, so a failed or destructive migration can be rolled back by hand. Keeps the newest few.
 */
function backupBeforeMigrations(sqlite: Database.Database, file: string): void {
  const last = lastAppliedMigration(sqlite);
  if (last === null) return; // fresh database: nothing to protect
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { when: number; tag: string }[];
  };
  const pending = journal.entries.filter((entry) => entry.when > last);
  if (pending.length === 0) return;

  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.pre-migration-`;
  const target = path.join(dir, `${prefix}${Date.now()}.bak`);
  if (existsSync(target)) return;
  sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEPT_MIGRATION_BACKUPS))) {
    rmSync(path.join(dir, old), { force: true });
  }
}

export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value as T | undefined;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}
