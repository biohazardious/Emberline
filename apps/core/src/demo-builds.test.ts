import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectStatusSummary, WorkspaceDemoTarget } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectSettings, writeProjectSettings } from './db/project-settings.js';
import { runs } from './db/schema.js';
import {
  buildStartCommit,
  DEMO_BUILDS_KEY,
  isDemoStale,
  readDemoBuilds,
  recordDemoBuild,
} from './factory/demo-builds.js';
import { buildWorkspaceDemo, hasVerifiableBuildTarget } from './factory/demo.js';
import { workspaceHeadSha, worktreeHeadSha } from './runs/git.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return git(dir, 'rev-parse', 'HEAD');
}

describe('workspace HEAD without spawning git', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'head-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a main checkout, a linked worktree, packed refs and a detached HEAD', async () => {
    const main = path.join(dir, 'main');
    const first = repo(main);
    expect(await workspaceHeadSha(main, main)).toBe(first);

    const wt = path.join(dir, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'run', wt);
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'run work');
    expect(await workspaceHeadSha(wt, main)).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(await worktreeHeadSha(wt, main)).toBe(git(wt, 'rev-parse', 'HEAD'));

    git(main, 'pack-refs', '--all');
    expect(await workspaceHeadSha(main, main)).toBe(first);
    expect(await workspaceHeadSha(wt, main)).toBe(git(wt, 'rev-parse', 'HEAD'));

    git(main, 'checkout', '-q', '--detach', 'HEAD');
    expect(await workspaceHeadSha(main, main)).toBe(first);
  });

  it('is null outside a git repository', async () => {
    expect(await workspaceHeadSha(dir, dir)).toBeNull();
    expect(await workspaceHeadSha(path.join(dir, 'missing'), dir)).toBeNull();
  });

  /** Resolves within `ms`, or fails: a read that blocks would hang every status poll. */
  const quickly = <T>(p: Promise<T>, ms = 2_000) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('blocked')), ms))]);

  it('is null, at once, for a FIFO as HEAD', async () => {
    const main = path.join(dir, 'main');
    repo(main);
    unlinkSync(path.join(main, '.git', 'HEAD'));
    execFileSync('mkfifo', [path.join(main, '.git', 'HEAD')]);
    expect(await quickly(workspaceHeadSha(main, main))).toBeNull();
  });

  it('is null for a symlinked HEAD or ref, even when they point at valid content', async () => {
    const main = path.join(dir, 'main');
    const sha = repo(main);
    const elsewhere = path.join(dir, 'elsewhere');
    writeFileSync(elsewhere, `${sha}\n`);
    const ref = path.join(main, '.git', 'refs', 'heads', 'main');
    unlinkSync(ref);
    symlinkSync(elsewhere, ref);
    expect(await quickly(workspaceHeadSha(main, main))).toBeNull();

    writeFileSync(path.join(dir, 'head-elsewhere'), `${sha}\n`);
    unlinkSync(path.join(main, '.git', 'HEAD'));
    symlinkSync(path.join(dir, 'head-elsewhere'), path.join(main, '.git', 'HEAD'));
    expect(await quickly(workspaceHeadSha(main, main))).toBeNull();
    unlinkSync(path.join(main, '.git', 'HEAD'));
    symlinkSync('/dev/zero', path.join(main, '.git', 'HEAD'));
    expect(await quickly(workspaceHeadSha(main, main))).toBeNull();
  });

  it("is null when a worktree's gitdir points outside the project's .git/worktrees", async () => {
    const main = path.join(dir, 'main');
    repo(main);
    const wt = path.join(dir, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'run', wt);
    const outside = path.join(dir, 'fake-gitdir');
    cpSync(path.join(main, '.git', 'worktrees', 'wt'), outside, { recursive: true });
    writeFileSync(path.join(wt, '.git'), `gitdir: ${outside}\n`);
    expect(await quickly(workspaceHeadSha(wt, main))).toBeNull();
    expect(await quickly(worktreeHeadSha(wt, main))).toBeNull();
    // A worktree of another project is not this project's either.
    const other = path.join(dir, 'other');
    repo(other);
    const otherWt = path.join(dir, 'other-wt');
    git(other, 'worktree', 'add', '-q', '-b', 'run', otherWt);
    expect(await workspaceHeadSha(otherWt, main)).toBeNull();
  });

  it("is null for a ref name or sha that does not look like git's", async () => {
    const main = path.join(dir, 'main');
    const sha = repo(main);
    const head = path.join(main, '.git', 'HEAD');
    writeFileSync(head, 'ref: refs/heads/../../../../etc/hostname\n');
    expect(await workspaceHeadSha(main, main)).toBeNull();
    writeFileSync(head, 'ref: HEAD\n');
    expect(await workspaceHeadSha(main, main)).toBeNull();
    writeFileSync(head, `${sha.slice(0, 39)}\n`);
    expect(await workspaceHeadSha(main, main)).toBeNull();
    writeFileSync(head, 'ref: refs/heads/main\n');
    writeFileSync(path.join(main, '.git', 'refs', 'heads', 'main'), 'not-a-sha\n');
    expect(await workspaceHeadSha(main, main)).toBeNull();
    writeFileSync(path.join(main, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
    expect(await workspaceHeadSha(main, main)).toBe(sha);
  });

  it("reads main's package.json with a cap and never blocks on a FIFO in the build-target check", async () => {
    const ws = path.join(dir, 'ws');
    mkdirSync(ws);
    writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    expect(await hasVerifiableBuildTarget(ws)).toBe(true);
    unlinkSync(path.join(ws, 'package.json'));
    execFileSync('mkfifo', [path.join(ws, 'package.json')]);
    expect(await quickly(hasVerifiableBuildTarget(ws))).toBe(false);
    unlinkSync(path.join(ws, 'package.json'));
    writeFileSync(
      path.join(ws, 'package.json'),
      `{"scripts":{"build":"x"},"pad":"${'x'.repeat(1024 * 1024)}"}`,
    );
    expect(await hasVerifiableBuildTarget(ws)).toBe(false);
  });

  it('the commit recorded at build start is the HEAD git reports, null outside git', async () => {
    const main = path.join(dir, 'main');
    const sha = repo(main);
    expect(await buildStartCommit(main)).toBe(sha);
    expect(await buildStartCommit(dir)).toBeNull();
  });
});

describe('staleness', () => {
  const build = { commit: 'a'.repeat(40), builtAt: '2026-10-18T10:00:00.000Z', ok: true };

  it('is stale when the workspace moved past the recorded commit', () => {
    expect(isDemoStale({ head: 'b'.repeat(40), build, hasDemoEntry: true })).toBe(true);
    expect(isDemoStale({ head: 'b'.repeat(40), build, hasDemoEntry: false })).toBe(true);
  });

  it('is fresh at the recorded commit, failed builds included', () => {
    expect(isDemoStale({ head: build.commit, build, hasDemoEntry: true })).toBe(false);
    expect(isDemoStale({ head: build.commit, build: { ...build, ok: false }, hasDemoEntry: false })).toBe(
      false,
    );
  });

  it('a demo entry nobody recorded a build for is stale; no entry and no record is not', () => {
    expect(isDemoStale({ head: build.commit, build: null, hasDemoEntry: true })).toBe(true);
    expect(isDemoStale({ head: build.commit, build: null, hasDemoEntry: false })).toBe(false);
  });

  it('cannot tell without a HEAD (not a git repo): not stale', () => {
    expect(isDemoStale({ head: null, build, hasDemoEntry: true })).toBe(false);
    expect(isDemoStale({ head: null, build: { ...build, commit: null }, hasDemoEntry: true })).toBe(false);
  });

  it('a build recorded without a commit cannot tell either: not stale, also once the workspace has a HEAD', () => {
    expect(isDemoStale({ head: build.commit, build: { ...build, commit: null }, hasDemoEntry: true })).toBe(
      false,
    );
    expect(
      isDemoStale({ head: build.commit, build: { ...build, commit: null, ok: false }, hasDemoEntry: false }),
    ).toBe(false);
  });
});

describe('build records', () => {
  let t: TestApp;
  let cookie: string;
  const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
  });
  afterEach(async () => {
    await t.close();
  });

  async function gitProject(name = 'Builds') {
    const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json() as {
      project: { id: string; path: string };
    };
    const head = repo(project.path);
    return { project, head };
  }

  function insertRun(projectId: string, id: string, worktreePath: string) {
    const now = new Date();
    t.db
      .insert(runs)
      .values({
        id,
        projectId,
        agent: 'claude',
        state: 'done',
        worktreePath,
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
      })
      .run();
  }

  const status = async (projectId: string) =>
    (await api('GET', `/api/projects/${projectId}/status`)).json() as ProjectStatusSummary;
  const target = (s: ProjectStatusSummary, id: string) =>
    s.targets.find((x) => x.id === id) as WorkspaceDemoTarget;

  it('are written under demoBuilds by target and keep the other settings', async () => {
    const { project } = await gitProject();
    writeProjectSettings(t.db, project.id, { ingestedTicketFiles: ['abc'] });
    const rec = { commit: 'c'.repeat(40), builtAt: '2026-10-18T10:00:00.000Z', ok: true };
    recordDemoBuild(t.db, project.id, 'main', rec);
    expect(readDemoBuilds(t.db, project.id)).toEqual({ main: rec });
    const doc = readProjectSettings(t.db, project.id);
    expect(doc.ingestedTicketFiles).toEqual(['abc']);
    expect(doc[DEMO_BUILDS_KEY]).toEqual({ main: rec });
  });

  it('drop entries of runs that no longer exist on every write, and ignore malformed ones', async () => {
    const { project } = await gitProject();
    insertRun(project.id, 'run-live', project.path);
    const rec = { commit: null, builtAt: '2026-10-18T10:00:00.000Z', ok: false };
    writeProjectSettings(t.db, project.id, {
      demoBuilds: { 'run-gone': rec, 'run-live': rec, junk: { commit: 3 } },
    });
    expect(Object.keys(readDemoBuilds(t.db, project.id)).sort()).toEqual(['run-gone', 'run-live']);
    recordDemoBuild(t.db, project.id, 'main', rec);
    expect(Object.keys(readDemoBuilds(t.db, project.id)).sort()).toEqual(['main', 'run-live']);
  });

  it('buildWorkspaceDemo records the HEAD at build start and the outcome when given the db', async () => {
    const { project, head } = await gitProject();
    writeFileSync(path.join(project.path, 'build.sh'), 'exit 0\n');
    const ok = await buildWorkspaceDemo({
      db: t.db,
      projectId: project.id,
      targetId: 'main',
      workspacePath: project.path,
    });
    expect(ok.ok).toBe(true);
    const first = readDemoBuilds(t.db, project.id).main;
    expect(first).toMatchObject({ commit: head, ok: true });
    expect(Date.parse(first!.builtAt)).toBeGreaterThan(Date.now() - 60_000);

    writeFileSync(path.join(project.path, 'build.sh'), 'if then\n');
    const failed = await buildWorkspaceDemo({
      db: t.db,
      projectId: project.id,
      targetId: 'main',
      workspacePath: project.path,
    });
    expect(failed.ok).toBe(false);
    expect(readDemoBuilds(t.db, project.id).main).toMatchObject({ commit: head, ok: false });
  });

  it('the build-demo route records the build of main', async () => {
    const { project, head } = await gitProject();
    const res = await api('POST', `/api/projects/${project.id}/build-demo`, { targetId: 'main' });
    expect(res.statusCode).toBe(200);
    expect(readDemoBuilds(t.db, project.id).main).toMatchObject({ commit: head, ok: true });
  });

  it('status shows each target’s build and whether its workspace moved past it', async () => {
    const { project, head } = await gitProject();
    let main = target(await status(project.id), 'main');
    expect(main.demoBuild).toBeNull();
    expect(main.demoStale).toBe(false);
    expect(main.rebuilding).toBe(false);

    // A demo on disk nobody recorded a build for.
    writeFileSync(path.join(project.path, 'index.html'), '<!doctype html><title>x</title>');
    expect(target(await status(project.id), 'main').demoStale).toBe(true);

    const rec = { commit: head, builtAt: '2026-10-18T10:00:00.000Z', ok: true };
    recordDemoBuild(t.db, project.id, 'main', rec);
    main = target(await status(project.id), 'main');
    expect(main.demoBuild).toEqual(rec);
    expect(main.demoStale).toBe(false);

    git(project.path, 'commit', '-q', '--allow-empty', '-m', 'merged work');
    expect(target(await status(project.id), 'main').demoStale).toBe(true);
  });

  it('run worktree targets carry their own record and staleness', async () => {
    const { project } = await gitProject();
    const wt = path.join(t.dir, 'wt-run');
    git(project.path, 'worktree', 'add', '-q', '-b', 'run-a', wt);
    insertRun(project.id, 'run-a', wt);
    const wtHead = git(wt, 'rev-parse', 'HEAD');
    recordDemoBuild(t.db, project.id, 'run-a', {
      commit: wtHead,
      builtAt: '2026-10-18T10:00:00.000Z',
      ok: true,
    });
    expect(target(await status(project.id), 'run-a')).toMatchObject({
      demoStale: false,
      demoBuild: { commit: wtHead },
    });
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'agent work');
    expect(target(await status(project.id), 'run-a').demoStale).toBe(true);
  });
});
