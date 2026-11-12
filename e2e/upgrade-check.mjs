#!/usr/bin/env node
/**
 * Upgrade-path checks (see e2e/upgrade-paths.sh and the CHANGELOG upgrade notes). It runs inside the
 * core image, mounted at /app/upgrade-check.mjs so it resolves core's own better-sqlite3 and drizzle:
 *
 *   seed <old-drizzle-dir> <label>   a data dir as an old release left it: its migrations, seeded rows,
 *                                    secrets sealed (0.6+) or plaintext (0.5) and the secrets key
 *   verify <label>                   after the upgrade: a pre-migration snapshot, every migration applied,
 *                                    every seeded row and secret intact under the same key
 *   restore <old-drizzle-dir> <label> the rollback drill: the snapshot back in place opens under the
 *                                    previous release's migrations with every seeded row
 *   matrix                           every migration step of this release: from any database state, the
 *                                    upgrade snapshots first and breaks no seeded row
 *   api <base-url> ops-missing|ops-ok  what the web app's banner reads (GET /api/system)
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const DATA = process.env.EMBERLINE_DATA_DIR ?? '/data';
const DB_FILE = path.join(DATA, 'emberline.db');
const KEY_FILE = path.join(DATA, 'secrets.key');
const MANIFEST = path.join(DATA, 'upgrade-manifest.json');
const CURRENT_MIGRATIONS = path.resolve('drizzle');
const SECRET_PLAIN = 'ghp_upgrade-path-secret-token';
const PASSWORD = 'e2e password long enough';
const SETUP_TOKEN = 'e2e-setup-token';
const NOW = 1_760_000_000_000;

const journalOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')).entries;
const lastWhen = (dir) => Math.max(...journalOf(dir).map((e) => e.when));

/** A migrations folder holding only the first `count` migrations of `dir`. */
function prefixFolder(dir, count) {
  const out = mkdtempSync(path.join(tmpdir(), 'migrations-'));
  cpSync(dir, out, { recursive: true });
  const journalFile = path.join(out, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalFile, JSON.stringify(journal));
  return out;
}

const tableColumns = (sqlite, table) => sqlite.prepare(`pragma table_info(${table})`).all();

/** Inserts a row with the known values for the columns this schema has; other required columns get a filler. */
function insertRow(sqlite, table, known) {
  const columns = tableColumns(sqlite, table);
  if (columns.length === 0) return null;
  const row = {};
  for (const c of columns) {
    if (c.name in known) row[c.name] = known[c.name];
    else if (c.notnull && c.dflt_value === null && !c.pk) row[c.name] = /INT|REAL/i.test(c.type) ? 1 : 'x';
  }
  const names = Object.keys(row);
  sqlite
    .prepare(`insert into ${table} (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
  return { table, id: known.id, values: Object.fromEntries(Object.entries(row).filter(([k]) => k in known)) };
}

const SEEDS = [
  [
    'projects',
    {
      id: 'p-up',
      name: 'Upgrade Project',
      slug: 'upgrade-project',
      path: '/workspaces/upgrade-project',
      created_at: NOW,
    },
  ],
  [
    'tickets',
    {
      id: 't-up',
      project_id: 'p-up',
      number: 1,
      key: 'UP-1',
      title: 'Survives the upgrade',
      status: 'review',
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  [
    'runs',
    {
      id: 'r-up',
      project_id: 'p-up',
      ticket_id: 't-up',
      agent: 'claude',
      state: 'done',
      worktree_path: '/workspaces/upgrade-project/wt',
      hook_token_hash: 'h',
      state_changed_at: NOW,
      created_at: NOW,
    },
  ],
  [
    'review_comments',
    {
      id: 'c-up',
      run_id: 'r-up',
      file_path: 'src/a.ts',
      line: 3,
      side: 'new',
      body: 'Keep this comment',
      created_at: NOW,
      updated_at: NOW,
    },
  ],
];

/** Seeds every row whose table exists and is not yet seeded; returns the rows seeded now. */
function seedRows(sqlite, done) {
  const seeded = [];
  for (const [table, known] of SEEDS) {
    if (done.has(table)) continue;
    const row = insertRow(sqlite, table, known);
    if (row) {
      done.add(table);
      seeded.push(row);
    }
  }
  return seeded;
}

function assertRows(sqlite, rows, where) {
  for (const { table, id, values } of rows) {
    const found = sqlite
      .prepare(`select ${Object.keys(values).join(', ')} from ${table} where id = ?`)
      .get(id);
    assert.deepEqual(found, values, `${where}: ${table} row ${id} changed or is missing`);
  }
}

const snapshots = (dir) =>
  readdirSync(dir)
    .filter((n) => /^emberline\.db\.pre-migration-\d+\.bak$/.test(n))
    .sort();

function lastMigration(file) {
  const sqlite = new Database(file, { readonly: true });
  try {
    return sqlite.prepare('select max(created_at) as last, count(*) as n from __drizzle_migrations').get();
  } finally {
    sqlite.close();
  }
}

async function seed(oldDir, label) {
  mkdirSync(DATA, { recursive: true });
  const sqlite = new Database(DB_FILE);
  migrate(drizzle({ client: sqlite }), { migrationsFolder: oldDir });
  const rows = seedRows(sqlite, new Set());
  const key = randomBytes(32);
  const sealed = label !== '0.5.2';
  let stored = SECRET_PLAIN;
  if (sealed) {
    const { sealWith } = await import('/app/dist/secrets/box.js');
    stored = sealWith(key, SECRET_PLAIN);
    writeFileSync(KEY_FILE, `${key.toString('base64')}\n`, { mode: 0o600 });
  }
  sqlite
    .prepare('insert into settings (key, value) values (?, ?)')
    .run('updates.config', JSON.stringify({ githubToken: stored }));
  sqlite.close();
  writeFileSync(
    MANIFEST,
    JSON.stringify({
      label,
      rows,
      sealed,
      keyDigest: sealed ? createHash('sha256').update(readFileSync(KEY_FILE)).digest('hex') : null,
      seededLast: lastWhen(oldDir),
      seededCount: journalOf(oldDir).length,
    }),
  );
  console.log(
    `seeded ${label}: ${rows.length} rows, ${journalOf(oldDir).length} migrations, secrets ${sealed ? 'sealed' : 'plaintext'}`,
  );
}

const manifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));

async function openSecret() {
  const { openWith, isSealed } = await import('/app/dist/secrets/box.js');
  const sqlite = new Database(DB_FILE, { readonly: true });
  const row = sqlite.prepare(`select value from settings where key = 'updates.config'`).get();
  sqlite.close();
  const stored = JSON.parse(row.value).githubToken;
  assert.ok(isSealed(stored), 'the secret is stored sealed after the upgrade');
  const key = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  return openWith(key, stored);
}

async function verify(label) {
  const m = manifest();
  assert.equal(m.label, label);
  const current = journalOf(CURRENT_MIGRATIONS);
  const applied = lastMigration(DB_FILE);
  assert.equal(applied.n, current.length, 'every migration of this release is applied');
  const backups = snapshots(DATA);
  assert.ok(
    backups.length > 0,
    `no pre-migration snapshot in ${DATA}: the upgrade ran migrations unprotected`,
  );
  const newest = backups[backups.length - 1];
  const snap = lastMigration(path.join(DATA, newest));
  assert.equal(snap.last, m.seededLast, 'the snapshot holds the database as the old release left it');
  const pending = current.filter((e) => e.when > m.seededLast);
  assert.ok(pending.length > 0, 'the old release has migrations to run');
  const sqlite = new Database(DB_FILE, { readonly: true });
  assertRows(sqlite, m.rows, 'upgraded database');
  sqlite.close();
  const snapDb = new Database(path.join(DATA, newest), { readonly: true });
  assertRows(snapDb, m.rows, 'snapshot');
  snapDb.close();
  if (m.sealed) {
    const digest = createHash('sha256').update(readFileSync(KEY_FILE)).digest('hex');
    assert.equal(digest, m.keyDigest, 'the secrets key file is unchanged');
  }
  assert.equal(await openSecret(), SECRET_PLAIN, 'the secret opens to the same value with the same key');
  console.log(`verified ${label}: ${pending.length} migrations ran after ${newest}; rows and secrets intact`);
}

function restore(oldDir, label) {
  const m = manifest();
  assert.equal(m.label, label);
  const backups = snapshots(DATA);
  assert.ok(backups.length > 0, 'nothing to restore: no pre-migration snapshot');
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_FILE}${suffix}`, { force: true });
  copyFileSync(path.join(DATA, backups[0]), DB_FILE);
  const sqlite = new Database(DB_FILE);
  // The previous release's startup is its migrator over its own migrations: with the snapshot in
  // place, it finds nothing pending and changes nothing.
  const before = sqlite.prepare('select count(*) as n from __drizzle_migrations').get().n;
  migrate(drizzle({ client: sqlite }), { migrationsFolder: oldDir });
  const after = sqlite.prepare('select count(*) as n from __drizzle_migrations').get().n;
  assert.equal(after, before, 'the previous release would run migrations on the restored snapshot');
  assert.equal(before, m.seededCount, 'the snapshot is at the previous release schema');
  assertRows(sqlite, m.rows, 'restored snapshot');
  sqlite.close();
  console.log(`restored ${label}: the previous release's migrations find nothing to run; rows intact`);
}

async function matrix() {
  const { openDb } = await import('/app/dist/db/index.js');
  const entries = journalOf(CURRENT_MIGRATIONS);
  const work = mkdtempSync(path.join(tmpdir(), 'matrix-'));
  const file = path.join(work, 'emberline.db');
  const done = new Set();
  const rows = [];
  for (let at = 1; at < entries.length; at++) {
    const sqlite = new Database(file);
    migrate(drizzle({ client: sqlite }), { migrationsFolder: prefixFolder(CURRENT_MIGRATIONS, at) });
    rows.push(...seedRows(sqlite, done));
    sqlite.close();
    // Upgrade a copy from this state: it must snapshot first, then break no row.
    const copyDir = path.join(work, `from-${at}`);
    mkdirSync(copyDir);
    const copy = path.join(copyDir, 'emberline.db');
    const src = new Database(file);
    src.exec(`vacuum into '${copy.replaceAll("'", "''")}'`);
    src.close();
    openDb(copy).close();
    const made = snapshots(copyDir);
    assert.equal(
      made.length,
      1,
      `from migration ${entries[at - 1].tag}: expected one snapshot, found ${made.length}`,
    );
    assert.equal(
      lastMigration(path.join(copyDir, made[0])).last,
      entries[at - 1].when,
      `from ${entries[at - 1].tag}: the snapshot is not the pre-migration state`,
    );
    assert.equal(
      lastMigration(copy).n,
      entries.length,
      `from ${entries[at - 1].tag}: migrations were left pending`,
    );
    const upgraded = new Database(copy, { readonly: true });
    assertRows(upgraded, rows, `upgrade from ${entries[at - 1].tag}`);
    upgraded.close();
  }
  rmSync(work, { recursive: true, force: true });
  console.log(
    `matrix: ${entries.length - 1} upgrade starting points each snapshot first and keep ${rows.length} seeded rows`,
  );
}

async function api(base, expect) {
  let cookie = '';
  let key = '';
  const call = async (method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'x-emberline-csrf': key || '1' }),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const setup = await call('POST', '/api/auth/setup', { password: PASSWORD, setupToken: SETUP_TOKEN });
  assert.ok(setup.status < 500, `setup answered ${setup.status}`);
  const login = await call('POST', '/api/auth/login', { password: PASSWORD });
  assert.equal(login.status, 200, 'login');
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  key = login.json.sessionKey;
  const wantMissing = expect === 'ops-missing';
  const deadline = Date.now() + 90_000;
  let status;
  do {
    status = (await call('GET', '/api/system')).json;
    if (status.opsMissing === wantMissing) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  assert.equal(status.opsMissing, wantMissing, `/api/system opsMissing should be ${wantMissing}`);
  if (wantMissing) {
    const refused = await call('POST', '/api/terminals', { kind: 'shell' });
    assert.equal(refused.status, 503);
    assert.equal(refused.json.code, 'ops_missing');
  }
  const projects = await call('GET', '/api/projects');
  assert.ok(
    projects.json.some((p) => p.slug === 'upgrade-project'),
    'the seeded project is listed by the API',
  );
  console.log(`api: ops banner ${wantMissing ? 'shown' : 'clear'}; seeded project listed`);
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'seed') await seed(a, b);
else if (mode === 'verify') await verify(a);
else if (mode === 'restore') restore(a, b);
else if (mode === 'matrix') await matrix();
else if (mode === 'api') await api(a, b);
else {
  console.error(`unknown mode ${mode ?? ''}`);
  process.exit(2);
}
