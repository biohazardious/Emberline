/**
 * Compose cleanup (spec §6, plan Review Focus 3): every worktree prune path takes down the
 * worktree's agent project and the preview project of every run sharing it, with their volumes; the
 * GC sweep removes what is left of runs that are gone. `docker` is faked in the command executor.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExecRequest, type ExecResult, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { runs } from './db/schema.js';
import { composeProjectName, mainComposeProjectName, previewComposeProjectName } from './docker/engine.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false });
const failed = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, signal: null, stdout: '', stderr, timedOut: false, truncated: false });

/** The engine as far as cleanup sees it: `compose ls/down`, `image prune`, `run` (reclaim). */
class FakeEngine {
  available = true;
  /** Every docker command line, in order. */
  calls: string[][] = [];
  /** Compose projects `compose ls -a` lists. */
  projects = new Set<string>();
  /** Projects whose `down` fails. */
  failDown = new Set<string>();
  /** For each `down`: whether the worktree directory still existed then. */
  worktreeAtDown = new Map<string, boolean>();
  watchWorktree: string | null = null;
  reclaims: ExecRequest[] = [];
  /** While set, `compose ls` waits for it. */
  lsGate: Promise<void> | null = null;

  readonly exec = async (request: ExecRequest): Promise<ExecResult> => {
    if (request.file !== 'docker') return localCommandExecutor(request);
    const args = request.args;
    if (args[0] === 'version') return this.available ? ok('"29.8.2"\n') : failed('Cannot connect to the Docker daemon');
    this.calls.push(args);
    if (args[0] === 'compose' && args[1] === 'ls') {
      if (this.lsGate) await this.lsGate;
      return ok(JSON.stringify([...this.projects].map((Name) => ({ Name, Status: 'running(1)', ConfigFiles: '/x/compose.yaml' }))));
    }
    if (args[0] === 'compose' && args.includes('down')) {
      const project = args[2]!;
      if (this.watchWorktree) this.worktreeAtDown.set(project, existsSync(this.watchWorktree));
      if (this.failDown.has(project)) return failed(`Error response from daemon: ${project} is stuck`);
      this.projects.delete(project);
      return ok();
    }
    if ((args[0] === 'image' || args[0] === 'builder') && args[1] === 'prune') return ok('Total reclaimed space: 0B\n');
    if (args[0] === 'run') {
      this.reclaims.push(request);
      // What the throwaway container does to the files the engine's containers left: make them the
      // runner user's own again.
      const mount = args[args.indexOf('--mount') + 1] ?? '';
      const source = /source=([^,]+)/.exec(mount)?.[1];
      if (source) execFileSync('chmod', ['-R', 'u+rwX', source]);
      return ok();
    }
    if (args[0] === 'compose' && args.includes('ps')) return ok('');
    return failed(`unexpected docker ${args.join(' ')}`);
  };

  downs(): string[] {
    return this.calls.filter((a) => a[0] === 'compose' && a.includes('down')).map((a) => a[2]!);
  }
}

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;
let engine: FakeEngine;

afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  await ptydServer.close();
  await t.close();
});

async function start(dockerHost: string | null = 'tcp://docker:2376') {
  t = await createTestApp(dockerHost ? { dockerHost } : {});
  engine = new FakeEngine();
  setCommandExecutor(engine.exec);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
}

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

async function createProject(name = 'Shop'): Promise<{ id: string; path: string }> {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return project;
}

async function endedRun(projectId: string): Promise<Run> {
  const run = await t.runs.enqueue({ projectId, prompt: 'x' });
  await t.runs.stop(run.id);
  return t.runs.getRun(run.id);
}

/** A quota-handoff successor: a second run (ended too) in the same worktree. */
function successorOf(run: Run): string {
  const row = t.db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  const id = randomUUID();
  t.db.insert(runs).values({ ...row, id, createdAt: new Date(row.createdAt.getTime() + 1000) }).run();
  return id;
}

const downArgs = (project: string) => ['compose', '-p', project, 'down', '-v', '--rmi', 'local', '--remove-orphans'];
const typesOf = (id: string) => t.runs.get(id).events.map((e) => e.type);

describe('compose cleanup on every prune path (Review Focus 3)', () => {
  it('a per-run prune takes down the agent project and the preview project with their volumes, then removes the worktree', async () => {
    await start();
    const p = await createProject();
    const run = await endedRun(p.id);
    engine.watchWorktree = run.worktreePath;
    const agent = composeProjectName(run.id, run.worktreePath);
    const preview = previewComposeProjectName(run.id);
    const res = await api('POST', `/api/runs/${run.id}/worktree/prune`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: true });
    expect(existsSync(run.worktreePath)).toBe(false);
    const downs = engine.calls.filter((a) => a.includes('down'));
    expect(downs).toEqual(expect.arrayContaining([downArgs(agent), downArgs(preview)]));
    expect(downs).toHaveLength(2);
    // After teardown, before the worktree goes.
    expect(engine.worktreeAtDown.get(agent)).toBe(true);
    expect(engine.worktreeAtDown.get(preview)).toBe(true);
  });

  it('a worktree shared after a handoff: the preview project of every run in it, the agent project once', async () => {
    await start();
    const p = await createProject();
    const first = await endedRun(p.id);
    const second = successorOf(first);
    expect(composeProjectName(second, first.worktreePath)).toBe(composeProjectName(first.id, first.worktreePath));
    const res = await api('POST', `/api/runs/${second}/worktree/prune`, {});
    expect(res.json()).toMatchObject({ removed: true });
    expect(engine.downs().sort()).toEqual(
      [composeProjectName(first.id, first.worktreePath), previewComposeProjectName(first.id), previewComposeProjectName(second)].sort(),
    );
  });

  it('a manual GC prune', async () => {
    await start();
    const p = await createProject();
    const run = await endedRun(p.id);
    const res = await api('POST', '/api/runs/gc', { projectId: p.id, keepRecent: 0, includeFailed: true, pruneWorktrees: true });
    expect(res.json()).toMatchObject({ prunedWorktrees: 1 });
    expect(engine.downs().sort()).toEqual([composeProjectName(run.id, run.worktreePath), previewComposeProjectName(run.id)].sort());
    expect(existsSync(run.worktreePath)).toBe(false);
  });

  it('an auto-GC prune', async () => {
    await start();
    const p = await createProject();
    const ended: Run[] = [];
    for (let i = 0; i < 11; i++) ended.push(await endedRun(p.id));
    await t.runs.enqueue({ projectId: p.id, prompt: 'open' });
    await t.runs.reconcile();
    const oldest = ended[0]!;
    await expect.poll(() => existsSync(oldest.worktreePath), { timeout: 8_000 }).toBe(false);
    expect(engine.downs()).toEqual(expect.arrayContaining([composeProjectName(oldest.id, oldest.worktreePath), previewComposeProjectName(oldest.id)]));
    // The ten newest keep their worktrees and their containers.
    for (const run of ended.slice(1)) expect(engine.downs()).not.toContain(composeProjectName(run.id, run.worktreePath));
  });

  it("a project delete takes down every run's projects and the main workspace's project", async () => {
    await start();
    const p = await createProject();
    const a = await endedRun(p.id);
    const b = await t.runs.enqueue({ projectId: p.id, prompt: 'live' });
    expect((await api('DELETE', `/api/projects/${p.id}?deleteFiles=0`)).statusCode).toBeLessThan(300);
    const downs = engine.calls.filter((x) => x.includes('down'));
    for (const name of [
      composeProjectName(a.id, a.worktreePath),
      previewComposeProjectName(a.id),
      composeProjectName(b.id, b.worktreePath),
      previewComposeProjectName(b.id),
      mainComposeProjectName(p.id),
    ]) {
      expect(downs, name).toContainEqual(downArgs(name));
    }
    expect(existsSync(a.worktreePath)).toBe(false);
  });

  it('a failed down is a worktree_teardown_failed note; the prune goes ahead', async () => {
    await start();
    const p = await createProject();
    const run = await endedRun(p.id);
    const agent = composeProjectName(run.id, run.worktreePath);
    engine.failDown.add(agent);
    const res = await api('POST', `/api/runs/${run.id}/worktree/prune`, {});
    expect(res.json()).toMatchObject({ removed: true });
    const note = t.runs.get(run.id).events.find((e) => e.type === 'worktree_teardown_failed');
    expect(note?.payload).toMatchObject({ command: `docker ${downArgs(agent).join(' ')}`, exitCode: 1 });
    expect(String((note?.payload as { tail: string }).tail)).toContain('is stuck');
    expect(typesOf(run.id).indexOf('worktree_pruned')).toBeGreaterThan(typesOf(run.id).indexOf('worktree_teardown_failed'));
  });

  it('with the engine off no prune path runs a docker command (Review Focus 2)', async () => {
    await start(null);
    const p = await createProject();
    const a = await endedRun(p.id);
    await api('POST', `/api/runs/${a.id}/worktree/prune`, {});
    await endedRun(p.id);
    await api('POST', '/api/runs/gc', { projectId: p.id, keepRecent: 0, includeFailed: true, pruneWorktrees: true });
    await endedRun(p.id);
    await api('DELETE', `/api/projects/${p.id}?deleteFiles=0`);
    expect((await t.runs.sweepDockerProjects()).removed).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("deleting a run takes down its agent project unless another run shares the worktree", async () => {
    await start();
    const p = await createProject();
    const alone = await endedRun(p.id);
    expect((await api('DELETE', `/api/runs/${alone.id}`)).statusCode).toBeLessThan(300);
    expect(engine.calls).toContainEqual(downArgs(composeProjectName(alone.id, alone.worktreePath)));
    // The worktree itself is kept.
    expect(existsSync(alone.worktreePath)).toBe(true);
    engine.calls = [];
    const first = await endedRun(p.id);
    successorOf(first);
    expect((await api('DELETE', `/api/runs/${first.id}`)).statusCode).toBeLessThan(300);
    expect(engine.downs()).not.toContain(composeProjectName(first.id, first.worktreePath));
  });

  it.skipIf(process.getuid?.() === 0)(
    "files the engine's containers left that the runner user cannot remove are reclaimed through a throwaway container",
    async () => {
      await start();
      const p = await createProject();
      const run = await endedRun(p.id);
      // Stands in for a database directory a container wrote under a sub-uid: not removable as is.
      const data = path.join(run.worktreePath, 'pgdata');
      mkdirSync(path.join(data, 'base'), { recursive: true });
      writeFileSync(path.join(data, 'base', 'PG_VERSION'), '18\n');
      chmodSync(path.join(data, 'base'), 0o555);
      chmodSync(data, 0o555);
      const res = await api('POST', `/api/runs/${run.id}/worktree/prune`, { force: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ removed: true });
      expect(existsSync(run.worktreePath)).toBe(false);
      expect(engine.reclaims).toHaveLength(1);
      const reclaim = engine.reclaims[0]!;
      expect(reclaim.args.slice(0, 6)).toEqual(['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${run.worktreePath},target=/w`]);
      expect(reclaim.env).toMatchObject({ DOCKER_HOST: 'tcp://docker:2376', DOCKER_TLS_VERIFY: '1' });
    },
  );

  /** A directory the runner user cannot empty, as a container's sub-uid would leave it. */
  function stuckDir(dir: string): void {
    mkdirSync(path.join(dir, 'pgdata', 'base'), { recursive: true });
    writeFileSync(path.join(dir, 'pgdata', 'base', 'PG_VERSION'), '18\n');
    chmodSync(path.join(dir, 'pgdata', 'base'), 0o555);
    chmodSync(path.join(dir, 'pgdata'), 0o555);
  }

  it.skipIf(process.getuid?.() === 0)('a project delete reclaims such files too, then removes the worktrees', async () => {
    await start();
    const p = await createProject();
    const run = await endedRun(p.id);
    stuckDir(run.worktreePath);
    expect((await api('DELETE', `/api/projects/${p.id}?deleteFiles=0`)).statusCode).toBeLessThan(300);
    await expect.poll(() => existsSync(path.dirname(run.worktreePath)), { timeout: 8_000 }).toBe(false);
    expect(engine.reclaims.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(process.getuid?.() === 0)('never reclaims outside .worktrees, the project directory, or outside the workspaces', async () => {
    await start();
    const p = await createProject();
    // Outside the workspaces volume (the test's workspaces are its temp dir).
    const outside = mkdtempSync(path.join(tmpdir(), 'not-a-worktree-'));
    stuckDir(outside);
    const internals = t.runs as unknown as { pruneRunWorktree: (project: string, worktree: string) => Promise<boolean> };
    await expect(internals.pruneRunWorktree(p.path, outside)).rejects.toThrow();
    await expect(internals.pruneRunWorktree(p.path, p.path)).rejects.toThrow();
    await t.runs.removeTree(outside);
    expect(engine.reclaims).toEqual([]);
    chmodSync(path.join(outside, 'pgdata'), 0o755);
    chmodSync(path.join(outside, 'pgdata', 'base'), 0o755);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('GC sweep of compose projects', () => {
  it("removes Emberline projects whose run is gone or ended without a worktree, keeps live, review and other projects", async () => {
    await start();
    const p = await createProject();
    const live = await t.runs.enqueue({ projectId: p.id, prompt: 'live' });
    const review = await endedRun(p.id);
    const gone = await endedRun(p.id);
    rmSync(gone.worktreePath, { recursive: true, force: true });
    const keep = [
      composeProjectName(live.id, live.worktreePath),
      previewComposeProjectName(live.id),
      composeProjectName(review.id, review.worktreePath),
      previewComposeProjectName(review.id),
      mainComposeProjectName(p.id),
      // Not Emberline's run projects: never touched.
      'emberline',
      'emberline-verify-docker',
      'emberline-deadbeef-extra',
      'shop',
    ];
    const remove = ['emberline-deadbeef', composeProjectName(gone.id, gone.worktreePath), previewComposeProjectName(gone.id), 'emberline-main-00000000'];
    for (const name of [...keep, ...remove]) engine.projects.add(name);
    const { removed } = await t.runs.sweepDockerProjects();
    expect(removed.sort()).toEqual([...remove].sort());
    expect(engine.calls.filter((a) => a.includes('down'))).toEqual(expect.arrayContaining(remove.map(downArgs)));
    expect(engine.downs().sort()).toEqual([...remove].sort());
    expect([...engine.projects].sort()).toEqual([...keep].sort());
    expect(engine.calls[0]).toEqual(['compose', 'ls', '-a', '--format', 'json']);
  });

  it('caps the downs per sweep; the next sweep takes the rest', async () => {
    await start();
    for (let i = 0; i < 13; i++) engine.projects.add(`emberline-dead${String(i).padStart(4, '0')}`);
    expect((await t.runs.sweepDockerProjects()).removed).toHaveLength(10);
    expect((await t.runs.sweepDockerProjects()).removed).toHaveLength(3);
    expect(engine.projects.size).toBe(0);
  });

  it('prunes images older than 72 h at most once a day', async () => {
    await start();
    const now = Date.now();
    await t.runs.sweepDockerProjects(now);
    await t.runs.sweepDockerProjects(now + 30 * 60_000);
    const prunes = () => engine.calls.filter((a) => a[0] === 'image' || a[0] === 'builder');
    expect(prunes()).toEqual([
      ['image', 'prune', '-f', '--filter', 'until=72h'],
      ['builder', 'prune', '-f', '--filter', 'until=72h'],
    ]);
    await t.runs.sweepDockerProjects(now + 24 * 3_600_000);
    expect(prunes()).toHaveLength(4);
  });

  it('runs a minute after start (leftovers from before a restart), then every 30 minutes', async () => {
    await start();
    vi.spyOn(t.runs, 'reconcile').mockResolvedValue(undefined);
    const sweep = vi.spyOn(t.runs, 'sweepDockerProjects').mockResolvedValue({ removed: [], listed: true, pruned: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    try {
      t.runs.startReconciler();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(sweep).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(sweep).toHaveBeenCalledTimes(2);
      t.runs.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs two sweeps at once', async () => {
    await start();
    engine.projects.add('emberline-deadbeef');
    let open!: () => void;
    engine.lsGate = new Promise((resolve) => (open = resolve));
    const first = t.runs.sweepDockerProjects();
    await expect.poll(() => engine.calls.filter((a) => a[1] === 'ls').length).toBe(1);
    expect((await t.runs.sweepDockerProjects()).removed).toEqual([]);
    open();
    expect((await first).removed).toEqual(['emberline-deadbeef']);
    expect(engine.calls.filter((a) => a[1] === 'ls')).toHaveLength(1);
  });

  it('does nothing while the engine does not answer', async () => {
    await start();
    engine.available = false;
    await t.runs.docker.probe();
    engine.projects.add('emberline-deadbeef');
    expect((await t.runs.sweepDockerProjects()).removed).toEqual([]);
    expect(engine.calls).toEqual([]);
  });
});
