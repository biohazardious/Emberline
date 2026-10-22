import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgeAccounts, projects, runs, settings } from '../db/schema.js';
import { authHeaders, createTestApp, seedForgeAccount, setupAndLogin, type TestApp } from '../test-utils.js';
import {
  accountForRemote,
  forgetLegacyToken,
  LEGACY_FORGE_SETTINGS_KEY,
  legacyTokenUnmatched,
  migrateLegacyForgeToken,
} from './account-store.js';
import { ForgeAccountsService } from './accounts.js';
import type { Db } from '../db/index.js';
import { ForgeService } from './service.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});
const legacy = (value: Record<string, unknown>) =>
  t.db
    .insert(settings)
    .values({ key: LEGACY_FORGE_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
const project = (id: string, repoUrl: string | null) =>
  t.db
    .insert(projects)
    .values({ id, name: id, slug: id, repoUrl, path: `${t.dir}/${id}`, createdAt: new Date() })
    .run();
const accounts = () =>
  t.db
    .select()
    .from(forgeAccounts)
    .all()
    .map((a) => [a.provider, a.serverUrl, a.apiUrl, a.token]);
const storedToken = () =>
  (
    t.db
      .select()
      .from(settings)
      .all()
      .find((r) => r.key === LEGACY_FORGE_SETTINGS_KEY)?.value as { token?: unknown }
  )?.token;

describe('migrateLegacyForgeToken', () => {
  it.each([
    [
      'an API URL names the server',
      { provider: 'auto', apiUrl: 'https://gitea.example.com/api/v1', token: 'T' },
      [],
      ['gitea', 'https://gitea.example.com', 'https://gitea.example.com/api/v1', 'T'],
    ],
    [
      'auto keeps the provider the host name gave before the upgrade, not the API path',
      { provider: 'auto', apiUrl: 'https://git.corp.example/api/v1', token: 'T' },
      [],
      ['github', 'https://git.corp.example', 'https://git.corp.example/api/v1', 'T'],
    ],
    [
      'an explicit provider wins over the host name',
      { provider: 'gitea', apiUrl: 'https://git.corp.example/api/v1', token: 'T' },
      [],
      ['gitea', 'https://git.corp.example', 'https://git.corp.example/api/v1', 'T'],
    ],
    [
      'GitHub Enterprise API URL',
      { provider: 'auto', apiUrl: 'https://ghe.example.com/api/v3', token: 'T' },
      [],
      ['github', 'https://ghe.example.com', 'https://ghe.example.com/api/v3', 'T'],
    ],
    [
      'an ssh project on a custom port is its https host',
      { provider: 'auto', apiUrl: null, token: 'T' },
      ['ssh://git@gitea.example.com:2222/a/b.git'],
      ['gitea', 'https://gitea.example.com', 'https://gitea.example.com/api/v1', 'T'],
    ],
    [
      'a fixed github provider on a single non-github project host',
      { provider: 'github', apiUrl: null, token: 'T' },
      ['https://git.example.com/a/b.git'],
      ['github', 'https://git.example.com', 'https://git.example.com/api/v3', 'T'],
    ],
    [
      'a confirmed http API URL stays http',
      { provider: 'gitea', apiUrl: 'http://forge.lan:3000/api/v1', token: 'T' },
      [],
      ['gitea', 'http://forge.lan:3000', 'http://forge.lan:3000/api/v1', 'T'],
    ],
    [
      'no API URL, no projects: github.com',
      { provider: 'auto', apiUrl: null, token: 'T' },
      [],
      ['github', 'https://github.com', 'https://api.github.com', 'T'],
    ],
    [
      'no API URL, gitlab: gitlab.com',
      { provider: 'gitlab', apiUrl: null, token: 'T' },
      [],
      ['gitlab', 'https://gitlab.com', 'https://gitlab.com/api/v4', 'T'],
    ],
    [
      'no API URL, one project host',
      { provider: 'auto', apiUrl: null, token: 'T' },
      ['git@gitea.example.com:a/b.git', 'https://gitea.example.com/c/d.git'],
      ['gitea', 'https://gitea.example.com', 'https://gitea.example.com/api/v1', 'T'],
    ],
  ])('%s', (_name, value, repoUrls, expected) => {
    repoUrls.forEach((url, i) => project(`p${i}`, url));
    legacy(value);
    expect(migrateLegacyForgeToken(t.db)).toBe('migrated');
    expect(accounts()).toEqual([expected]);
    expect(storedToken()).toBeNull();
  });

  it('unmatched: several project hosts, a gitea without API URL, an http project host', () => {
    for (const [value, urls] of [
      [
        { provider: 'auto', apiUrl: null, token: 'T' },
        ['https://a.example/x/y.git', 'https://b.example/x/y.git'],
      ],
      [{ provider: 'gitea', apiUrl: null, token: 'T' }, []],
      [{ provider: 'auto', apiUrl: null, token: 'T' }, ['http://gitea.lan:3000/x/y.git']],
      // An address no server name can be made from must not stop core, nor be replaced by a guess.
      [{ provider: 'auto', apiUrl: null, token: 'T' }, ['git@[fe80::1]:a/b.git']],
      [{ provider: 'auto', apiUrl: null, token: 'T' }, ['git@a|b:x/y.git']],
      // An API URL with user info is never copied into an account.
      [{ provider: 'auto', apiUrl: 'https://u:p@git.example.com/api/v1', token: 'T' }, []],
    ] as const) {
      t.db.delete(projects).run();
      urls.forEach((url, i) => project(`p${i}`, url));
      legacy(value);
      expect(migrateLegacyForgeToken(t.db)).toBe('unmatched');
      expect(accounts()).toEqual([]);
      expect(legacyTokenUnmatched(t.db)).toBe(true);
    }
    forgetLegacyToken(t.db);
    expect(legacyTokenUnmatched(t.db)).toBe(false);
    expect(migrateLegacyForgeToken(t.db)).toBe('none');
  });

  it('idempotent; a removed account stays removed; an existing account for the host is kept', () => {
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'mine' });
    legacy({ provider: 'auto', apiUrl: null, token: 'old' });
    expect(migrateLegacyForgeToken(t.db)).toBe('migrated');
    expect(accounts()).toEqual([['github', 'https://github.com', 'https://api.github.com', 'mine']]);
    t.db.delete(forgeAccounts).run();
    expect(migrateLegacyForgeToken(t.db)).toBe('none');
    expect(accounts()).toEqual([]);
  });
});

describe('an unmatched token is decided once', () => {
  it('later starts do not re-derive it when the projects change; nothing is sent', async () => {
    project('a', 'https://github.com/x/y.git');
    project('b', 'https://gitlab.com/x/y.git');
    legacy({ provider: 'auto', apiUrl: null, token: 'T-secret' });
    const urls: string[] = [];
    t.forgeFetch.current = async (url) => {
      urls.push(String(url));
      return new Response('{}', { status: 401 });
    };
    expect(migrateLegacyForgeToken(t.db)).toBe('unmatched');
    t.db.delete(projects).where(eq(projects.id, 'a')).run();
    expect(migrateLegacyForgeToken(t.db)).toBe('unmatched');
    await t.forge.accounts.fillMissingUsernames(() => undefined);
    expect(accounts()).toEqual([]);
    expect(urls).toEqual([]);
    expect(legacyTokenUnmatched(t.db)).toBe(true);
    forgetLegacyToken(t.db);
    expect(legacyTokenUnmatched(t.db)).toBe(false);
    expect(migrateLegacyForgeToken(t.db)).toBe('none');
  });
});

describe('start-up', () => {
  it('buildServer runs the migration', async () => {
    const t2 = await createTestApp({}, {}, {}, (db) =>
      db
        .insert(settings)
        .values({ key: LEGACY_FORGE_SETTINGS_KEY, value: { provider: 'auto', apiUrl: null, token: 'T' } })
        .run(),
    );
    try {
      expect(
        t2.db
          .select()
          .from(forgeAccounts)
          .all()
          .map((a) => [a.serverUrl, a.token]),
      ).toEqual([['https://github.com', 'T']]);
    } finally {
      await t2.close();
    }
  });

  it('a failing migration is logged without the token and never stops the start', async () => {
    const boom = {
      select: () => {
        throw new Error('disk gone');
      },
    } as unknown as Db;
    const logs: string[] = [];
    await new ForgeAccountsService(boom, globalThis.fetch).start((m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('disk gone');
  });
});

describe('callers pick the account by host', () => {
  it('each project gets the token of its own host, with that account API', async () => {
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'gh-tok' });
    seedForgeAccount(t.db, {
      provider: 'gitea',
      serverUrl: 'https://gitea.example.com',
      token: 'gt-tok',
      username: 'al',
    });
    project('g1', 'https://gitea.example.com/acme/widget.git');
    project('h1', 'git@github.com:acme/widget.git');
    const forge = new ForgeService(t.db, t.runs);
    expect(await forge.projectRemote('g1')).toMatchObject({
      token: 'gt-tok',
      remote: { provider: 'gitea', apiBaseUrl: 'https://gitea.example.com/api/v1' },
    });
    expect(await forge.projectRemote('h1')).toMatchObject({
      token: 'gh-tok',
      remote: { provider: 'github', apiBaseUrl: 'https://api.github.com' },
    });
  });
  it('no account for the host: the reworded 409', async () => {
    project('x1', 'https://codeberg.org/acme/widget.git');
    await expect(new ForgeService(t.db, t.runs).projectRemote('x1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'forge_account_missing',
      message: 'Add a forge account for codeberg.org in Settings → Forge accounts.',
    });
  });
});

describe('migration details', () => {
  it('an environment account for the host does not block it: the stored account is created and wins', () => {
    legacy({ provider: 'auto', apiUrl: null, token: 'T' });
    expect(migrateLegacyForgeToken(t.db)).toBe('migrated');
    expect(accounts()).toEqual([['github', 'https://github.com', 'https://api.github.com', 'T']]);
    expect(
      accountForRemote(t.db, 'https://github.com/a/b.git', { EMBERLINE_FORGE_TOKEN: 'envtok' })?.token,
    ).toBe('T');
  });

  it('start-up fills the username of a migrated account; a refused token is only logged, never with the token', async () => {
    legacy({ provider: 'auto', apiUrl: null, token: 'T-secret' });
    migrateLegacyForgeToken(t.db);
    const logs: string[] = [];
    t.forgeFetch.current = async () => new Response('{}', { status: 401 });
    await t.forge.accounts.fillMissingUsernames((m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('github.com');
    expect(logs[0]).not.toContain('T-secret');
    t.forgeFetch.current = async () =>
      new Response(JSON.stringify({ login: 'octo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await t.forge.accounts.fillMissingUsernames((m) => logs.push(m));
    expect(t.db.select().from(forgeAccounts).all()[0]?.username).toBe('octo');
  });

  it('the accounts list reports an unmatched token and DELETE /api/forge/legacy-token forgets it', async () => {
    project('a', 'https://a.example/x/y.git');
    project('b', 'https://b.example/x/y.git');
    legacy({ provider: 'auto', apiUrl: null, token: 'T' });
    expect(migrateLegacyForgeToken(t.db)).toBe('unmatched');
    expect(t.forge.accounts.list().legacyTokenUnmatched).toBe(true);
    const cookie = await setupAndLogin(t.app);
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/forge/legacy-token',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(t.forge.accounts.list().legacyTokenUnmatched).toBe(false);
  });
});

describe('account views and sub-path servers', () => {
  it('an API URL with user info is never listed', () => {
    const env = {
      EMBERLINE_FORGE_TOKEN: 'e',
      EMBERLINE_FORGE_API_URL: 'https://u:pw@git.example.com/api/v3',
    };
    const list = new ForgeAccountsService(t.db, globalThis.fetch, env).list();
    expect(JSON.stringify(list)).not.toMatch(/u:pw|pw@/);
    expect(list.accounts[0]?.apiUrl).toBe('https://git.example.com/api/v3');
  });

  it('a server under a sub-path does not double the path', async () => {
    project('s1', 'https://host.example/gitea/acme/widget.git');
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: 'https://host.example/gitea', token: 'tok' });
    const target = await new ForgeService(t.db, t.runs).projectRemote('s1');
    expect(target.remote).toMatchObject({
      repoPath: 'acme/widget',
      apiBaseUrl: 'https://host.example/gitea/api/v1',
    });
  });
});

describe('pull requests and status use the account of the remote', () => {
  it('posts to the account API with its token; tokenConfigured follows the account', async () => {
    project('p1', 'https://gitea.example.com/acme/widget.git');
    const now = new Date();
    t.db
      .insert(runs)
      .values({
        id: 'r1',
        projectId: 'p1',
        agent: 'claude',
        state: 'done',
        worktreePath: `${t.dir}/none`,
        branch: 'emberline/x',
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
        title: 'T',
      })
      .run();
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: 'https://gitea.example.com', token: 'gt-tok' });
    const calls: { url: string; method: string; authorization: string | undefined }[] = [];
    t.forgeFetch.current = async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      return new Response(
        JSON.stringify({
          number: 3,
          html_url: 'https://gitea.example.com/acme/widget/pulls/3',
          state: 'open',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    };
    await t.forge.createPullRequest('r1', { title: 'T', pushFirst: false });
    expect(calls).toEqual([
      {
        url: 'https://gitea.example.com/api/v1/repos/acme/widget/pulls',
        method: 'POST',
        authorization: 'token gt-tok',
      },
    ]);
    expect((await t.forge.getRunForgeStatus('r1')).tokenConfigured).toBe(true);
    t.db.delete(forgeAccounts).run();
    expect((await t.forge.getRunForgeStatus('r1')).tokenConfigured).toBe(false);
  });
});
