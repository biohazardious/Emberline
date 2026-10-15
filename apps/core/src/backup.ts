/**
 * `node dist/backup.js` (used by `make backup`): writes a consistent copy of the live database to
 * <data>/backups/emberline-<UTC timestamp>.db with `VACUUM INTO` (safe while core runs, WAL
 * included), keeps the newest EMBERLINE_BACKUP_KEEP (default 10) and prints the new file's path.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from './config.js';

export function backupDatabase(dbFile: string, backupDir: string, keep: number, now = new Date()): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(backupDir, `emberline-${stamp}.db`);
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    sqlite.close();
  }
  const existing = readdirSync(backupDir)
    .filter((name) => /^emberline-\d{8}T\d{6}Z\.db$/.test(name))
    .sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) {
    rmSync(path.join(backupDir, old), { force: true });
  }
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const keep = Math.max(1, Number(process.env.EMBERLINE_BACKUP_KEEP ?? 10));
  const target = backupDatabase(
    path.join(config.dataDir, 'emberline.db'),
    path.join(config.dataDir, 'backups'),
    keep,
  );
  process.stdout.write(`${target}\n`);
}
