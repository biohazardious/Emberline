import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgeAccounts } from '../db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from '../test-utils.js';
import {
  accountForRemote,
  deriveApiUrl,
  environmentAccounts,
  normalizeServerUrl,
  serverFromApiUrl,
} from './account-store.js';
import { ForgeAccountsService } from './accounts.js';

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('server URLs', () => {
  it('normalises to the origin (and sub-path), refusing anything but http(s) without credentials', () => {
    expect(normalizeServerUrl(' https://GitHub.com/ ')).toBe('https://github.com');
    expect(normalizeServerUrl('https://git.example.com:443/')).toBe('https://git.example.com');
    expect(normalizeServerUrl('https://example.com/gitea/')).toBe('https://example.com/gitea');
    expect(normalizeServerUrl('http://gitea.lan:3000')).toBe('http://gitea.lan:3000');
    for (const bad of [
      'git@github.com:a/b.git',
      'ssh://git@host/x',
      'https://u:p@github.com',
      'https://tok@github.com',
      'ftp://x',
      'nope',
      '',
    ]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });
  it('derives the API URL per provider', () => {
    expect(deriveApiUrl('github', 'https://github.com')).toBe('https://api.github.com');
    expect(deriveApiUrl('github', 'https://ghe.corp')).toBe('https://ghe.corp/api/v3');
    expect(deriveApiUrl('gitlab', 'https://gitlab.example.com')).toBe('https://gitlab.example.com/api/v4');
    expect(deriveApiUrl('gitea', 'https://example.com/gitea')).toBe('https://example.com/gitea/api/v1');
  });
  it('reads the server back from an API URL', () => {
    expect(serverFromApiUrl('https://api.github.com', null)).toEqual({
      provider: 'github',
      serverUrl: 'https://github.com',
    });
    expect(serverFromApiUrl('https://git.example.com/api/v1', null)).toEqual({
      provider: 'gitea',
      serverUrl: 'https://git.example.com',
    });
    expect(serverFromApiUrl('https://gl.example.com/api/v4/', null)).toEqual({
      provider: 'gitlab',
      serverUrl: 'https://gl.example.com',
    });
    expect(serverFromApiUrl('https://ghe.corp/api/v3', null)).toEqual({
      provider: 'github',
      serverUrl: 'https://ghe.corp',
    });
    expect(serverFromApiUrl('http://forge.lan:3000/api/v1', 'gitea')).toEqual({
      provider: 'gitea',
      serverUrl: 'http://forge.lan:3000',
    });
    expect(serverFromApiUrl('not a url', null)).toBeNull();
  });
});

describe('forge accounts API', () => {
  let t: TestApp;
  let cookie: string;
  let calls: { url: string; headers: Record<string, string> }[];
  let answer: (url: string) => Response;
  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
    calls = [];
    answer = () => reply({ login: 'octo', username: 'octo' });
    t.forgeFetch.current = async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({ url, headers });
      return answer(url);
    };
  });
  afterEach(async () => {
    await t.close();
  });
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { ...CSRF, cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it('adds a GitHub account after checking the token; the token never comes back', async () => {
    const res = await send('POST', '/api/forge/accounts', {
      provider: 'github',
      serverUrl: 'https://github.com/',
      token: 'ghp_SECRET_1',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      provider: 'github',
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      username: 'octo',
      tokenConfigured: true,
      source: 'settings',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/user',
        headers: expect.objectContaining({ authorization: 'Bearer ghp_SECRET_1' }),
      },
    ]);
    const list = await send('GET', '/api/forge/accounts');
    expect(list.json().accounts).toHaveLength(1);
    expect(res.body + list.body).not.toContain('ghp_SECRET_1');
  });

  it('derives GitLab and Gitea API URLs and uses each provider header', async () => {
    await send('POST', '/api/forge/accounts', {
      provider: 'gitlab',
      serverUrl: 'https://gitlab.example.com',
      token: 'glpat-x',
    });
    await send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'https://git.example.com',
      token: 'gt-x',
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://gitlab.example.com/api/v4/user',
      'https://git.example.com/api/v1/user',
    ]);
    expect(calls[0]!.headers['private-token']).toBe('glpat-x');
    expect(calls[1]!.headers.authorization).toBe('token gt-x');
  });

  it('plain http needs the confirmation', async () => {
    const refused = await send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'http://gitea.lan:3000',
      token: 'gt-x',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'plain_http' });
    expect(calls).toHaveLength(0);
    const ok = await send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'http://gitea.lan:3000',
      token: 'gt-x',
      allowHttp: true,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().apiUrl).toBe('http://gitea.lan:3000/api/v1');
  });

  it('a refused token is not saved and not echoed', async () => {
    answer = () => reply({ message: 'Bad credentials ghp_SECRET_2' }, 401);
    const res = await send('POST', '/api/forge/accounts', {
      provider: 'github',
      serverUrl: 'https://github.com',
      token: 'ghp_SECRET_2',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'token_refused', message: 'The forge refused this token.' });
    expect(t.db.select().from(forgeAccounts).all()).toHaveLength(0);
  });

  it('one account per host; a bad server URL and a too-long token are refused without echoing it', async () => {
    await send('POST', '/api/forge/accounts', {
      provider: 'github',
      serverUrl: 'https://github.com',
      token: 'a',
    });
    const dup = await send('POST', '/api/forge/accounts', {
      provider: 'github',
      serverUrl: 'https://GITHUB.com/',
      token: 'b',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toBe('An account for github.com already exists.');
    const bad = await send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'git@x:y',
      token: 'c',
    });
    expect(bad.json().message).toBe("Enter the server's web address, such as https://gitea.example.com.");
    const long = 'L'.repeat(501);
    const tooLong = await send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'https://x.example',
      token: long,
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).not.toContain(long);
  });

  it('two adds for one host at once: one is saved, the other is a 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.forgeFetch.current = async () => {
      await gate;
      return reply({ login: 'octo' });
    };
    const first = send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'https://git.example.com',
      token: 'a',
    });
    const second = send('POST', '/api/forge/accounts', {
      provider: 'gitea',
      serverUrl: 'https://git.example.com/sub',
      token: 'b',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const codes = (await Promise.all([first, second])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
    expect(t.db.select().from(forgeAccounts).all()).toHaveLength(1);
  });

  it('update: a blank token keeps the stored one without a call; a new token is checked first', async () => {
    const id = (
      await send('POST', '/api/forge/accounts', {
        provider: 'github',
        serverUrl: 'https://github.com',
        token: 'old',
      })
    ).json().id;
    calls = [];
    expect((await send('PATCH', `/api/forge/accounts/${id}`, { token: '' })).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    answer = () => reply({}, 403);
    expect((await send('PATCH', `/api/forge/accounts/${id}`, { token: 'new-bad' })).json().error).toBe(
      'token_refused',
    );
    expect(t.db.select().from(forgeAccounts).get()!.token).toBe('old');
    answer = () => reply({ login: 'octo2' });
    expect((await send('PATCH', `/api/forge/accounts/${id}`, { token: 'new-ok' })).json().username).toBe(
      'octo2',
    );
    expect(t.db.select().from(forgeAccounts).get()!.token).toBe('new-ok');
  });

  it('check refreshes the username; remove deletes; unknown ids are 404', async () => {
    const id = (
      await send('POST', '/api/forge/accounts', {
        provider: 'github',
        serverUrl: 'https://github.com',
        token: 't',
      })
    ).json().id;
    answer = () => reply({ login: 'renamed' });
    expect((await send('POST', `/api/forge/accounts/${id}/check`)).json().username).toBe('renamed');
    expect((await send('DELETE', `/api/forge/accounts/${id}`)).json()).toEqual({ ok: true });
    expect((await send('GET', '/api/forge/accounts')).json().accounts).toEqual([]);
    expect((await send('POST', '/api/forge/accounts/nope/check')).statusCode).toBe(404);
  });
});

describe('environment accounts', () => {
  it('EMBERLINE_FORGE_TOKEN is a read-only account; ALLOWED_HOSTS add hosts for it', async () => {
    const env = {
      EMBERLINE_FORGE_TOKEN: 'env-secret',
      EMBERLINE_FORGE_API_URL: 'https://git.example.com/api/v1',
      EMBERLINE_FORGE_ALLOWED_HOSTS: 'gitlab.example.org, api.github.com',
    };
    expect(environmentAccounts(env).map((a) => [a.id, a.provider, a.serverUrl, a.apiUrl])).toEqual([
      ['env', 'gitea', 'https://git.example.com', 'https://git.example.com/api/v1'],
      ['env:gitlab.example.org', 'gitlab', 'https://gitlab.example.org', 'https://gitlab.example.org/api/v4'],
    ]);
    expect(environmentAccounts({ EMBERLINE_FORGE_TOKEN: 'x' })[0]).toMatchObject({
      provider: 'github',
      serverUrl: 'https://github.com',
    });
    expect(environmentAccounts({})).toEqual([]);
    const t = await createTestApp();
    try {
      const svc = new ForgeAccountsService(t.db, async () => reply({ login: 'x' }), env);
      expect(svc.list().accounts.map((a) => a.source)).toEqual(['environment', 'environment']);
      expect(JSON.stringify(svc.list())).not.toContain('env-secret');
      expect(() => svc.remove('env')).toThrow(
        'This account comes from EMBERLINE_FORGE_TOKEN; change it in the environment.',
      );
      expect(accountForRemote(t.db, 'git@gitlab.example.org:g/app.git', env)?.id).toBe(
        'env:gitlab.example.org',
      );
    } finally {
      await t.close();
    }
  });
});

describe('accountForRemote', () => {
  it('matches by host (port only between http(s) URLs), never another host', async () => {
    const t = await createTestApp();
    try {
      const { seedForgeAccount } = await import('../test-utils.js');
      seedForgeAccount(t.db, {
        provider: 'gitea',
        serverUrl: 'https://git.example.com',
        token: 't',
        username: 'al',
      });
      expect(accountForRemote(t.db, 'https://git.example.com/a/b.git', {})?.serverUrl).toBe(
        'https://git.example.com',
      );
      expect(accountForRemote(t.db, 'ssh://git@git.example.com:2222/a/b.git', {})).not.toBeNull();
      expect(accountForRemote(t.db, 'git@git.example.com:a/b.git', {})).not.toBeNull();
      expect(accountForRemote(t.db, 'https://git.example.com:8443/a/b.git', {})).toBeNull();
      expect(accountForRemote(t.db, 'https://evil.example.org/a/b.git', {})).toBeNull();
      expect(accountForRemote(t.db, 'https://git.example.com.evil.org/a/b.git', {})).toBeNull();
    } finally {
      await t.close();
    }
  });
});
