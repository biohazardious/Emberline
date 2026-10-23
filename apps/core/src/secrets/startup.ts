/**
 * Start-up pass for secrets at rest: load the key, prove it opens every sealed value, install it,
 * then seal the plaintext values an older version left (one transaction, then a checkpoint and
 * VACUUM so no plaintext page stays in the file). Nothing is written before the key is verified, except,
 * with `EMBERLINE_FORGET_SECRETS=1`: plaintext is sealed first, then a snapshot is taken, then the
 * values the key cannot open are cleared.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Db } from '../db/index.js';
import { remoteUrlForDisplay } from '../forge/hosts.js';
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

function forgeTokenRows(sqlite: Sqlite): { id: string; token: string; server_url: string }[] {
  return sqlite.prepare('select id, token, server_url from forge_accounts').all() as {
    id: string;
    token: string;
    server_url: string;
  }[];
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

/**
 * Limit: a pre-0.5 plaintext secret that itself starts with `enc:v1:` counts as sealed, so start
 * then needs a key that opens it (in practice no real token has that prefix).
 */
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
        throw new SecretsKeyError(`${place} could not be decrypted with this key`, { keyLost: true });
      }
    };
  for (const row of secretSettingRows(sqlite)) mapSettingRow(row, open(`settings ${row.key}`));
  for (const row of forgeTokenRows(sqlite)) open('forge_accounts')(row.token);
}

/** Set to `1` for one start: stored secrets the current key cannot open are cleared instead of refusing to start. */
export const FORGET_SECRETS_ENV = 'EMBERLINE_FORGET_SECRETS';

/** The demo's HMAC secret: made again on first use, so nobody enters it. */
export const DEMO_SECRET_LABEL = 'demo signing secret';
/** What a person calls each secret setting, for the log; never a value. */
const SETTING_LABELS: Record<string, string> = {
  'factory.providerKeys': 'provider API keys',
  'notifications.config': 'notification token',
  'updates.config': 'update check GitHub token',
  'forge.config': 'old Forge & Webhooks token',
  'demo.tokenSecret': DEMO_SECRET_LABEL,
  'factory.settings': 'MCP server environment values',
};
const settingPlace = (key: string) => SETTING_LABELS[key] ?? `settings ${key}`;
const accountPlace = (serverUrl: string) => `forge account ${serverUrl} token`;

/** A mapper that leaves readable values alone and notes (or, with `clear`, empties) the others' place. */
function unreadableMapper(key: Buffer, places: Set<string>, place: string, clear: boolean): Fn {
  return (s) => {
    if (!isSealed(s)) return s;
    try {
      openWith(key, s);
      return s;
    } catch {
      places.add(place);
      return clear ? '' : s;
    }
  };
}

/** Which stored secrets `key` cannot open, by label (`notification token`, `forge account <server> token`); never a value. */
export function unreadableSecrets(sqlite: Sqlite, key: Buffer): string[] {
  const places = new Set<string>();
  for (const row of secretSettingRows(sqlite)) {
    mapSettingRow(row, unreadableMapper(key, places, settingPlace(row.key), false));
  }
  for (const row of forgeTokenRows(sqlite)) {
    unreadableMapper(key, places, accountPlace(row.server_url), false)(row.token);
  }
  return [...places];
}

/**
 * Clears every stored secret `key` cannot open, in one transaction: such a setting field becomes
 * empty (unset: the feature reads as not configured, the demo secret is made again), such a forge
 * account keeps no token. Readable values, also in the same setting, stay. Returns the places.
 */
export function forgetUnreadableSecrets(sqlite: Sqlite, key: Buffer): string[] {
  const cleared = new Set<string>();
  sqlite.transaction(() => {
    const setValue = sqlite.prepare('update settings set value = ? where key = ?');
    for (const row of secretSettingRows(sqlite)) {
      const place = settingPlace(row.key);
      const next = mapSettingRow(row, unreadableMapper(key, cleared, place, true));
      if (cleared.has(place)) setValue.run(JSON.stringify(next), row.key);
    }
    const setToken = sqlite.prepare('update forge_accounts set token = ? where id = ?');
    for (const row of forgeTokenRows(sqlite)) {
      const place = accountPlace(row.server_url);
      unreadableMapper(key, cleared, place, true)(row.token);
      // Sealed like every token, so the encryption pass below leaves it alone; it opens to "".
      if (cleared.has(place)) setToken.run(sealWith(key, ''), row.id);
    }
  })();
  return [...cleared];
}

/** A `VACUUM INTO` snapshot next to the database, like the migration snapshots (db/index.ts); null in memory. */
function snapshotBeforeForget(sqlite: Sqlite): string | null {
  const file = sqlite.name;
  if (!file || file === ':memory:') return null;
  const target = `${file}.pre-forget-secrets-${Date.now()}.bak`;
  sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  return target;
}

/**
 * Seals every plaintext secret in one transaction; a crash leaves each value plaintext or sealed.
 * The same transaction strips credentials (`user:token@`, a query) from stored repository URLs that
 * older versions accepted; an ssh user name stays.
 */
export function encryptStoredSecrets(
  sqlite: Sqlite,
  key: Buffer,
): { encrypted: number; cleanedRepoUrls: number } {
  let encrypted = 0;
  let cleanedRepoUrls = 0;
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
      const setRepoUrl = sqlite.prepare('update projects set repo_url = ? where id = ?');
      const repoRows = sqlite
        .prepare('select id, repo_url from projects where repo_url is not null')
        .all() as {
        id: string;
        repo_url: string;
      }[];
      for (const row of repoRows) {
        const shown = remoteUrlForDisplay(row.repo_url);
        // An address that may hold a secret but cannot be cleaned without changing what it names is kept.
        if (!shown.hadCredentials || shown.url === row.repo_url) continue;
        setRepoUrl.run(shown.url, row.id);
        cleanedRepoUrls += 1;
      }
    })();
  } finally {
    sqlite.pragma(`secure_delete = ${Number(secureDelete)}`);
  }
  if (encrypted + cleanedRepoUrls > 0) {
    // The old pages still hold the plaintext: fold the WAL in, rebuild the file, fold again.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.exec('VACUUM');
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  }
  return { encrypted, cleanedRepoUrls };
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
): {
  source: 'env' | 'file' | 'created';
  file: string;
  encrypted: number;
  cleanedRepoUrls: number;
  plaintextSnapshots: string[];
  forget: { requested: boolean; cleared: string[]; snapshot: string | null };
} {
  const startedAt = Date.now();
  const sqlite = db.$client;
  const requested = o.env[FORGET_SECRETS_ENV]?.trim() === '1';
  // A key file is created only for a database that holds no sealed value yet, or when the person
  // asked to forget what a lost key sealed (as on a first start).
  const loaded = loadSecretsKey({
    env: o.env,
    dataDir: o.dataDir,
    allowCreate: requested || !hasSealedSecrets(sqlite),
  });
  const forget = { requested, cleared: [] as string[], snapshot: null as string | null };
  let before = { encrypted: 0, cleanedRepoUrls: 0 };
  if (requested && unreadableSecrets(sqlite, loaded.key).length > 0) {
    // Seal leftover plaintext with this key first, so the snapshot holds no plaintext secret.
    before = encryptStoredSecrets(sqlite, loaded.key);
    forget.snapshot = snapshotBeforeForget(sqlite);
    forget.cleared = forgetUnreadableSecrets(sqlite, loaded.key);
  }
  assertSecretsReadable(sqlite, loaded.key);
  installSecretsKey(loaded.key);
  // Only after the key is durably on disk (key.ts) and proven: from here on data is written.
  const after = encryptStoredSecrets(sqlite, loaded.key);
  const encrypted = before.encrypted + after.encrypted;
  const cleanedRepoUrls = before.cleanedRepoUrls + after.cleanedRepoUrls;
  return {
    source: loaded.source,
    file: loaded.file,
    encrypted,
    cleanedRepoUrls,
    plaintextSnapshots: encrypted + cleanedRepoUrls > 0 ? plaintextSnapshots(o.dataDir, startedAt) : [],
    forget,
  };
}

/** The start log line for {@link startSecrets}' `forget`; null when the variable was not set. */
export function forgetLogLine(forget: {
  requested: boolean;
  cleared: string[];
  snapshot: string | null;
}): { level: 'warn' | 'info'; message: string } | null {
  if (forget.cleared.length === 0) {
    return forget.requested
      ? {
          level: 'info',
          message: `secrets: every stored secret is readable, nothing was cleared; remove ${FORGET_SECRETS_ENV}`,
        }
      : null;
  }
  const enterAgain = forget.cleared.filter((label) => label !== DEMO_SECRET_LABEL);
  const parts = [
    `secrets: ${FORGET_SECRETS_ENV} cleared the stored secrets the current key cannot read.`,
    enterAgain.length > 0 ? `Enter these again in Settings: ${enterAgain.join(', ')}.` : '',
    forget.cleared.includes(DEMO_SECRET_LABEL) ? 'The demo signing secret is made again automatically.' : '',
    forget.snapshot ? `The database before this is in ${forget.snapshot}.` : '',
    `Remove ${FORGET_SECRETS_ENV} now.`,
  ];
  return { level: 'warn', message: parts.filter(Boolean).join(' ') };
}

/**
 * A wrong or missing secrets key stops start: both lines go to `write`, the database is closed and
 * the process exits 1. Any other error is rethrown.
 */
export function exitOnSecretsKeyError(
  error: unknown,
  io: { write: (text: string) => void; closeDb: () => void; exit: (code: number) => void },
): void {
  if (!(error instanceof SecretsKeyError)) throw error;
  io.write(`${error.message}\n${error.detail}\n`);
  io.closeDb();
  io.exit(1);
}
