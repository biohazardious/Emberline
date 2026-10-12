import { mkdirSync } from 'node:fs';
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
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => sqlite.close() };
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
