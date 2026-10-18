import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectStatusSummary, Run, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects, projectWorktreeConfig, runs } from './db/schema.js';
import { readDemoBuilds } from './factory/demo-builds.js';
import { isDemoBuildRunning } from './factory/demo.js';
import { MERGE_NOTES, PostMergeJobs, type PostMergeContext } from './factory/post-merge.js';
import type { RunService } from './runs/service.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** RunService's note events and the build path's lookups, nothing else. */
class FakeRuns extends EventEmitter {
  get(): never {
    throw new Error('no runs here');
  }
  async dockerEnvFor() {
    return {};
  }
  async dockerEnvForMain() {
    return {};
  }
}

let t: TestApp;
let cookie: string;
const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

async function gitProject(name = 'Merge') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json() as {
    project: { id: string; path: string };
  };
  git(project.path, 'init', '-q', '-b', 'main');
  git(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return project;
}

/** Approves a worktree.yml for the project, as a person would. */
function approve(projectId: string, yml: string) {
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
}

const BUILD_YML = [
  'version: 1',
  'setup:',
  '  - "echo set-up > setup-ran.txt"',
  'checks:',
  '  build: "mkdir -p dist && cp page.html dist/index.html"',
  '',
].join('\n');

const projectRow = (id: string) => t.db.select().from(projects).where(eq(projects.id, id)).get()!;

const runNote = (projectId: string, id = 'r1') => ({ id, projectId }) as Run;

describe('post-merge jobs', () => {
  let fake: FakeRuns;
  let logs: string[];
  let jobs: PostMergeJobs;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
    fake = new FakeRuns();
    logs = [];
    projectId = (await gitProject()).id;
  });
  afterEach(async () => {
    await jobs?.stop();
    await t.close();
  });

  const make = (steps: { name: string; run: (ctx: PostMergeContext) => Promise<void> }[]) => {
    jobs = new PostMergeJobs(t.db, fake as unknown as RunService, { steps, log: (m) => logs.push(m) });
    jobs.start();
    return jobs;
  };

  it('start after a pipeline merge and after a person merge, not after other notes', async () => {
    const seen: string[] = [];
    make([{ name: 'probe', run: async (ctx) => void seen.push(ctx.projectId) }]);
    expect(MERGE_NOTES).toEqual(['merged_to_main', 'merged_by_person']);
    fake.emit('note', runNote(projectId), 'merge_failed', {});
    fake.emit('note', runNote(projectId), 'build_gate_failed', {});
    await jobs.idle();
    expect(seen).toEqual([]);
    fake.emit('note', runNote(projectId), 'merged_to_main', {});
    await jobs.idle();
    fake.emit('note', runNote(projectId), 'merged_by_person', {});
    await jobs.idle();
    expect(seen).toEqual([projectId, projectId]);
  });

  it('never run inside the merge: the note returns first, and a failing step is logged, not thrown', async () => {
    const order: string[] = [];
    make([
      {
        name: 'boom',
        run: async () => {
          order.push('boom');
          throw new Error('build exploded');
        },
      },
      { name: 'after', run: async () => void order.push('after') },
    ]);
    fake.emit('note', runNote(projectId), 'merged_to_main', {});
    order.push('note returned');
    await jobs.idle();
    expect(order).toEqual(['note returned', 'boom', 'after']);
    expect(logs.some((l) => l.includes('boom') && l.includes('build exploded'))).toBe(true);
  });

  it('run one job per project at a time; merges meanwhile coalesce into one pending job', async () => {
    const gate = deferred();
    let running = 0;
    let maxRunning = 0;
    let started = 0;
    make([
      {
        name: 'slow',
        run: async () => {
          started += 1;
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          if (started === 1) await gate.promise;
          running -= 1;
        },
      },
    ]);
    expect(jobs.isRebuilding(projectId)).toBe(false);
    jobs.enqueue(projectId);
    await expect.poll(() => started).toBe(1);
    expect(jobs.isRebuilding(projectId)).toBe(true);
    jobs.enqueue(projectId);
    jobs.enqueue(projectId);
    jobs.enqueue(projectId);
    gate.resolve();
    await jobs.idle();
    expect(started).toBe(2);
    expect(maxRunning).toBe(1);
    expect(jobs.isRebuilding(projectId)).toBe(false);
  });

  it('keep projects apart: a slow job in one does not hold another', async () => {
    const other = (await gitProject('Other')).id;
    const gate = deferred();
    const done: string[] = [];
    make([
      {
        name: 'per-project',
        run: async (ctx) => {
          if (ctx.projectId === projectId) await gate.promise;
          done.push(ctx.projectId);
        },
      },
    ]);
    jobs.enqueue(projectId);
    jobs.enqueue(other);
    await expect.poll(() => done).toEqual([other]);
    gate.resolve();
    await jobs.idle();
    expect(done).toEqual([other, projectId]);
  });

  it('run registered steps after the built-in ones, with the project’s main workspace', async () => {
    const order: string[] = [];
    make([{ name: 'first', run: async () => void order.push('first') }]);
    jobs.registerPostMergeStep('refresh', async (ctx) => void order.push(`refresh ${ctx.mainPath}`));
    jobs.enqueue(projectId);
    await jobs.idle();
    const mainPath = projectRow(projectId).path;
    expect(order).toEqual(['first', `refresh ${mainPath}`]);
  });

  it('skip a project that was deleted meanwhile', async () => {
    const seen: string[] = [];
    make([{ name: 'probe', run: async (ctx) => void seen.push(ctx.projectId) }]);
    jobs.enqueue('no-such-project');
    await jobs.idle();
    expect(seen).toEqual([]);
  });

  it('rebuild main with the approved setup and checks and record the build (default steps)', async () => {
    const project = projectRow(projectId);
    writeFileSync(path.join(project.path, 'page.html'), '<!doctype html><title>v2</title>');
    git(project.path, 'add', '-A');
    git(project.path, 'commit', '-q', '-m', 'merged page');
    approve(project.id, BUILD_YML);
    jobs = new PostMergeJobs(t.db, fake as unknown as RunService, { log: (m) => logs.push(m) });
    jobs.start();
    fake.emit('note', runNote(project.id), 'merged_to_main', {});
    await jobs.idle();
    expect(readFileSync(path.join(project.path, 'dist', 'index.html'), 'utf8')).toContain('v2');
    expect(existsSync(path.join(project.path, 'setup-ran.txt'))).toBe(true);
    expect(readDemoBuilds(t.db, project.id).main).toMatchObject({
      commit: git(project.path, 'rev-parse', 'HEAD'),
      ok: true,
    });
    expect(logs.some((l) => /rebuilt main/i.test(l))).toBe(true);
  });

  it('leave a main without a verifiable build target alone (no build, no record)', async () => {
    jobs = new PostMergeJobs(t.db, fake as unknown as RunService, { log: (m) => logs.push(m) });
    jobs.start();
    fake.emit('note', runNote(projectId), 'merged_by_person', {});
    await jobs.idle();
    expect(readDemoBuilds(t.db, projectId)).toEqual({});
  });

  it('records a failed rebuild and keeps going', async () => {
    approve(projectId, 'version: 1\nchecks:\n  build: "exit 3"\n');
    jobs = new PostMergeJobs(t.db, fake as unknown as RunService, { log: (m) => logs.push(m) });
    jobs.start();
    jobs.enqueue(projectId);
    await jobs.idle();
    expect(readDemoBuilds(t.db, projectId).main).toMatchObject({ ok: false });
    expect(logs.some((l) => /failed/i.test(l))).toBe(true);
  });

  it('stop gives up waiting for a held step after stopTimeoutMs', async () => {
    const gate = deferred();
    let started = false;
    jobs = new PostMergeJobs(t.db, fake as unknown as RunService, {
      steps: [{ name: 'held', run: async () => ((started = true), gate.promise) }],
      stopTimeoutMs: 50,
    });
    jobs.start();
    jobs.enqueue(projectId);
    await expect.poll(() => started).toBe(true);
    const t0 = Date.now();
    await jobs.stop();
    expect(Date.now() - t0).toBeLessThan(2_000);
    gate.resolve();
  });

  it('a failing project lookup is logged; idle and stop never reject', async () => {
    const brokenDb = {
      select: () => {
        throw new Error('database is closed');
      },
    } as unknown as typeof t.db;
    jobs = new PostMergeJobs(brokenDb, fake as unknown as RunService, {
      steps: [],
      log: (m) => logs.push(m),
    });
    jobs.start();
    fake.emit('note', runNote(projectId), 'merged_to_main', {});
    await expect(jobs.idle()).resolves.toBeUndefined();
    await expect(jobs.stop()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('database is closed'))).toBe(true);
    expect(jobs.isRebuilding(projectId)).toBe(false);
  });

  it("a person's build of main waits for a running post-merge build of main", async () => {
    const project = projectRow(projectId);
    const log = path.join(project.path, 'build-log.txt');
    writeFileSync(path.join(project.path, '.gitignore'), 'build-log.txt\nrelease\n');
    approve(
      project.id,
      [
        'version: 1',
        'checks:',
        `  build: "echo start >> build-log.txt; while [ ! -f release ]; do sleep 0.05; done; echo end >> build-log.txt"`,
        '',
      ].join('\n'),
    );
    jobs = new PostMergeJobs(t.db, fake as unknown as RunService, { log: (m) => logs.push(m) });
    jobs.start();
    jobs.enqueue(project.id);
    await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toBe('start\n');
    expect(isDemoBuildRunning(project.path)).toBe(true);
    const person = api('POST', `/api/projects/${project.id}/build-demo`, { targetId: 'main' });
    await new Promise((r) => setTimeout(r, 400));
    // Without the lock the person's build would have started next to the running one.
    expect(readFileSync(log, 'utf8')).toBe('start\n');
    writeFileSync(path.join(project.path, 'release'), '');
    expect((await person).statusCode).toBe(200);
    await jobs.idle();
    expect(readFileSync(log, 'utf8')).toBe('start\nend\nstart\nend\n');
  });
});

describe('post-merge jobs in the server', () => {
  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
  });
  afterEach(async () => {
    await t.close();
  });

  it('a person merge note on a run rebuilds main, and status says so while it runs', async () => {
    const project = await gitProject();
    writeFileSync(path.join(project.path, 'page.html'), '<!doctype html><title>person</title>');
    approve(project.id, BUILD_YML);
    const now = new Date();
    t.db
      .insert(runs)
      .values({
        id: 'run-p',
        projectId: project.id,
        agent: 'claude',
        state: 'done',
        worktreePath: project.path,
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
      })
      .run();
    const gate = deferred();
    t.postMerge.registerPostMergeStep('hold', () => gate.promise);
    t.runs.note('run-p', 'merged_by_person', {});
    const main = async () =>
      ((await api('GET', `/api/projects/${project.id}/status`)).json() as ProjectStatusSummary).targets[0]!;
    await expect.poll(async () => (await main()).rebuilding).toBe(true);
    gate.resolve();
    await t.postMerge.idle();
    expect((await main()).rebuilding).toBe(false);
    expect((await main()).demoBuild).toMatchObject({
      commit: git(project.path, 'rev-parse', 'HEAD'),
      ok: true,
    });
  });
});

describe('post-merge jobs after a person syncs a run without a ticket', () => {
  beforeEach(async () => {
    t = await createTestApp();
    cookie = await setupAndLogin(t.app);
  });
  afterEach(async () => {
    await t.close();
  });

  it('enqueue the job directly (no ticket, so no merged_by_person note)', async () => {
    const project = await gitProject('No Ticket');
    const worktree = `${project.path}-wt`;
    git(project.path, 'worktree', 'add', '-q', '-b', 'emberline/run-loose', worktree);
    writeFileSync(path.join(worktree, 'loose.txt'), 'loose\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'loose work');
    const now = new Date();
    t.db
      .insert(runs)
      .values({
        id: 'run-loose',
        projectId: project.id,
        agent: 'claude',
        state: 'done',
        branch: 'emberline/run-loose',
        worktreePath: worktree,
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
      })
      .run();
    const seen: string[] = [];
    t.postMerge.registerPostMergeStep('seen', async (ctx) => void seen.push(ctx.projectId));
    const res = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: 'run-loose' });
    expect(res.json()).toMatchObject({ ok: true, alreadyMerged: false });
    await expect.poll(() => seen).toEqual([project.id]);
    await t.postMerge.idle();
    // Nothing new to merge: no second job.
    expect((await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: 'run-loose' })).json()).toMatchObject({
      ok: true,
      alreadyMerged: true,
    });
    await t.postMerge.idle();
    expect(seen).toEqual([project.id]);
  });
});

describe('post-merge jobs after a pipeline merge', () => {
  let ptydServer: PtydServer;

  function writeLivingClaude(dir: string): string {
    const file = path.join(dir, 'living-claude.sh');
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
        `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
        `: > "${dir}/ready-$EMBERLINE_RUN_ID"`,
        'while read line; do :; done',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return file;
  }

  beforeEach(async () => {
    t = await createTestApp();
    t.config.claudeCommand = writeLivingClaude(t.dir);
    ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
    cookie = await setupAndLogin(t.app);
  });
  afterEach(async () => {
    await ptydServer.close();
    await t.close();
  });

  const hook = (runId: string, event: string, token: string, payload: object = {}) =>
    t.app.inject({
      method: 'POST',
      url: '/api/internal/hooks',
      headers: { authorization: `Bearer ${token}` },
      payload: { runId, event, receivedAt: new Date().toISOString(), payload },
    });

  async function waitFile(name: string): Promise<string> {
    const file = path.join(t.dir, name);
    await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
    return readFileSync(file, 'utf8');
  }

  it('the merged ticket reaches Done while main is still rebuilding, then main is rebuilt from the merge', async () => {
    const project = await gitProject('Pipeline');
    writeFileSync(path.join(project.path, 'page.html'), '<!doctype html><title>v1</title>');
    // Build output and setup leftovers stay out of the merge, so main's dist can only come from its rebuild.
    writeFileSync(path.join(project.path, '.gitignore'), 'dist/\nsetup-ran.txt\n');
    git(project.path, 'add', '-A');
    git(project.path, 'commit', '-q', '-m', 'page');
    approve(project.id, BUILD_YML);
    // A slow post-merge step: the pipeline must not wait for it.
    const gate = deferred();
    t.postMerge.registerPostMergeStep('hold', () => gate.promise);

    const ticket = (
      await api('POST', `/api/projects/${project.id}/tickets`, { title: 'A', status: 'ready' })
    ).json() as Ticket;
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = t.runs.list().find((r) => r.ticketId === ticket.id) as Run;
    mkdirSync(run.worktreePath, { recursive: true });
    writeFileSync(path.join(run.worktreePath, 'page.html'), '<!doctype html><title>v2</title>');
    git(run.worktreePath, 'add', '-A');
    git(run.worktreePath, 'commit', '-q', '-m', 'v2');
    await waitFile(`ready-${run.id}`);
    const token = await waitFile(`token-${run.id}`);
    await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
    await hook(run.id, 'UserPromptSubmit', token);
    await hook(run.id, 'Stop', token);

    const statusOf = async () => ((await api('GET', `/api/tickets/${ticket.id}`)).json() as Ticket).status;
    await expect.poll(statusOf, { timeout: 10_000 }).toBe('done');
    expect(t.postMerge.isRebuilding(project.id)).toBe(true);
    gate.resolve();
    await t.postMerge.idle();
    expect(readFileSync(path.join(project.path, 'dist', 'index.html'), 'utf8')).toContain('v2');
    const builds = readDemoBuilds(t.db, project.id);
    expect(builds.main).toMatchObject({ commit: git(project.path, 'rev-parse', 'HEAD'), ok: true });
    // The build gate's build of the run worktree is recorded too.
    expect(builds[run.id]).toMatchObject({ ok: true });
  });
});
