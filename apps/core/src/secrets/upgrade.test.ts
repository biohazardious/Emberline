import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSetting, openDb } from '../db/index.js';
import { getProviderEnvFromSettings } from '../factory/settings.js';
import { listAccountRecords } from '../forge/account-store.js';
import { installedSecretsKey, installSecretsKey, SecretsKeyError, sealWith } from './box.js';
import { encryptStoredSecrets, startSecrets } from './startup.js';

const testKey = installedSecretsKey();
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'secrets-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  installSecretsKey(testKey);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('secrets at start', () => {
  it('encrypts a 0.4 database in place, once, and refuses another key', () => {
    const dir = tempDir();
    const file = path.join(dir, 'emberline.db');
    const k1 = randomBytes(32).toString('base64');
    let o = openDb(file);
    const raw = o.db.$client;
    const put = raw.prepare('insert into settings(key, value) values (?, ?)');
    const demo = 'cd'.repeat(32);
    put.run(
      'factory.providerKeys',
      JSON.stringify({ anthropicApiKey: 'sk-ant-CANARY1', openaiApiKey: null }),
    );
    put.run(
      'notifications.config',
      JSON.stringify({ enabled: true, provider: 'ntfy', url: 'https://ntfy.sh/x', token: 'CANARY2' }),
    );
    put.run('updates.config', JSON.stringify({ autoCheck: true, githubToken: 'ghp_CANARY3' }));
    put.run('demo.tokenSecret', JSON.stringify(demo));
    put.run('forge.config', JSON.stringify({ provider: 'auto', apiUrl: null, token: 'CANARY4' }));
    put.run(
      'factory.settings',
      JSON.stringify({ mcpServers: [{ id: 'gh', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'CANARY6' } }] }),
    );
    raw
      .prepare(
        `insert into forge_accounts (id, provider, server_url, api_url, username, token, created_at, updated_at)
      values ('a','github','https://github.com','https://api.github.com',null,'CANARY5',0,0)`,
      )
      .run();
    const env = { EMBERLINE_SECRETS_KEY: k1 };
    expect(startSecrets(o.db, { env, dataDir: dir }).encrypted).toBe(7);
    const rows = () =>
      JSON.stringify([
        o.db.$client.prepare('select * from settings').all(),
        o.db.$client.prepare('select token from forge_accounts').all(),
      ]);
    const after = rows();
    expect(after).not.toMatch(/CANARY/);
    expect(after).not.toContain(demo);
    expect(after).toContain('https://ntfy.sh/x'); // non-secret fields stay readable
    expect(getProviderEnvFromSettings(o.db, 'claude').ANTHROPIC_API_KEY).toBe('sk-ant-CANARY1');
    expect(listAccountRecords(o.db, {})[0]!.token).toBe('CANARY5');
    expect(startSecrets(o.db, { env, dataDir: dir }).encrypted).toBe(0);
    expect(rows()).toBe(after); // idempotent
    o.close();
    expect(readFileSync(file).includes('CANARY')).toBe(false); // no plaintext page left (VACUUM)
    o = openDb(file);
    expect(() =>
      startSecrets(o.db, {
        env: { EMBERLINE_SECRETS_KEY: randomBytes(32).toString('base64') },
        dataDir: dir,
      }),
    ).toThrow("Emberline can't read its stored secrets: the secrets key changed or is missing.");
    expect(() => startSecrets(o.db, { env: {}, dataDir: dir })).toThrow(SecretsKeyError);
    expect(existsSync(path.join(dir, 'secrets.key'))).toBe(false); // a missing key is never silently replaced
    expect(rows()).toBe(after); // nothing wiped or rewritten
    o.close();
  });

  it('names the place that cannot be decrypted, never the value', () => {
    const dir = tempDir();
    const o = openDb(path.join(dir, 'emberline.db'));
    const raw = o.db.$client;
    raw
      .prepare('insert into settings(key, value) values (?, ?)')
      .run('updates.config', JSON.stringify({ githubToken: 'ghp_CANARY7' }));
    startSecrets(o.db, { env: {}, dataDir: dir });
    rmSync(path.join(dir, 'secrets.key'));
    writeFileSync(path.join(dir, 'secrets.key'), `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    let error: unknown;
    try {
      startSecrets(o.db, { env: {}, dataDir: dir });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecretsKeyError);
    expect((error as SecretsKeyError).detail).toContain('updates.config');
    expect((error as SecretsKeyError).detail).not.toMatch(/CANARY|enc:v1:/);
    o.close();
  });

  it('a fresh install creates secrets.key (0600) and the next start reuses it', () => {
    const dir = tempDir();
    const o = openDb(path.join(dir, 'emberline.db'));
    const first = startSecrets(o.db, { env: {}, dataDir: dir });
    expect(first).toMatchObject({ source: 'created', file: path.join(dir, 'secrets.key'), encrypted: 0 });
    expect(statSync(first.file).mode & 0o777).toBe(0o600);
    const second = startSecrets(o.db, { env: {}, dataDir: dir });
    expect(second.source).toBe('file');
    o.close();
  });

  it('lists plaintext snapshots older than this start when it encrypts', () => {
    const dir = tempDir();
    const o = openDb(path.join(dir, 'emberline.db'));
    o.db.$client
      .prepare('insert into settings(key, value) values (?, ?)')
      .run('demo.tokenSecret', JSON.stringify('ab'.repeat(32)));
    const snapshot = path.join(dir, 'emberline.db.pre-migration-1.bak');
    writeFileSync(snapshot, 'old');
    mkdirSync(path.join(dir, 'backups'));
    const backup = path.join(dir, 'backups', 'emberline-20261001T000000Z.db');
    writeFileSync(backup, 'old');
    const past = new Date(Date.now() - 60_000);
    utimesSync(snapshot, past, past);
    utimesSync(backup, past, past);
    const result = startSecrets(o.db, { env: {}, dataDir: dir });
    expect(result.encrypted).toBe(1);
    expect(result.plaintextSnapshots.sort()).toEqual([backup, snapshot].sort());
    // Nothing was encrypted on the next start: nothing to warn about.
    expect(startSecrets(o.db, { env: {}, dataDir: dir }).plaintextSnapshots).toEqual([]);
    o.close();
  });

  it('a failure midway leaves every value as it was (one transaction)', () => {
    const dir = tempDir();
    const o = openDb(path.join(dir, 'emberline.db'));
    const raw = o.db.$client;
    raw
      .prepare('insert into settings(key, value) values (?, ?)')
      .run('updates.config', JSON.stringify({ githubToken: 'ghp_X' }));
    raw
      .prepare(
        `insert into forge_accounts (id, provider, server_url, api_url, username, token, created_at, updated_at)
      values ('a','github','https://github.com','https://api.github.com',null,'tok',0,0)`,
      )
      .run();
    raw.exec(
      `create trigger fail_token before update on forge_accounts begin select raise(abort, 'disk full'); end`,
    );
    const before = JSON.stringify(raw.prepare('select * from settings').all());
    expect(() => encryptStoredSecrets(raw, randomBytes(32))).toThrow('disk full');
    expect(JSON.stringify(raw.prepare('select * from settings').all())).toBe(before);
    o.close();
  });
  it('strips credentials from stored repository URLs in the same pass, keeping ssh user names', () => {
    const dir = tempDir();
    const file = path.join(dir, 'emberline.db');
    let o = openDb(file);
    const put = o.db.$client.prepare(
      'insert into projects (id, name, slug, repo_url, path, created_at) values (?, ?, ?, ?, ?, 0)',
    );
    const urls: Record<string, string | null> = {
      a: 'https://x-access-token:ghp_CANARY8@github.com/o/a.git',
      b: 'http://oauth2:glpat-CANARY9@git.lan/o/b.git',
      c: 'git@github.com:o/c.git',
      d: 'ssh://git@host:2222/o/d.git',
      e: 'https://github.com/o/e.git',
      f: null,
    };
    for (const [id, url] of Object.entries(urls)) put.run(id, id, id, url, `/w/${id}`);
    const repoUrls = () =>
      Object.fromEntries(
        (
          o.db.$client.prepare('select id, repo_url from projects order by id').all() as {
            id: string;
            repo_url: string | null;
          }[]
        ).map((r) => [r.id, r.repo_url]),
      );
    const first = startSecrets(o.db, { env: {}, dataDir: dir });
    expect(first.cleanedRepoUrls).toBe(2);
    expect(repoUrls()).toEqual({
      ...urls,
      a: 'https://github.com/o/a.git',
      b: 'http://git.lan/o/b.git',
    });
    expect(startSecrets(o.db, { env: {}, dataDir: dir }).cleanedRepoUrls).toBe(0);
    o.close();
    expect(readFileSync(file).includes('CANARY')).toBe(false);
    o = openDb(file);
    o.close();
  });

  it('a non-secret setting that merely contains the prefix does not block creating the key', () => {
    const dir = tempDir();
    const o = openDb(path.join(dir, 'emberline.db'));
    o.db.$client
      .prepare('insert into settings(key, value) values (?, ?)')
      .run('ui.note', JSON.stringify('enc:v1:hello'));
    expect(startSecrets(o.db, { env: {}, dataDir: dir }).source).toBe('created');
    o.close();
  });
});

describe('EMBERLINE_FORGET_SECRETS=1 (a database restored without its key)', () => {
  /** Two settings and an account sealed with `lost`, the notification token sealed with `kept`. */
  const restored = (dir: string, lost: Buffer, kept: Buffer) => {
    const o = openDb(path.join(dir, 'emberline.db'));
    const put = o.db.$client.prepare('insert into settings(key, value) values (?, ?)');
    put.run(
      'updates.config',
      JSON.stringify({ autoCheck: true, githubToken: sealWith(lost, 'ghp_CANARY10') }),
    );
    put.run('demo.tokenSecret', JSON.stringify(sealWith(lost, 'ef'.repeat(32))));
    put.run(
      'factory.providerKeys',
      JSON.stringify({
        anthropicApiKey: sealWith(lost, 'sk-ant-CANARY13'),
        openaiApiKey: sealWith(kept, 'sk-CANARY14'),
      }),
    );
    put.run(
      'notifications.config',
      JSON.stringify({
        enabled: true,
        provider: 'ntfy',
        url: 'https://ntfy.sh/x',
        token: sealWith(kept, 'CANARY11'),
      }),
    );
    o.db.$client
      .prepare(
        `insert into forge_accounts (id, provider, server_url, api_url, username, token, created_at, updated_at)
      values ('a','github','https://github.com','https://api.github.com',null,?,0,0)`,
      )
      .run(sealWith(lost, 'CANARY12'));
    return o;
  };
  const envWith = (key: Buffer, forget = true): NodeJS.ProcessEnv => ({
    EMBERLINE_SECRETS_KEY: key.toString('base64'),
    ...(forget ? { EMBERLINE_FORGET_SECRETS: '1' } : {}),
  });
  const rows = (o: ReturnType<typeof openDb>) =>
    JSON.stringify([
      o.db.$client.prepare('select * from settings order by key').all(),
      o.db.$client.prepare('select token from forge_accounts').all(),
    ]);

  it('without it, a key that cannot read them still stops start and changes nothing', () => {
    const dir = tempDir();
    const o = restored(dir, randomBytes(32), randomBytes(32));
    const before = rows(o);
    expect(() => startSecrets(o.db, { env: envWith(randomBytes(32), false), dataDir: dir })).toThrow(
      SecretsKeyError,
    );
    expect(rows(o)).toBe(before);
    o.close();
  });

  it('clears only what the key cannot read, snapshots first, and names places, never values', () => {
    const dir = tempDir();
    const lost = randomBytes(32);
    const kept = randomBytes(32);
    const o = restored(dir, lost, kept);
    const result = startSecrets(o.db, { env: envWith(kept), dataDir: dir });
    expect(result.forget.requested).toBe(true);
    expect([...result.forget.cleared].sort()).toEqual([
      'forge account https://github.com',
      'settings demo.tokenSecret',
      'settings factory.providerKeys',
      'settings updates.config',
    ]);
    expect(JSON.stringify(result.forget)).not.toMatch(/CANARY|enc:v1:/);
    expect(result.forget.snapshot).toMatch(/emberline\.db\.pre-forget-secrets-\d+\.bak$/);
    expect(existsSync(result.forget.snapshot!)).toBe(true);
    // A half-readable setting keeps its readable field; the readable setting stays as it was.
    expect(getSetting(o.db, 'factory.providerKeys')).toEqual({
      anthropicApiKey: '',
      openaiApiKey: 'sk-CANARY14',
    });
    expect(getSetting(o.db, 'notifications.config')).toMatchObject({ token: 'CANARY11' });
    expect(getSetting(o.db, 'updates.config')).toMatchObject({ githubToken: '' });
    expect(getSetting(o.db, 'demo.tokenSecret')).toBe('');
    expect(listAccountRecords(o.db, {})[0]!.token).toBe('');
    // The next start, without the variable, opens everything.
    expect(startSecrets(o.db, { env: envWith(kept, false), dataDir: dir }).forget).toEqual({
      requested: false,
      cleared: [],
      snapshot: null,
    });
    o.close();
  });

  it('with every secret readable it clears nothing and takes no snapshot', () => {
    const dir = tempDir();
    const kept = randomBytes(32);
    const o = restored(dir, kept, kept);
    const before = rows(o);
    expect(startSecrets(o.db, { env: envWith(kept), dataDir: dir }).forget).toEqual({
      requested: true,
      cleared: [],
      snapshot: null,
    });
    expect(rows(o)).toBe(before);
    o.close();
  });

  it('a missing key file is created as on a first start, and what the lost key sealed is cleared', () => {
    const dir = tempDir();
    const lost = randomBytes(32);
    const o = restored(dir, lost, lost);
    const result = startSecrets(o.db, { env: { EMBERLINE_FORGET_SECRETS: '1' }, dataDir: dir });
    expect(result.source).toBe('created');
    expect(result.forget.cleared).toHaveLength(5);
    expect(startSecrets(o.db, { env: {}, dataDir: dir }).source).toBe('file');
    o.close();
  });

  it('never masks a malformed EMBERLINE_SECRETS_KEY: start still stops and nothing is cleared', () => {
    const dir = tempDir();
    const o = restored(dir, randomBytes(32), randomBytes(32));
    const before = rows(o);
    expect(() =>
      startSecrets(o.db, {
        env: { EMBERLINE_SECRETS_KEY: 'not-a-key', EMBERLINE_FORGET_SECRETS: '1' },
        dataDir: dir,
      }),
    ).toThrow(SecretsKeyError);
    expect(rows(o)).toBe(before);
    o.close();
  });
});
