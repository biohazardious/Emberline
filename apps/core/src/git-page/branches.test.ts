import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { runs } from '../db/schema.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  authHeaders,
  createTestApp,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';

let t: TestApp;
let cookie: string;
let projectId: string;
let projectPath: string;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    encoding: 'utf8',
  }).trim();
const send = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: authHeaders(cookie), ...(payload ? { payload } : {}) });
const commit = (dir: string, file: string, content = `${file}\n`) => {
  writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `feat: ${file}`);
};
/** A commit on `branch` without checking it out. */
const commitOn = (branch: string, file: string) => {
  const parent = git(projectPath, 'rev-parse', `refs/heads/${branch}`);
  const blob = execFileSync('git', ['-C', projectPath, 'hash-object', '-w', '--stdin'], {
    input: `${file}\n`,
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['-C', projectPath, 'mktree'], {
    input: `${git(projectPath, 'ls-tree', parent)}\n100644 blob ${blob}\t${file}\n`,
    encoding: 'utf8',
  }).trim();
  const sha = git(projectPath, 'commit-tree', tree, '-p', parent, '-m', `feat: ${file}`);
  git(projectPath, 'update-ref', `refs/heads/${branch}`, sha, parent);
  return sha;
};
const has = (dir: string, ref: string) => {
  try {
    return git(dir, 'rev-parse', '--verify', '--quiet', ref);
  } catch {
    return '';
  }
};
const seedRun = (
  id: string,
  {
    state,
    branch,
    worktreePath = path.join(t.dir, `wt-${id}`),
  }: { state: string; branch: string; worktreePath?: string },
) => {
  const now = new Date();
  t.db
    .insert(runs)
    .values({
      id,
      projectId,
      agent: 'claude',
      state,
      worktreePath,
      branch,
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      title: `Run ${id}`,
    })
    .run();
};
const clearRuns = () => t.db.delete(runs).run();
const branchesUrl = () => `/api/projects/${projectId}/git/branches`;
const workingUrl = () => `/api/projects/${projectId}/git/working-branch`;
const del = (name: string, remote = false) =>
  send('DELETE', `${branchesUrl()}/${encodeURIComponent(name)}${remote ? '?remote=1' : ''}`);

beforeEach(async () => {
  t = await createTestApp();
  await startGitGateway(t);
  cookie = await setupAndLogin(t.app);
  const made = (await send('POST', '/api/projects', { name: 'Branch App', initGit: true })).json();
  projectId = made.project.id;
  projectPath = made.project.path;
  commit(projectPath, 'a.txt');
});
afterEach(async () => {
  await t.close();
});

describe('git branches', () => {
  it('lists branches with their kind, ahead/behind against main, and hides nothing itself', async () => {
    git(projectPath, 'branch', 'develop');
    commitOn('develop', 'd.txt');
    git(projectPath, 'branch', 'emberline/run-1');
    git(projectPath, 'branch', 'alice/idea');
    commitOn('alice/idea', 'i1.txt');
    commitOn('alice/idea', 'i2.txt');
    commit(projectPath, 'b.txt'); // main moves on: every other branch is one behind
    writeRepositorySettings(t.db, projectId, { workingBranch: 'develop' });
    const res = await send('GET', branchesUrl());
    expect(res.statusCode).toBe(200);
    const list = res.json() as { name: string }[];
    const byName = Object.fromEntries(list.map((b) => [b.name, b]));
    expect(Object.keys(byName).sort()).toEqual(['alice/idea', 'develop', 'emberline/run-1', 'main']);
    expect(byName.main).toMatchObject({ kind: 'main', vsMain: null, mergedIntoMain: true, vsOrigin: null });
    expect(byName.develop).toMatchObject({
      kind: 'working',
      vsMain: { ahead: 1, behind: 1 },
      mergedIntoMain: false,
      mergedIntoWorking: true,
      subject: 'feat: d.txt',
      tip: git(projectPath, 'rev-parse', 'develop'),
    });
    expect(byName['emberline/run-1']).toMatchObject({
      kind: 'run',
      vsMain: { ahead: 0, behind: 1 },
      mergedIntoMain: true,
      liveRuns: [],
    });
    expect(byName['alice/idea']).toMatchObject({ kind: 'person', vsMain: { ahead: 2, behind: 1 } });
  });

  it('names the live runs on their branch, and reads each against origin as last read', async () => {
    git(projectPath, 'branch', 'emberline/run-2');
    seedRun('r2', { state: 'working', branch: 'emberline/run-2' });
    git(projectPath, 'branch', 'pub');
    git(projectPath, 'update-ref', 'refs/remotes/origin/pub', git(projectPath, 'rev-parse', 'pub'));
    commitOn('pub', 'p.txt');
    git(projectPath, 'remote', 'add', 'origin', 'https://example.invalid/app.git');
    const list = (await send('GET', branchesUrl())).json() as {
      name: string;
      liveRuns: string[];
      vsOrigin: unknown;
    }[];
    expect(list.find((b) => b.name === 'emberline/run-2')?.liveRuns).toEqual(['r2']);
    expect(list.find((b) => b.name === 'pub')?.vsOrigin).toEqual({ state: 'ahead', ahead: 1, behind: 0 });
    expect(list.find((b) => b.name === 'main')?.vsOrigin).toMatchObject({ state: 'unknown' });
  });

  it('creates a branch from main or from the working branch, without checking it out', async () => {
    git(projectPath, 'branch', 'develop');
    const developTip = commitOn('develop', 'd.txt');
    writeRepositorySettings(t.db, projectId, { workingBranch: 'develop' });
    expect((await send('POST', branchesUrl(), { name: 'from-main', from: 'main' })).statusCode).toBe(200);
    expect((await send('POST', branchesUrl(), { name: 'feat/x', from: 'working' })).statusCode).toBe(200);
    expect(git(projectPath, 'rev-parse', 'from-main')).toBe(git(projectPath, 'rev-parse', 'main'));
    expect(git(projectPath, 'rev-parse', 'feat/x')).toBe(developTip);
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    const again = await send('POST', branchesUrl(), { name: 'from-main', from: 'main' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('branch_exists');
    for (const name of ['', '-x', 'a..b', 'x~1', 'HEAD', 'emberline/mine', 'a b']) {
      const res = await send('POST', branchesUrl(), { name, from: 'main' });
      expect(res.statusCode, name).toBe(400);
    }
  });

  it('switches the working branch, and refuses while a run is live', async () => {
    git(projectPath, 'branch', 'develop');
    seedRun('rx', { state: 'working', branch: 'emberline/run-x' });
    const refused = await send('POST', workingUrl(), { branch: 'develop' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'runs_live', runs: [{ id: 'rx', title: 'Run rx' }] });
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    clearRuns();
    expect((await send('POST', workingUrl(), { branch: 'develop' })).statusCode).toBe(200);
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('develop');
    expect(readRepositorySettings(t.db, projectId).workingBranch).toBe('develop');
    // Back to the default branch: nothing is stored, so the project reads as before.
    expect((await send('POST', workingUrl(), { branch: 'main' })).statusCode).toBe(200);
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(readRepositorySettings(t.db, projectId).workingBranch).toBeUndefined();
  });

  it('refuses while a finished run waits to merge, and not once its work is in the working branch', async () => {
    git(projectPath, 'branch', 'develop');
    const dir = path.join(t.dir, 'wt-rw');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/rw', dir);
    seedRun('rw', { state: 'done', branch: 'emberline/rw', worktreePath: dir });
    // A done run with no commits of its own has nothing waiting.
    expect((await send('POST', workingUrl(), { branch: 'develop' })).statusCode).toBe(200);
    expect((await send('POST', workingUrl(), { branch: 'main' })).statusCode).toBe(200);
    commit(dir, 'w.txt');
    const refused = await send('POST', workingUrl(), { branch: 'develop' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('runs_live');
    expect(refused.json().message).toContain('waiting to merge');
    expect(refused.json().runs).toEqual([{ id: 'rw', title: 'Run rw' }]);
    // A stopped run never merges.
    t.db.update(runs).set({ cancelledAt: new Date() }).run();
    expect((await send('POST', workingUrl(), { branch: 'develop' })).statusCode).toBe(200);
  });

  it('a dirty tree that blocks the switch is refused with git’s reason, and the edit is kept', async () => {
    git(projectPath, 'branch', 'develop');
    commitOn('develop', 'a.txt'); // develop changes a.txt
    writeFileSync(path.join(projectPath, 'a.txt'), 'my edit\n');
    const res = await send('POST', workingUrl(), { branch: 'develop' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('workspace_dirty');
    expect(res.json().message).toContain('a.txt');
    expect(readFileSync(path.join(projectPath, 'a.txt'), 'utf8')).toBe('my edit\n');
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(readRepositorySettings(t.db, projectId).workingBranch).toBeUndefined();
  });

  it('a branch only on origin becomes a local branch from what origin had, then the working branch', async () => {
    const tip = git(projectPath, 'rev-parse', 'HEAD');
    git(projectPath, 'update-ref', 'refs/remotes/origin/release', tip);
    expect((await send('POST', workingUrl(), { branch: 'release' })).statusCode).toBe(200);
    expect(git(projectPath, 'rev-parse', 'refs/heads/release')).toBe(tip);
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('release');
    expect((await send('POST', workingUrl(), { branch: 'nowhere' })).statusCode).toBe(404);
    expect((await send('POST', workingUrl(), { branch: '' })).statusCode).toBe(400);
    expect((await send('POST', workingUrl(), { branch: '--force' })).statusCode).toBe(400);
  });

  it('refuses to delete the working branch, main, and an unmerged branch', async () => {
    git(projectPath, 'branch', 'develop');
    writeRepositorySettings(t.db, projectId, { workingBranch: 'develop' });
    git(projectPath, 'branch', 'idea');
    commitOn('idea', 'i.txt');
    git(projectPath, 'branch', 'emberline/live');
    seedRun('rl', { state: 'working', branch: 'emberline/live' });
    for (const name of ['develop', 'main', 'idea', 'emberline/live']) {
      const res = await del(name);
      expect(res.statusCode, name).toBe(409);
      expect(has(projectPath, `refs/heads/${name}`), name).not.toBe('');
    }
    expect((await del('nothing')).statusCode).toBe(404);
    expect((await del('-x')).statusCode).toBe(400);
    // Merged into the working branch only still goes.
    git(projectPath, 'branch', 'done/one', 'develop');
    commitOn('done/one', 'o.txt');
    git(projectPath, 'update-ref', 'refs/heads/develop', git(projectPath, 'rev-parse', 'done/one'));
    const gone = await del('done/one');
    expect(gone.statusCode).toBe(200);
    expect(has(projectPath, 'refs/heads/done/one')).toBe('');
    // A branch checked out in a worktree is in use.
    git(projectPath, 'branch', 'busy');
    git(projectPath, 'worktree', 'add', '-q', path.join(t.dir, 'busy'), 'busy');
    expect((await del('busy')).statusCode).toBe(409);
  });
});

describe('git branches on origin', () => {
  let forge: FakeForge;
  let bare: string;
  beforeEach(async () => {
    forge = await startFakeForge({ token: 'br-token', username: 'alice' });
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: forge.url, token: 'br-token', username: 'alice' });
    bare = forge.bare('alice', 'app');
    await t.repository.connect(projectId, { url: `${forge.url}/alice/app.git` });
    git(projectPath, 'push', '-q', bare, 'main');
  });
  afterEach(async () => {
    await forge.close();
  });

  it('deletes a remote branch only with the tick, and only the commit it read', async () => {
    git(projectPath, 'branch', 'old');
    git(projectPath, 'push', '-q', bare, 'old');
    // Without the tick, only the local branch goes.
    expect((await del('old')).statusCode).toBe(200);
    expect(has(projectPath, 'refs/heads/old')).toBe('');
    expect(has(bare, 'refs/heads/old')).not.toBe('');
    // With it, origin's too, and the tracking ref with it.
    git(projectPath, 'branch', 'old');
    git(projectPath, 'update-ref', 'refs/remotes/origin/old', git(projectPath, 'rev-parse', 'old'));
    const both = await del('old', true);
    expect(both.statusCode).toBe(200);
    expect(both.json()).toMatchObject({ remote: 'deleted' });
    expect(has(bare, 'refs/heads/old')).toBe('');
    expect(has(projectPath, 'refs/heads/old')).toBe('');
    expect(has(projectPath, 'refs/remotes/origin/old')).toBe('');

    // Origin's branch has a commit this project never had: nothing is deleted anywhere.
    git(projectPath, 'branch', 'shared');
    const elsewhere = path.join(t.dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', bare, elsewhere]);
    git(elsewhere, 'switch', '-q', '-c', 'shared');
    commit(elsewhere, 'theirs.txt');
    git(elsewhere, 'push', '-q', 'origin', 'shared');
    const theirs = git(elsewhere, 'rev-parse', 'HEAD');
    const refused = await del('shared', true);
    expect(refused.statusCode).toBe(409);
    expect(git(bare, 'rev-parse', 'refs/heads/shared')).toBe(theirs);
    expect(has(projectPath, 'refs/heads/shared')).not.toBe('');
  });

  it('a branch already gone on origin counts as deleted there', async () => {
    git(projectPath, 'branch', 'local-only');
    const res = await del('local-only', true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ remote: 'already_gone' });
    expect(res.json().message).toContain('already gone on origin');
    expect(has(projectPath, 'refs/heads/local-only')).toBe('');
  });
});
