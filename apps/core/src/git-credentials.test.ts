import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CommandExecutor, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { credentialPtyEnvForRemote, gitCredentialForRemote } from './forge/account-store.js';
import {
  basicAuthValue,
  credentialGitEnv,
  type GitHttpCredential,
  redactCredential,
} from './git-credentials.js';
import { execGitFile, UnsafeGitConfigError } from './git-exec.js';
import { pushWorktreeBranch } from './runs/git.js';
import { type FakeForge, startFakeForge } from './test-fake-forge.js';
import { createTestApp, seedForgeAccount, type TestApp } from './test-utils.js';

const TOKEN = 'forge-secret-token';
let t: TestApp;
let a: FakeForge;
let b: FakeForge;
let repo: string;
const cred = (): GitHttpCredential => ({ serverUrl: a.url, username: 'alice', token: TOKEN });
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

beforeEach(async () => {
  t = await createTestApp();
  a = await startFakeForge({ token: TOKEN });
  b = await startFakeForge({ token: 'other-token' });
  a.bare('alice', 'app');
  b.bare('alice', 'app');
  repo = path.join(t.dir, 'work');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  gitIn(repo, 'add', 'a.txt');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init');
});
afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  await a.close();
  await b.close();
  await t.close();
});

describe('credential env', () => {
  it('scopes one Authorization header to the server and turns off redirects and helpers', () => {
    const c: GitHttpCredential = {
      serverUrl: 'https://github.com',
      username: 'x-access-token',
      token: 'ghp_X',
    };
    expect(credentialGitEnv(c)).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:ghp_X').toString('base64')}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: '',
    });
    expect(redactCredential(`x ghp_X y ${basicAuthValue(c)} z`, c)).toBe('x [redacted] y [redacted] z');
  });
});

describe('credentialed git calls', () => {
  it('reach a private repository on the account server', async () => {
    await expect(execGitFile(['-C', repo, 'ls-remote', `${a.url}/alice/app.git`])).rejects.toThrow();
    await expect(
      execGitFile(['-C', repo, 'ls-remote', `${a.url}/alice/app.git`], { credential: cred() }),
    ).resolves.toBeDefined();
    expect(
      a.seen.some((r) => r.authorization === `Basic ${Buffer.from(`alice:${TOKEN}`).toString('base64')}`),
    ).toBe(true);
  });

  it('other host gets nothing', async () => {
    await execGitFile(['-C', repo, 'ls-remote', `${b.url}/alice/app.git`], { credential: cred() }).catch(
      () => undefined,
    );
    expect(b.seen.length).toBeGreaterThan(0);
    expect(b.seen.every((r) => r.authorization === undefined)).toBe(true);
  });

  it('http remote of an https account gets nothing', async () => {
    const https = { ...cred(), serverUrl: a.url.replace(/^http:/, 'https:') };
    await execGitFile(['-C', repo, 'ls-remote', `${a.url}/alice/app.git`], { credential: https }).catch(
      () => undefined,
    );
    expect(a.seen.length).toBeGreaterThan(0);
    expect(a.seen.every((r) => r.authorization === undefined)).toBe(true);
  });

  it('a redirect is not followed', async () => {
    a.redirectTo = b.url;
    const error = await execGitFile(['-C', repo, 'ls-remote', `${a.url}/alice/app.git`], {
      credential: cred(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(b.seen).toEqual([]);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(TOKEN);
  });

  it('insteadOf is refused', async () => {
    gitIn(repo, 'config', `url.${b.url}/.insteadOf`, `${a.url}/`);
    await expect(
      execGitFile(['-C', repo, 'ls-remote', `${a.url}/alice/app.git`], { credential: cred() }),
    ).rejects.toBeInstanceOf(UnsafeGitConfigError);
    expect(b.seen).toEqual([]);
  });

  it('http.* repo config is refused with credentials, and still allowed without', async () => {
    gitIn(repo, 'config', 'http.sslVerify', 'false');
    gitIn(repo, 'config', `http.${a.url}/.proxy`, b.url);
    await expect(
      execGitFile(['-C', repo, 'ls-remote', `${a.url}/alice/app.git`], { credential: cred() }),
    ).rejects.toThrow(/The repository's git config sets http\.sslverify, http\..*\.proxy/);
    expect(b.seen).toEqual([]);
    await expect(execGitFile(['-C', repo, 'rev-parse', 'HEAD'])).resolves.toBeDefined();
  });

  it('a failed credentialed call is re-thrown redacted and without the request', async () => {
    const c = cred();
    const fake: CommandExecutor = async () => ({
      exitCode: 128,
      signal: null,
      stdout: `out ${TOKEN}`,
      stderr: `fatal: header Authorization: Basic ${basicAuthValue(c)} token ${TOKEN}`,
      timedOut: false,
      truncated: false,
    });
    // The config check must pass first: only the git call itself fails.
    setCommandExecutor(async (request) =>
      request.args.includes('--name-only') ? localCommandExecutor(request) : fake(request),
    );
    const error = (await execGitFile(['-C', repo, 'ls-remote', 'origin'], { credential: c }).catch(
      (e: unknown) => e,
    )) as Error & Record<string, unknown>;
    const everything = `${error.message} ${String(error.stderr)} ${String(error.stdout)} ${JSON.stringify(error)}`;
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(basicAuthValue(c));
    expect(error.request).toBeUndefined();
    expect(error.stderr).toContain('[redacted]');
  });
});

describe('gitCredentialForRemote', () => {
  it('only http(s) remotes under the account server, with the provider user', () => {
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'gh' });
    seedForgeAccount(t.db, { provider: 'gitlab', serverUrl: 'https://gitlab.example.com', token: 'gl' });
    seedForgeAccount(t.db, {
      provider: 'gitea',
      serverUrl: 'https://example.com/gitea',
      token: 'gt',
      username: 'al',
    });
    expect(gitCredentialForRemote(t.db, 'https://github.com/a/b.git', {})).toEqual({
      serverUrl: 'https://github.com',
      username: 'x-access-token',
      token: 'gh',
    });
    expect(gitCredentialForRemote(t.db, 'https://gitlab.example.com/g/b.git', {})?.username).toBe('oauth2');
    expect(gitCredentialForRemote(t.db, 'https://example.com/gitea/al/b.git', {})).toMatchObject({
      username: 'al',
      token: 'gt',
    });
    expect(gitCredentialForRemote(t.db, 'https://example.com/other/al/b.git', {})).toBeNull();
    expect(gitCredentialForRemote(t.db, 'http://github.com/a/b.git', {})).toBeNull();
    expect(gitCredentialForRemote(t.db, 'git@github.com:a/b.git', {})).toBeNull();
    expect(gitCredentialForRemote(t.db, 'https://github.com.evil.org/a/b.git', {})).toBeNull();
  });
  it('a Gitea account without a username must be checked first', () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: 'https://gitea.example.com', token: 'gt' });
    expect(() => gitCredentialForRemote(t.db, 'https://gitea.example.com/a/b.git', {})).toThrow(
      'Check the account for gitea.example.com in Settings → Forge accounts first.',
    );
  });
  it('the import clone env carries the credentials only for the account host', () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    const env = credentialPtyEnvForRemote(t.db, `${a.url}/alice/app.git`);
    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_KEY_0: `http.${a.url}/.extraHeader`,
    });
    expect(credentialPtyEnvForRemote(t.db, `${b.url}/alice/app.git`)).toEqual({});
    expect(credentialPtyEnvForRemote(t.db, 'git@github.com:a/b.git')).toEqual({});
  });
});

describe('run branch push', () => {
  it('pushes a run branch with the account credentials and leaves no secret in .git/config', async () => {
    seedForgeAccount(t.db, { provider: 'github', serverUrl: a.url, token: TOKEN });
    gitIn(repo, 'remote', 'add', 'origin', `${a.url}/alice/app.git`);
    gitIn(repo, 'checkout', '-q', '-b', 'emberline/run-1');
    const res = await pushWorktreeBranch(repo, 'emberline/run-1', 'main', (url) =>
      gitCredentialForRemote(t.db, url),
    );
    expect(res.branch).toBe('emberline/run-1');
    expect(gitIn(a.bare('alice', 'app'), 'branch', '--list', 'emberline/run-1').trim()).toContain(
      'emberline/run-1',
    );
    const config = readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toMatch(/extraheader|Authorization/i);
  });

  it('a refused repository config says what to remove, and nothing reaches the forge', async () => {
    seedForgeAccount(t.db, { provider: 'github', serverUrl: a.url, token: TOKEN });
    gitIn(repo, 'remote', 'add', 'origin', `${a.url}/alice/app.git`);
    gitIn(repo, 'checkout', '-q', '-b', 'emberline/run-1');
    gitIn(repo, 'config', 'http.sslVerify', 'false');
    await expect(
      pushWorktreeBranch(repo, 'emberline/run-1', 'main', (url) => gitCredentialForRemote(t.db, url)),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("git push failed: The repository's git config sets http.sslverify."),
    });
    expect(a.seen).toEqual([]);
  });
});
