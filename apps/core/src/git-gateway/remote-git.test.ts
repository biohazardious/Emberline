import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { projects, runs } from '../db/schema.js';
import { basicAuthValue, type GitHttpCredential } from '../git-credentials.js';
import { pushWorktreeBranch } from '../runs/git.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  createTestApp,
  CSRF,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';

const TOKEN = 'remote-git-secret-token';
let t: TestApp;
let a: FakeForge;
let b: FakeForge;
let repo: string;
let outside: string;
let savedPath: string | undefined;
const execs: ExecRequest[] = [];
const cred = (): GitHttpCredential => ({ serverUrl: a.url, username: 'alice', token: TOKEN });
const appUrl = () => `${a.url}/alice/app.git`;
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string) => {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  gitIn(cwd, 'add', file);
  gitIn(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
};
/** Anything an agent in the runner could see: every exec, the planted git's and askPass's dumps, b's requests. */
function expectAgentsSeeNoToken(...extra: unknown[]) {
  const dumps = ['planted-git.log', 'askpass-ran']
    .map((f) => path.join(outside, f))
    .filter(existsSync)
    .map((f) => readFileSync(f, 'utf8'));
  const all = JSON.stringify([execs, dumps, b.seen, extra]).toLowerCase();
  for (const marker of [TOKEN, basicAuthValue(cred())]) expect(all).not.toContain(marker.toLowerCase());
}

beforeEach(async () => {
  t = await createTestApp();
  await startGitGateway(t);
  a = await startFakeForge({ token: TOKEN });
  b = await startFakeForge({ token: 'other-token' });
  a.bare('alice', 'app');
  b.bare('alice', 'app');
  outside = mkdtempSync(path.join(tmpdir(), 'agent-view-'));
  // A `git` an agent planted earlier on PATH: it records its arguments and environment, then runs the real git.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(outside, 'bin'));
  writeFileSync(
    path.join(outside, 'bin', 'git'),
    `#!/bin/sh\n{ echo "$@"; env; } >> ${path.join(outside, 'planted-git.log')}\nexec ${realGit} "$@"\n`,
  );
  chmodSync(path.join(outside, 'bin', 'git'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${path.join(outside, 'bin')}:${savedPath}`;
  repo = path.join(t.dir, 'work');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'a.txt');
  execs.length = 0;
  setCommandExecutor(async (request) => {
    execs.push(request);
    return localCommandExecutor(request);
  });
});
afterEach(async () => {
  process.env.PATH = savedPath;
  setCommandExecutor(localCommandExecutor);
  vi.restoreAllMocks();
  await a.close();
  await b.close();
  await t.close();
  rmSync(outside, { recursive: true, force: true });
});

describe('run push through the gateway', () => {
  const setupRun = () => {
    const wt = path.join(t.dir, '.worktrees', 'work', 'run-1');
    gitIn(repo, 'worktree', 'add', '-q', '-b', 'emberline/run-1', wt);
    commit(wt, 'run.txt');
    return wt;
  };
  const account = () => ({ gateway: t.runs.gitGateway, projectId: 'p1', url: appUrl(), credential: cred() });

  it('RunService.push goes to projects.repoUrl with the account, never to the origin an agent set', async () => {
    const wt = setupRun();
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    t.db
      .insert(projects)
      .values({ id: 'p1', name: 'Work', slug: 'work', repoUrl: appUrl(), path: repo, createdAt: new Date() })
      .run();
    const now = new Date();
    t.db
      .insert(runs)
      .values({
        id: 'r1',
        projectId: 'p1',
        agent: 'claude',
        state: 'done',
        worktreePath: wt,
        branch: 'emberline/run-1',
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
        title: 'T',
      })
      .run();
    gitIn(repo, 'remote', 'add', 'origin', `${b.url}/alice/app.git`);
    await t.runs.push('r1');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/emberline/run-1')).toBe(
      gitIn(wt, 'rev-parse', 'HEAD'),
    );
    expect(gitIn(repo, 'config', 'branch.emberline/run-1.remote')).toBe('origin');
    expect(readFileSync(path.join(repo, '.git', 'config'), 'utf8')).not.toMatch(
      /api\/internal\/git|extraheader|authorization/i,
    );
    expect(b.seen).toEqual([]);
    expectAgentsSeeNoToken();
  });

  it("the repository's config, a planted git and askPass get nothing: pushurl helper, insteadOf, proxy, askPass, helper, submodules", async () => {
    const wt = setupRun();
    const askpass = path.join(outside, 'askpass.sh');
    writeFileSync(askpass, `#!/bin/sh\nenv >> ${path.join(outside, 'askpass-ran')}\necho x\n`);
    chmodSync(askpass, 0o755);
    gitIn(repo, 'remote', 'add', 'origin', appUrl());
    for (const [key, value] of [
      ['remote.origin.pushurl', `evil::${b.url}/alice/app.git`],
      ['http.proxy', b.url],
      ['core.askPass', askpass],
      ['credential.helper', `!${askpass}`],
      ['push.recurseSubmodules', 'on-demand'],
      ['submodule.sub.url', `${b.url}/alice/app.git`],
    ]) {
      gitIn(repo, 'config', key!, value!);
    }
    mkdirSync(path.join(repo, '.git', 'modules', 'sub'), { recursive: true });
    writeFileSync(path.join(repo, '.git', 'modules', 'sub', 'config'), `[http]\n\tproxy = ${b.url}\n`);
    await pushWorktreeBranch(wt, 'emberline/run-1', 'main', account());
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/emberline/run-1')).toBe(
      gitIn(wt, 'rev-parse', 'HEAD'),
    );
    // A revoked token: the gateway answers 403 (never 401), so git asks no askPass or helper.
    const refused = await pushWorktreeBranch(wt, 'emberline/run-1', 'main', {
      ...account(),
      credential: { ...cred(), token: 'revoked' },
    }).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("The forge refused the account's token"),
    });
    expect(existsSync(path.join(outside, 'askpass-ran'))).toBe(false);
    // insteadOf is still refused outright by the runner's hardened git (BLOCKED_CONFIG_KEY).
    gitIn(repo, 'config', `url.${b.url}/.insteadOf`, `${a.url}/`);
    await expect(pushWorktreeBranch(wt, 'emberline/run-1', 'main', account())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(readFileSync(path.join(outside, 'planted-git.log'), 'utf8')).toContain('/api/internal/git/'); // the planted git ran…
    expectAgentsSeeNoToken(refused, String(refused)); // …and saw no token
    expect(t.runs.gitGateway.size).toBe(0);
  });

  it('an account push needs the run branch: a worktree switched to another branch is refused', async () => {
    const wt = setupRun();
    gitIn(wt, 'checkout', '-q', '-b', 'agent-branch');
    await expect(pushWorktreeBranch(wt, 'emberline/run-1', 'main', account())).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(pushWorktreeBranch(wt, null, 'main', account())).rejects.toMatchObject({ statusCode: 409 });
    expect(a.seen.filter((r) => r.method === 'POST')).toEqual([]);
  });
});

describe('import clone', () => {
  let cookie: string;
  const spawned: {
    file: string;
    args: string[];
    cwd: string;
    env?: unknown;
    meta?: Record<string, string>;
  }[] = [];
  let clone: Promise<unknown> | null = null;
  let exitCode: number | null = null;
  beforeEach(async () => {
    cookie = await setupAndLogin(t.app);
    spawned.length = 0;
    exitCode = null;
    // The runner's PTY: runs the command like ptyd would (same user, no extra env).
    vi.spyOn(t.ptyd, 'get').mockReturnValue({
      spawn: async (params: { file: string; args: string[]; cwd: string; meta: Record<string, string> }) => {
        spawned.push(params);
        clone = promisify(execFile)(params.file, params.args, { cwd: params.cwd }).then(
          () => (exitCode = 0),
          () => (exitCode = 1),
        );
        return { id: 'clone-1' };
      },
      list: async () => ({
        sessions: spawned.map((p) => ({
          id: 'clone-1',
          status: exitCode === null ? 'running' : 'exited',
          exitCode,
          meta: p.meta ?? {},
          createdAt: new Date().toISOString(),
        })),
      }),
      snapshot: async () => ({ data: 'Cloning into …\n' }),
    } as never);
  });
  const create = (repoUrl: string, name: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...CSRF, cookie },
      payload: { name, source: 'import_url', repoUrl },
    });
  const importStatus = async (id: string) =>
    (
      await t.app.inject({ method: 'GET', url: `/api/projects/${id}/import-status`, headers: { cookie } })
    ).json();

  it('with an account, a URL Connect would refuse is refused before anything runs', async () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    for (const [i, url] of [`${appUrl()}?x=1`, `${appUrl()}#frag`].entries()) {
      const res = await create(url, `Odd ${i}`);
      expect(res.statusCode, res.body).toBe(400);
    }
    expect(spawned).toEqual([]);
  });

  it('with an account: the PTY clones from a capability URL, then origin is the real URL and the capability is gone', async () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const res = await create(appUrl(), 'Private App');
    expect(res.statusCode, res.body).toBe(201);
    const { project } = res.json();
    expect(spawned[0]!.args).toEqual(
      expect.arrayContaining(['clone', '--no-recurse-submodules', '-c', 'protocol.allow=never']),
    );
    expect(spawned[0]).not.toHaveProperty('env');
    await clone;
    const status = await importStatus(project.id);
    expect(status).toMatchObject({ status: 'ready' });
    expect(gitIn(project.path, 'remote', 'get-url', 'origin')).toBe(appUrl());
    expect(gitIn(project.path, 'log', '--oneline')).toContain('a.txt');
    expect(readFileSync(path.join(project.path, '.git', 'config'), 'utf8')).not.toContain(
      '/api/internal/git/',
    );
    expect(t.runs.gitGateway.size).toBe(0);
    expect(JSON.stringify(status)).not.toMatch(/\/api\/internal\/git\/[A-Za-z0-9_-]{43}/);
    expectAgentsSeeNoToken(spawned);
  });

  it('without an account the clone is the plain PTY clone, with no credential and no capability', async () => {
    const res = await create(`${b.url}/alice/app.git`, 'Public App');
    expect(res.json().terminalId).toBe('clone-1');
    expect(spawned[0]!.args).toEqual([
      'clone',
      '--progress',
      '--',
      `${b.url}/alice/app.git`,
      path.join(t.dir, 'public-app'),
    ]);
    expect(t.runs.gitGateway.size).toBe(0);
    expectAgentsSeeNoToken(spawned);
  });

  it('the capability never reaches .git/config: origin is the real URL as soon as the clone ends', async () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const { project } = (await create(appUrl(), 'Private App')).json();
    await clone;
    expect(exitCode).toBe(0);
    // No import-status poll yet (core may have restarted): .git/config already names the real URL.
    expect(gitIn(project.path, 'remote', 'get-url', 'origin')).toBe(appUrl());
    expect(readFileSync(path.join(project.path, '.git', 'config'), 'utf8')).not.toContain(
      '/api/internal/git/',
    );
  });

  it('an origin left on a capability URL is repaired on the next poll even after a restart, and a failed repair is retried', async () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const { project } = (await create(appUrl(), 'Private App')).json();
    await clone;
    // What an earlier version left behind; core restarted since, so it tracks no clone.
    gitIn(
      project.path,
      'remote',
      'set-url',
      'origin',
      `${t.runs.gitGateway.baseUrl}/api/internal/git/${'x'.repeat(43)}`,
    );
    t.runs.gitGateway.forgetClone(project.id);
    let failed = false;
    setCommandExecutor(async (request) => {
      if (!failed && request.args.includes('set-url')) {
        failed = true;
        throw new Error('runner restarting');
      }
      return localCommandExecutor(request);
    });
    const first = await t.app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/import-status`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(500);
    expect(failed).toBe(true);
    expect(await importStatus(project.id)).toMatchObject({ status: 'ready' });
    expect(gitIn(project.path, 'remote', 'get-url', 'origin')).toBe(appUrl());
  });
});
