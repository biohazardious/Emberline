import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type BuildDemoResponse, TICKET_BODY_MAX } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readRepositorySettings,
  writeProjectSettings,
  writeRepositorySettings,
} from '../db/project-settings.js';
import { runEvents, runs } from '../db/schema.js';
import { withMainWorkspaceLock } from '../factory/merge.js';
import { updateFactorySettings } from '../factory/settings.js';
import { pullTicketUpstream } from '../runs/gates.js';
import { doneStarting, markStarting } from '../runs/starting.js';
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
import { GitSync, listBackups, pullTicketOf, setAsideNote } from './sync.js';

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
const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
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
const seedRun = (
  id: string,
  state: string,
  {
    ticketId = null,
    worktreePath = path.join(t.dir, `wt-${id}`),
    createdAt = new Date(),
    endedAt = null,
  } = {} as { ticketId?: string | null; worktreePath?: string; createdAt?: Date; endedAt?: Date | null },
) => {
  const now = createdAt;
  t.db
    .insert(runs)
    .values({
      id,
      projectId,
      ticketId,
      agent: 'claude',
      state,
      worktreePath,
      branch: `emberline/${id}`,
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      endedAt,
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

  it("sweeps the heal and release worktrees a crash left, with their compose projects, never a running heal's", async () => {
    additiveConflict();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const svc = service({
      buildWorkspaceDemo: async () => {
        await blocked;
        return okBuild();
      },
    });
    await svc.pull(projectId, { auto: false });
    await waitFor(() => worktrees().length === 2);
    const parent = path.join(t.config.workspacesDir, '.worktrees', projectSlug);
    const running = readdirSync(parent).find((n) => n.startsWith('pull-'))!;
    for (const name of ['pull-deadbeef', 'release-0a1b2c3d'])
      git(projectPath, 'worktree', 'add', '-q', '--detach', path.join(parent, name));
    const torn: string[] = [];
    const teardown = vi
      .spyOn(t.runs, 'teardownJobWorktree')
      .mockImplementation(async (_p, _dir, composeProject) => void torn.push(composeProject));
    let kept: Record<string, boolean> = {};
    const engine = vi.spyOn(t.runs, 'downLeftoverJobProjects').mockImplementation(async (inUse) => {
      kept = Object.fromEntries(
        [`emberline-${running}`, 'emberline-pull-deadbeef', 'emberline-release-0a1b2c3d'].map((n) => [
          n,
          inUse(n),
        ]),
      );
      return [];
    });
    await svc.sweepLeftovers();
    expect(torn.sort()).toEqual(['emberline-pull-deadbeef', 'emberline-release-0a1b2c3d']);
    expect(existsSync(path.join(parent, 'pull-deadbeef'))).toBe(false);
    expect(existsSync(path.join(parent, 'release-0a1b2c3d'))).toBe(false);
    expect(existsSync(path.join(parent, running))).toBe(true);
    expect(kept).toEqual({
      [`emberline-${running}`]: true,
      'emberline-pull-deadbeef': false,
      'emberline-release-0a1b2c3d': false,
    });
    teardown.mockRestore();
    engine.mockRestore();
    release();
    await svc.idle();
  });

  it('core stopping during the sweep waits for the leftover being taken down and leaves the rest', async () => {
    const parent = path.join(t.config.workspacesDir, '.worktrees', projectSlug);
    mkdirSync(parent, { recursive: true });
    for (const name of ['pull-deadbeef', 'release-0a1b2c3d'])
      git(projectPath, 'worktree', 'add', '-q', '--detach', path.join(parent, name));
    const torn: string[] = [];
    let tearing!: () => void;
    const inTeardown = new Promise<void>((r) => (tearing = r));
    let goOn!: () => void;
    const slow = new Promise<void>((r) => (goOn = r));
    const teardown = vi
      .spyOn(t.runs, 'teardownJobWorktree')
      .mockImplementation(async (_p, _dir, composeProject) => {
        torn.push(composeProject);
        tearing();
        await slow;
      });
    const engine = vi.spyOn(t.runs, 'downLeftoverJobProjects').mockResolvedValue([]);
    const svc = service();
    let swept = false;
    const sweeping = svc.sweepLeftovers().then(() => {
      swept = true;
    });
    await inTeardown;
    let sweptWhenStopped: boolean | null = null;
    const stopping = svc.stop(60_000).then(() => {
      sweptWhenStopped = swept;
    });
    goOn();
    await stopping;
    await sweeping;
    // stop waited for the leftover under way; the next one and the engine's were left alone.
    expect(sweptWhenStopped).toBe(true);
    expect(torn).toEqual(['emberline-pull-deadbeef']);
    expect(existsSync(path.join(parent, 'pull-deadbeef'))).toBe(false);
    expect(existsSync(path.join(parent, 'release-0a1b2c3d'))).toBe(true);
    expect(engine).not.toHaveBeenCalled();
    teardown.mockRestore();
    engine.mockRestore();
  });

  it("a deleted project's heal and release leftovers are torn down with it", async () => {
    const parent = path.join(t.config.workspacesDir, '.worktrees', projectSlug);
    mkdirSync(parent, { recursive: true });
    git(projectPath, 'worktree', 'add', '-q', '--detach', path.join(parent, 'release-0a1b2c3d'));
    const torn: string[] = [];
    const teardown = vi
      .spyOn(t.runs, 'teardownJobWorktree')
      .mockImplementation(async (_p, _dir, composeProject) => void torn.push(composeProject));
    expect((await send('DELETE', `/api/projects/${projectId}`)).statusCode).toBe(200);
    expect(torn).toEqual(['emberline-release-0a1b2c3d']);
    teardown.mockRestore();
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

  it('Match origin sets the blocking runs aside on request: stopped or cancelled, their tickets back in Backlog', async () => {
    const oldTip = head();
    const rewritten = forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    const busy = t.tickets.create(projectId, { title: 'Live work', status: 'in_progress' });
    seedRun('live1', 'working', { ticketId: busy.id });
    const waits = t.tickets.create(projectId, { title: 'Waits', body: 'Do the thing.', status: 'review' });
    const dir = path.join(t.dir, 'wt-wait1');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/wait1', dir);
    commit(dir, 'w.txt');
    // Finished, its session ended (EMB-38's shape): stop() would change nothing.
    seedRun('wait1', 'done', { ticketId: waits.id, worktreePath: dir, endedAt: new Date() });

    // Without setAside: refused, with the runs and their tickets; nothing changed.
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('runs_live');
    expect(refused.json().message).toContain('set them aside');
    // Backlog pickup is off: the tickets stay in Backlog until someone starts them.
    expect(refused.json().backlogPickup).toBe(false);
    const byId = (list: { id: string }[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(refused.json().runs)).toEqual([
      { id: 'live1', ticketId: busy.id, ticketKey: busy.key, title: 'Run live1', status: 'live' },
      { id: 'wait1', ticketId: waits.id, ticketKey: waits.key, title: 'Run wait1', status: 'waiting' },
    ]);
    expect(head()).toBe(oldTip);
    expect(t.runs.getRun('wait1').cancelled).toBe(false);
    expect(t.tickets.get(waits.id).status).toBe('review');

    const matched = await send('POST', gitUrl('/match-origin'), {
      branch: 'main',
      setAside: ['live1', 'wait1'],
    });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(rewritten);
    const backups = await listBackups(projectPath);
    expect(git(projectPath, 'rev-parse', `refs/emberline/backup/${backups[0]}`)).toBe(oldTip);
    // The live run was stopped, the finished one marked stopped all the same, each with the reason.
    const stops = t.db
      .select()
      .from(runEvents)
      .all()
      .filter((e) => e.type === 'stop_requested' || e.type === 'cancelled')
      .map((e) => [e.runId, e.type, e.source, (e.payload as { reason?: string } | null)?.reason]);
    expect(stops).toEqual(
      expect.arrayContaining([
        ['live1', 'stop_requested', 'user', 'Set aside by Match origin'],
        ['wait1', 'cancelled', 'user', 'Set aside by Match origin'],
      ]),
    );
    expect(t.runs.getRun('live1').cancelled).toBe(true);
    expect(t.runs.getRun('wait1')).toMatchObject({ cancelled: true, state: 'done' });
    for (const ticket of [busy, waits]) {
      const now = t.tickets.get(ticket.id);
      expect(now.status).toBe('backlog');
      expect(now.body).toContain('Set aside by Match origin');
    }
    expect(t.tickets.get(waits.id).body).toMatch(/^Do the thing\.\n\n/);
    // Their branches and worktrees stay as they are.
    expect(has(projectPath, 'refs/heads/emberline/wait1')).not.toBe('');
    expect(existsSync(path.join(dir, 'w.txt'))).toBe(true);
  });

  it('sets aside only the runs the person confirmed: one that blocks since then is refused with the fresh list', async () => {
    const oldTip = head();
    const rewritten = forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    seedRun('seen', 'working');
    // With Backlog pickup on, the refusal says so: the factory may start the tickets again.
    updateFactorySettings(t.db, { autoPickupBacklog: true });
    const first = (await send('POST', gitUrl('/match-origin'), { branch: 'main' })).json();
    expect(first.runs).toHaveLength(1);
    expect(first.backlogPickup).toBe(true);
    // Another run starts working before the person confirms.
    seedRun('later', 'working');
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['seen'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('runs_live');
    expect(
      refused
        .json()
        .runs.map((r: { id: string }) => r.id)
        .sort(),
    ).toEqual(['later', 'seen']);
    expect(t.runs.getRun('seen').cancelled).toBe(false);
    expect(t.runs.getRun('later').cancelled).toBe(false);
    expect(head()).toBe(oldTip);
    // A confirmed run that no longer blocks (it merged meanwhile) is no reason to refuse.
    const matched = await send('POST', gitUrl('/match-origin'), {
      branch: 'main',
      setAside: ['seen', 'later', 'merged-meanwhile'],
    });
    expect(matched.statusCode).toBe(200);
    expect(head()).toBe(rewritten);
    expect(t.runs.getRun('later').cancelled).toBe(true);
  });

  it('a backup that cannot be kept refuses Match origin before any run is set aside', async () => {
    const oldTip = head();
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    const busy = t.tickets.create(projectId, { title: 'Live work', status: 'in_progress' });
    seedRun('kept1', 'working', { ticketId: busy.id });
    // A ref where the backups' folder would go: no backup ref can be made under it.
    git(projectPath, 'update-ref', 'refs/emberline/backup', oldTip);
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['kept1'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('backup_failed');
    expect(t.runs.getRun('kept1').cancelled).toBe(false);
    expect(t.tickets.get(busy.id).status).toBe('in_progress');
    expect(head()).toBe(oldTip);
  });

  it("says Backlog auto-pickup is on as the dispatcher reads it: the global setting, whatever a project's own settings hold", async () => {
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    seedRun('hint1', 'working');
    updateFactorySettings(t.db, { autoPickupReady: true, autoPickupBacklog: true });
    // A project's own settings that say otherwise are not what dispatch reads.
    writeProjectSettings(t.db, projectId, { gates: { autoPickupBacklog: false, autoPickupReady: false } });
    const on = (await send('POST', gitUrl('/match-origin'), { branch: 'main' })).json();
    expect(on.backlogPickup).toBe(true);
    updateFactorySettings(t.db, { autoPickupBacklog: false });
    writeProjectSettings(t.db, projectId, { gates: { autoPickupBacklog: true } });
    const off = (await send('POST', gitUrl('/match-origin'), { branch: 'main' })).json();
    expect(off.backlogPickup).toBe(false);
  });

  it('an unfinished merge in the main workspace refuses Match origin before any run is set aside', async () => {
    const oldTip = head();
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    seedRun('keep1', 'working');
    writeFileSync(
      path.join(git(projectPath, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'),
      `${oldTip}\n`,
    );
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['keep1'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('workspace_dirty');
    expect(t.runs.getRun('keep1').cancelled).toBe(false);
    expect(head()).toBe(oldTip);
  });

  it('an edit the reset would refuse over refuses Match origin before any run is set aside or backup kept', async () => {
    const oldTip = head();
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    const busy = t.tickets.create(projectId, { title: 'Live work', status: 'in_progress' });
    seedRun('gone1', 'working', { ticketId: busy.id });
    // An edit to a file origin's history does not have: reset --keep would refuse to drop it.
    writeFileSync(path.join(projectPath, 'a.txt'), 'edited\n');
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['gone1'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('workspace_dirty');
    expect(refused.json().message).toContain('nothing was set aside');
    expect(refused.json().message).toContain('a.txt');
    expect(t.runs.getRun('gone1').cancelled).toBe(false);
    expect(t.tickets.get(busy.id).status).toBe('in_progress');
    expect(await listBackups(projectPath)).toEqual([]);
    expect(head()).toBe(oldTip);
    expect(readFileSync(path.join(projectPath, 'a.txt'), 'utf8')).toBe('edited\n');
  });

  it("an untracked file where origin's history adds one refuses Match origin before any run is set aside", async () => {
    const oldTip = head();
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    seedRun('untracked1', 'working');
    // origin's history adds new.txt; one here, untracked, would stop the reset.
    writeFileSync(path.join(projectPath, 'new.txt'), 'mine\n');
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['untracked1'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('workspace_dirty');
    expect(refused.json().message).toContain('new.txt');
    expect(t.runs.getRun('untracked1').cancelled).toBe(false);
    expect(await listBackups(projectPath)).toEqual([]);
    expect(head()).toBe(oldTip);
    expect(readFileSync(path.join(projectPath, 'new.txt'), 'utf8')).toBe('mine\n');
  });

  it('a file whose stat changed but not its content (a copied or restored workspace) does not stop Match origin', async () => {
    const rewritten = forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    seedRun('copied1', 'working');
    // Same bytes, new mtime: the index's stat data no longer matches, as after a copy or a restore.
    utimesSync(path.join(projectPath, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    const matched = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['copied1'] });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(rewritten);
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
  });

  it('a run that is still starting cannot be set aside: Match origin refuses and changes nothing', async () => {
    const oldTip = head();
    forcePushUnrelated(cloneOf(bare));
    expect((await pullNow()).state).toBe('rewritten');
    const waits = t.tickets.create(projectId, { title: 'Waits', status: 'review' });
    const dir = path.join(t.dir, 'wt-wait2');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/wait2', dir);
    commit(dir, 'w.txt');
    seedRun('wait2', 'done', { ticketId: waits.id, worktreePath: dir, endedAt: new Date() });
    const starting = path.join(t.dir, 'wt-starting');
    markStarting(projectPath, starting, 'emberline/starting');
    try {
      // Even confirmed by the person, a run still starting has no row to stop yet.
      const refused = await send('POST', gitUrl('/match-origin'), {
        branch: 'main',
        setAside: ['wait2', 'wt-starting'],
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('runs_live');
      expect(refused.json().message).toContain('starting');
    } finally {
      doneStarting(projectPath, starting);
    }
    expect(head()).toBe(oldTip);
    expect(await listBackups(projectPath)).toEqual([]);
    expect(t.runs.getRun('wait2').cancelled).toBe(false);
    expect(t.tickets.get(waits.id).status).toBe('review');
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

describe('reading all of origin', () => {
  const refsCalls = () =>
    forge.seen.filter((r) => r.method === 'GET' && r.path.endsWith('/info/refs')).length;
  const refresh = async () => {
    const res = await send('POST', gitUrl('/fetch'));
    expect(res.statusCode).toBe(200);
  };

  it('reads every branch and tag of origin; a local tag is never moved, and one that differs is said so', async () => {
    const shared = head();
    git(projectPath, 'tag', 'v0.7.0');
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'switch', '-q', '-c', '12112026_backup');
    const backupTip = commit(elsewhere, 'backup.txt');
    git(elsewhere, 'switch', '-q', '-c', 'emberline/run-on-origin', 'main');
    const runTip = commit(elsewhere, 'run.txt');
    git(elsewhere, 'tag', '-a', '-m', 'v0.8.0', 'v0.8.0', shared);
    git(elsewhere, 'tag', 'v0.9.0', runTip);
    // origin's v0.7.0 names another commit than the one here.
    git(elsewhere, 'tag', 'v0.7.0', backupTip);
    // v0.6.0: lightweight here, annotated on origin, on the same commit: the same tag.
    git(projectPath, 'tag', 'v0.6.0', shared);
    git(elsewhere, 'tag', '-a', '-m', 'v0.6.0', 'v0.6.0', shared);

    git(elsewhere, 'push', '-q', 'origin', '12112026_backup', 'emberline/run-on-origin', '--tags');

    await refresh();
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/12112026_backup')).toBe(backupTip);
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/emberline/run-on-origin')).toBe(runTip);
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/main')).toBe(shared);
    // The tags origin has and this project lacks come in as origin has them; v0.7.0 stays.
    expect(git(projectPath, 'rev-parse', 'refs/tags/v0.8.0')).toBe(
      git(elsewhere, 'rev-parse', 'refs/tags/v0.8.0'),
    );
    expect(git(projectPath, 'cat-file', '-t', 'refs/tags/v0.8.0')).toBe('tag');
    expect(git(projectPath, 'rev-parse', 'refs/tags/v0.9.0')).toBe(runTip);
    expect(git(projectPath, 'rev-parse', 'refs/tags/v0.7.0')).toBe(shared);
    const status = (await send('GET', gitUrl())).json();
    expect(status.latestTag).toBe('v0.8.0');
    expect(status.tagsDifferFromOrigin).toEqual(['v0.7.0']);
    // Nothing reached the local branches.
    expect(git(projectPath, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('refs/heads/main');

    // A read with nothing new on origin is one ls-remote: no fetch.
    const before = refsCalls();
    await refresh();
    expect(refsCalls() - before).toBe(1);

    // v0.5.0: here a tag of an annotated tag (a nested tag), on origin a lightweight one, both on the
    // same commit in the end: the same tag too.
    git(projectPath, 'tag', '-a', '-m', 'inner', 'inner', backupTip);
    git(projectPath, '-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'v0.5.0', 'v0.5.0', 'inner');
    git(projectPath, 'tag', '-d', 'inner');
    git(elsewhere, 'tag', 'v0.5.0', backupTip);
    git(elsewhere, 'push', '-q', 'origin', 'v0.5.0');
    await refresh();
    expect((await send('GET', gitUrl())).json().tagsDifferFromOrigin).toEqual(['v0.7.0']);

    // A branch gone from origin loses its tracking ref; a tag gone from origin stays here.
    git(elsewhere, 'push', '-q', 'origin', '--delete', '12112026_backup', 'v0.9.0');
    await refresh();
    expect(has(projectPath, 'refs/remotes/origin/12112026_backup')).toBe('');
    expect(git(projectPath, 'rev-parse', 'refs/tags/v0.9.0')).toBe(runTip);
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/emberline/run-on-origin')).toBe(runTip);
  });

  it("origin's tags named like a branch, or HEAD, are never created here, and the branch names stay plain", async () => {
    git(projectPath, 'branch', 'mine');
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'switch', '-q', '-c', 'feature');
    commit(elsewhere, 'feature.txt');
    git(elsewhere, 'push', '-q', 'origin', 'feature');
    const tip = git(bare, 'rev-parse', 'refs/heads/main');
    for (const tag of ['main', 'feature', 'mine', 'HEAD', 'v1.0.0'])
      git(bare, 'update-ref', `refs/tags/${tag}`, tip);
    await refresh();
    expect(git(projectPath, 'for-each-ref', '--format=%(refname)', 'refs/tags/')).toBe('refs/tags/v1.0.0');
    const status = (await send('GET', gitUrl())).json();
    expect(status.tagsNamedLikeBranches).toEqual(['feature', 'main', 'mine']);
    expect(status.checkedOut).toBe('main');
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('a branch origin replaced by one named like its folder (develop/x, then develop) never blocks a read', async () => {
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'switch', '-q', '-c', 'develop/x');
    const tip = commit(elsewhere, 'x.txt');
    git(elsewhere, 'push', '-q', 'origin', 'develop/x');
    await refresh();
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/develop/x')).toBe(tip);
    // On origin, develop/x goes and develop comes; here develop is the working branch (a needed read).
    git(bare, 'update-ref', '-d', 'refs/heads/develop/x');
    git(bare, 'update-ref', 'refs/heads/develop', tip);
    git(projectPath, 'branch', 'develop');
    writeRepositorySettings(t.db, projectId, { workingBranch: 'develop' });
    await refresh();
    expect(readRepositorySettings(t.db, projectId).lastRemoteCheck?.error).toBeNull();
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/develop')).toBe(tip);
    expect(has(projectPath, 'refs/remotes/origin/develop/x')).toBe('');
  });

  it("origin's branches whose fetch keeps failing are left alone for a while, and the page says so", async () => {
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'switch', '-q', '-c', 'broken');
    const broken = commit(elsewhere, 'broken.txt');
    git(elsewhere, 'push', '-q', 'origin', 'broken');
    const { localCommandExecutor, setCommandExecutor } = await import('../command-exec.js');
    let fetches = 0;
    let failing = true;
    setCommandExecutor(async (request) => {
      if (!request.args.includes('fetch') || !request.args.includes('refs/heads/broken'))
        return localCommandExecutor(request);
      fetches++;
      // A ref the forge refuses to send, every time.
      const args = request.args.map((a) => (failing && a === 'refs/heads/broken' ? 'refs/heads/no-such' : a));
      return localCommandExecutor({ ...request, args });
    });
    try {
      await refresh();
      expect(fetches).toBe(1);
      expect(readRepositorySettings(t.db, projectId).lastRemoteCheck?.error).toBeNull();
      expect((await send('GET', gitUrl())).json().originRefsUnread).toBe(true);
      // The next reads leave it alone: no fetch while origin's listing stays the same.
      await refresh();
      await refresh();
      expect(fetches).toBe(1);
      // origin moved on: tried again.
      commit(elsewhere, 'broken-2.txt');
      git(elsewhere, 'push', '-q', 'origin', 'broken');
      await refresh();
      expect(fetches).toBe(2);
      // After the wait, tried again too, and once it comes in the page no longer says so.
      failing = false;
      const unread = readRepositorySettings(t.db, projectId).originRefsUnread!;
      writeRepositorySettings(t.db, projectId, {
        originRefsUnread: { ...unread, at: new Date(Date.now() - 31 * 60_000).toISOString() },
      });
      await refresh();
      expect(fetches).toBe(3);
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/broken')).toBe(
      git(elsewhere, 'rev-parse', 'HEAD'),
    );
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/broken')).not.toBe(broken);
    expect((await send('GET', gitUrl())).json().originRefsUnread).toBe(false);
  });

  it('a branch origin drops between the listing and the fetch fails no read; the others come in the next one', async () => {
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'switch', '-q', '-c', 'gone-soon');
    commit(elsewhere, 'gone.txt');
    git(elsewhere, 'switch', '-q', '-c', 'stays', 'main');
    const stays = commit(elsewhere, 'stays.txt');
    git(elsewhere, 'push', '-q', 'origin', 'gone-soon', 'stays');
    // Right after origin was listed, gone-soon is deleted there.
    const { localCommandExecutor, setCommandExecutor } = await import('../command-exec.js');
    let dropped = false;
    setCommandExecutor(async (request) => {
      const out = await localCommandExecutor(request);
      if (!dropped && request.args.includes('ls-remote')) {
        dropped = true;
        git(bare, 'update-ref', '-d', 'refs/heads/gone-soon');
      }
      return out;
    });
    try {
      await refresh();
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    // main came in alone; what the failed fetch would have brought waits for the next read.
    expect(readRepositorySettings(t.db, projectId).lastRemoteCheck?.error).toBeNull();
    expect(has(projectPath, 'refs/remotes/origin/gone-soon')).toBe('');
    await refresh();
    expect(git(projectPath, 'rev-parse', 'refs/remotes/origin/stays')).toBe(stays);
    expect(has(projectPath, 'refs/remotes/origin/gone-soon')).toBe('');
  });
});

describe('pullTicketOf', () => {
  it("is the stop's ticket only when the stop merged origin's same branch", () => {
    const stop = (source: string) => ({ syncStop: { source, ticketId: 't1' } });
    expect(pullTicketOf(stop('origin/main'), 'main')).toBe('t1');
    expect(pullTicketOf(stop('origin/develop'), 'develop')).toBe('t1');
    // Match origin on main while the stop is develop's: its ticket is not main's to close.
    expect(pullTicketOf(stop('origin/develop'), 'main')).toBeNull();
    // A stop merging main into the working branch still needs its ticket after develop matches origin.
    expect(pullTicketOf(stop('main'), 'develop')).toBeNull();
    expect(pullTicketOf({ syncStop: { source: 'origin/main' } }, 'main')).toBeNull();
    expect(pullTicketOf({ syncStop: null }, 'main')).toBeNull();
  });
});

describe('the status after a read of origin that failed', () => {
  it('says the read failed, keeping when it was tried', async () => {
    const at = new Date().toISOString();
    const check = { url: 'x', originKey: 'k', branch: 'main', at, published: true };
    writeRepositorySettings(t.db, projectId, {
      lastRemoteCheck: { ...check, error: 'could not read origin' },
    });
    expect((await send('GET', gitUrl())).json()).toMatchObject({ checkedAt: at, checkFailed: true });
    writeRepositorySettings(t.db, projectId, { lastRemoteCheck: { ...check, error: null } });
    expect((await send('GET', gitUrl())).json()).toMatchObject({ checkedAt: at, checkFailed: false });
  });
});

describe("the guards' upstream for the pull's own ticket", () => {
  it("is the tip core recorded when the pull stopped, only for that stop's ticket", () => {
    const tip = 'a'.repeat(40);
    writeRepositorySettings(t.db, projectId, {
      syncStop: { working: tip, main: tip, source: 'origin/main', sourceTip: tip, ticketId: 't1' },
    });
    expect(pullTicketUpstream(t.db, projectId, 't1')).toBe(tip);
    expect(pullTicketUpstream(t.db, projectId, 't2')).toBeUndefined();
    expect(pullTicketUpstream(t.db, projectId, undefined)).toBeUndefined();
    expect(pullTicketUpstream(t.db, null, 't1')).toBeUndefined();
    // Never anything that is not a full commit id.
    writeRepositorySettings(t.db, projectId, {
      syncStop: { working: tip, main: tip, source: 'origin/main', sourceTip: 'main', ticketId: 't1' },
    });
    expect(pullTicketUpstream(t.db, projectId, 't1')).toBeUndefined();
    writeRepositorySettings(t.db, projectId, { syncStop: null });
    expect(pullTicketUpstream(t.db, projectId, 't1')).toBeUndefined();
  });
});

describe('a pull that cannot merge, and Match origin', () => {
  /** On `dir` (checked out), the same change as `file`'s commit here: the same patch under a new hash. */
  const samePatch = (dir: string, file: string) =>
    commit(dir, file, `${file}\n`, `feat: ${file} (rewritten)`);

  /**
   * The TrueNAS case: origin keeps the old base; its history after it is a rewrite of the commits
   * here, plus more. One commit of the project's own is not in the rewrite and conflicts with it.
   */
  const rewriteKeepingBase = () => {
    const elsewhere = cloneOf(bare);
    for (let i = 1; i <= 9; i++) commit(projectPath, `f${i}.txt`);
    git(projectPath, 'switch', '-q', '-c', 'side');
    commit(projectPath, 's.txt');
    git(projectPath, 'switch', '-q', 'main');
    git(projectPath, 'merge', '-q', '--no-ff', '-m', 'Merge side into main', 'side');
    git(projectPath, 'branch', '-D', 'side');
    commit(projectPath, 'own.txt', 'mine\n', 'feat: own');
    const oldTip = head();
    for (let i = 1; i <= 9; i++) samePatch(elsewhere, `f${i}.txt`);
    samePatch(elsewhere, 's.txt');
    commit(elsewhere, 'own.txt', 'theirs\n', 'feat: own, rewritten differently');
    const originTip = commit(elsewhere, 'after.txt', 'after\n', 'feat: after the rewrite');
    git(elsewhere, 'push', '-q', '-f', 'origin', 'main');
    return { oldTip, originTip };
  };

  it("origin rewritten with the old history kept (the TrueNAS case): classified rewritten, nothing merged, and Match origin takes origin's", async () => {
    const { oldTip, originTip } = rewriteKeepingBase();

    const sync = await pullNow();
    expect(sync).toMatchObject({ state: 'rewritten', branch: 'main', files: [] });
    expect(sync.message).toContain(
      "10 of your 11 commits are already on origin with new hashes, so origin was probably rewritten. Match origin takes origin's history and keeps yours as a backup. 1 commit is not on origin; Match origin keeps it only in the backup.",
    );
    // No merge was tried.
    expect(head()).toBe(oldTip);
    expect(has(projectPath, 'MERGE_HEAD')).toBe('');
    expect(worktrees()).toHaveLength(1);
    expect((await send('GET', gitUrl())).json()).toMatchObject({
      main: 'rewritten',
      working: 'rewritten',
      notOnOrigin: { main: 1, working: 1 },
    });

    const matched = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(originTip);
    const backups = await listBackups(projectPath);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^main-\d{8}-\d{6}$/);
    expect(git(projectPath, 'rev-parse', `refs/emberline/backup/${backups[0]}`)).toBe(oldTip);
  });

  it('the TrueNAS case with runs: only the one that can still merge blocks, and setting it aside lets Match origin through', async () => {
    const { oldTip, originTip } = rewriteKeepingBase();
    expect((await pullNow()).state).toBe('rewritten');
    /** A finished run of `ticketId` whose session ended, in its own worktree off main's old history. */
    const finished = (id: string, ticketId: string, at: number, work: (dir: string) => void) => {
      const dir = path.join(t.dir, `wt-${id}`);
      git(projectPath, 'worktree', 'add', '-q', '-b', `emberline/${id}`, dir, 'main');
      work(dir);
      seedRun(id, 'done', {
        ticketId,
        worktreePath: dir,
        createdAt: new Date(Date.UTC(2026, 10, 13) + at),
        endedAt: new Date(),
      });
    };
    // EMB-9: done, completed by its second run; its first run's superseded attempt never merged.
    const split = t.tickets.create(projectId, { title: 'Split runs/service.ts', status: 'review' });
    finished('emb9-1', split.id, 0, (dir) => commit(dir, 'attempt.txt'));
    finished('emb9-2', split.id, 1000, () => undefined);
    t.tickets.update(split.id, { status: 'done' });
    // EMB-38: the pull's resolution ticket; its finished run merged the rewritten origin into the old
    // history, and waits in Review to merge that back.
    const resolve = t.tickets.create(projectId, { title: 'Merge origin/main into main', status: 'review' });
    finished('emb38', resolve.id, 2000, (dir) => {
      git(dir, 'fetch', '-q', bare, 'main');
      git(dir, 'merge', '-q', '--no-edit', '-X', 'ours', 'FETCH_HEAD');
    });

    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'runs_live',
      runs: [
        { id: 'emb38', ticketId: resolve.id, ticketKey: resolve.key, title: 'Run emb38', status: 'waiting' },
      ],
    });
    expect(refused.json().runs).toHaveLength(1);
    expect(head()).toBe(oldTip);

    const matched = await send('POST', gitUrl('/match-origin'), { branch: 'main', setAside: ['emb38'] });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(originTip);
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
    const backups = await listBackups(projectPath);
    expect(backups).toHaveLength(1);
    expect(git(projectPath, 'rev-parse', `refs/emberline/backup/${backups[0]}`)).toBe(oldTip);
    // The resolution's run is set aside and no longer listed; EMB-9's runs were never touched.
    expect(t.runs.getRun('emb38')).toMatchObject({ cancelled: true, state: 'done' });
    expect(t.runs.getRun('emb9-1').cancelled).toBe(false);
    const listed = (await send('GET', gitUrl('/branches'))).json() as { name: string; liveRuns: string[] }[];
    expect(listed.find((b) => b.name === 'emberline/emb38')?.liveRuns).toEqual([]);
    const ticket = t.tickets.get(resolve.id);
    expect(ticket.status).toBe('backlog');
    expect(ticket.body).toMatch(
      /^Set aside by Match origin on \d{4}-\d{2}-\d{2}: main took origin's history, and this ticket's earlier work was based on the old history, so it was not merged\. Do not reuse its branch emberline\/emb38; start from the current main\.$/,
    );
    expect(t.tickets.get(split.id).status).toBe('done');
    // Nothing left to match.
    const again = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('nothing_to_match');
  });

  it("the pull's own ticket (Resolve with a ticket) is closed by Match origin, not sent back to Backlog", async () => {
    const { originTip } = rewriteKeepingBase();
    expect((await pullNow()).state).toBe('rewritten');
    // As on TrueNAS: the stop kept the ticket Resolve with a ticket made for it.
    const resolve = t.tickets.create(projectId, {
      title: 'Merge origin/main into main',
      body: 'Resolve it.',
      status: 'review',
    });
    const stop = readRepositorySettings(t.db, projectId).syncStop!;
    writeRepositorySettings(t.db, projectId, { syncStop: { ...stop, ticketId: resolve.id } });
    const dir = path.join(t.dir, 'wt-pull1');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/pull1', dir, 'main');
    commit(dir, 'merged.txt');
    seedRun('pull1', 'done', { ticketId: resolve.id, worktreePath: dir, endedAt: new Date() });
    // Another ticket's waiting run: set aside as usual.
    const other = t.tickets.create(projectId, { title: 'Other work', status: 'review' });
    const dir2 = path.join(t.dir, 'wt-other1');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/other1', dir2, 'main');
    commit(dir2, 'other.txt');
    seedRun('other1', 'done', { ticketId: other.id, worktreePath: dir2, endedAt: new Date() });

    // The refusal names the pull's ticket, so the dialog can say it is closed, not sent back.
    const refused = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().pullTicketId).toBe(resolve.id);
    const matched = await send('POST', gitUrl('/match-origin'), {
      branch: 'main',
      setAside: ['pull1', 'other1'],
    });
    expect(matched.statusCode).toBe(200);
    expect(head()).toBe(originTip);
    const closed = t.tickets.get(resolve.id);
    expect(closed.status).toBe('done');
    expect(closed.body).toMatch(
      /^Resolve it\.\n\nClosed by Match origin on \d{4}-\d{2}-\d{2}: main took origin's history, so there is nothing left to merge\.$/,
    );
    expect(t.runs.getRun('pull1').cancelled).toBe(true);
    expect(t.tickets.get(other.id).status).toBe('backlog');
    expect(t.tickets.get(other.id).body).toContain('Set aside by Match origin');
    expect(readRepositorySettings(t.db, projectId).syncStop).toBeNull();
  });

  it('commits mostly on origin under new hashes, but not nearly all, are a conflict that says so', async () => {
    const elsewhere = cloneOf(bare);
    commit(projectPath, 'f1.txt');
    commit(projectPath, 'f2.txt');
    commit(projectPath, 'a.txt', 'mine\n', 'feat: mine');
    samePatch(elsewhere, 'f1.txt');
    samePatch(elsewhere, 'f2.txt');
    commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    await pullNow();
    const sync = await settled();
    expect(sync).toMatchObject({ state: 'conflict', branch: 'main', files: ['a.txt'] });
    expect(sync.message).toContain(
      "2 of your 3 commits are already on origin with new hashes, so origin was probably rewritten. Match origin takes origin's history and keeps yours as a backup. 1 commit is not on origin; Match origin keeps it only in the backup.",
    );
  });

  it('a pull that stops on a conflict with diverged history can match origin; nothing to gain is still refused', async () => {
    const elsewhere = cloneOf(bare);
    const theirs = commit(elsewhere, 'a.txt', 'theirs\n', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    const mine = commit(projectPath, 'a.txt', 'mine\n', 'feat: mine');
    await pullNow();
    const sync = await settled();
    expect(sync.state).toBe('conflict');
    expect(sync.message).toContain(
      "Match origin takes origin's history instead and keeps yours as a backup.",
    );
    const matched = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ state: 'pulled', branch: 'main' });
    expect(head()).toBe(theirs);
    const backups = await listBackups(projectPath);
    expect(git(projectPath, 'rev-parse', `refs/emberline/backup/${backups[0]}`)).toBe(mine);
    expect(readRepositorySettings(t.db, projectId).syncStop).toBeNull();
    // Re-read: the same as origin now, so there is nothing to match.
    const again = await send('POST', gitUrl('/match-origin'), { branch: 'main' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('nothing_to_match');
  });
});

describe('the note on a ticket whose runs Match origin set aside', () => {
  const day = new Date().toISOString().slice(0, 10);
  it("goes after the person's text, and replaces an earlier one instead of adding another", () => {
    const once = setAsideNote('Do the thing.', 'main', ['emberline/a']);
    expect(once).toBe(
      `Do the thing.\n\nSet aside by Match origin on ${day}: main took origin's history, and this ticket's earlier work was based on the old history, so it was not merged. Do not reuse its branch emberline/a; start from the current main.`,
    );
    const twice = setAsideNote(once, 'main', ['emberline/b', 'emberline/c']);
    expect(twice).toBe(
      `Do the thing.\n\nSet aside by Match origin on ${day}: main took origin's history, and this ticket's earlier work was based on the old history, so it was not merged. Do not reuse its branches emberline/b, emberline/c; start from the current main.`,
    );
    expect(setAsideNote('', 'main', [null])).toBe(
      `Set aside by Match origin on ${day}: main took origin's history, and this ticket's earlier work was based on the old history, so it was not merged. Start from the current main.`,
    );
  });

  it("never cuts the person's text: a short note when the full one does not fit, none when nothing fits", () => {
    const long = 'x'.repeat(TICKET_BODY_MAX - 120);
    const short = setAsideNote(long, 'main', ['emberline/a']);
    expect(short.startsWith(`${long}\n\n`)).toBe(true);
    expect(short.slice(long.length + 2)).toBe(
      `Set aside by Match origin on ${day}: do not reuse branch emberline/a; start from the current main.`,
    );
    expect(short.length).toBeLessThanOrEqual(TICKET_BODY_MAX);
    const full = 'y'.repeat(TICKET_BODY_MAX - 10);
    expect(setAsideNote(full, 'main', ['emberline/a'])).toBe(full);
  });
});

describe('a conflict in many files', () => {
  it('names the first ten in the message, and keeps every one in files', async () => {
    const names = Array.from({ length: 15 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
    const elsewhere = cloneOf(bare);
    for (const name of names) writeFileSync(path.join(elsewhere, name), 'theirs\n');
    git(elsewhere, 'add', '.');
    git(elsewhere, 'commit', '-q', '-m', 'feat: theirs');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    for (const name of names) writeFileSync(path.join(projectPath, name), 'mine\n');
    git(projectPath, 'add', '.');
    git(projectPath, 'commit', '-q', '-m', 'feat: mine');
    await pullNow();
    const sync = await settled();
    expect(sync.state).toBe('conflict');
    expect(sync.files).toEqual(names);
    expect(sync.message).toContain(`${names.slice(0, 10).join(', ')} and 5 more files`);
    expect(sync.message).not.toContain('f11.txt');
    // Resolve with a ticket: its body names the first ten too.
    const res = await send('POST', gitUrl('/pull/ticket'));
    const ticket = (await send('GET', `/api/tickets/${res.json().ticketId}`)).json();
    expect(ticket.body).toContain(
      `Conflicting files:\n${names
        .slice(0, 10)
        .map((n) => `- ${n}`)
        .join('\n')}\n- and 5 more files\n`,
    );
    expect(ticket.body).not.toContain('f11.txt');
    expect(storedSync()?.files).toEqual(names);
  });
});
