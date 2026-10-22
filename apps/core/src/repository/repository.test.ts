import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryStatus, Run } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateAccount } from '../forge/account-store.js';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  CSRF,
  createTestApp,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';
import { DIVERGED_MESSAGE } from './git.js';

const TOKEN = 'repo-secret-token';
let t: TestApp;
let cookie: string;
let forge: FakeForge;
let projectId: string;
let projectPath: string;
let accountId: string;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { ...CSRF, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const status = async (): Promise<RepositoryStatus> =>
  (await send('GET', `/api/projects/${projectId}/repository`)).json();
const refresh = async (): Promise<RepositoryStatus> =>
  (await send('POST', `/api/projects/${projectId}/repository/refresh`)).json();
const commit = (dir: string, file: string) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
};

beforeEach(async () => {
  t = await createTestApp();
  await startGitGateway(t); // the local git plays the runner and reaches core's gateway
  cookie = await setupAndLogin(t.app);
  forge = await startFakeForge({ token: TOKEN, username: 'alice' });
  accountId = seedForgeAccount(t.db, {
    provider: 'gitea',
    serverUrl: forge.url,
    token: TOKEN,
    username: 'alice',
  });
  const made = (await send('POST', '/api/projects', { name: 'Repo App', initGit: true })).json();
  projectId = made.project.id;
  projectPath = made.project.path;
});
afterEach(async () => {
  await forge.close();
  await t.close();
});

describe('repository status', () => {
  it('no remote yet, with the account-less defaults', async () => {
    expect(await status()).toMatchObject({
      isGitRepo: true,
      branch: 'main',
      hasCommits: true,
      originUrl: null,
      connected: false,
      mainState: 'no_remote',
      checkedAt: null,
      originHasCredentials: false,
      keepMainPushed: false,
      lastMainPushError: null,
    });
  });
});

describe('connect', () => {
  it('refuses URLs with credentials, options and non-forge URLs', async () => {
    const creds = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `http://alice:${TOKEN}@127.0.0.1:1/alice/app.git`,
    });
    expect(creds.statusCode).toBe(400);
    expect(creds.json().message).toBe(
      'Remove the user name and token from the URL; Emberline uses the forge account.',
    );
    expect(creds.body).not.toContain(TOKEN);
    for (const url of [
      '-oProxyCommand=touch /tmp/x:a/b',
      'file:///tmp/x.git',
      '/tmp/x.git',
      'ext::sh -c x',
      'http://[bad/a/b.git',
    ]) {
      const res = await send('POST', `/api/projects/${projectId}/repository/connect`, { url });
      expect(res.statusCode).toBe(400);
    }
  });

  it('connects an empty repository: origin, repoUrl, not published yet; no secret written', async () => {
    forge.bare('alice', 'app');
    const url = `${forge.url}/alice/app.git`;
    const res = await send('POST', `/api/projects/${projectId}/repository/connect`, { url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      originUrl: url,
      transport: 'http',
      connected: true,
      account: { id: accountId, username: 'alice' },
      mainState: 'unpublished',
    });
    expect(res.json().checkedAt).toEqual(expect.any(String));
    expect(git(projectPath, 'remote', 'get-url', 'origin')).toBe(url);
    expect(
      (await send('GET', '/api/projects')).json().find((p: { id: string }) => p.id === projectId).repoUrl,
    ).toBe(url);
    const config = readFileSync(path.join(projectPath, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toMatch(/extraheader|authorization/i);
    expect(res.body).not.toContain(TOKEN);
  });

  it('another origin needs replace', async () => {
    forge.bare('alice', 'app');
    forge.bare('alice', 'other');
    await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
    });
    const again = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/other.git`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'origin_exists', origin: `${forge.url}/alice/app.git` });
    const replaced = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/other.git`,
      replace: true,
    });
    expect(replaced.json().originUrl).toBe(`${forge.url}/alice/other.git`);
  });

  it('another origin without replace is refused before the remote is contacted', async () => {
    forge.bare('alice', 'app');
    await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
    });
    const before = forge.seen.length;
    const again = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/other.git`,
    });
    expect(again.json().error).toBe('origin_exists');
    expect(forge.seen.length).toBe(before);
  });

  it('an account that is not checked yet keeps its own error code', async () => {
    forge.bare('alice', 'app');
    updateAccount(t.db, accountId, { username: null });
    const res = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('forge_account_unchecked');
  });

  it('a remote on a host without an account is read without credentials', async () => {
    const other = await startFakeForge({ token: 'x' });
    try {
      other.bare('alice', 'app');
      const res = await send('POST', `/api/projects/${projectId}/repository/connect`, {
        url: `${other.url}/alice/app.git`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('remote_unreachable');
      expect(other.seen.every((r) => r.authorization === undefined)).toBe(true);
      expect(res.body).not.toContain(TOKEN);
    } finally {
      await other.close();
    }
  });
});

describe('push main', () => {
  beforeEach(async () => {
    forge.bare('alice', 'app');
    await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
    });
  });

  it('publishes main, then counts what is not pushed', async () => {
    const pushed = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json()).toMatchObject({ mainState: 'up_to_date', ahead: 0, behind: 0 });
    expect(git(forge.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
      git(projectPath, 'rev-parse', 'HEAD'),
    );
    expect(git(projectPath, 'config', 'branch.main.remote')).toBe('origin');
    commit(projectPath, 'b.txt');
    expect(await status()).toMatchObject({ mainState: 'ahead', ahead: 1, behind: 0 });
  });

  it('diverged is refused and the remote is unchanged', async () => {
    await send('POST', `/api/projects/${projectId}/repository/push-main`);
    const elsewhere = path.join(t.dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', forge.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'theirs.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const remoteMain = git(forge.bare('alice', 'app'), 'rev-parse', 'refs/heads/main');
    commit(projectPath, 'ours.txt');
    expect(await refresh()).toMatchObject({ mainState: 'diverged', ahead: 1, behind: 1 });
    const res = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'main_diverged', message: DIVERGED_MESSAGE });
    expect(git(forge.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(remoteMain);
  });

  it('a separate push URL is refused', async () => {
    git(projectPath, 'remote', 'set-url', '--push', 'origin', `${forge.url}/alice/elsewhere.git`);
    const res = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('push_url_differs');
  });

  it('refresh never moves local main', async () => {
    await send('POST', `/api/projects/${projectId}/repository/push-main`);
    const elsewhere = path.join(t.dir, 'elsewhere2');
    execFileSync('git', ['clone', '-q', forge.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'remote-only.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    git(projectPath, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
    const before = git(projectPath, 'rev-parse', 'refs/heads/main');
    expect((await refresh()).mainState).toBe('behind');
    expect(git(projectPath, 'rev-parse', 'refs/heads/main')).toBe(before);
  });

  it('status reads no network; Refresh does', async () => {
    await send('POST', `/api/projects/${projectId}/repository/push-main`);
    const elsewhere = path.join(t.dir, 'elsewhere3');
    execFileSync('git', ['clone', '-q', forge.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'later.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const before = forge.seen.length;
    expect((await status()).mainState).toBe('up_to_date'); // what the last read of origin saw
    expect(forge.seen.length).toBe(before);
    expect((await refresh()).mainState).toBe('behind');
    expect(forge.seen.length).toBeGreaterThan(before);
  });

  it("an origin changed behind Emberline's back is not used", async () => {
    forge.bare('alice', 'other');
    git(projectPath, 'remote', 'set-url', 'origin', `${forge.url}/alice/other.git`);
    expect((await status()).connected).toBe(false);
    const push = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(push.statusCode).toBe(409);
    expect(push.json().error).toBe('origin_differs');
    expect((await send('POST', `/api/projects/${projectId}/repository/refresh`)).json().error).toBe(
      'origin_differs',
    );
    expect(forge.seen.filter((r) => r.path.startsWith('/alice/other.git/'))).toEqual([]);
  });

  it('the account stays in core: nothing credential-related reaches the runner', async () => {
    const execs: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      execs.push(request);
      return localCommandExecutor(request);
    });
    try {
      await send('POST', `/api/projects/${projectId}/repository/push-main`);
      await refresh();
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    const all = JSON.stringify(execs).toLowerCase();
    // GIT_CONFIG_NOSYSTEM/GLOBAL are the hardened env of every call; config passed through the env is not.
    const configEnv = [
      'git_config_count',
      'git_config_key_',
      'git_config_value_',
      'git_config_parameters',
      'git_askpass',
    ];
    for (const marker of [
      TOKEN,
      Buffer.from(`alice:${TOKEN}`).toString('base64'),
      ...configEnv,
      'extraheader',
      'authorization',
    ]) {
      expect(all).not.toContain(marker.toLowerCase());
    }
    expect(
      forge.seen.some((r) => r.path.endsWith('git-receive-pack') && r.authorization?.startsWith('Basic ')),
    ).toBe(true);
  });

  it('detached HEAD and an unknown project', async () => {
    git(projectPath, 'checkout', '-q', '--detach');
    expect((await send('POST', `/api/projects/${projectId}/repository/push-main`)).json().error).toBe(
      'detached_head',
    );
    expect((await send('GET', '/api/projects/nope/repository')).statusCode).toBe(404);
  });

  it("status names the default branch's tip, which is what Push main publishes", async () => {
    commit(projectPath, 'tip.txt');
    expect(await status()).toMatchObject({
      defaultBranch: 'main',
      mainTip: {
        sha: git(projectPath, 'rev-parse', 'HEAD'),
        shortSha: git(projectPath, 'rev-parse', '--short', 'HEAD'),
        subject: 'tip.txt',
      },
    });
  });

  it('another branch checked out in the main workspace is refused; the remote is unchanged', async () => {
    git(projectPath, 'checkout', '-q', '-b', 'side');
    commit(projectPath, 'side.txt');
    const res = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'branch_differs',
      message: 'The main workspace is on side, not main.',
    });
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
  });

  it('tags are never pushed, even with push.followTags in the repository config', async () => {
    git(projectPath, 'config', 'push.followTags', 'true');
    git(projectPath, '-c', 'user.name=t', '-c', 'user.email=t@e', 'tag', '-a', '-m', 'v1', 'v1');
    const res = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(res.statusCode).toBe(200);
    expect(git(forge.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
      git(projectPath, 'rev-parse', 'HEAD'),
    );
    expect(git(forge.bare('alice', 'app'), 'tag', '--list')).toBe('');
  });
});

describe('an origin set by hand with a token in it', () => {
  it('status, origin_exists and origin_differs show the URL without it', async () => {
    const secret = 'ghp_handsetsecret';
    git(
      projectPath,
      'remote',
      'add',
      'origin',
      `https://x-access-token:${secret}@github.example/o/r.git?private_token=${secret}`,
    );
    const s = await status();
    expect(s).toMatchObject({
      originUrl: 'https://github.example/o/r.git',
      originHasCredentials: true,
      connected: false,
    });
    forge.bare('alice', 'app');
    const exists = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
    });
    expect(exists.json()).toMatchObject({ error: 'origin_exists', origin: 'https://github.example/o/r.git' });
    const differs = await send('POST', `/api/projects/${projectId}/repository/push-main`);
    expect(differs.json().error).toBe('origin_differs');
    const refreshed = await send('POST', `/api/projects/${projectId}/repository/refresh`);
    for (const res of [exists, differs, refreshed]) expect(res.body).not.toContain(secret);
    expect(JSON.stringify(s)).not.toContain(secret);
    // Connecting the clean URL (after the confirm) replaces the origin, and its token with it.
    const replaced = await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
      replace: true,
    });
    expect(replaced.json()).toMatchObject({ originHasCredentials: false, connected: true });
    expect(readFileSync(path.join(projectPath, '.git', 'config'), 'utf8')).not.toContain(secret);
  });
});

describe('create', () => {
  it('lists owners, creates under the user, and builds origin from the account server', async () => {
    expect((await send('GET', `/api/forge/accounts/${accountId}/owners`)).json().owners).toEqual([
      { id: 'alice', name: 'alice', kind: 'user' },
      { id: 'acme', name: 'acme', kind: 'organization' },
    ]);
    const res = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'alice',
      name: 'repo-app',
      private: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      originUrl: `${forge.url}/alice/repo-app.git`,
      mainState: 'unpublished',
    });
  });

  it('an account not checked yet is checked first, so its own login creates under the user', async () => {
    updateAccount(t.db, accountId, { username: null });
    const res = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'alice',
      name: 'mine',
    });
    expect(res.statusCode).toBe(200);
    expect(forge.seen.some((r) => r.method === 'POST' && r.path === '/api/v1/user/repos')).toBe(true);
    expect(res.json().originUrl).toBe(`${forge.url}/alice/mine.git`);
  });

  it("a forge's repository path that is not owner/name is not used for origin", async () => {
    t.forgeFetch.current = async (url, init) => {
      const res = await globalThis.fetch(url, init);
      if (init?.method !== 'POST') return res;
      return new Response(JSON.stringify({ full_name: 'alice/odd?x=1#y' }), { status: 201 });
    };
    const res = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'alice',
      name: 'odd',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().originUrl).toBe(`${forge.url}/alice/odd.git`);
  });

  it('a forge that cannot be reached is a forge error without the token', async () => {
    await forge.close();
    const res = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'alice',
      name: 'x',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'forge_error' });
    expect(res.body).not.toContain(TOKEN);
    forge = await startFakeForge({ token: TOKEN }); // afterEach closes it
  });

  it('name taken, missing scope, and an existing origin (checked before the forge is called)', async () => {
    forge.bare('alice', 'taken');
    const taken = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'alice',
      name: 'taken',
    });
    expect(taken.json()).toMatchObject({
      error: 'repo_name_taken',
      message: 'A repository named taken already exists for alice.',
    });
    forge.canCreate = false;
    const scope = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'acme',
      name: 'x',
    });
    expect(scope.json()).toMatchObject({
      error: 'forge_create_refused',
      message:
        'The forge did not let this token create a repository under acme. Scopes: write:repository, write:issue, and write:user to create repositories under your user.',
    });
    forge.canCreate = true;
    forge.bare('alice', 'app');
    await send('POST', `/api/projects/${projectId}/repository/connect`, {
      url: `${forge.url}/alice/app.git`,
    });
    const posts = () => forge.seen.filter((r) => r.method === 'POST' && r.path.endsWith('/repos')).length;
    const before = posts();
    const exists = await send('POST', `/api/projects/${projectId}/repository/create`, {
      accountId,
      owner: 'alice',
      name: 'fresh',
    });
    expect(exists.json().error).toBe('origin_exists');
    expect(posts()).toBe(before);
  });
});

describe('settings', () => {
  it('keepMainPushed is off by default and persists', async () => {
    expect(
      (await send('PATCH', `/api/projects/${projectId}/repository`, { keepMainPushed: true })).json()
        .keepMainPushed,
    ).toBe(true);
    expect((await status()).keepMainPushed).toBe(true);
  });
});

describe('keep main pushed after a ticketless merge', () => {
  it('sync-worktree of a run without a ticket queues a push of main', async () => {
    const fake = path.join(t.dir, 'fake-claude.sh');
    writeFileSync(fake, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    t.config.claudeCommand = fake;
    const ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    try {
      t.ptyd.start();
      await t.ptyd.waitUntilConnected();
      forge.bare('alice', 'app');
      await send('POST', `/api/projects/${projectId}/repository/connect`, {
        url: `${forge.url}/alice/app.git`,
      });
      expect(
        (await send('PATCH', `/api/projects/${projectId}/repository`, { keepMainPushed: true })).json()
          .keepMainPushed,
      ).toBe(true);
      expect((await send('POST', `/api/projects/${projectId}/repository/push-main`)).statusCode).toBe(200);
      const run: Run = (await send('POST', '/api/runs', { projectId, prompt: 'x' })).json();
      commit(run.worktreePath, 'loose.txt');
      const synced = await send('POST', `/api/projects/${projectId}/sync-worktree`, { runId: run.id });
      expect(synced.json()).toMatchObject({ ok: true, alreadyMerged: false });
      await t.mainPush.idle();
      expect(git(forge.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
        git(projectPath, 'rev-parse', 'HEAD'),
      );
    } finally {
      await ptydServer.close();
    }
  });
});
