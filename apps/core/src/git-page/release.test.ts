import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildDemoResponse, GitPageStatus, ReleaseJob, StartReleaseBody } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepositorySettings, writeRepositorySettings } from '../db/project-settings.js';
import { projectWorktreeConfig } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { syncWorktreeToMainWorkspace, withMainWorkspaceLock } from '../factory/merge.js';
import type { buildWorkspaceDemo } from '../factory/demo.js';
import { type FakeForge, startFakeForge } from '../test-fake-forge.js';
import {
  authHeaders,
  createTestApp,
  seedForgeAccount,
  setupAndLogin,
  startGitGateway,
  type TestApp,
} from '../test-utils.js';
import { ReleaseJobs } from './release.js';
import { GitPageService } from './service.js';

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
const send = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, headers: authHeaders(cookie), ...(payload ? { payload } : {}) });
const gitUrl = (rest = '') => `/api/projects/${projectId}/git${rest}`;
const commit = (dir: string, file: string, content: string, subject: string) => {
  writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', subject);
  return git(dir, 'rev-parse', 'HEAD');
};
const has = (dir: string, ref: string) => {
  try {
    return git(dir, 'rev-parse', '--verify', '--quiet', ref);
  } catch {
    return '';
  }
};
const cloneOf = (from: string) => {
  const dir = path.join(t.dir, `elsewhere-${++clones}`);
  execFileSync('git', ['clone', '-q', '-b', 'main', from, dir]);
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storedJob = () => readRepositorySettings(t.db, projectId).releaseJob!;
const stepsOf = (job: ReleaseJob) => job.steps.map((s) => [s.name, s.status]);
const okBuild = (): BuildDemoResponse => ({
  ok: true,
  targetId: 'release',
  demoEntryRelPath: null,
  demoUrl: null,
  output: '',
});
type Build = typeof buildWorkspaceDemo;
const releaseWorktrees = () => {
  const dir = path.join(t.config.workspacesDir, '.worktrees', projectSlug);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('release-')) : [];
};

/** Approves a worktree.yml with a build check, as a person would. */
const approveChecks = () => {
  const yml = 'version: 1\nchecks:\n  build: "true"\n';
  t.db
    .insert(projectWorktreeConfig)
    .values({
      projectId,
      content: yml,
      sha256: createHash('sha256').update(yml).digest('hex'),
      approvedAt: new Date(),
      approvedBy: 'person',
    })
    .run();
};

let checked: string[];
const jobsWith = (
  extra: { build?: Build; forge?: ConstructorParameters<typeof ReleaseJobs>[1]['forge'] } = {},
) =>
  new ReleaseJobs(t.db, {
    repository: t.repository,
    forge: extra.forge ?? t.forge,
    runs: t.runs,
    workspacesDir: t.config.workspacesDir,
    buildWorkspaceDemo:
      extra.build ??
      (async (p) => {
        checked.push(p.workspacePath);
        return okBuild();
      }),
  });
const serviceWith = (jobs: ReleaseJobs) =>
  new GitPageService(t.db, t.repository, {
    runs: t.runs,
    forge: t.forge,
    tickets: t.tickets,
    workspacesDir: t.config.workspacesDir,
    releases: jobs,
  });
const refusal = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
};

/** develop with two ticket commits on top of main; main has a CHANGELOG.md with ## [Unreleased]. */
const developWithTickets = async () => {
  commit(
    projectPath,
    'CHANGELOG.md',
    '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- First.\n',
    'docs: changelog',
  );
  git(projectPath, 'push', '-q', bare, 'main');
  git(projectPath, 'branch', 'develop');
  git(projectPath, 'push', '-q', bare, 'develop');
  expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
  commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
  commit(projectPath, 'c.txt', 'c\n', 'feat(EMB-2): c');
  git(projectPath, 'push', '-q', bare, 'develop');
  return git(projectPath, 'rev-parse', 'develop');
};
const publish = (head: string, extra: Partial<StartReleaseBody> = {}): StartReleaseBody => ({
  mode: 'publish',
  version: 'v0.2.0',
  notes: '### Added\n- x',
  head,
  ...extra,
});

beforeEach(async () => {
  checked = [];
  t = await createTestApp();
  await startGitGateway(t);
  cookie = await setupAndLogin(t.app);
  const made = (await send('POST', '/api/projects', { name: 'Release App', initGit: true })).json();
  projectId = made.project.id;
  projectPath = made.project.path;
  projectSlug = made.project.slug;
  commit(projectPath, 'a.txt', 'a\n', 'feat: a');
  forge = await startFakeForge({ token: 'rl-token', username: 'alice' });
  seedForgeAccount(t.db, { provider: 'gitea', serverUrl: forge.url, token: 'rl-token', username: 'alice' });
  bare = forge.bare('alice', 'app');
  await t.repository.connect(projectId, { url: `${forge.url}/alice/app.git` });
  git(projectPath, 'push', '-q', bare, 'main');
});
afterEach(async () => {
  await forge.close();
  await t.close();
});

describe('release', () => {
  it('promotes develop into main, runs the checks, writes CHANGELOG, tags, pushes and creates the forge release', async () => {
    approveChecks();
    const head = await developWithTickets();
    const mainBefore = git(projectPath, 'rev-parse', 'main');
    const jobs = jobsWith();
    const started = await jobs.start(projectId, publish(head));
    expect(started.state).toBe('running');
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(stepsOf(job)).toEqual([
      ['promote', 'done'],
      ['checks', 'done'],
      ['changelog', 'done'],
      ['push_main', 'done'],
      ['tag', 'done'],
      ['push_tag', 'done'],
      ['forge_release', 'done'],
      ['sync_working', 'done'],
    ]);
    expect(job.previousMain).toBe(mainBefore);
    expect(job.releaseUrl).toContain('/releases/tag/v0.2.0');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): v0.2.0');
    // The promote merge: main first, then the working branch, with Emberline's subject.
    expect(git(bare, 'log', '-1', '--format=%P', 'main~1').split(' ')).toEqual([mainBefore, head]);
    expect(git(bare, 'log', '-1', '--format=%s', 'main~1')).toBe('Merge develop into main');
    expect(git(bare, 'cat-file', '-t', 'refs/tags/v0.2.0')).toBe('tag');
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(git(bare, 'rev-parse', 'main'));
    expect(forge.releases).toEqual([
      expect.objectContaining({ tag_name: 'v0.2.0', name: 'v0.2.0', body: '### Added\n- x' }),
    ]);
    expect(git(projectPath, 'rev-parse', 'develop')).toBe(git(projectPath, 'rev-parse', 'main'));
    expect(git(bare, 'log', '--format=%B', 'main')).not.toMatch(/Co-Authored-By|Generated with/i);
    // The release commit changes CHANGELOG.md alone.
    expect(git(bare, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main')).toBe('CHANGELOG.md');
    const today = new Date().toISOString().slice(0, 10);
    expect(git(bare, 'show', 'main:CHANGELOG.md')).toBe(
      `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - ${today}\n\n### Added\n- x\n\n## [0.1.0] - 2026-01-01\n\n- First.`,
    );
    // The checks ran on main in core's own worktree, which is gone; the main workspace is clean.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain(`${path.sep}.worktrees${path.sep}`);
    expect(releaseWorktrees()).toEqual([]);
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('develop');
  });

  it('red checks stop before anything is pushed, and Undo promote puts main back', async () => {
    approveChecks();
    const head = await developWithTickets();
    const mainBefore = git(projectPath, 'rev-parse', 'main');
    const jobs = jobsWith({
      build: async () => ({ ...okBuild(), ok: false, output: `${'x'.repeat(3000)}the build broke` }),
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('failed');
    expect(stepsOf(job).slice(0, 3)).toEqual([
      ['promote', 'done'],
      ['checks', 'failed'],
      ['changelog', 'pending'],
    ]);
    const detail = job.steps[1]!.detail!;
    expect(detail.length).toBeLessThanOrEqual(2400);
    expect(detail.endsWith('the build broke')).toBe(true);
    // Main stays promoted here, unpushed; origin is untouched.
    expect(git(projectPath, 'rev-parse', 'main')).toBe(job.promoteOid);
    expect(git(bare, 'rev-parse', 'main')).toBe(mainBefore);
    expect(has(projectPath, 'refs/tags/v0.2.0')).toBe('');
    expect(releaseWorktrees()).toEqual([]);

    const undone = await jobs.undoPromote(projectId);
    expect(undone.state).toBe('undone');
    expect(git(projectPath, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(projectPath, 'rev-parse', 'develop')).toBe(head);
    // Nothing more to undo or retry.
    expect((await refusal(jobs.undoPromote(projectId))).code).toBe('nothing_to_undo');
    expect((await refusal(jobs.retry(projectId))).code).toBe('nothing_to_retry');
  });

  it('refuses a version whose tag exists on origin before main changes', async () => {
    const head = await developWithTickets();
    const mainBefore = git(projectPath, 'rev-parse', 'main');
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'tag', 'v0.2.0');
    git(elsewhere, 'push', '-q', 'origin', 'v0.2.0');
    const jobs = jobsWith();
    const error = await refusal(jobs.start(projectId, publish(head)));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('tag_exists');
    expect(git(projectPath, 'rev-parse', 'main')).toBe(mainBefore);
    expect(readRepositorySettings(t.db, projectId).releaseJob).toBeNull();
  });

  it('refuses before anything runs: a moved head, a bad version, a version tagged here, no changes', async () => {
    const head = await developWithTickets();
    const jobs = jobsWith();
    expect((await refusal(jobs.start(projectId, publish('0'.repeat(40))))).code).toBe('head_moved');
    expect((await refusal(jobs.start(projectId, publish(head, { version: 'v1.2' })))).code).toBe(
      'version_invalid',
    );
    expect((await refusal(jobs.start(projectId, publish(head, { version: 'v1.0.0-a..b' })))).code).toBe(
      'version_invalid',
    );
    git(projectPath, 'tag', 'v0.2.0', 'main');
    expect((await refusal(jobs.start(projectId, publish(head)))).code).toBe('tag_exists');
    expect(readRepositorySettings(t.db, projectId).releaseJob).toBeNull();
  });

  it("origin's main moving mid-release stops at push_main with no tag, and Retry after a Pull finishes", async () => {
    approveChecks();
    const head = await developWithTickets();
    const mainBefore = git(projectPath, 'rev-parse', 'main');
    let moved = false;
    const jobs = jobsWith({
      build: async () => {
        if (!moved) {
          moved = true;
          const elsewhere = cloneOf(bare);
          commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
          git(elsewhere, 'push', '-q', 'origin', 'main');
        }
        return okBuild();
      },
    });
    const svc = serviceWith(jobs);
    await svc.startRelease(projectId, publish(head));
    await jobs.idle();
    let job = storedJob();
    expect(job.state).toBe('failed');
    const pushMain = job.steps.find((s) => s.name === 'push_main')!;
    expect(pushMain).toMatchObject({
      status: 'failed',
      detail: "origin's main moved during the release: Pull, then Retry",
    });
    expect(has(projectPath, 'refs/tags/v0.2.0')).toBe('');
    expect(has(bare, 'refs/tags/v0.2.0')).toBe('');
    expect(forge.releases).toEqual([]);
    // Nothing of the release was published, and main is back where it was, so a Pull brings origin's in.
    expect(git(projectPath, 'rev-parse', 'main')).toBe(mainBefore);

    expect((await svc.pull(projectId, { auto: false })).state).toBe('pulled');
    await svc.retryRelease(projectId);
    await jobs.idle();
    job = storedJob();
    expect(job.state).toBe('done');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): v0.2.0');
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(git(bare, 'rev-parse', 'main'));
    // The promote merged exactly the approved head into origin's new main.
    expect(git(bare, 'log', '-1', '--format=%P', 'main~1').split(' ')[1]).toBe(head);
    expect(git(bare, 'log', '--format=%s', 'main')).toContain('feat: merged on the forge');
    // develop has everything main has.
    git(projectPath, 'merge-base', '--is-ancestor', 'main', 'develop');
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
  });

  it('Promote only merges and pushes main, with no tag, CHANGELOG or release', async () => {
    approveChecks();
    const head = await developWithTickets();
    const jobs = jobsWith();
    await jobs.start(projectId, { mode: 'promote_only', head });
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(stepsOf(job)).toEqual([
      ['promote', 'done'],
      ['checks', 'done'],
      ['changelog', 'skipped'],
      ['push_main', 'done'],
      ['tag', 'skipped'],
      ['push_tag', 'skipped'],
      ['forge_release', 'skipped'],
      ['sync_working', 'done'],
    ]);
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('Merge develop into main');
    expect(git(bare, 'rev-parse', 'main')).toBe(git(projectPath, 'rev-parse', 'main'));
    expect(git(bare, 'tag', '--list')).toBe('');
    expect(forge.releases).toEqual([]);
    expect(git(projectPath, 'rev-parse', 'develop')).toBe(git(projectPath, 'rev-parse', 'main'));
  });

  it('working = default: the release tags main itself without a promote', async () => {
    approveChecks();
    commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- First.\n', 'docs: log');
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    const jobs = jobsWith();
    await jobs.start(projectId, publish(head, { version: '0.2.0' }));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(stepsOf(job)).toEqual([
      ['promote', 'skipped'],
      ['checks', 'done'],
      ['changelog', 'done'],
      ['push_main', 'done'],
      ['tag', 'done'],
      ['push_tag', 'done'],
      ['forge_release', 'done'],
      ['sync_working', 'skipped'],
    ]);
    expect(git(bare, 'log', '-1', '--format=%P', 'main')).toBe(head);
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): 0.2.0');
    expect(git(bare, 'rev-parse', 'refs/tags/0.2.0^{commit}')).toBe(git(bare, 'rev-parse', 'main'));
    // main is checked out: the main workspace moved with it and is clean.
    expect(git(projectPath, 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'main'));
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
    // No ## [Unreleased]: the new section goes above the first one.
    expect(readFileSync(path.join(projectPath, 'CHANGELOG.md'), 'utf8')).toMatch(
      /^# Changelog\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n- x\n\n## \[0\.1\.0\]/,
    );
  });

  it('without a forge account the tag is pushed and the release step is skipped with the reason', async () => {
    const head = await developWithTickets();
    const jobs = jobsWith({
      forge: {
        createRelease: async () => {
          throw new HttpError(409, 'forge_account_missing', 'No forge account.');
        },
      },
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(job.steps.find((s) => s.name === 'checks')).toMatchObject({
      status: 'skipped',
      detail: 'No approved checks in .emberline/worktree.yml',
    });
    expect(job.steps.find((s) => s.name === 'forge_release')).toMatchObject({
      status: 'skipped',
      detail: `No forge account for ${new URL(forge.url).host}: the tag is pushed, the release page is not`,
    });
    expect(git(bare, 'cat-file', '-t', 'refs/tags/v0.2.0')).toBe('tag');
    expect(job.releaseUrl).toBeNull();
  });

  it('a release starts and finishes with typed notes after a failed draft', async () => {
    const head = await developWithTickets();
    writeRepositorySettings(t.db, projectId, {
      releaseDraft: {
        status: 'failed',
        head,
        baseTag: null,
        version: null,
        bump: null,
        notes: '',
        agent: null,
        error: 'No agent is set up.',
        at: new Date().toISOString(),
      },
    });
    const jobs = jobsWith();
    await jobs.start(projectId, publish(head, { notes: '- Typed by hand.' }));
    await jobs.idle();
    expect(storedJob().state).toBe('done');
    expect(forge.releases).toEqual([expect.objectContaining({ body: '- Typed by hand.' })]);
    expect(git(bare, 'show', 'main:CHANGELOG.md')).toContain('- Typed by hand.\n');
  });

  it('Retry resumes after a failed step, and a tag origin already has as ours counts as pushed', async () => {
    const head = await developWithTickets();
    let fail = true;
    const jobs = jobsWith({
      forge: {
        createRelease: async (id, input) => {
          if (fail) throw new HttpError(502, 'forge_error', 'Gitea release failed (502): bad gateway');
          return t.forge.createRelease(id, input);
        },
      },
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    let job = storedJob();
    expect(job.state).toBe('failed');
    expect(job.steps.find((s) => s.name === 'forge_release')).toMatchObject({
      status: 'failed',
      detail: 'Gitea release failed (502): bad gateway',
    });
    expect(git(bare, 'cat-file', '-t', 'refs/tags/v0.2.0')).toBe('tag');
    // As if core had stopped right after the tag push, before recording it.
    writeRepositorySettings(t.db, projectId, {
      releaseJob: {
        ...job,
        steps: job.steps.map((s) => (s.name === 'push_tag' ? { ...s, status: 'pending' as const } : s)),
      },
    });
    fail = false;
    await jobs.retry(projectId);
    await jobs.idle();
    job = storedJob();
    expect(job.state).toBe('done');
    expect(forge.releases).toHaveLength(1);
  });

  it('a push_tag that finds another object under the tag on origin fails with the reason', async () => {
    const head = await developWithTickets();
    const jobs = jobsWith({
      forge: {
        createRelease: async () => {
          throw new HttpError(502, 'forge_error', 'down');
        },
      },
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    // Someone replaced the tag on origin meanwhile.
    const elsewhere = cloneOf(bare);
    git(elsewhere, 'push', '-q', 'origin', ':refs/tags/v0.2.0');
    git(elsewhere, 'tag', '-f', '-a', 'v0.2.0', '-m', 'theirs');
    git(elsewhere, 'push', '-q', 'origin', 'v0.2.0');
    writeRepositorySettings(t.db, projectId, {
      releaseJob: {
        ...job,
        steps: job.steps.map((s) => (s.name === 'push_tag' ? { ...s, status: 'pending' as const } : s)),
      },
    });
    await jobs.retry(projectId);
    await jobs.idle();
    expect(storedJob().steps.find((s) => s.name === 'push_tag')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('origin already has a tag v0.2.0 that names another object'),
    });
  });

  it('a job core stopped during a step reads as failed, and Retry continues it', async () => {
    approveChecks();
    const head = await developWithTickets();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const first = jobsWith({
      build: async () => {
        await gate;
        return okBuild();
      },
    });
    await first.start(projectId, publish(head));
    for (let i = 0; i < 200 && storedJob().steps[1]!.status !== 'running'; i++) await sleep(25);
    await first.stop(50);
    // A new core (after a restart) owns no job: the stored one stopped during its checks.
    const after = jobsWith();
    const svc = serviceWith(after);
    const status = await svc.status(projectId);
    expect(status.releaseJob).toMatchObject({ state: 'failed' });
    expect(status.releaseJob!.steps[1]).toMatchObject({ name: 'checks', status: 'failed' });
    expect(status.release.ok).toBe(false);
    release();
    await first.idle();
    await after.retry(projectId);
    await after.idle();
    expect(storedJob().state).toBe('done');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): v0.2.0');
  });

  it('is refused while a run is merging into the working branch', async () => {
    const head = await developWithTickets();
    const worktree = path.join(t.dir, 'run-wt');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/r1', worktree, 'develop');
    let unlock: () => void = () => undefined;
    const held = withMainWorkspaceLock(projectPath, () => new Promise<void>((r) => (unlock = r)));
    const merging = syncWorktreeToMainWorkspace({
      worktreePath: worktree,
      mainWorkspacePath: projectPath,
      ticketKey: null,
      runId: 'r1',
    });
    const jobs = jobsWith();
    const error = await refusal(jobs.start(projectId, publish(head)));
    expect(error.code).toBe('runs_live');
    expect(error.details).toEqual({ runs: [{ id: 'r1', title: null }] });
    unlock();
    await held;
    await merging;
  });

  it('POST /git/release answers 202 with the job, and GET /git shows the page status', async () => {
    const head = await developWithTickets();
    const before = (await send('GET', gitUrl())).json() as GitPageStatus;
    expect(before).toMatchObject({
      isGitRepo: true,
      defaultBranch: 'main',
      workingBranch: 'develop',
      checkedOut: 'develop',
      workingMismatch: false,
      mainBehindWorking: 2,
      latestTag: null,
      hasOrigin: true,
      autoPull: true,
      sync: { state: 'idle', at: null, branch: null, files: [], message: null },
      forgeRelease: true,
      release: { ok: true, reason: null },
      releaseJob: null,
      releaseDraft: null,
      backups: [],
    });
    expect(before.originUrl).toContain('/alice/app.git');

    const res = await send('POST', gitUrl('/release'), publish(head));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ mode: 'publish', version: 'v0.2.0', state: 'running' });
    // A second start while it runs is refused.
    const again = await send('POST', gitUrl('/release'), publish(head));
    expect(again.statusCode).toBe(409);
    let status = before;
    for (let i = 0; i < 400; i++) {
      status = (await send('GET', gitUrl())).json() as GitPageStatus;
      if (status.releaseJob?.state !== 'running') break;
      await sleep(25);
    }
    expect(status.releaseJob?.state).toBe('done');
    expect(status).toMatchObject({
      mainBehindWorking: 0,
      latestTag: 'v0.2.0',
      main: 'up_to_date',
      release: { ok: false, reason: expect.stringContaining('nothing') },
    });
    expect((await send('POST', gitUrl('/release/retry'))).statusCode).toBe(409);
    expect((await send('POST', gitUrl('/release/undo-promote'))).statusCode).toBe(409);
  });
});
