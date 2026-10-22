import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { runEvents, runs } from '../db/schema.js';
import { syncWorktreeToMainWorkspace } from '../factory/merge.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  CSRF,
  createTestApp,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';
import { DIVERGED_MESSAGE, MAIN_MOVED_MESSAGE, MERGE_UNVERIFIED_MESSAGE } from './git.js';

let t: TestApp;
let cookie: string;
let forge: FakeForge;
let projectId: string;
let projectPath: string;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const commit = (dir: string, file: string) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
};
/** A merge note as the pipeline and Merge now write it: the merge commit's short sha and full id. */
const merged = () => ({
  commitSha: git(projectPath, 'rev-parse', '--short', 'HEAD'),
  commitOid: git(projectPath, 'rev-parse', 'HEAD'),
});
const addRun = (id: string, worktreePath: string, branch: string) => {
  const now = new Date();
  t.db
    .insert(runs)
    .values({
      id,
      projectId,
      agent: 'claude',
      state: 'done',
      worktreePath,
      branch,
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      title: 'T',
    })
    .run();
};
const remoteMain = () =>
  git(forge.bare('alice', 'app'), 'rev-parse', '--verify', '--quiet', 'refs/heads/main');
const worktree = (id: string) => {
  const dir = path.join(t.dir, `wt-${id}`);
  git(projectPath, 'worktree', 'add', '-q', '-b', `emberline/${id}`, dir);
  commit(dir, `${id}.txt`);
  addRun(id, dir, `emberline/${id}`);
  return dir;
};
const merge = (id: string, dir: string) =>
  syncWorktreeToMainWorkspace({
    worktreePath: dir,
    mainWorkspacePath: projectPath,
    ticketKey: null,
    runId: id,
    branch: `emberline/${id}`,
  });
/** As the pipeline notes a merge (tickets/service.ts). */
const noteMerge = (
  runId: string,
  res: { commitSha: string | null; commitOid: string | null; commitUnverified?: boolean },
) =>
  t.runs.note(runId, 'merged_to_main', {
    ...(res.commitSha ? { commitSha: res.commitSha } : {}),
    ...(res.commitOid ? { commitOid: res.commitOid } : {}),
    ...(res.commitUnverified ? { commitUnverified: true } : {}),
  });
const notes = (runId: string) =>
  t.db
    .select()
    .from(runEvents)
    .all()
    .filter((e) => e.runId === runId && e.type === 'main_push_failed');

beforeEach(async () => {
  t = await createTestApp();
  await startGitGateway(t);
  cookie = await setupAndLogin(t.app);
  forge = await startFakeForge({ token: 'kp-token', username: 'alice' });
  seedForgeAccount(t.db, { provider: 'gitea', serverUrl: forge.url, token: 'kp-token', username: 'alice' });
  const made = (
    await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...CSRF, cookie },
      payload: { name: 'KP', initGit: true },
    })
  ).json();
  projectId = made.project.id;
  projectPath = made.project.path;
  forge.bare('alice', 'app');
  await t.repository.connect(projectId, { url: `${forge.url}/alice/app.git` });
  const now = new Date();
  t.db
    .insert(runs)
    .values({
      id: 'r1',
      projectId,
      agent: 'claude',
      state: 'done',
      worktreePath: projectPath,
      branch: 'emberline/x',
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      title: 'T',
    })
    .run();
});
afterEach(async () => {
  await forge.close();
  await t.close();
});

describe('keep main pushed', () => {
  it('off by default: a merge pushes nothing', async () => {
    t.runs.note('r1', 'merged_to_main', {});
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
  });

  it('on: each merge note pushes main', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    t.runs.note('r1', 'merged_to_main', merged());
    await t.mainPush.idle();
    expect(remoteMain()).toBe(git(projectPath, 'rev-parse', 'HEAD'));
  });

  it('failure is noted and never throws; a later success clears it', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    t.runs.note('r1', 'merged_to_main', merged());
    await t.mainPush.idle();
    const elsewhere = path.join(t.dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', forge.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'theirs.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    commit(projectPath, 'ours.txt');
    expect(() => t.runs.note('r1', 'merged_by_person', merged())).not.toThrow();
    await t.mainPush.idle();
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: DIVERGED_MESSAGE }]);
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBe(DIVERGED_MESSAGE);
    expect((await t.repository.status(projectId)).lastMainPushError).toBe(DIVERGED_MESSAGE);
    git(projectPath, 'reset', '-q', '--hard', 'HEAD~1');
    // The fake needs auth: pull straight from the bare directory.
    git(projectPath, 'pull', '-q', '--ff-only', forge.bare('alice', 'app'), 'main');
    commit(projectPath, 'again.txt');
    t.runs.note('r1', 'merged_to_main', merged());
    await t.mainPush.idle();
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBeNull();
  });

  it('an unreachable origin is noted with a reason that has no token', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    await forge.close();
    t.runs.note('r1', 'merged_to_main', merged());
    await t.mainPush.idle();
    const [note] = notes('r1');
    expect(note).toBeDefined();
    expect(JSON.stringify(note!.payload)).not.toContain('kp-token');
    forge = await startFakeForge({ token: 'kp-token' }); // afterEach closes it
  });

  it('main moved outside Emberline after the merge: nothing is pushed and the failure is noted', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    const merge = merged();
    commit(projectPath, 'agent.txt'); // an agent moves refs/heads/main after the merge
    t.runs.note('r1', 'merged_to_main', merge);
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: MAIN_MOVED_MESSAGE }]);
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBe(MAIN_MOVED_MESSAGE);
  });

  it('a merge note without its commit pushes nothing', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    t.runs.note('r1', 'merged_to_main', {});
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: MAIN_MOVED_MESSAGE }]);
  });

  it('a note with only the short sha is never pushed automatically', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    t.runs.note('r1', 'merged_to_main', { commitSha: git(projectPath, 'rev-parse', '--short', 'HEAD') });
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: MAIN_MOVED_MESSAGE }]);
  });

  it("an agent's commit with the merge's short prefix (core.abbrev=4) is never published", async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    git(projectPath, 'config', 'core.abbrev', '4');
    commit(projectPath, 'merge.txt'); // the merge Emberline made
    const merge = merged();
    expect(merge.commitSha).toHaveLength(4);
    // The agent: commit X with the same prefix, main moved to X, the merge's loose object removed.
    const tree = git(projectPath, 'rev-parse', 'HEAD^{tree}');
    const parent = git(projectPath, 'rev-parse', 'HEAD~1');
    let body = '';
    let sha = '';
    for (let n = 0; ; n++) {
      body = `tree ${tree}\nparent ${parent}\nauthor evil <e@e> 1700000000 +0000\ncommitter evil <e@e> 1700000000 +0000\n\nevil ${n}\n`;
      sha = createHash('sha1')
        .update(`commit ${Buffer.byteLength(body)}\0${body}`)
        .digest('hex');
      if (sha.startsWith(merge.commitSha)) break;
    }
    execFileSync('git', ['-C', projectPath, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: body });
    git(projectPath, 'update-ref', 'refs/heads/main', sha);
    rmSync(path.join(projectPath, '.git', 'objects', merge.commitOid.slice(0, 2), merge.commitOid.slice(2)));
    t.runs.note('r1', 'merged_to_main', merge);
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: MAIN_MOVED_MESSAGE }]);
  });

  it('parallel merges: the earlier one is not reported as moved, and the remote ends at the later one', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    const a = worktree('ra');
    const b = worktree('rb');
    const resA = await merge('ra', a);
    expect(resA.commitOid).toMatch(/^[0-9a-f]{40}$/); // a normal merge is recorded
    const mergingB = merge('rb', b); // takes the main-workspace lock before A's push can
    // As the pipeline notes a merge (tickets/service.ts): the short sha and the full id.
    t.runs.note('ra', 'merged_to_main', { commitSha: resA.commitSha, commitOid: resA.commitOid });
    const resB = await mergingB;
    t.runs.note('rb', 'merged_to_main', { commitSha: resB.commitSha, commitOid: resB.commitOid });
    await t.mainPush.idle();
    expect(notes('ra')).toEqual([]);
    expect(notes('rb')).toEqual([]);
    expect(remoteMain()).toBe(git(projectPath, 'rev-parse', 'HEAD'));
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBeNull();
  });

  it("another agent moving main while the merge writes it: the agent's commit is never published", async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    const a = worktree('ra');
    // The other agent's commit X, prepared in advance on main as it is.
    const evil = worktree('evil');
    const x = git(evil, 'rev-parse', 'HEAD');
    let fired = false;
    const watcher = watch(path.join(projectPath, '.git', 'refs', 'heads'), (_event, name) => {
      if (fired || name !== 'main') return;
      fired = true;
      execFileSync('git', ['-C', projectPath, 'update-ref', 'refs/heads/main', x]);
    });
    const res = await merge('ra', a);
    watcher.close();
    expect(fired).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.commitOid).not.toBe(x);
    noteMerge('ra', res);
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('ra')).toHaveLength(1);
  });

  it('a merge Emberline could not verify is never pushed, and says why', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    noteMerge('r1', {
      commitSha: git(projectPath, 'rev-parse', '--short', 'HEAD'),
      commitOid: null,
      commitUnverified: true,
    });
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: MERGE_UNVERIFIED_MESSAGE }]);
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBe(MERGE_UNVERIFIED_MESSAGE);
  });

  it('main rewound to an older Emberline merge: the later merge gets the moved note, nothing is pushed', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    const resA = await merge('ra', worktree('ra'));
    const resB = await merge('rb', worktree('rb'));
    git(projectPath, 'update-ref', 'refs/heads/main', resA.commitOid!);
    noteMerge('rb', resB);
    await t.mainPush.idle();
    expect(forge.seen.some((r) => r.path.endsWith('git-receive-pack'))).toBe(false);
    expect(notes('rb').map((n) => n.payload)).toEqual([{ reason: MAIN_MOVED_MESSAGE }]);
  });
});
