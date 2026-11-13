import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildDemoResponse } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { runs } from '../db/schema.js';
import { withMainWorkspaceLock } from '../factory/merge.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  authHeaders,
  createTestApp,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';
import { classify } from './branches.js';
import { type GitPageDeps, GitPageService } from './service.js';
import { GitSync, listBackups } from './sync.js';

let t: TestApp;
let cookie: string;
let projectId: string;
let projectPath: string;
let projectSlug: string;
let forge: FakeForge;
let bare: string;
let clones = 0;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    encoding: 'utf8',
  }).trim();
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: authHeaders(cookie), ...(payload ? { payload } : {}) });
const commit = (dir: string, file: string, content = `${file}\n`, subject = `feat: ${file}`) => {
  writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', subject);
  return git(dir, 'rev-parse', 'HEAD');
};
/** A commit on `branch` of the project without checking it out. */
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
/** The maintainer's own machine: a clone of origin. */
const cloneOf = (from: string) => {
  const dir = path.join(t.dir, `elsewhere-${++clones}`);
  execFileSync('git', ['clone', '-q', '-b', 'main', from, dir]);
  return dir;
};
const head = () => git(projectPath, 'rev-parse', 'HEAD');
const worktrees = () => git(projectPath, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean);
const gitUrl = (rest = '') => `/api/projects/${projectId}/git${rest}`;
const pullNow = async () => {
  const res = await send('POST', gitUrl('/pull'));
  expect(res.statusCode).toBe(200);
  return res.json();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(25);
  expect(ok()).toBe(true);
};
const storedSync = () => readRepositorySettings(t.db, projectId).sync;
/** A merge whose conflicts go to the heal ends in the background: its stored outcome, once there. */
const settled = async () => {
  await waitFor(() => storedSync()?.state !== 'idle');
  return storedSync()!;
};
const okBuild = (): BuildDemoResponse => ({
  ok: true,
  targetId: 'pull',
  demoEntryRelPath: null,
  demoUrl: null,
  output: '',
});
/** Both sides append to CHANGELOG.md (an additive conflict) in a project with a build to check. */
const additiveConflict = () => {
  commit(projectPath, 'package.json', '{"scripts":{"build":"true"}}\n', 'chore: build script');
  commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n', 'docs: changelog');
  git(projectPath, 'push', '-q', bare, 'main');
  const elsewhere = cloneOf(bare);
  commit(elsewhere, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n- theirs\n', 'docs: theirs');
  git(elsewhere, 'push', '-q', 'origin', 'main');
  const mine = commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n- mine\n', 'docs: mine');
  return { elsewhere, mine };
};
/** A GitPageService on the server's own repository service (same remote-ops order and lock). */
const service = (extra: Partial<GitPageDeps> = {}) =>
  new GitPageService(t.db, t.repository, {
    runs: t.runs,
    forge: t.forge,
    tickets: t.tickets,
    workspacesDir: t.config.workspacesDir,
    ...extra,
  });
const seedRun = (id: string, state: string) => {
  const now = new Date();
  t.db
    .insert(runs)
    .values({
      id,
      projectId,
      agent: 'claude',
      state,
      worktreePath: path.join(t.dir, `wt-${id}`),
      branch: `emberline/${id}`,
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      title: `Run ${id}`,
    })
    .run();
};
/** Rewrites origin's main from `elsewhere`: a history that shares nothing with the project's. */
const forcePushUnrelated = (elsewhere: string) => {
  git(elsewhere, 'checkout', '-q', '--orphan', 'fresh');
  git(elsewhere, 'rm', '-rqf', '.');
  commit(elsewhere, 'new.txt', 'new\n', 'feat: rewritten root');
  git(elsewhere, 'push', '-q', '-f', 'origin', 'fresh:main');
  return git(elsewhere, 'rev-parse', 'HEAD');
};

beforeEach(async () => {
  t = await createTestApp();
  await startGitGateway(t);
  cookie = await setupAndLogin(t.app);
  const made = (await send('POST', '/api/projects', { name: 'Sync App', initGit: true })).json();
  projectId = made.project.id;
  projectPath = made.project.path;
  projectSlug = made.project.slug;
  commit(projectPath, 'a.txt');
  forge = await startFakeForge({ token: 'sy-token', username: 'alice' });
  seedForgeAccount(t.db, { provider: 'gitea', serverUrl: forge.url, token: 'sy-token', username: 'alice' });
  bare = forge.bare('alice', 'app');
  await t.repository.connect(projectId, { url: `${forge.url}/alice/app.git` });
  git(projectPath, 'push', '-q', bare, 'main');
});
afterEach(async () => {
  await forge.close();
  await t.close();
});

describe('pull from origin', () => {
  it('fast-forwards a push from elsewhere into the working branch and marks those commits as from origin', async () => {
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'x.txt', 'x\n', 'feat: from my laptop');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const sync = await pullNow();
    expect(sync).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(git(elsewhere, 'rev-parse', 'HEAD'));
    expect(readFileSync(path.join(projectPath, 'x.txt'), 'utf8')).toBe('x\n');
    const page = (await send('GET', gitUrl('/commits'))).json();
    expect(page.commits[0]).toMatchObject({ subject: 'feat: from my laptop', fromOrigin: true });
    expect(page.commits[1]).toMatchObject({ subject: 'feat: a.txt', fromOrigin: false });
    // Nothing more to bring in.
    expect((await pullNow()).state).toBe('up_to_date');
  });

  it('merges origin into a working branch that has local commits, and merges main into the working branch', async () => {
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'push', '-q', bare, 'develop');
    expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
    writeRepositorySettings(t.db, projectId, {
      commitIdentity: { name: 'Project Bot', email: 'bot@project.example' },
    });
    commit(projectPath, 'local.txt', 'local\n', 'feat: local on develop');
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'switch', '-q', 'develop');
    commit(elsewhere, 'dev.txt', 'dev\n', 'feat: on develop elsewhere');
    git(elsewhere, 'push', '-q', 'origin', 'develop');
    git(elsewhere, 'switch', '-q', 'main');
    commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
    git(elsewhere, 'push', '-q', 'origin', 'main');

    const sync = await pullNow();
    expect(sync).toMatchObject({ state: 'pulled', branch: 'develop' });
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('develop');
    // Main fast-forwarded to origin's; develop has everything.
    expect(git(projectPath, 'rev-parse', 'main')).toBe(git(elsewhere, 'rev-parse', 'main'));
    for (const file of ['local.txt', 'dev.txt', 'pr.txt'])
      expect(existsSync(path.join(projectPath, file))).toBe(true);
    expect(git(projectPath, 'log', '--merges', '--format=%s|%an|%ae|%cn', 'develop').split('\n')).toEqual([
      'Merge main into develop|Project Bot|bot@project.example|Project Bot',
      'Merge origin/develop into develop|Project Bot|bot@project.example|Project Bot',
    ]);
    expect(git(projectPath, 'log', '--merges', '--format=%B', 'develop')).not.toMatch(
      /Co-Authored-By|Generated with|Signed-off-by|\* /i,
    );
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
    // origin's commits are marked; Emberline's merges and the local commit are not.
    const page = (await send('GET', gitUrl('/commits'))).json();
    const from = Object.fromEntries(
      (page.commits as { subject: string; fromOrigin: boolean }[]).map((c) => [c.subject, c.fromOrigin]),
    );
    expect(from).toMatchObject({
      'feat: on develop elsewhere': true,
      'feat: merged on the forge': true,
      'feat: local on develop': false,
      'Merge main into develop': false,
      'Merge origin/develop into develop': false,
    });
  });

  it('fast-forwards a working branch with nothing of its own to main, with no empty merge commit', async () => {
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'push', '-q', bare, 'develop');
    expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    expect(await pullNow()).toMatchObject({ state: 'pulled', branch: 'develop' });
    expect(git(projectPath, 'rev-parse', 'develop')).toBe(git(elsewhere, 'rev-parse', 'main'));
    expect(git(projectPath, 'rev-parse', 'main')).toBe(git(elsewhere, 'rev-parse', 'main'));
    expect(git(projectPath, 'log', '--merges', '--format=%s', 'develop')).toBe('');
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
  });

  it('stops on a real conflict, leaves the branch as it was, and lists the files', async () => {
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const before = commit(projectPath, 'a.txt', 'mine\n', 'feat: mine');
    expect((await pullNow()).state).toBe('idle'); // the heal tries it in the background
    const sync = await settled();
    expect(sync).toMatchObject({ state: 'conflict', branch: 'main', files: ['a.txt'] });
    expect(sync.message).toContain('a.txt');
    expect(head()).toBe(before);
    expect(has(projectPath, 'MERGE_HEAD')).toBe('');
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(projectPath, 'a.txt'), 'utf8')).toBe('mine\n');
    // The heal's own worktree is gone again.
    expect(worktrees()).toHaveLength(1);

    // Auto-pull leaves it to the person until origin moves: the tick only reads origin.
    const timer = new GitSync(t.db, service(), { log: () => undefined });
    await timer.tick();
    expect(head()).toBe(before);
    expect(readRepositorySettings(t.db, projectId).sync).toEqual(sync);
    // A new tip on origin is tried again (and still conflicts).
    commit(elsewhere, 'later.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const healing = service();
    await new GitSync(t.db, healing, { log: () => undefined }).tick();
    await healing.idle();
    const retried = readRepositorySettings(t.db, projectId).sync;
    expect(retried).toMatchObject({ state: 'conflict', files: ['a.txt'] });
    expect(retried?.at).not.toBe(sync.at);
    expect(head()).toBe(before);

    // Resolve with a ticket: a ticket whose run merges origin in.
    const res = await send('POST', gitUrl('/pull/ticket'));
    expect(res.statusCode).toBe(200);
    const ticket = (await send('GET', `/api/tickets/${res.json().ticketId}`)).json();
    expect(ticket.title).toBe('Merge origin/main into main');
    expect(ticket.body).toContain('- a.txt');
    expect(ticket.body).toContain(
      "Run `git merge origin/main`, resolve every conflict keeping both changes' intent, run the project's checks, commit.",
    );
  });

  it('one ticket per conflict, and auto-pull lifts the stop once the ticket merged origin in', async () => {
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    commit(projectPath, 'a.txt', 'mine\n', 'feat: mine');
    await pullNow();
    expect((await settled()).state).toBe('conflict');
    const first = await send('POST', gitUrl('/pull/ticket'));
    const again = await send('POST', gitUrl('/pull/ticket'));
    expect(again.json().ticketId).toBe(first.json().ticketId);
    expect(t.tickets.list(projectId).filter((x) => x.title === 'Merge origin/main into main')).toHaveLength(
      1,
    );

    // The ticket's run merges origin in (by hand here), as its prompt asks.
    git(projectPath, 'fetch', '-q', bare, 'main');
    try {
      git(projectPath, 'merge', '-q', 'FETCH_HEAD');
    } catch {
      // the conflict the ticket is for
    }
    writeFileSync(path.join(projectPath, 'a.txt'), 'mine and theirs\n');
    git(projectPath, 'commit', '-qam', 'fix: merge origin/main');
    // origin did not move, yet the stop no longer stands: the tick pulls and lifts it.
    await new GitSync(t.db, service(), { log: () => undefined }).tick();
    expect(storedSync()?.state).toBe('up_to_date');
    expect(readRepositorySettings(t.db, projectId).syncStop).toBeNull();
    expect((await send('POST', gitUrl('/pull/ticket'))).statusCode).toBe(409);
  });

  it('a ticket that is done no longer answers for its conflict: asking again makes a new one', async () => {
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    commit(projectPath, 'a.txt', 'mine\n', 'feat: mine');
    await pullNow();
    expect((await settled()).state).toBe('conflict');
    const first = (await send('POST', gitUrl('/pull/ticket'))).json().ticketId as string;
    // The same stop again (a person's Pull) keeps its ticket.
    await pullNow();
    expect((await settled()).state).toBe('conflict');
    expect((await send('POST', gitUrl('/pull/ticket'))).json().ticketId).toBe(first);
    t.tickets.update(first, { status: 'done' });
    const second = (await send('POST', gitUrl('/pull/ticket'))).json().ticketId as string;
    expect(second).not.toBe(first);
  });

  it('heals a purely additive conflict like the merge ladder does', async () => {
    const { elsewhere, mine } = additiveConflict();
    // A heal worktree a crash left behind goes before the next heal.
    const leftover = path.join(t.dir, '.worktrees', projectSlug, 'pull-deadbeef');
    git(projectPath, 'worktree', 'add', '-q', '--detach', leftover, 'HEAD');
    expect(worktrees()).toHaveLength(2);
    const checked: string[] = [];
    const build = async (p: { workspacePath: string }) => {
      checked.push(p.workspacePath);
      return okBuild();
    };
    const svc = service({ buildWorkspaceDemo: build });
    expect((await svc.pull(projectId, { auto: false })).state).toBe('idle');
    await svc.idle();
    expect(storedSync()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(readFileSync(path.join(projectPath, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## [Unreleased]\n- mine\n- theirs\n',
    );
    expect(git(projectPath, 'log', '-1', '--format=%s', 'HEAD')).toBe(
      'Merge origin/main into main (auto-resolved: CHANGELOG.md)',
    );
    expect(git(projectPath, 'log', '-1', '--format=%P', 'HEAD').split(' ')).toEqual([
      mine,
      git(elsewhere, 'rev-parse', 'HEAD'),
    ]);
    // The checks ran on the healed tree in core's own worktree, never in the main workspace.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain(`${path.sep}.worktrees${path.sep}`);
    expect(worktrees()).toHaveLength(1);
    expect(existsSync(leftover)).toBe(false);
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
  });

  it("a heal runs without holding origin's queue, and only one per project", async () => {
    additiveConflict();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const build = async () => {
      calls += 1;
      await gate;
      return okBuild();
    };
    const svc = service({ buildWorkspaceDemo: build });
    // The tick goes on to the next project while the heal's checks run.
    await new GitSync(t.db, svc, { log: () => undefined }).tick();
    await waitFor(() => calls === 1);
    expect(storedSync()?.state).toBe('idle');
    // Refresh (origin's queue) is not held up by the heal.
    const refreshed = await Promise.race([
      t.repository.refresh(projectId).then(() => 'done'),
      sleep(5_000).then(() => 'stuck'),
    ]);
    expect(refreshed).toBe('done');
    // Another Pull does not start a second heal, and Match origin waits for it.
    expect((await svc.pull(projectId, { auto: false })).message).toContain('trying to resolve');
    const match = await svc
      .matchOrigin(projectId, { branch: 'main' })
      .catch((e: { code?: string }) => e.code);
    expect(match).toBe('pull_running');
    release();
    await svc.idle();
    expect(calls).toBe(1);
    expect(storedSync()).toMatchObject({ state: 'pulled', branch: 'main' });
  });

  it('a heal whose working branch moved meanwhile is dropped', async () => {
    const { mine } = additiveConflict();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const svc = service({
      buildWorkspaceDemo: async () => {
        calls += 1;
        await gate;
        return okBuild();
      },
    });
    await svc.pull(projectId, { auto: false });
    await waitFor(() => calls === 1);
    // The factory (or the person) commits on main while the heal is being checked.
    const meanwhile = commit(projectPath, 'meanwhile.txt');
    release();
    await svc.idle();
    expect(storedSync()).toMatchObject({ state: 'error', branch: 'main' });
    expect(storedSync()?.message).toContain('moved');
    expect(head()).toBe(meanwhile);
    expect(git(projectPath, 'rev-parse', 'HEAD~1')).toBe(mine);
    expect(readFileSync(path.join(projectPath, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## [Unreleased]\n- mine\n',
    );
    expect(worktrees()).toHaveLength(1);
  });

  it('a Match origin queued behind the pull that starts a heal sees the heal', async () => {
    const { mine } = additiveConflict();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = service({
      buildWorkspaceDemo: async () => {
        await gate;
        return okBuild();
      },
    });
    // Origin's queue is held, so the pull is queued first and the match right behind it (main has
    // diverged, so the match would otherwise reset main under the heal).
    let unblock!: () => void;
    const held = t.repository.remoteAction(projectId, () => new Promise<void>((r) => (unblock = r)));
    const pulling = svc.pull(projectId, { auto: false });
    await sleep(300);
    const matching = svc.matchOrigin(projectId, { branch: 'main' }).catch((e: { code?: string }) => e.code);
    unblock();
    await held;
    const [pulled, matched] = await Promise.all([pulling, matching]);
    expect(pulled.state).toBe('idle');
    expect(matched).toBe('pull_running');
    expect(await listBackups(projectPath)).toEqual([]);
    expect(head()).toBe(mine);
    release();
    await svc.idle();
    expect(storedSync()).toMatchObject({ state: 'pulled' });
  });

  it('stopping core gives up a heal blocked in its checks, and nothing is applied afterwards', async () => {
    const { mine } = additiveConflict();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const svc = service({
      buildWorkspaceDemo: async () => {
        calls += 1;
        await gate;
        return okBuild();
      },
    });
    const timer = new GitSync(t.db, svc, { log: () => undefined, stopTimeoutMs: 300 });
    await timer.tick();
    await waitFor(() => calls === 1);
    const healing = storedSync();
    const started = Date.now();
    await timer.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The checks finish later (they pass): the heal has given up, so none of it lands.
    release();
    await svc.idle();
    expect(head()).toBe(mine);
    expect(readFileSync(path.join(projectPath, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n## [Unreleased]\n- mine\n',
    );
    expect(storedSync()).toEqual(healing);
    expect(worktrees()).toHaveLength(1);
    // A stopped service starts no heal.
    expect((await svc.pull(projectId, { auto: false })).state).toBe('idle');
    expect(calls).toBe(1);
  });

  it('a heal that core stopped during reads as an interrupted pull, not as one still being checked', async () => {
    additiveConflict();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const svc = service({
      buildWorkspaceDemo: async () => {
        await blocked;
        return okBuild();
      },
    });
    expect((await svc.pull(projectId, { auto: false })).state).toBe('idle');
    // While the heal runs, the page says so.
    const running = (await svc.status(projectId)).sync;
    expect(running).toMatchObject({ state: 'idle', message: expect.stringContaining('trying to resolve') });
    await svc.stop(50);
    release();
    await svc.idle();
    // Stopped mid-heal: nothing recorded its end. Another core (after a restart) reads it.
    expect(storedSync()).toMatchObject({
      state: 'idle',
      message: expect.stringContaining('trying to resolve'),
    });
    const after = (await service().status(projectId)).sync;
    expect(after.state).toBe('error');
    expect(after.message).toContain('the pull did not finish. Pull again.');
  });

  it('a failed read of origin never hides a conflict that waits for the person', async () => {
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    commit(projectPath, 'a.txt', 'mine\n', 'feat: mine');
    await pullNow();
    const stop = await settled();
    expect(stop.state).toBe('conflict');
    // The forge is unreachable now (and origin moved on, so only the read stands in the way).
    commit(elsewhere, 'later.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    forge.redirectTo = 'http://127.0.0.1:1';
    await new GitSync(t.db, service(), { log: () => undefined }).tick();
    expect(storedSync()).toEqual(stop);
    expect(readRepositorySettings(t.db, projectId).lastRemoteCheck?.error).toBeTruthy();
    // A person's Pull answers with the failure and keeps the stop too.
    expect((await pullNow()).state).toBe('error');
    expect(storedSync()).toEqual(stop);
    expect((await send('POST', gitUrl('/pull/ticket'))).statusCode).toBe(200);
  });

  it('never merges into a dirty tree, and a fast-forward that would overwrite an edit is refused by git', async () => {
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const before = head();
    writeFileSync(path.join(projectPath, 'a.txt'), 'my edit\n');
    const refused = await pullNow();
    expect(refused).toMatchObject({ state: 'workspace_dirty', branch: 'main' });
    expect(head()).toBe(before);
    expect(readFileSync(path.join(projectPath, 'a.txt'), 'utf8')).toBe('my edit\n');

    // With a local commit too, the pull is a merge: never tried on a tree with edits, even an
    // edit of a file the merge would not touch (git itself would merge then).
    git(projectPath, 'checkout', '--', 'a.txt');
    commit(projectPath, 'local.txt');
    writeFileSync(path.join(projectPath, 'local.txt'), 'my other edit\n');
    const local = head();
    const again = await pullNow();
    expect(again).toMatchObject({ state: 'workspace_dirty', branch: 'main' });
    expect(head()).toBe(local);
    expect(has(projectPath, 'MERGE_HEAD')).toBe('');
    expect(readFileSync(path.join(projectPath, 'local.txt'), 'utf8')).toBe('my other edit\n');
  });

  it("does not move main when local main has commits origin's main lacks", async () => {
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'push', '-q', bare, 'develop');
    expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
    const promoted = commitOn('main', 'promote.txt');
    const sync = await pullNow();
    expect(sync).toMatchObject({ state: 'main_unpushed', branch: 'main' });
    expect(git(projectPath, 'rev-parse', 'main')).toBe(promoted);
  });

  it('a rewritten origin stops auto-pull; Match origin keeps the old tip under a backup ref', async () => {
    const oldTip = head();
    const rewritten = forcePushUnrelated(cloneOf(bare));
    expect(await pullNow()).toMatchObject({ state: 'rewritten', branch: 'main' });
    expect(head()).toBe(oldTip);

    const stopped = readRepositorySettings(t.db, projectId).sync;
    await new GitSync(t.db, service(), { log: () => undefined }).tick();
    expect(head()).toBe(oldTip);
    expect(readRepositorySettings(t.db, projectId).sync).toEqual(stopped);

    expect((await send('POST', gitUrl('/match-origin'), { branch: '' })).statusCode).toBe(400);
    const matched = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(rewritten);
    expect(readFileSync(path.join(projectPath, 'new.txt'), 'utf8')).toBe('new\n');
    const backups = await listBackups(projectPath);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^main-\d{8}-\d{6}$/);
    expect(git(projectPath, 'rev-parse', `refs/emberline/backup/${backups[0]}`)).toBe(oldTip);
    expect(readRepositorySettings(t.db, projectId).syncStop).toBeNull();
    // Nothing left to match.
    const again = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('nothing_to_match');
  });

  it('Match origin on the working branch is refused while a run is live', async () => {
    const oldTip = head();
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    seedRun('live1', 'working');
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'runs_live', runs: [{ id: 'live1', title: 'Run live1' }] });
    expect(head()).toBe(oldTip);
    expect(await listBackups(projectPath)).toEqual([]);
  });

  it("pages once when an automatic pull stops, with origin's tip in the occurrence; a person's pull pages nothing", async () => {
    const pages: { projectId: string; occurrence: string; title: string }[] = [];
    const notify = (p: string, occurrence: string, m: { title: string }) =>
      pages.push({ projectId: p, occurrence, title: m.title });
    const personal = service({ notify });
    forcePushUnrelated(cloneOf(bare));
    expect((await personal.pull(projectId, { auto: false })).state).toBe('rewritten');
    expect(pages).toEqual([]);
    // Wipe the person's stop so the timer meets origin's rewrite itself.
    writeRepositorySettings(t.db, projectId, { sync: null, syncStop: null });
    const timer = new GitSync(t.db, personal, { log: () => undefined });
    await timer.tick();
    await timer.tick();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.projectId).toBe(projectId);
    expect(pages[0]?.occurrence).toMatch(new RegExp(`^${projectId}:pull:rewritten:[0-9a-f]{40}`));
    expect(pages[0]?.title).toMatch(/^Pull stopped on main: /);
  });

  it('with auto-pull off, a tick reads origin and pulls nothing', async () => {
    const off = await send('PATCH', gitUrl(), { autoPull: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ autoPull: false });
    const before = head();
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'x.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    await new GitSync(t.db, service(), { log: () => undefined }).tick();
    expect(head()).toBe(before);
    const origin = git(projectPath, 'rev-parse', 'refs/remotes/origin/main');
    expect(origin).toBe(git(elsewhere, 'rev-parse', 'HEAD'));
    expect(await classify(projectPath, before, origin)).toBe('behind');
    // The person's Pull still pulls.
    expect((await pullNow()).state).toBe('pulled');
    expect(head()).toBe(origin);
  });

  it('a tick waits for a merge in progress (the main-workspace lock)', async () => {
    const before = head();
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'x.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    let release!: () => void;
    const held = withMainWorkspaceLock(projectPath, () => new Promise<void>((r) => (release = r)));
    const ticking = new GitSync(t.db, service(), { log: () => undefined }).tick();
    await new Promise((r) => setTimeout(r, 400));
    expect(head()).toBe(before);
    release();
    await held;
    await ticking;
    expect(head()).toBe(git(elsewhere, 'rev-parse', 'HEAD'));
  });

  it('a project without origin is no_remote, with no network call', async () => {
    git(projectPath, 'remote', 'remove', 'origin');
    const seen = forge.seen.length;
    expect(await pullNow()).toMatchObject({ state: 'no_remote' });
    expect(forge.seen.length).toBe(seen);
  });
});
