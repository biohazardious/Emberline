import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { projects, runs } from '../db/schema.js';
import { basicAuthValue, type GitHttpCredential } from '../git-credentials.js';
import { pushWorktreeBranch } from '../runs/git.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import { createTestApp, CSRF, seedForgeAccount, setupAndLogin, type TestApp } from '../test-utils.js';
import { accountClonesIdle } from './import-clone.js';
import { fetchBranchRef, pushBranchRef, remoteBranches } from './transport.js';

const TOKEN = 'transport-secret-token';
const MB = 1024 * 1024;
/** The pako that isomorphic-git inflates every object with (its own copy, resolved from its folder). */
const requireHere = createRequire(import.meta.url);
const pako = createRequire(requireHere.resolve('isomorphic-git'))('pako') as {
  inflate: (data: Uint8Array) => Uint8Array;
  Inflate: { prototype: { push: (...args: unknown[]) => boolean } };
};
/** Spies on isomorphic-git's inflates; returns the largest output any of them produced so far. */
function watchInflates(): () => number {
  const whole = vi.spyOn(pako, 'inflate');
  const streamed = vi.spyOn(pako.Inflate.prototype, 'push');
  return () =>
    Math.max(
      0,
      ...whole.mock.results.map((r) => (r.type === 'return' ? (r.value as Uint8Array).length : 0)),
      ...streamed.mock.contexts.map((c) => (c as { strm: { total_out: number } }).strm.total_out),
    );
}
/** A blob of `mb` MB of zero bytes, written by real git (its loose object is a few hundred KB). */
const zeroBlob = (dir: string, mb: number) =>
  execFileSync('sh', ['-c', `head -c ${mb}M /dev/zero | git -C "$0" hash-object -w --stdin`, dir], {
    encoding: 'utf8',
  }).trim();
/** Commits `oid` as big.bin on top of HEAD of the checked-out branch in `dir`. */
const commitBlob = (dir: string, oid: string) => {
  gitIn(dir, 'update-index', '--add', '--cacheinfo', `100644,${oid},big.bin`);
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'big');
};
let t: TestApp;
let a: FakeForge;
let b: FakeForge;
let repo: string;
let outside: string;
const execs: ExecRequest[] = [];
const cred = (): GitHttpCredential => ({ serverUrl: a.url, username: 'alice', token: TOKEN });
const appUrl = () => `${a.url}/alice/app.git`;
const target = () => ({ url: appUrl(), credential: cred(), workspacesDir: t.dir, repoRoot: repo });
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const commit = (dir: string, file: string) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  gitIn(dir, 'add', file);
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
};
/** A second clone pushes a commit straight into the bare repository (no HTTP). */
const remoteMovesOn = (name: string) => {
  const elsewhere = path.join(t.dir, name);
  execFileSync('git', ['clone', '-q', a.bare('alice', 'app'), elsewhere]);
  commit(elsewhere, `${name}.txt`);
  gitIn(elsewhere, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main');
};
/** Every file below `dir` with its content hash. */
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      return `${path.relative(dir, file)} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
    })
    .sort();
/**
 * No runner exec and no ptyd spawn carries anything credential-related (what C1/C2 of the review exploited).
 * GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL are the runner git's own hardening (git-exec.ts); the per-call
 * config variables (COUNT, KEY_n, VALUE_n) are what carried the header before.
 */
function expectNoCredentialInRunner(extra: unknown[] = []) {
  const all = JSON.stringify([execs, extra]).toLowerCase();
  const markers = [TOKEN, basicAuthValue(cred()), 'git_config_count', 'git_config_key_', 'git_config_value_'];
  for (const marker of [...markers, 'git_config_parameters', 'extraheader', 'authorization', 'askpass']) {
    expect(all).not.toContain(marker.toLowerCase());
  }
}

beforeEach(async () => {
  t = await createTestApp();
  a = await startFakeForge({ token: TOKEN });
  b = await startFakeForge({ token: 'other-token' });
  a.bare('alice', 'app');
  b.bare('alice', 'app');
  outside = mkdtempSync(path.join(tmpdir(), 'core-data-')); // stands for /data: outside the workspaces root
  writeFileSync(path.join(outside, 'core.db'), 'sentinel\n');
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
  setCommandExecutor(localCommandExecutor);
  vi.restoreAllMocks();
  await accountClonesIdle();
  await a.close();
  await b.close();
  await t.close();
  rmSync(outside, { recursive: true, force: true });
});

describe('ls-remote in core', () => {
  it('reads a private repository with the account and starts no process', async () => {
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    expect(await remoteBranches({ url: appUrl(), credential: cred() })).toEqual(['main']);
    expect(execs).toEqual([]);
    expect(a.seen.some((r) => r.authorization === `Basic ${basicAuthValue(cred())}`)).toBe(true);
  });

  it('an empty repository has no branches', async () => {
    expect(await remoteBranches({ url: appUrl(), credential: cred() })).toEqual([]);
  });

  it('a refused token is named, never shown', async () => {
    const error = await remoteBranches({
      url: appUrl(),
      credential: { ...cred(), token: 'wrong-token' },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'auth_refused',
      message: `The forge refused the account's token for ${new URL(a.url).host}.`,
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('wrong-token');
  });

  it('another host is refused before any request, and a redirect to it is not followed', async () => {
    await expect(remoteBranches({ url: `${b.url}/alice/app.git`, credential: cred() })).rejects.toMatchObject(
      { code: 'url_refused' },
    );
    a.redirectTo = b.url;
    const error = await remoteBranches({ url: appUrl(), credential: cred() }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'redirect_refused' });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(b.seen).toEqual([]);
  });
});

describe('run branch push', () => {
  const setupRun = () => {
    const wt = path.join(t.dir, '.worktrees', 'work', 'run-1');
    gitIn(repo, 'worktree', 'add', '-q', '-b', 'emberline/run-1', wt);
    commit(wt, 'run.txt');
    return wt;
  };
  const account = () => ({ mainPath: repo, url: appUrl(), credential: cred(), workspacesDir: t.dir });

  it('pushes refs/heads/<branch> from the main repository; nothing credential-related reaches the runner or .git/config', async () => {
    const wt = setupRun();
    const res = await pushWorktreeBranch(wt, 'emberline/run-1', 'main', account());
    expect(res.branch).toBe('emberline/run-1');
    const head = gitIn(wt, 'rev-parse', 'HEAD');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/emberline/run-1')).toBe(head);
    expect(gitIn(repo, 'rev-parse', 'refs/remotes/origin/emberline/run-1')).toBe(head);
    expect(gitIn(repo, 'config', 'branch.emberline/run-1.remote')).toBe('origin');
    const config = readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toMatch(/extraheader|authorization/i);
    expectNoCredentialInRunner();
  });

  it('RunService.push uses projects.repoUrl with its account, never the origin an agent set', async () => {
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
    expect(b.seen).toEqual([]);
    expectNoCredentialInRunner();
  });

  it("the repository's config cannot steer it: pushurl helper, insteadOf, proxy, corsProxy, askPass, helper, submodules", async () => {
    const wt = setupRun();
    const marker = path.join(outside, 'askpass-ran');
    const askpass = path.join(outside, 'askpass.sh');
    writeFileSync(askpass, `#!/bin/sh\nenv > ${marker}\necho x\n`);
    chmodSync(askpass, 0o755);
    gitIn(repo, 'remote', 'add', 'origin', appUrl());
    for (const [key, value] of [
      ['remote.origin.pushurl', `evil::${b.url}/alice/app.git`],
      [`url.${b.url}/.insteadOf`, `${a.url}/`],
      ['http.proxy', b.url],
      [`http.${a.url}/.proxy`, b.url],
      ['http.sslVerify', 'false'],
      ['http.corsProxy', b.url],
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
    // A revoked token: a 401 runs no askPass and no helper either.
    await expect(
      pushWorktreeBranch(wt, 'emberline/run-1', 'main', {
        ...account(),
        credential: { ...cred(), token: 'revoked' },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("The forge refused the account's token"),
    });
    expect(existsSync(marker)).toBe(false);
    expect(b.seen).toEqual([]);
    expectNoCredentialInRunner();
  });

  it("pushes the run's own branch, never another one the worktree was switched to", async () => {
    const wt = setupRun();
    gitIn(wt, 'checkout', '-q', '-b', 'production');
    await expect(pushWorktreeBranch(wt, 'emberline/run-1', 'main', account())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(gitIn(a.bare('alice', 'app'), 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(a.seen).toEqual([]);
  });

  it('a non-fast-forward is rejected before anything is sent, never forced', async () => {
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const remoteMain = remoteMovesOn('elsewhere');
    commit(repo, 'ours.txt');
    expect(await pushBranchRef({ ...target(), branch: 'main' })).toBe('rejected');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(remoteMain);
    expect(a.seen.filter((r) => r.method === 'POST')).toEqual([]);
  });
});

describe('the project .git is read and written without following links', () => {
  /** Moves `rel` (under the project) outside the workspaces root and leaves a link to it. */
  const linkOut = (rel: string) => {
    const from = path.join(repo, rel);
    const to = path.join(outside, `${path.basename(rel)}-moved`);
    renameSync(from, to);
    symlinkSync(to, from);
  };
  it.each([
    ['.git/objects', () => linkOut('.git/objects')],
    [
      '.git/objects/pack',
      () => {
        gitIn(repo, 'repack', '-adq');
        linkOut('.git/objects/pack');
      },
    ],
    ['.git/refs/heads', () => linkOut('.git/refs/heads')],
    [
      '.git/packed-refs',
      () => {
        gitIn(repo, 'pack-refs', '--all');
        linkOut('.git/packed-refs');
      },
    ],
    [
      '.git/config',
      () => {
        writeFileSync(
          path.join(repo, '.git', 'config'),
          `${readFileSync(path.join(repo, '.git', 'config'), 'utf8')}[http]\n\tproxy = ${b.url}\n`,
        );
        linkOut('.git/config');
      },
    ],
    ['.git', () => linkOut('.git')],
    [
      'the project folder',
      () => {
        const moved = path.join(outside, 'work');
        renameSync(repo, moved);
        symlinkSync(moved, repo);
      },
    ],
  ])('%s as a link: refused before any request, nothing outside written', async (_name, arrange) => {
    arrange();
    const before = snapshot(outside);
    await expect(pushBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({
      code: 'unsafe_repo',
    });
    await expect(fetchBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({
      code: 'unsafe_repo',
    });
    expect(a.seen).toEqual([]);
    expect(b.seen).toEqual([]);
    expect(snapshot(outside)).toEqual(before);
  });

  it('a link where a fetch writes (refs/remotes/origin) is refused and nothing lands behind it', async () => {
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    remoteMovesOn('elsewhere');
    mkdirSync(path.join(outside, 'origin'));
    mkdirSync(path.join(repo, '.git', 'refs', 'remotes'), { recursive: true });
    symlinkSync(path.join(outside, 'origin'), path.join(repo, '.git', 'refs', 'remotes', 'origin'));
    await expect(fetchBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({
      code: 'unsafe_repo',
    });
    expect(readdirSync(path.join(outside, 'origin'))).toEqual([]);
    expect(a.seen).toEqual([]);
  });
});

describe('fetch of one branch', () => {
  it("updates only refs/remotes/origin/<branch>, whatever remote.origin.fetch says, in a pack the runner's git reads", async () => {
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const remoteMain = remoteMovesOn('elsewhere');
    gitIn(repo, 'remote', 'add', 'origin', appUrl());
    gitIn(repo, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
    const localMain = gitIn(repo, 'rev-parse', 'refs/heads/main');
    await fetchBranchRef({ ...target(), branch: 'main' });
    expect(gitIn(repo, 'rev-parse', 'refs/heads/main')).toBe(localMain);
    expect(gitIn(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(remoteMain);
    expect(gitIn(repo, 'rev-list', '--count', 'refs/heads/main..refs/remotes/origin/main')).toBe('1');
    expect(execs).toEqual([]);
  });

  it('a branch the remote does not have is not_found', async () => {
    await expect(fetchBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('import clone', () => {
  let cookie: string;
  const spawned: unknown[] = [];
  beforeEach(async () => {
    cookie = await setupAndLogin(t.app);
    spawned.length = 0;
    vi.spyOn(t.ptyd, 'get').mockReturnValue({
      spawn: async (params: unknown) => {
        spawned.push(params);
        return { id: 'clone-terminal' };
      },
      list: async () => ({ sessions: [] }),
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

  it('with an account: core fetches, the runner checks out without credentials, ptyd is never asked', async () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: a.url, token: TOKEN, username: 'alice' });
    gitIn(repo, 'push', '-q', a.bare('alice', 'app'), 'main');
    const res = await create(appUrl(), 'Private App');
    expect(res.statusCode, res.body).toBe(201);
    const { project, terminalId } = res.json();
    expect(terminalId).toBeNull();
    await accountClonesIdle();
    expect(await importStatus(project.id)).toMatchObject({ status: 'ready', terminalId: null });
    expect(gitIn(project.path, 'log', '--oneline')).toContain('a.txt');
    expect(gitIn(project.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main');
    expect(readFileSync(path.join(project.path, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
    expect(spawned).toEqual([]);
    expectNoCredentialInRunner();
  });

  it('a refused token fails the import with a plain sentence and no token', async () => {
    seedForgeAccount(t.db, {
      provider: 'gitea',
      serverUrl: a.url,
      token: 'revoked-token',
      username: 'alice',
    });
    const { project } = (await create(appUrl(), 'Revoked')).json();
    await accountClonesIdle();
    const status = await importStatus(project.id);
    expect(status.status).toBe('failed');
    expect(status.tail).toContain("The forge refused the account's token");
    expect(JSON.stringify(status)).not.toContain('revoked-token');
  });

  it('without an account the clone stays a runner PTY session, with no credential variables', async () => {
    const res = await create(`${b.url}/alice/app.git`, 'Public App');
    expect(res.json().terminalId).toBe('clone-terminal');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).not.toHaveProperty('env');
    expectNoCredentialInRunner(spawned);
  });
});

describe('object sizes bound what core inflates', () => {
  it("an agent's commit with a 200 MB file (a small loose object) is refused before it is inflated", async () => {
    commitBlob(repo, zeroBlob(repo, 200));
    const largest = watchInflates();
    await expect(pushBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({
      code: 'too_large',
      message: 'A file in this push is larger than 64 MB. Push it from a terminal instead.',
    });
    expect(largest()).toBeLessThanOrEqual(64 * MB);
    expect(a.seen.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('the same file inside a pack of the repository is refused too', async () => {
    commitBlob(repo, zeroBlob(repo, 200));
    gitIn(repo, 'repack', '-adq');
    const largest = watchInflates();
    await expect(pushBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({ code: 'too_large' });
    expect(largest()).toBeLessThanOrEqual(64 * MB);
  });

  it('a remote pack with a 200 MB file is refused before it is unpacked, and nothing is stored', async () => {
    const elsewhere = path.join(t.dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', a.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'x.txt');
    commitBlob(elsewhere, zeroBlob(elsewhere, 200));
    gitIn(elsewhere, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const largest = watchInflates();
    await expect(fetchBranchRef({ ...target(), branch: 'main' })).rejects.toMatchObject({
      code: 'too_large',
      message: 'A file in this fetch is larger than 64 MB. Fetch it from a terminal instead.',
    });
    expect(largest()).toBeLessThanOrEqual(64 * MB);
    expect(readdirSync(path.join(repo, '.git', 'objects', 'pack'))).toEqual([]);
    expect(existsSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main'))).toBe(false);
  });

  it('a 60 MB file still goes both ways', async () => {
    commitBlob(repo, zeroBlob(repo, 60));
    expect(await pushBranchRef({ ...target(), branch: 'main' })).toBe('pushed');
    expect(gitIn(a.bare('alice', 'app'), 'rev-parse', 'refs/heads/main')).toBe(
      gitIn(repo, 'rev-parse', 'HEAD'),
    );
    const other = path.join(t.dir, 'other');
    mkdirSync(other);
    gitIn(other, 'init', '-q', '-b', 'main');
    await fetchBranchRef({ ...target(), repoRoot: other, branch: 'main' });
    expect(gitIn(other, 'cat-file', '-s', 'refs/remotes/origin/main:big.bin')).toBe(String(60 * MB));
  });
});
