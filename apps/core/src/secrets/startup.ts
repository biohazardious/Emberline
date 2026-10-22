/**
 * Start-up pass for secrets at rest: load the key, prove it opens every sealed value, install it,
 * then seal the plaintext values an older version left (one transaction, then a checkpoint and
 * VACUUM so no plaintext page stays in the file). Nothing is written before the key is verified.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Db } from '../db/index.js';
import { installSecretsKey, isSealed, openWith, SecretsKeyError, sealWith } from './box.js';
import { SECRET_SETTINGS } from './fields.js';
import { loadSecretsKey } from './key.js';

type Sqlite = Database.Database;
type Fn = (s: string) => string;

const SECRET_KEYS = Object.keys(SECRET_SETTINGS);

function secretSettingRows(sqlite: Sqlite): { key: string; value: string }[] {
  return sqlite
    .prepare(`select key, value from settings where key in (${SECRET_KEYS.map(() => '?').join(', ')})`)
    .all(...SECRET_KEYS) as { key: string; value: string }[];
}

function forgeTokenRows(sqlite: Sqlite): { id: string; token: string }[] {
  return sqlite.prepare('select id, token from forge_accounts').all() as { id: string; token: string }[];
}

/** Maps a settings row's secret strings; null when its stored JSON cannot be read (left alone). */
function mapSettingRow(row: { key: string; value: string }, f: Fn): unknown {
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    return null;
  }
  return SECRET_SETTINGS[row.key]!(value, f);
}

export function hasSealedSecrets(sqlite: Sqlite): boolean {
  let found = false;
  const note: Fn = (s) => {
    if (isSealed(s)) found = true;
    return s;
  };
  for (const row of secretSettingRows(sqlite)) mapSettingRow(row, note);
  return found || forgeTokenRows(sqlite).some((r) => isSealed(r.token));
}

/** Throws SecretsKeyError naming the first place the key cannot open (never the value). */
export function assertSecretsReadable(sqlite: Sqlite, key: Buffer): void {
  const open =
    (place: string): Fn =>
    (s) => {
      if (!isSealed(s)) return s;
      try {
        return openWith(key, s);
      } catch {
        throw new SecretsKeyError(`${place} could not be decrypted with this key`);
      }
    };
  for (const row of secretSettingRows(sqlite)) mapSettingRow(row, open(`settings ${row.key}`));
  for (const row of forgeTokenRows(sqlite)) open('forge_accounts')(row.token);
}

/** Seals every plaintext secret in one transaction; a crash leaves each value plaintext or sealed. */
export function encryptStoredSecrets(sqlite: Sqlite, key: Buffer): { encrypted: number } {
  let encrypted = 0;
  const seal: Fn = (s) => {
    if (isSealed(s)) return s;
    encrypted += 1;
    return sealWith(key, s);
  };
  // Freed cells are zeroed, so even a crash before the VACUUM below leaves no plaintext once checkpointed.
  const secureDelete = sqlite.pragma('secure_delete', { simple: true }) as number;
  sqlite.pragma('secure_delete = ON');
  try {
    sqlite.transaction(() => {
      const setValue = sqlite.prepare('update settings set value = ? where key = ?');
      for (const row of secretSettingRows(sqlite)) {
        const before = encrypted;
        const next = mapSettingRow(row, seal);
        if (encrypted > before) setValue.run(JSON.stringify(next), row.key);
      }
      const setToken = sqlite.prepare('update forge_accounts set token = ? where id = ?');
      for (const row of forgeTokenRows(sqlite)) {
        if (!isSealed(row.token)) setToken.run(seal(row.token), row.id);
      }
    })();
  } finally {
    sqlite.pragma(`secure_delete = ${Number(secureDelete)}`);
  }
  if (encrypted > 0) {
    // The old pages still hold the plaintext: fold the WAL in, rebuild the file, fold again.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.exec('VACUUM');
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  }
  return { encrypted };
}

/** Snapshots written before `before` (migration .bak files, `make backup` copies): they hold plaintext. */
function plaintextSnapshots(dataDir: string, before: number): string[] {
  const list = (dir: string, match: (name: string) => boolean): string[] => {
    try {
      return readdirSync(dir)
        .filter(match)
        .map((name) => path.join(dir, name))
        .filter((file) => statSync(file).mtimeMs <= before);
    } catch {
      return [];
    }
  };
  return [
    ...list(dataDir, (name) => /\.pre-migration-.*\.bak$/.test(name)),
    ...list(path.join(dataDir, 'backups'), (name) => /^emberline-.*\.db$/.test(name)),
  ];
}

export function startSecrets(
  db: Db,
  o: { env: NodeJS.ProcessEnv; dataDir: string },
): { source: 'env' | 'file' | 'created'; file: string; encrypted: number; plaintextSnapshots: string[] } {
  const startedAt = Date.now();
  const sqlite = db.$client;
  // A key file is created only for a database that holds no sealed value yet.
  const loaded = loadSecretsKey({ env: o.env, dataDir: o.dataDir, allowCreate: !hasSealedSecrets(sqlite) });
  assertSecretsReadable(sqlite, loaded.key);
  installSecretsKey(loaded.key);
  const { encrypted } = encryptStoredSecrets(sqlite, loaded.key);
  return {
    source: loaded.source,
    file: loaded.file,
    encrypted,
    plaintextSnapshots: encrypted > 0 ? plaintextSnapshots(o.dataDir, startedAt) : [],
  };
}
