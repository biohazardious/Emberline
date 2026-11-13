import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { runEvents, runs } from '../db/schema.js';
import type { HttpError } from '../errors.js';
import { holdMergesInto, withMainWorkspaceLock } from '../factory/merge.js';
import type { RepositoryService } from '../repository/service.js';
import { prepareWorkspace } from '../runs/git.js';
import { doneStarting, startingWorktrees } from '../runs/starting.js';
import { prepareRunWorkspace } from '../runs/worktree.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  authHeaders,
  createTestApp,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';
import { deleteBranch } from './branches.js';

let t: TestApp;
let cookie: string;
let projectId: string;
let projectPath: string;
let projectSlug: string;
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
  projectSlug = made.project.slug;
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

describe('a working branch the factory merges into', () => {
  /** A finished run with one commit of its own, in a worktree branched from what is checked out. */
  const finishedRun = (id: string) => {
    const dir = path.join(t.dir, `wt-${id}`);
    git(projectPath, 'worktree', 'add', '-q', '-b', `emberline/${id}`, dir);
    commit(dir, `${id}.txt`);
    seedRun(id, { state: 'done', branch: `emberline/${id}`, worktreePath: dir });
    return dir;
  };
  const pipelineMerge = (id: string) =>
    (
      t.tickets as unknown as {
        mergeRunIntoMain(
          run: unknown,
          main: string,
          key: null,
          stale: () => boolean,
        ): Promise<{ ok: boolean }>;
      }
    ).mergeRunIntoMain(t.runs.get(id), projectPath, null, () => false);
  const failures = (id: string) =>
    t.db
      .select()
      .from(runEvents)
      .all()
      .filter((e) => e.runId === id && e.type === 'merge_failed')
      .map((e) => (e.payload as { summary: string }).summary);

  it('a merge waits while the main workspace is off the working branch, and main is unchanged', async () => {
    git(projectPath, 'branch', 'develop');
    writeRepositorySettings(t.db, projectId, { workingBranch: 'develop' }); // main stays checked out
    finishedRun('m1');
    const mainBefore = git(projectPath, 'rev-parse', 'main');
    const message =
      "the main workspace is on main, but the factory's working branch is develop. Switch back on the Git page (or check out develop) and merge again.";

    // The pipeline's merge: refused as a held merge (merge_failed), never thrown.
    expect(await pipelineMerge('m1')).toMatchObject({ ok: false });
    expect(failures('m1')).toEqual([expect.stringContaining(message)]);
    // A person's merge: the same refusal.
    const person = await send('POST', `/api/projects/${projectId}/sync-worktree`, { runId: 'm1' });
    expect(person.statusCode).toBe(200);
    expect(person.json()).toMatchObject({ ok: false });
    expect(person.json().summary).toContain(message);
    expect(git(projectPath, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(projectPath, 'rev-parse', 'develop')).toBe(mainBefore);

    // Back on the working branch, it merges there, and main still does not move.
    git(projectPath, 'switch', '-q', 'develop');
    expect(await pipelineMerge('m1')).toMatchObject({ ok: true });
    expect(git(projectPath, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(projectPath, 'rev-parse', 'develop')).not.toBe(mainBefore);
  });

  it("while a release holds main, a person's merge is refused at once and the pipeline's waits", async () => {
    finishedRun('m3');
    const mainBefore = git(projectPath, 'rev-parse', 'main');
    // What a release on main itself (the working branch is the default branch) holds while it runs.
    const hold = holdMergesInto(projectPath);
    let landed = false;
    const pipeline = pipelineMerge('m3').then((r) => {
      landed = true;
      return r;
    });

    const person = await send('POST', `/api/projects/${projectId}/sync-worktree`, { runId: 'm3' });
    expect(person.statusCode).toBe(409);
    expect(person.json()).toMatchObject({
      error: 'release_running',
      message: 'A release is running on main; merge once it finishes.',
    });
    expect(git(projectPath, 'rev-parse', 'main')).toBe(mainBefore);
    // The pipeline's merge is still waiting for the release.
    expect(landed).toBe(false);

    hold.end();
    expect(await pipeline).toMatchObject({ ok: true });
    expect(git(projectPath, 'rev-parse', 'main')).not.toBe(mainBefore);
  });

  it('with no working branch stored, a merge goes into what is checked out, as before', async () => {
    git(projectPath, 'switch', '-q', '-c', 'side');
    finishedRun('m2');
    const sideBefore = git(projectPath, 'rev-parse', 'side');
    expect(await pipelineMerge('m2')).toMatchObject({ ok: true });
    expect(git(projectPath, 'rev-parse', 'side')).not.toBe(sideBefore);
  });
});

describe('a run that is starting', () => {
  const project = () => ({ id: projectId, path: projectPath, slug: projectSlug });

  it('a worktree left behind with no run row is not live: the switch goes through', async () => {
    git(projectPath, 'branch', 'develop');
    const dir = path.join(t.config.workspacesDir, '.worktrees', projectSlug, 'orphan01');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/run-orphan01', dir);
    expect((await send('POST', workingUrl(), { branch: 'develop' })).statusCode).toBe(200);
  });

  it('a run between its worktree and its row counts as live, and stops counting once the start ends', async () => {
    git(projectPath, 'branch', 'develop');
    // Prepared as enqueue prepares it, with the row not inserted yet.
    const { workspace } = await prepareRunWorkspace({
      db: t.db,
      workspacesDir: t.config.workspacesDir,
      project: project(),
      runShort: 'abcd1234',
    });
    const refused = await send('POST', workingUrl(), { branch: 'develop' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'runs_live',
      runs: [{ id: 'abcd1234', title: 'A run is starting' }],
    });
    const listed = (await send('GET', branchesUrl())).json() as { name: string; liveRuns: string[] }[];
    expect(listed.find((b) => b.name === workspace.branch)?.liveRuns).toEqual(['abcd1234']);
    doneStarting(projectPath, workspace.path);
    expect((await send('POST', workingUrl(), { branch: 'develop' })).statusCode).toBe(200);
  });

  it('a start that fails after its worktree was added is no longer counted', async () => {
    git(projectPath, 'branch', 'develop');
    t.ptyd.assertCanStart = () => undefined;
    // The row's insert fails (no such ticket): the worktree stays, the start is over.
    await expect(
      t.runs.enqueue({ projectId, prompt: 'x' }, { ticketId: 'no-such-ticket' }),
    ).rejects.toThrow();
    expect(git(projectPath, 'worktree', 'list')).toContain(path.join('.worktrees', projectSlug));
    expect(startingWorktrees(projectPath)).toEqual([]);
    expect((await send('POST', workingUrl(), { branch: 'develop' })).statusCode).toBe(200);
  });

  it("a run's worktree is added under the main-workspace lock", async () => {
    let release!: () => void;
    const held = withMainWorkspaceLock(projectPath, () => new Promise<void>((r) => (release = r)));
    const dir = path.join(t.config.workspacesDir, '.worktrees', projectSlug, 'locked01');
    const preparing = prepareWorkspace(projectPath, dir, 'emberline/run-locked01');
    await new Promise((r) => setTimeout(r, 300));
    expect(has(projectPath, 'refs/heads/emberline/run-locked01')).toBe('');
    release();
    await held;
    expect(await preparing).toMatchObject({ path: dir, branch: 'emberline/run-locked01' });
    expect(has(projectPath, 'refs/heads/emberline/run-locked01')).not.toBe('');
    doneStarting(projectPath, dir);
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

  it("a local refusal after origin's delete says what happened on origin", async () => {
    git(projectPath, 'branch', 'old');
    git(projectPath, 'push', '-q', bare, 'old');
    const wt = path.join(t.dir, 'wt-old');
    // Checked out elsewhere while origin's branch was being deleted.
    const repository: Pick<RepositoryService, 'remoteAction'> = {
      remoteAction: async (id, fn) => {
        const out = await t.repository.remoteAction(id, fn);
        git(projectPath, 'worktree', 'add', '-q', wt, 'old');
        return out;
      },
    };
    const project = { id: projectId, path: projectPath, defaultBranch: 'main' };
    const error = await deleteBranch(t.db, project, 'old', true, repository).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(error?.code).toBe('branch_checked_out');
    expect(error?.message).toBe('old is checked out in a worktree, so it stays. On origin it is deleted.');
    expect(has(bare, 'refs/heads/old')).toBe('');
    expect(has(projectPath, 'refs/heads/old')).not.toBe('');
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
