import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, Ticket, WorktreeConfigStatusResponse } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandExecutor, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { projectWorktreeConfig, runs } from './db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/**
 * Claude stand-in: leaks its hook token and its prompt (the last argument) to files, then waits for
 * one line and exits.
 */
function writeFakeClaude(dir: string): string {
  const file = path.join(dir, 'fake-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'last=""; for a in "$@"; do last="$a"; done',
      `printf %s "$last" > "${dir}/.prompt-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.prompt-$EMBERLINE_RUN_ID" "${dir}/prompt-$EMBERLINE_RUN_ID"`,
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      'read line',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

beforeEach(async () => {
  t = await createTestApp();
  t.config.claudeCommand = writeFakeClaude(t.dir);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  vi.useRealTimers();
  setCommandExecutor(localCommandExecutor);
  await t.close();
  await ptydServer.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

const hook = (runId: string, event: string, token: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${token}` },
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const YML = '.emberline/worktree.yml';

/** A git project whose main workspace commits `yml` as its worktree.yml (not approved yet). */
async function createProject(yml?: string, name = 'Lifecycle') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  if (yml !== undefined) {
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, YML), yml);
    git('add', YML);
  }
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return project as { id: string; path: string };
}

/** What an agent's merge does: a new worktree.yml lands on main. */
function commitYml(project: { path: string }, yml: string) {
  writeFileSync(path.join(project.path, YML), yml);
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('add', YML);
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'agent: change worktree.yml');
}

const status = async (projectId: string) =>
  (await api('GET', `/api/projects/${projectId}/worktree-config`)).json() as WorktreeConfigStatusResponse;

async function approveHead(projectId: string) {
  const { head } = await status(projectId);
  const res = await api('POST', `/api/projects/${projectId}/worktree-config/approve`, { sha256: head!.sha256 });
  expect(res.statusCode).toBe(200);
  return res.json() as WorktreeConfigStatusResponse;
}

async function waitFile(file: string): Promise<string> {
  await expect.poll(() => existsSync(file), { timeout: 8_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

// Read from the service: a test that moves the clock would outlive its login session.
const eventsOf = async (id: string) => t.runs.get(id).events;
const typesOf = async (id: string) => (await eventsOf(id)).map((e) => e.type);
const payloadOf = async (id: string, type: string) => (await eventsOf(id)).find((e) => e.type === type)?.payload;

/** Starts a run and waits until its agent got a terminal. */
async function startRun(projectId: string, prompt = 'do the ticket'): Promise<Run> {
  const run: Run = (await api('POST', '/api/runs', { projectId, prompt })).json();
  await waitFile(path.join(t.dir, `token-${run.id}`));
  return run;
}

const promptOf = (runId: string) => waitFile(path.join(t.dir, `prompt-${runId}`));

const setupYml = (cmd: string) => `version: 1\nsetup:\n  - ${JSON.stringify(cmd)}\n`;

describe('worktree.yml trust (Review Focus 1)', () => {
  it('reports HEAD next to the approved content, and approves only HEAD', async () => {
    const yml = setupYml('echo ok > setup-ran');
    const project = await createProject(yml);
    const before = await status(project.id);
    expect(before).toMatchObject({ approved: null, head: { content: yml, sha256: sha(yml) }, changed: true, errors: [] });
    expect(before.diff).toContain('+setup:');

    const approved = await approveHead(project.id);
    expect(approved).toMatchObject({ approved: { content: yml, sha256: sha(yml), approvedBy: 'person' }, changed: false, diff: '' });
    expect(Date.parse(approved.approved!.approvedAt)).not.toBeNaN();
  });

  it('a worktree.yml the project never approved does nothing for runs', async () => {
    const project = await createProject(setupYml('echo ok > setup-ran'));
    const run = await startRun(project.id);
    expect(existsSync(path.join(run.worktreePath, 'setup-ran'))).toBe(false);
    expect((await typesOf(run.id)).filter((x) => x.startsWith('worktree_'))).toEqual([]);
  });

  it('an agent-merged change never runs until a person approves it; runs keep the approved content', async () => {
    const project = await createProject(setupYml('echo ok > setup-ran'));
    await approveHead(project.id);
    commitYml(project, setupYml('echo evil > evil-ran'));

    const changed = await status(project.id);
    expect(changed.changed).toBe(true);
    expect(changed.approved?.sha256).toBe(sha(setupYml('echo ok > setup-ran')));
    expect(changed.diff).toContain('-  - "echo ok > setup-ran"');
    expect(changed.diff).toContain('+  - "echo evil > evil-ran"');

    // The run branches from HEAD (which has the agent's file), yet runs the approved setup.
    const first = await startRun(project.id);
    expect(readFileSync(path.join(first.worktreePath, YML), 'utf8')).toContain('evil');
    expect(existsSync(path.join(first.worktreePath, 'setup-ran'))).toBe(true);
    expect(existsSync(path.join(first.worktreePath, 'evil-ran'))).toBe(false);

    // A stale or made-up sha cannot approve it.
    const stale = await api('POST', `/api/projects/${project.id}/worktree-config/approve`, {
      sha256: sha(setupYml('echo ok > setup-ran')),
    });
    expect(stale.statusCode).toBe(409);
    expect((await status(project.id)).approved?.sha256).toBe(sha(setupYml('echo ok > setup-ran')));

    await approveHead(project.id);
    const second = await startRun(project.id);
    expect(existsSync(path.join(second.worktreePath, 'evil-ran'))).toBe(true);
  });

  it('an invalid HEAD file shows its errors, cannot be approved, and runs keep the old content', async () => {
    const project = await createProject(setupYml('echo ok > setup-ran'));
    await approveHead(project.id);
    commitYml(project, 'version: 1\nsetup: [ "echo evil > evil-ran" ]\nunknown: true\n');
    const s = await status(project.id);
    expect(s.changed).toBe(true);
    expect(s.errors.length).toBeGreaterThan(0);
    expect(s.errors.join('\n')).toContain('unknown');
    const res = await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: s.head!.sha256 });
    expect(res.statusCode).toBe(400);
    const run = await startRun(project.id);
    expect(existsSync(path.join(run.worktreePath, 'setup-ran'))).toBe(true);
    expect(existsSync(path.join(run.worktreePath, 'evil-ran'))).toBe(false);
  });

  it('a HEAD file that is a symbolic link is refused', async () => {
    const project = await createProject();
    mkdirSync(path.join(project.path, '.emberline'));
    execFileSync('ln', ['-s', '/etc/passwd', path.join(project.path, YML)]);
    execFileSync('git', ['-C', project.path, 'add', YML]);
    execFileSync('git', ['-C', project.path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'link']);
    const s = await status(project.id);
    expect(s).toMatchObject({ head: null, changed: false });
    expect(s.errors.join()).toContain('symbolic link');
  });

  it('answers 404 for an unknown project and 400 for a bad body', async () => {
    expect((await api('GET', '/api/projects/nope/worktree-config')).statusCode).toBe(404);
    const project = await createProject(setupYml('true'));
    expect((await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: 'x' })).statusCode).toBe(400);
  });
});

describe('run worktree lifecycle', () => {
  it('copies (default) and links entries from the main workspace before the run starts', async () => {
    const project = await createProject('version: 1\ncopy:\n  - .env\n  - { path: .env.local, mode: symlink }\n  - missing.txt\n');
    writeFileSync(path.join(project.path, '.env'), 'A=1\n');
    writeFileSync(path.join(project.path, '.env.local'), 'B=2\n');
    await approveHead(project.id);
    const run = await startRun(project.id);
    expect(readFileSync(path.join(run.worktreePath, '.env'), 'utf8')).toBe('A=1\n');
    expect(lstatSync(path.join(run.worktreePath, '.env')).isSymbolicLink()).toBe(false);
    expect(readlinkSync(path.join(run.worktreePath, '.env.local'))).toBe(path.join(project.path, '.env.local'));
    expect(await payloadOf(run.id, 'worktree_copied')).toMatchObject({
      entries: [
        { path: '.env', status: 'copied' },
        { path: '.env.local', status: 'linked' },
        { path: 'missing.txt', status: 'skipped', reason: 'missing in the main workspace' },
      ],
    });
  });

  it('runs setup in order in the worktree, with started and finished events', async () => {
    const project = await createProject('version: 1\nsetup:\n  - echo one >> order\n  - echo two >> order\n');
    await approveHead(project.id);
    const run = await startRun(project.id, 'build it');
    expect(readFileSync(path.join(run.worktreePath, 'order'), 'utf8')).toBe('one\ntwo\n');
    const types = await typesOf(run.id);
    expect(types.indexOf('worktree_setup_started')).toBeGreaterThan(-1);
    expect(types.indexOf('worktree_setup_finished')).toBeGreaterThan(types.indexOf('worktree_setup_started'));
    expect(types.indexOf('spawned')).toBeGreaterThan(types.indexOf('worktree_setup_finished'));
    expect(types).not.toContain('worktree_setup_failed');
    expect(await promptOf(run.id)).toBe('build it');
  });

  it('a failed setup still starts the run, and its first prompt says what failed', async () => {
    const project = await createProject(
      'version: 1\nsetup:\n  - echo first >> order\n  - "echo broken install >&2; exit 7"\n  - echo never >> order\n',
    );
    await approveHead(project.id);
    const run = await startRun(project.id, 'build it');
    expect(readFileSync(path.join(run.worktreePath, 'order'), 'utf8')).toBe('first\n');
    expect(await payloadOf(run.id, 'worktree_setup_failed')).toEqual({
      command: 'echo broken install >&2; exit 7',
      exitCode: 7,
      tail: 'broken install',
    });
    expect(await typesOf(run.id)).not.toContain('worktree_setup_finished');
    expect(await promptOf(run.id)).toBe(
      'Worktree setup failed: `echo broken install >&2; exit 7` (exit 7)\n```\nbroken install\n```\nFix it as part of this ticket.\n\nbuild it',
    );
    expect(t.runs.getRun(run.id).terminalId).not.toBeNull();
  });

  it('does nothing for a run in place (no git) or a run that shares an existing worktree', async () => {
    const { project } = (await api('POST', '/api/projects', { name: 'Plain', initGit: false })).json();
    t.db
      .insert(projectWorktreeConfig)
      .values({ projectId: project.id, content: setupYml('echo x > setup-ran'), sha256: 'x', approvedAt: new Date(), approvedBy: 'wizard' })
      .run();
    const run = await startRun(project.id);
    expect(run.worktreePath).toBe(project.path);
    expect(existsSync(path.join(project.path, 'setup-ran'))).toBe(false);

    const gitProject = await createProject(setupYml('echo x >> setup-ran'), 'Shared');
    await approveHead(gitProject.id);
    const first = await startRun(gitProject.id);
    const shared = await t.runs.enqueue(
      { projectId: gitProject.id, prompt: 'more' },
      { worktree: { path: first.worktreePath, branch: first.branch } },
    );
    expect(await typesOf(shared.id)).not.toContain('worktree_setup_pending');
    expect(readFileSync(path.join(first.worktreePath, 'setup-ran'), 'utf8')).toBe('x\n');
  });

  describe('setup and the starting watchdog (Review Focus 3)', () => {
    /** Holds every setup command until `release()`; everything else (git) runs normally. */
    function holdSetup() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const executor: CommandExecutor = async (request) => {
        if (request.file === 'sh' && request.args[1]?.includes('slow-setup')) {
          started++;
          await gate;
        }
        return localCommandExecutor(request);
      };
      setCommandExecutor(executor);
      return { release, started: () => started };
    }

    it('a setup longer than the watchdog does not fail the run; the run stays starting', async () => {
      const held = holdSetup();
      const project = await createProject(setupYml('echo slow-setup > setup-ran'));
      await approveHead(project.id);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'x' })).json();
      await expect.poll(() => held.started()).toBe(1);
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'starting', terminalId: null });

      // 10 minutes later (the watchdog fails a terminal-less `starting` run after 3).
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'starting', terminalId: null });
      expect(await typesOf(run.id)).not.toContain('spawn_lost');

      held.release();
      await expect.poll(() => t.runs.getRun(run.id).terminalId, { timeout: 8_000 }).not.toBeNull();
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).state).toBe('starting');
      expect(await typesOf(run.id)).not.toContain('spawn_lost');
      expect(existsSync(path.join(run.worktreePath, 'setup-ran'))).toBe(true);
    });

    it('the watchdog still fails a stuck spawn that is not in setup', async () => {
      const project = await createProject(setupYml('true'));
      const queued = await t.runs.enqueue({ projectId: project.id, prompt: 'x' });
      t.db
        .update(runs)
        .set({ state: 'starting', stateChangedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(runs.id, queued.id))
        .run();
      await t.runs.reconcile();
      expect(await typesOf(queued.id)).toContain('spawn_lost');
    });

    it('a stop during setup ends the run without starting the agent', async () => {
      const held = holdSetup();
      const project = await createProject(setupYml('echo slow-setup > setup-ran'));
      await approveHead(project.id);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'x' })).json();
      await expect.poll(() => held.started()).toBe(1);
      expect((await api('POST', `/api/runs/${run.id}/resume`, {})).statusCode).toBe(409);
      await api('POST', `/api/runs/${run.id}/stop`, {});
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'failed' });
      held.release();
      await expect.poll(() => existsSync(path.join(run.worktreePath, 'setup-ran'))).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'failed', terminalId: null });
      expect(existsSync(path.join(t.dir, `token-${run.id}`))).toBe(false);
    });
  });
});

describe('teardown before prune', () => {
  const teardownYml = (log: string) =>
    `version: 1\nteardown:\n  - ${JSON.stringify(`echo first >> ${log}; exit 3`)}\n  - ${JSON.stringify(`echo second >> ${log}`)}\n`;

  async function endedRun(projectId: string): Promise<Run> {
    const run = await t.runs.enqueue({ projectId, prompt: 'x' });
    await t.runs.stop(run.id);
    return t.runs.getRun(run.id);
  }

  it('runs teardown on a per-run prune; its failure never blocks the prune', async () => {
    const log = path.join(t.dir, 'teardown.log');
    const project = await createProject(teardownYml(log));
    await approveHead(project.id);
    const run = await endedRun(project.id);
    const res = await api('POST', `/api/runs/${run.id}/worktree/prune`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: true });
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('first\nsecond\n');
    expect(await payloadOf(run.id, 'worktree_teardown_failed')).toMatchObject({ command: `echo first >> ${log}; exit 3`, exitCode: 3 });
    const types = await typesOf(run.id);
    expect(types.indexOf('worktree_pruned')).toBeGreaterThan(types.indexOf('worktree_teardown_failed'));
  });

  it('runs teardown on a manual GC prune', async () => {
    const log = path.join(t.dir, 'teardown.log');
    const project = await createProject(teardownYml(log));
    await approveHead(project.id);
    const run = await endedRun(project.id);
    const res = await api('POST', '/api/runs/gc', { projectId: project.id, keepRecent: 0, includeFailed: true, pruneWorktrees: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ prunedWorktrees: 1 });
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('first\nsecond\n');
  });

  it('runs teardown on an auto-GC prune', async () => {
    const log = path.join(t.dir, 'teardown.log');
    const project = await createProject(`version: 1\nteardown:\n  - ${JSON.stringify(`basename "$PWD" >> ${log}`)}\n`);
    await approveHead(project.id);
    const ended: Run[] = [];
    for (let i = 0; i < 11; i++) ended.push(await endedRun(project.id));
    // Reconcile only looks further while some run is open.
    await t.runs.enqueue({ projectId: project.id, prompt: 'open' });
    await t.runs.reconcile();
    const oldest = ended[0]!;
    expect(existsSync(oldest.worktreePath)).toBe(false);
    expect(readFileSync(log, 'utf8').trim()).toBe(path.basename(oldest.worktreePath));
  });
});

describe('services and checks', () => {
  it('a preview starts the approved preview service with PORT from the allocator', async () => {
    const out = path.join(t.dir, 'preview-port');
    const cmd = `echo "port=$PORT" > ${out}; sleep 30`;
    const project = await createProject(
      `version: 1\nservices:\n  - name: api\n    command: sleep 30\n  - name: web\n    command: ${JSON.stringify(cmd)}\n    preview: true\n`,
    );
    writeFileSync(path.join(project.path, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    await approveHead(project.id);
    const run = await t.runs.enqueue({ projectId: project.id, prompt: 'x' });
    expect((await api('GET', `/api/runs/${run.id}/preview`)).json()).toMatchObject({ detectedCommand: cmd });
    const res = await api('POST', `/api/runs/${run.id}/preview/start`, {});
    expect(res.statusCode).toBe(200);
    const preview = res.json() as { command: string; port: number };
    expect(preview.command).toBe(cmd);
    expect(preview.port).toBeGreaterThanOrEqual(3100);
    expect((await waitFile(out)).trim()).toBe(`port=${preview.port}`);
    await api('POST', `/api/runs/${run.id}/preview/stop`, {});
  });

  it('without a preview service, detection applies as before', async () => {
    const project = await createProject('version: 1\nservices:\n  - name: api\n    command: sleep 30\n');
    await approveHead(project.id);
    const run = await t.runs.enqueue({ projectId: project.id, prompt: 'x' });
    writeFileSync(path.join(run.worktreePath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect((await api('GET', `/api/runs/${run.id}/preview`)).json()).toMatchObject({ detectedCommand: 'npm run dev' });
  });

  it('the build gate runs the approved checks in order build, lint, test — even without a detected target', async () => {
    const log = path.join(t.dir, 'checks.log');
    const project = await createProject(
      [
        'version: 1',
        'checks:',
        `  test: ${JSON.stringify(`echo test >> ${log}`)}`,
        `  lint: ${JSON.stringify(`echo lint >> ${log}`)}`,
        `  build: ${JSON.stringify(`echo build >> ${log}`)}`,
        '',
      ].join('\n'),
    );
    await approveHead(project.id);
    const ticket: Ticket = (await api('POST', `/api/projects/${project.id}/tickets`, { title: 'A', status: 'ready' })).json();
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = t.runs.list().find((r) => r.ticketId === ticket.id) as Run;
    const token = await waitFile(path.join(t.dir, `token-${run.id}`));
    await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
    await hook(run.id, 'UserPromptSubmit', token);
    const headers = { authorization: `Bearer ${token}` };
    await t.app.inject({ method: 'POST', url: `/api/internal/runs/${run.id}/completion-tool`, headers });
    await t.app.inject({ method: 'POST', url: `/api/internal/runs/${run.id}/complete`, headers, payload: { summary: 'done' } });
    await hook(run.id, 'Stop', token);
    await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 10_000 }).toBe('build\nlint\ntest\n');
  });
});
