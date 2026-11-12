import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { openDb } from './db/index.js';
import * as schema from './db/schema.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};

type Snapshot = Awaited<ReturnType<typeof generateSQLiteDrizzleJson>>;

function readSnapshot(idx: number): Snapshot {
  const file = path.join(MIGRATIONS_DIR, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
}

const schemaExports: unknown[] = Object.values(schema);
const schemaTables = schemaExports.filter((value): value is SQLiteTable => is(value, SQLiteTable));

describe('database schema and migrations', () => {
  it('every journal entry has its SQL file and snapshot, in order and with rising timestamps', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      expect(entry.tag.startsWith(String(position).padStart(4, '0') + '_')).toBe(true);
      expect(existsSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`))).toBe(true);
      expect(existsSync(path.join(MIGRATIONS_DIR, 'meta', `${entry.tag.slice(0, 4)}_snapshot.json`))).toBe(
        true,
      );
      const previous = journal.entries[position - 1];
      if (previous) expect(entry.when).toBeGreaterThan(previous.when);
    });
  });

  it('schema.ts matches the newest migration snapshot (run `make db-generate` after a schema edit)', async () => {
    const newest = journal.entries.at(-1);
    if (!newest) throw new Error('no migrations in the journal');
    const current = await generateSQLiteDrizzleJson(schema);
    const pending = await generateSQLiteMigration(readSnapshot(newest.idx), current);
    expect(pending).toEqual([]);
  });

  it('the migrated database has exactly the tables and columns that schema.ts declares', () => {
    const opened = openDb(':memory:');
    try {
      const sqlite = opened.db.$client;
      const tables = (
        sqlite
          .prepare(
            `select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__drizzle_migrations'`,
          )
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .sort();
      expect(tables).toEqual(schemaTables.map((table) => getTableConfig(table).name).sort());

      for (const table of schemaTables) {
        const config = getTableConfig(table);
        const columns = (sqlite.prepare(`pragma table_info("${config.name}")`).all() as { name: string }[])
          .map((column) => column.name)
          .sort();
        expect({ table: config.name, columns }).toEqual({
          table: config.name,
          columns: config.columns.map((column) => column.name).sort(),
        });
      }
    } finally {
      opened.close();
    }
  });

  it('foreign keys are enforced on every connection', () => {
    const opened = openDb(':memory:');
    try {
      expect(opened.db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(opened.db.$client.pragma('foreign_key_check')).toEqual([]);
    } finally {
      opened.close();
    }
  });
});
