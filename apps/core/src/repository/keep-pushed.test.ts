import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { runEvents, runs } from '../db/schema.js';
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
const remoteMain = () =>
  git(forge.bare('alice', 'app'), 'rev-parse', '--verify', '--quiet', 'refs/heads/main');
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
    t.runs.note('r1', 'merged_to_main', {});
    await t.mainPush.idle();
    expect(remoteMain()).toBe(git(projectPath, 'rev-parse', 'HEAD'));
  });

  it('failure is noted and never throws; a later success clears it', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    t.runs.note('r1', 'merged_to_main', {});
    await t.mainPush.idle();
    const elsewhere = path.join(t.dir, 'elsewhere');
    execFileSync('git', ['clone', '-q', forge.bare('alice', 'app'), elsewhere]);
    commit(elsewhere, 'theirs.txt');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    commit(projectPath, 'ours.txt');
    expect(() => t.runs.note('r1', 'merged_by_person', {})).not.toThrow();
    await t.mainPush.idle();
    expect(notes('r1').map((n) => n.payload)).toEqual([{ reason: DIVERGED_MESSAGE }]);
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBe(DIVERGED_MESSAGE);
    expect((await t.repository.status(projectId)).lastMainPushError).toBe(DIVERGED_MESSAGE);
    git(projectPath, 'reset', '-q', '--hard', 'HEAD~1');
    // The fake needs auth: pull straight from the bare directory.
    git(projectPath, 'pull', '-q', '--ff-only', forge.bare('alice', 'app'), 'main');
    commit(projectPath, 'again.txt');
    t.runs.note('r1', 'merged_to_main', {});
    await t.mainPush.idle();
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBeNull();
  });

  it('an unreachable origin is noted with a reason that has no token', async () => {
    writeRepositorySettings(t.db, projectId, { keepMainPushed: true });
    await forge.close();
    t.runs.note('r1', 'merged_to_main', {});
    await t.mainPush.idle();
    const [note] = notes('r1');
    expect(note).toBeDefined();
    expect(JSON.stringify(note!.payload)).not.toContain('kp-token');
    forge = await startFakeForge({ token: 'kp-token' }); // afterEach closes it
  });
});
