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
import { ReleaseJobs, withReleaseSection } from './release.js';
import { GitPageService } from './service.js';
import { GitSync } from './sync.js';

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
const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(25);
  expect(ok()).toBe(true);
};
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
type Deps = ConstructorParameters<typeof ReleaseJobs>[1];
const jobsWith = (
  extra: {
    build?: Build;
    forge?: Deps['forge'];
    repository?: Deps['repository'];
    notify?: Deps['notify'];
  } = {},
) =>
  new ReleaseJobs(t.db, {
    repository: extra.repository ?? t.repository,
    forge: extra.forge ?? t.forge,
    runs: t.runs,
    workspacesDir: t.config.workspacesDir,
    ...(extra.notify ? { notify: extra.notify } : {}),
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

  it('pages once each time a release finishes or stops (a Retry that stops again too), naming the version and the step', async () => {
    approveChecks();
    const pages: { occurrence: string; title: string; event: string }[] = [];
    const notify: Deps['notify'] = (_p, occurrence, m) =>
      pages.push({ occurrence, title: m.title, event: m.event });
    const head = await developWithTickets();
    const jobs = jobsWith({
      notify,
      build: async () => ({ ...okBuild(), ok: false, output: 'the build broke' }),
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const failedJob = storedJob();
    expect(pages).toEqual([
      {
        occurrence: `${projectId}:release:${failedJob.id}:failed:${failedJob.finishedAt}`,
        title: 'Release v0.2.0 stopped at checks',
        event: 'release_finished',
      },
    ]);
    // A Retry that stops again is a page of its own.
    const again = jobsWith({
      notify,
      build: async () => ({ ...okBuild(), ok: false, output: 'still broken' }),
    });
    await sleep(5);
    await again.retry(projectId);
    await again.idle();
    const failedAgain = storedJob();
    expect(failedAgain.finishedAt).not.toBe(failedJob.finishedAt);
    expect(pages.slice(1)).toEqual([
      {
        occurrence: `${projectId}:release:${failedJob.id}:failed:${failedAgain.finishedAt}`,
        title: 'Release v0.2.0 stopped at checks',
        event: 'release_finished',
      },
    ]);
    const retrying = jobsWith({ notify });
    await retrying.retry(projectId);
    await retrying.idle();
    const doneJob = storedJob();
    expect(doneJob.state).toBe('done');
    expect(pages.slice(2)).toEqual([
      {
        occurrence: `${projectId}:release:${doneJob.id}:done:${doneJob.finishedAt}`,
        title: 'Released v0.2.0',
        event: 'release_finished',
      },
    ]);
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

  it('Undo promote is refused once origin has main, though the push was not recorded', async () => {
    approveChecks();
    const head = await developWithTickets();
    const jobs = jobsWith({ build: async () => ({ ...okBuild(), ok: false, output: 'red' }) });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const promoted = git(projectPath, 'rev-parse', 'main');
    expect(storedJob().state).toBe('failed');
    // The push landed without the job knowing, and the tracking ref still names the old main:
    // Undo reads origin itself.
    const tracked = git(projectPath, 'rev-parse', 'refs/remotes/origin/main');
    git(projectPath, 'push', '-q', bare, 'main');
    git(projectPath, 'update-ref', 'refs/remotes/origin/main', tracked);
    expect((await refusal(jobs.undoPromote(projectId))).code).toBe('already_pushed');
    expect(git(projectPath, 'rev-parse', 'main')).toBe(promoted);
  });

  it('a main push that landed counts as done though recording it failed', async () => {
    const head = await developWithTickets();
    const repo = t.repository;
    const jobs = jobsWith({
      repository: {
        remoteAction: (id, fn) => repo.remoteAction(id, fn),
        readOrigin: (id, ws) => repo.readOrigin(id, ws),
        recordPush: async () => {
          throw new Error('the database is gone');
        },
      },
    });
    await jobs.start(projectId, publish(head, { mode: 'promote_only' }));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(job.steps.find((s) => s.name === 'push_main')!.status).toBe('done');
    expect(git(bare, 'rev-parse', 'main')).toBe(job.promoteOid);
    expect((await refusal(jobs.undoPromote(projectId))).code).toBe('nothing_to_undo');
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
    const titles: string[] = [];
    const jobs = jobsWith({ notify: (_p, _o, m) => titles.push(m.title) });
    await jobs.start(projectId, { mode: 'promote_only', head });
    await jobs.idle();
    expect(titles).toEqual(['Promoted develop into main']);
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
    // A version tag without a "v" is the latest tag, and main at it has nothing to release.
    const status = await serviceWith(jobs).status(projectId);
    expect(status.latestTag).toBe('0.2.0');
    expect(status.release).toEqual({ ok: false, reason: expect.stringContaining('nothing new to release') });
    const again = await refusal(
      jobs.start(projectId, publish(git(projectPath, 'rev-parse', 'main'), { version: '0.3.0' })),
    );
    expect(again.code).toBe('nothing_to_release');
  });

  it('a CHANGELOG.md that is not UTF-8 is left as it is, and the release goes on', async () => {
    // Latin-1 bytes: read as UTF-8 they would turn into U+FFFD in the release commit.
    const latin1 = Buffer.from('# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- Caf\xe9.\n', 'latin1');
    writeFileSync(path.join(projectPath, 'CHANGELOG.md'), latin1);
    git(projectPath, 'add', 'CHANGELOG.md');
    git(projectPath, 'commit', '-q', '-m', 'docs: log');
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    const jobs = jobsWith();
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(job.steps.find((s) => s.name === 'changelog')).toEqual({
      name: 'changelog',
      status: 'skipped',
      detail: 'CHANGELOG.md is not UTF-8 text; the notes were not added.',
    });
    expect(job.releaseCommit).toBeNull();
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(head);
    expect(readFileSync(path.join(projectPath, 'CHANGELOG.md')).equals(latin1)).toBe(true);
  });

  it('a forge error that quotes the token is stored and paged with the token masked', async () => {
    const head = await developWithTickets();
    const bodies: string[] = [];
    const jobs = jobsWith({ notify: (_p, _o, m) => bodies.push(m.body) });
    forge.releaseFailure = 502;
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('failed');
    const step = job.steps.find((s) => s.name === 'forge_release')!;
    expect(step.status).toBe('failed');
    expect(step.detail).toContain('Gitea release failed (502)');
    expect(step.detail).toContain('authorization=token [redacted]');
    for (const text of [step.detail, job.error, ...bodies]) expect(text).not.toContain('rl-token');
    expect(bodies).toHaveLength(1);
  });

  it('without a forge account the tag is pushed and the release step is skipped with the reason', async () => {
    const head = await developWithTickets();
    const jobs = jobsWith({
      forge: {
        findRelease: async () => null,
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
        findRelease: async () => null,
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
        findRelease: async () => null,
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

  it('switching the working branch and Match origin are refused while a release runs, and while one left main unpushed', async () => {
    approveChecks();
    const head = await developWithTickets();
    git(projectPath, 'branch', 'other', 'main');
    let red!: () => void;
    const checking = new Promise<void>((r) => (red = r));
    const jobs = jobsWith({
      build: async () => {
        await checking;
        return { ...okBuild(), ok: false, output: 'red' };
      },
    });
    const svc = serviceWith(jobs);
    await jobs.start(projectId, publish(head));
    await waitFor(() => storedJob().steps[1]!.status === 'running');
    // During the checks the unchecked promote on main is not checked out (Keep pushed would publish it).
    const switching = await refusal(svc.setWorkingBranch(projectId, { branch: 'main' }));
    expect(switching.code).toBe('job_running');
    expect(switching.message).toContain('the working branch stays develop');
    const matching = await refusal(svc.matchOrigin(projectId, { branch: 'develop' }));
    expect(matching.code).toBe('job_running');
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('develop');
    red();
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('failed');
    expect(git(projectPath, 'rev-parse', 'main')).toBe(job.promoteOid);
    // Stopped with main promoted here and not pushed: Retry or Undo promote first.
    expect((await refusal(svc.setWorkingBranch(projectId, { branch: 'other' }))).code).toBe(
      'release_unfinished',
    );
    expect((await refusal(svc.matchOrigin(projectId, { branch: 'main' }))).code).toBe('release_unfinished');
    expect(readRepositorySettings(t.db, projectId).workingBranch).toBe('develop');
    await jobs.undoPromote(projectId);
    await svc.setWorkingBranch(projectId, { branch: 'other' });
    expect(git(projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('other');
  });

  it('auto-pull only reads origin while a release runs (no stop, no page), and a stopped one says Retry or Undo', async () => {
    approveChecks();
    const head = await developWithTickets();
    let red!: () => void;
    const checking = new Promise<void>((r) => (red = r));
    const jobs = jobsWith({
      build: async () => {
        await checking;
        return { ...okBuild(), ok: false, output: 'red' };
      },
    });
    const pages: string[] = [];
    const svc = new GitPageService(t.db, t.repository, {
      runs: t.runs,
      forge: t.forge,
      tickets: t.tickets,
      workspacesDir: t.config.workspacesDir,
      releases: jobs,
      notify: (_p, _o, m) => pages.push(m.title),
    });
    const timer = new GitSync(t.db, svc, { log: () => undefined });
    await jobs.start(projectId, publish(head));
    await waitFor(() => storedJob().steps[1]!.status === 'running');
    // main is promoted here and not pushed yet, on purpose.
    expect(git(projectPath, 'rev-parse', 'main')).toBe(storedJob().promoteOid);
    const before = readRepositorySettings(t.db, projectId).sync;
    await timer.tick();
    expect(readRepositorySettings(t.db, projectId).sync).toEqual(before);
    expect(readRepositorySettings(t.db, projectId).syncStop).toBeNull();
    expect(pages).toEqual([]);
    red();
    await jobs.idle();
    expect(storedJob().state).toBe('failed');
    // Stopped with main unpushed: the pull says what to do on the Release tab, not "Push main".
    const sync = await svc.pull(projectId, { auto: false });
    expect(sync.state).toBe('main_unpushed');
    expect(sync.message).toContain('Retry or Undo promote on the Release tab');
    expect(sync.message).not.toContain('Push main');
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

  it("working = default: origin's main moving stops at push_main, main goes back, and after a Pull a new release finishes", async () => {
    commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n', 'docs: log');
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    git(projectPath, 'push', '-q', bare, 'main');
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
    approveChecks();
    const svc = serviceWith(jobs);
    await svc.startRelease(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('failed');
    expect(job.steps.find((s) => s.name === 'push_main')!.detail).toBe(
      "origin's main moved during the release: Pull, then start the release again",
    );
    expect(git(projectPath, 'rev-parse', 'main')).toBe(head);
    expect(git(projectPath, 'status', '--porcelain')).toBe('');
    expect(has(bare, 'refs/tags/v0.2.0')).toBe('');
    // Retry cannot redo it on top of origin's commits: it says to start again.
    const retried = await refusal(svc.retryRelease(projectId));
    expect(retried.code).toBe('restart_needed');

    expect((await svc.pull(projectId, { auto: false })).state).toBe('pulled');
    const pulled = git(projectPath, 'rev-parse', 'main');
    expect(pulled).not.toBe(head);
    await svc.startRelease(projectId, publish(pulled));
    await jobs.idle();
    expect(storedJob().state).toBe('done');
    expect(git(bare, 'log', '-1', '--format=%P', 'main')).toBe(pulled);
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(git(bare, 'rev-parse', 'main'));
  });

  it("push_main is done when origin's main already has the release's commit", async () => {
    approveChecks();
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    git(projectPath, 'push', '-q', bare, 'main');
    const jobs = jobsWith({
      build: async () => {
        const elsewhere = cloneOf(bare);
        commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
        git(elsewhere, 'push', '-q', 'origin', 'main');
        return okBuild();
      },
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(job.steps.find((s) => s.name === 'push_main')).toMatchObject({
      status: 'done',
      detail: "origin's main has this release's commit already.",
    });
    // The tag names exactly the approved commit, not what origin got since.
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(head);
  });

  it('with the promote skipped (main has the working branch), Pull then Retry finishes after origin moved', async () => {
    commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n', 'docs: log');
    commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    git(projectPath, 'push', '-q', bare, 'main');
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'push', '-q', bare, 'develop');
    expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
    const head = git(projectPath, 'rev-parse', 'develop');
    let moved = false;
    approveChecks();
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
    expect(job.steps[0]).toMatchObject({ name: 'promote', status: 'skipped' });
    expect(job.steps.find((s) => s.name === 'push_main')!.detail).toBe(
      "origin's main moved during the release: Pull, then Retry",
    );
    expect((await svc.pull(projectId, { auto: false })).state).toBe('pulled');
    await svc.retryRelease(projectId);
    await jobs.idle();
    job = storedJob();
    expect(job.state).toBe('done');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): v0.2.0');
    expect(git(bare, 'log', '--format=%s', 'main')).toContain('feat: merged on the forge');
    git(projectPath, 'merge-base', '--is-ancestor', 'main', 'develop');
  });

  it('a Pull during the checks stops the release before the CHANGELOG, and Retry checks the new main first', async () => {
    commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n', 'docs: log');
    commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    git(projectPath, 'push', '-q', bare, 'main');
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'push', '-q', bare, 'develop');
    expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
    const head = git(projectPath, 'rev-parse', 'develop');
    approveChecks();
    const ranOn: string[] = [];
    let svc: GitPageService | null = null;
    const jobs = jobsWith({
      build: async (p) => {
        ranOn.push(git(p.workspacePath, 'rev-parse', 'HEAD'));
        if (ranOn.length === 1) {
          // A PR merged on the forge, and a Pull brings it into main while the checks run.
          const elsewhere = cloneOf(bare);
          commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
          git(elsewhere, 'push', '-q', 'origin', 'main');
          expect((await svc!.pull(projectId, { auto: false })).state).toBe('pulled');
        }
        return okBuild();
      },
    });
    svc = serviceWith(jobs);
    await svc.startRelease(projectId, publish(head));
    await jobs.idle();
    let job = storedJob();
    expect(job.state).toBe('failed');
    expect(job.steps.find((s) => s.name === 'changelog')).toMatchObject({
      status: 'failed',
      detail: "Origin's main moved after the checks; Retry checks it again.",
    });
    expect(job.steps.find((s) => s.name === 'checks')!.status).toBe('pending');
    expect(has(projectPath, 'refs/tags/v0.2.0')).toBe('');
    const pulledMain = git(projectPath, 'rev-parse', 'main');
    expect(ranOn).toEqual([head]);

    await svc.retryRelease(projectId);
    await jobs.idle();
    job = storedJob();
    expect(job.state).toBe('done');
    // The checks ran again on the pulled main, and the release commit sits right on it.
    expect(ranOn).toEqual([head, pulledMain]);
    expect(job.checked).toBe(pulledMain);
    expect(git(bare, 'log', '-1', '--format=%P', 'refs/tags/v0.2.0^{commit}')).toBe(pulledMain);
  });

  it('Retry after the forge made the release but its answer was lost finds it and records its URL', async () => {
    const head = await developWithTickets();
    let lost = true;
    const jobs = jobsWith({
      forge: {
        findRelease: (id, tag) => t.forge.findRelease(id, tag),
        createRelease: async (id, input) => {
          const made = await t.forge.createRelease(id, input);
          if (lost) {
            lost = false;
            throw new HttpError(502, 'forge_error', 'Gitea release failed (502): the answer was lost');
          }
          return made;
        },
      },
    });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    expect(storedJob().steps.find((s) => s.name === 'forge_release')!.status).toBe('failed');
    expect(forge.releases).toHaveLength(1);
    await jobs.retry(projectId);
    await jobs.idle();
    const job = storedJob();
    expect(job.state).toBe('done');
    expect(job.releaseUrl).toBe(`${forge.url}/alice/app/releases/tag/v0.2.0`);
    expect(job.steps.find((s) => s.name === 'forge_release')!.detail).toBe(
      'The forge had this release already.',
    );
    expect(job.steps.find((s) => s.name === 'sync_working')!.status).toBe('done');
    expect(forge.releases).toHaveLength(1);
  });

  it('after main is pushed, Retry finishes on what was pushed though a Pull moved main (promote, no CHANGELOG)', async () => {
    git(projectPath, 'branch', 'develop');
    git(projectPath, 'push', '-q', bare, 'develop');
    expect((await send('POST', gitUrl('/working-branch'), { branch: 'develop' })).statusCode).toBe(200);
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    git(projectPath, 'push', '-q', bare, 'develop');
    approveChecks();
    let down = true;
    const jobs = jobsWith({
      forge: {
        findRelease: async () => null,
        createRelease: async (id, input) => {
          if (down) throw new HttpError(502, 'forge_error', 'Gitea release failed (502): bad gateway');
          return t.forge.createRelease(id, input);
        },
      },
    });
    const svc = serviceWith(jobs);
    await svc.startRelease(projectId, publish(head));
    await jobs.idle();
    let job = storedJob();
    expect(job.steps.find((s) => s.name === 'changelog')!.status).toBe('skipped');
    expect(job.steps.find((s) => s.name === 'forge_release')!.status).toBe('failed');
    const pushed = git(bare, 'rev-parse', 'main');
    expect(pushed).toBe(job.promoteOid);
    // A PR merged on the forge, and a Pull brings it into main (and on into develop).
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    expect((await svc.pull(projectId, { auto: false })).state).toBe('pulled');
    expect(git(projectPath, 'rev-parse', 'main')).not.toBe(pushed);
    down = false;
    checked.length = 0;
    await svc.retryRelease(projectId);
    await jobs.idle();
    job = storedJob();
    expect(job.state).toBe('done');
    expect(checked).toEqual([]);
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(pushed);
    git(projectPath, 'merge-base', '--is-ancestor', 'main', 'develop');
  });

  it('after main is pushed, Retry finishes on what was pushed though a Pull moved main (working = default)', async () => {
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    approveChecks();
    let down = true;
    const jobs = jobsWith({
      forge: {
        findRelease: async () => null,
        createRelease: async (id, input) => {
          if (down) throw new HttpError(502, 'forge_error', 'Gitea release failed (502): bad gateway');
          return t.forge.createRelease(id, input);
        },
      },
    });
    const svc = serviceWith(jobs);
    await svc.startRelease(projectId, { mode: 'publish', version: 'v0.2.0', notes: '- b', head });
    await jobs.idle();
    expect(storedJob().steps.find((s) => s.name === 'forge_release')!.status).toBe('failed');
    expect(git(bare, 'rev-parse', 'main')).toBe(head);
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    expect((await svc.pull(projectId, { auto: false })).state).toBe('pulled');
    expect(git(projectPath, 'rev-parse', 'main')).not.toBe(head);
    down = false;
    checked.length = 0;
    await svc.retryRelease(projectId);
    await jobs.idle();
    expect(storedJob().state).toBe('done');
    expect(checked).toEqual([]);
    expect(git(bare, 'rev-parse', 'refs/tags/v0.2.0^{commit}')).toBe(head);
    expect(forge.releases).toEqual([expect.objectContaining({ tag_name: 'v0.2.0' })]);
  });

  it('a take-back that fails says why instead of "Pull, then Retry"', async () => {
    commit(projectPath, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n', 'docs: log');
    const head = commit(projectPath, 'b.txt', 'b\n', 'feat(EMB-1): b');
    let calls = 0;
    const repository: Deps['repository'] = {
      readOrigin: (id, ws) => t.repository.readOrigin(id, ws),
      recordPush: (id, ws, b, oid) => t.repository.recordPush(id, ws, b, oid),
      remoteAction: async (id, fn) => {
        // The push of main: origin moved, and the person edited CHANGELOG.md here meanwhile.
        if (++calls === 2) {
          const elsewhere = cloneOf(bare);
          commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
          git(elsewhere, 'push', '-q', 'origin', 'main');
          writeFileSync(path.join(projectPath, 'CHANGELOG.md'), 'edited by hand\n');
        }
        return t.repository.remoteAction(id, fn);
      },
    };
    const jobs = jobsWith({ repository });
    await jobs.start(projectId, publish(head));
    await jobs.idle();
    const job = storedJob();
    const detail = job.steps.find((s) => s.name === 'push_main')!.detail!;
    expect(detail).toContain('could not be put back');
    expect(detail).not.toContain('Pull, then');
    // main keeps the release commit (unpushed); Undo promote is what the detail names.
    expect(git(projectPath, 'rev-parse', 'main')).toBe(job.releaseCommit);
    expect(readFileSync(path.join(projectPath, 'CHANGELOG.md'), 'utf8')).toBe('edited by hand\n');
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
    // Nothing of either branch is on origin yet, so there is nothing to count against.
    expect([before.workingCounts, before.mainCounts]).toEqual([null, null]);

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
      mainCounts: { ahead: 0, behind: 0 },
      release: { ok: false, reason: expect.stringContaining('nothing') },
    });
    expect((await send('POST', gitUrl('/release/retry'))).statusCode).toBe(409);
    expect((await send('POST', gitUrl('/release/undo-promote'))).statusCode).toBe(409);
  });
});

describe('the release summary', () => {
  it('counts main..working with its distinct tickets and names the approved checks', async () => {
    const head = await developWithTickets();
    commit(projectPath, 'd.txt', 'd\n', 'fix(EMB-1): again');
    const tip = git(projectPath, 'rev-parse', 'develop');
    expect(tip).not.toBe(head);
    let status = (await send('GET', gitUrl())).json() as GitPageStatus;
    expect(status.releaseSummary).toEqual({ head: tip, commits: 3, tickets: 2, checks: [] });
    approveChecks();
    status = (await send('GET', gitUrl())).json() as GitPageStatus;
    expect(status.releaseSummary.checks).toEqual(['build']);
  });

  it('counts the commits since the latest tag when the working branch is main', async () => {
    git(projectPath, 'tag', '0.1.0');
    commit(projectPath, 'e.txt', 'e\n', 'feat(EMB-7): e');
    commit(projectPath, 'f.txt', 'f\n', 'chore: f');
    let status = (await send('GET', gitUrl())).json() as GitPageStatus;
    expect(status.releaseSummary).toEqual({
      head: git(projectPath, 'rev-parse', 'main'),
      commits: 2,
      tickets: 1,
      checks: [],
    });
    // Without a tag, all of main counts.
    git(projectPath, 'tag', '-d', '0.1.0');
    status = (await send('GET', gitUrl())).json() as GitPageStatus;
    expect(status.releaseSummary.commits).toBe(Number(git(projectPath, 'rev-list', '--count', 'main')));
  });
});

describe('the CHANGELOG section', () => {
  it('keeps the items under ## [Unreleased] there, and puts the version below them', () => {
    const text =
      '# Changelog\n\n## [Unreleased]\n\n- Not released yet.\n\n## [0.1.0] - 2026-01-01\n\n- First.\n';
    expect(withReleaseSection(text, 'v0.2.0', '2026-11-13', '- Second.')).toBe(
      '# Changelog\n\n## [Unreleased]\n\n- Not released yet.\n\n## [0.2.0] - 2026-11-13\n\n- Second.\n\n## [0.1.0] - 2026-01-01\n\n- First.\n',
    );
    // An Unreleased section that is the last one: the version goes at its end.
    expect(
      withReleaseSection('# Log\n\n## [Unreleased]\n- Pending.\n', '1.0.0', '2026-11-13', '- One.'),
    ).toBe('# Log\n\n## [Unreleased]\n- Pending.\n\n## [1.0.0] - 2026-11-13\n\n- One.\n');
    // No heading at all: at the end.
    expect(withReleaseSection('# Log\n', '1.0.0', '2026-11-13', '- One.')).toBe(
      '# Log\n\n## [1.0.0] - 2026-11-13\n\n- One.\n',
    );
  });

  it('stays linear on a long run of whitespace', () => {
    const text = `# Log\n${' '.repeat(400_000)}x\n${' \t'.repeat(200_000)}`;
    const started = performance.now();
    const out = withReleaseSection(text, 'v1.0.0', '2026-11-13', '- One.');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out.endsWith('x\n\n## [1.0.0] - 2026-11-13\n\n- One.\n')).toBe(true);
  });
});

describe('GET /git', () => {
  it('a folder that is no git repository', async () => {
    const made = (await send('POST', '/api/projects', { name: 'Plain Folder', initGit: false })).json();
    const status = (await send('GET', `/api/projects/${made.project.id}/git`)).json() as GitPageStatus;
    expect(status).toMatchObject({
      isGitRepo: false,
      hasOrigin: false,
      working: 'unknown',
      main: 'unknown',
      release: { ok: false, reason: expect.stringContaining('not a git repository') },
    });
  });

  it('a project with no origin', async () => {
    const made = (await send('POST', '/api/projects', { name: 'No Origin', initGit: true })).json();
    commit(made.project.path, 'a.txt', 'a\n', 'feat: a');
    const status = (await send('GET', `/api/projects/${made.project.id}/git`)).json() as GitPageStatus;
    expect(status).toMatchObject({
      isGitRepo: true,
      hasOrigin: false,
      originUrl: null,
      main: 'unknown',
      forgeRelease: false,
      release: { ok: false, reason: expect.stringContaining('no origin') },
    });
  });

  it('with auto-pull off, main and the working branch are classified against the tracking refs', async () => {
    await developWithTickets();
    expect((await send('PATCH', gitUrl(), { autoPull: false })).statusCode).toBe(200);
    const elsewhere = cloneOf(bare);
    commit(elsewhere, 'pr.txt', 'pr\n', 'feat: merged on the forge');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    git(elsewhere, 'switch', '-q', 'develop');
    git(elsewhere, 'reset', '-q', '--hard', 'origin/main~1');
    commit(elsewhere, 'other.txt', 'o\n', 'feat: other on develop');
    git(elsewhere, 'push', '-q', '-f', 'origin', 'develop');
    expect((await send('POST', gitUrl('/fetch'))).statusCode).toBe(200);
    const status = (await send('GET', gitUrl())).json() as GitPageStatus;
    expect(status).toMatchObject({
      autoPull: false,
      sync: { state: 'idle' },
      main: 'behind',
      working: 'diverged',
      release: { ok: false, reason: expect.stringContaining('Pull first') },
    });
    expect(status.checkedAt).not.toBeNull();
  });
});
