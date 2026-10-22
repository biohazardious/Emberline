import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run, RunBuildOutputsResponse, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { projects, runEvents, runs } from './db/schema.js';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { worktreeHeadSha } from './runs/git.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp, wsProtocols } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/**
 * Stand-in for the Claude CLI: leaks its hook token to a file (so the test can act as
 * emberline-hook), then waits for one line and exits 3 on "fail", 0 otherwise.
 */
function writeFakeClaude(dir: string): string {
  const file = path.join(dir, 'fake-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      // Written whole and then renamed: the test reads the file as soon as it exists.
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      'read line',
      '[ "$line" = "fail" ] && exit 3',
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
  await ptydServer.close();
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

const hook = (runId: string, event: string, token: string | undefined, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

async function createProject(name: string, withGit: boolean) {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  if (withGit) {
    const run = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
    run('init', '-q', '-b', 'main');
    run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  return project as { id: string; path: string };
}

async function tokenFor(runId: string): Promise<string> {
  const file = path.join(t.dir, `token-${runId}`);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

describe('run event pruning', () => {
  const seed = (runId: string, type: string, n: number) =>
    t.db
      .insert(runEvents)
      .values(Array.from({ length: n }, () => ({ runId, ts: new Date(), source: 'hook', type })))
      .run();
  const typesOf = (runId: string) =>
    t.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.id)
      .all()
      .map((e) => e.type);

  it('keeps the newest 5000 events of a run and never the protected kinds', async () => {
    const project = await createProject('Prune', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const other: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    t.db.delete(runEvents).where(eq(runEvents.runId, run.id)).run();
    seed(run.id, 'last_screen', 1);
    seed(run.id, 'auto_nudged', 1);
    seed(run.id, 'PreToolUse', 5100);
    seed(other.id, 'PreToolUse', 10);

    t.runs.pruneRunEvents();

    const kept = typesOf(run.id);
    expect(kept.filter((x) => x === 'PreToolUse')).toHaveLength(5000);
    expect(kept).toContain('last_screen');
    expect(kept).toContain('auto_nudged');
    expect(kept).toHaveLength(5002);
    expect(typesOf(other.id).filter((x) => x === 'PreToolUse')).toHaveLength(10);
  });

  it('keeps the worktree copy notes the first prompt reads', async () => {
    const project = await createProject('Prune Copy', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    t.db.delete(runEvents).where(eq(runEvents.runId, run.id)).run();
    seed(run.id, 'worktree_copied', 1);
    seed(run.id, 'worktree_copy_skipped', 1);
    seed(run.id, 'PreToolUse', 5100);
    t.runs.pruneRunEvents();
    expect(typesOf(run.id)).toEqual(expect.arrayContaining(['worktree_copied', 'worktree_copy_skipped']));
  });

  it('keeps the respawn note that marks a one-shot CLI session', async () => {
    const project = await createProject('Prune Respawn', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    t.db.delete(runEvents).where(eq(runEvents.runId, run.id)).run();
    seed(run.id, 'respawning', 1);
    seed(run.id, 'PreToolUse', 5100);
    t.runs.pruneRunEvents();
    expect(typesOf(run.id)).toContain('respawning');
  });

  it('keeps preview status and the fact that a long run worked', async () => {
    const project = await createProject('Prune3', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    t.db.delete(runEvents).where(eq(runEvents.runId, run.id)).run();
    const row = (type: string, state?: string) => ({
      runId: run.id,
      ts: new Date(),
      source: 'hook',
      type,
      ...(state ? { state } : {}),
    });
    t.db
      .insert(runEvents)
      .values([
        row('UserPromptSubmit', 'working'),
        row('preview_stopped'),
        row('preview_started'),
        row('preview_ready'),
        row('preview_failed'),
      ])
      .run();
    seed(run.id, 'PreToolUse', 5100);
    t.db.insert(runEvents).values(row('Failed', 'failed')).run();

    t.runs.pruneRunEvents();

    const kept = t.db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(runEvents.id).all();
    expect(kept.map((e) => e.type).slice(0, 5)).toEqual([
      'UserPromptSubmit',
      'preview_stopped',
      'preview_started',
      'preview_ready',
      'preview_failed',
    ]);
    expect(kept.some((e) => e.state === 'working')).toBe(true);
  });

  it('reconcile prunes on its own schedule', async () => {
    const project = await createProject('Prune2', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    seed(run.id, 'PreToolUse', 5100);
    (t.runs as unknown as { lastEventPruneAt: number }).lastEventPruneAt = 0;
    await t.runs.reconcile();
    expect(typesOf(run.id).length).toBeLessThanOrEqual(5001);
  });
});

describe('runs', () => {
  it('starts the agent in a fresh worktree on its own branch', async () => {
    const project = await createProject('Repo App', true);
    const res = await api('POST', '/api/runs', { projectId: project.id, prompt: 'hello' });
    expect(res.statusCode).toBe(201);
    const run: Run = res.json();

    expect(run.state).toBe('starting');
    expect(run.branch).toMatch(/^emberline\/run-[0-9a-f]{8}$/);
    expect(run.worktreePath).toBe(
      path.join(t.config.workspacesDir, '.worktrees', 'repo-app', run.id.slice(0, 8)),
    );
    expect(existsSync(path.join(run.worktreePath, '.git'))).toBe(true);
    expect(run.terminalId).toBeTruthy();

    const terminals = (await api('GET', '/api/terminals')).json();
    expect(terminals).toContainEqual(
      expect.objectContaining({ id: run.terminalId, kind: 'agent', runId: run.id }),
    );
  });

  it('runs in place for projects that are not git repositories', async () => {
    const project = await createProject('Plain Dir', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    expect(run.branch).toBeNull();
    expect(run.worktreePath).toBe(project.path);
  });

  it('derives state from hooks authenticated by the per-run token', async () => {
    const project = await createProject('Hooks', true);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);

    expect((await hook(run.id, 'SessionStart', undefined)).statusCode).toBe(401);
    expect((await hook(run.id, 'SessionStart', 'wrong')).statusCode).toBe(401);
    expect((await hook('no-such-run', 'SessionStart', token)).statusCode).toBe(401);

    const steps: [string, object, string][] = [
      ['SessionStart', { session_id: 'sess-1', source: 'startup' }, 'waiting_input'],
      ['UserPromptSubmit', { prompt: 'do it' }, 'working'],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x'.repeat(10_000) } }, 'working'],
      [
        'Notification',
        { notification_type: 'permission_prompt', message: 'needs permission' },
        'waiting_input',
      ],
      ['PostToolUse', { tool_name: 'Bash' }, 'working'],
      ['Stop', {}, 'done'],
    ];
    for (const [event, payload, expected] of steps) {
      const res = await hook(run.id, event, token, payload);
      expect(res.statusCode, event).toBe(200);
      expect(res.json().state, event).toBe(expected);
    }

    const detail: RunDetail = (await api('GET', `/api/runs/${run.id}`)).json();
    expect(detail).toMatchObject({ state: 'done', agentSessionId: 'sess-1', lastEvent: 'Stop' });
    const pre = detail.events.find((e) => e.type === 'PreToolUse');
    expect(pre?.payload).toEqual({ tool_name: 'Bash' }); // tool input is not stored
    expect(detail.events.filter((e) => e.state).map((e) => e.state)).toEqual([
      'starting',
      'waiting_input',
      'working',
      'waiting_input',
      'working',
      'done',
    ]);
  });

  it('records process exit: clean exit is done, non-zero is failed', async () => {
    const project = await createProject('Exit', false);
    const ok: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const bad: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const okToken = await tokenFor(ok.id);
    await tokenFor(bad.id);

    const ptyd = t.ptyd.get();
    await ptyd.write(ok.terminalId ?? '', 'bye\r');
    await ptyd.write(bad.terminalId ?? '', 'fail\r');

    const stateOf = async (id: string) => {
      await t.runs.reconcile();
      return ((await api('GET', `/api/runs/${id}`)).json() as Run).state;
    };
    await expect.poll(() => stateOf(ok.id), { timeout: 5_000 }).toBe('done');
    await expect.poll(() => stateOf(bad.id), { timeout: 5_000 }).toBe('failed');
    expect(((await api('GET', `/api/runs/${bad.id}`)).json() as Run).endedAt).not.toBeNull();
    // A hook that arrives after the process ended does not flip the finished run back to working.
    expect((await hook(ok.id, 'UserPromptSubmit', okToken)).json()).toMatchObject({ state: 'done' });
  });

  it('stops and removes runs', async () => {
    const project = await createProject('Stop', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(run.id);

    expect((await api('POST', `/api/runs/${run.id}/stop`)).statusCode).toBe(200);
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return ((await api('GET', `/api/runs/${run.id}`)).json() as Run).endedAt;
        },
        { timeout: 5_000 },
      )
      .not.toBeNull();

    expect((await api('DELETE', `/api/runs/${run.id}`)).statusCode).toBe(200);
    expect((await api('GET', '/api/runs')).json()).toHaveLength(0);
    expect((await api('GET', '/api/terminals')).json()).toHaveLength(0);
  });

  it('a stop is final: late hooks do not revive the run and it cannot be resumed', async () => {
    const project = await createProject('Final stop', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'SessionStart', token, { session_id: 'sess-final' });
    await hook(run.id, 'UserPromptSubmit', token);

    await api('POST', `/api/runs/${run.id}/stop`);
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return ((await api('GET', `/api/runs/${run.id}`)).json() as Run).endedAt;
        },
        { timeout: 5_000 },
      )
      .not.toBeNull();
    for (const event of ['Stop', 'SessionEnd', 'UserPromptSubmit']) await hook(run.id, event, token);

    const after = (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;
    expect(after).toMatchObject({ state: 'failed', resumable: false, cancelled: true });
    expect(after.events.map((e) => e.type)).toContain('cancelled');
    expect((await api('POST', `/api/runs/${run.id}/prompt`, { text: 'more' })).statusCode).toBe(409);
  });

  it('honours a stop that arrives while the terminal is being spawned', async () => {
    const project = await createProject('Spawn window', false);
    const queued = await t.runs.enqueue({ projectId: project.id, prompt: 'x' });
    const launching = t.runs.launch(queued.id);
    // launch() marks the run `starting` synchronously; the terminal does not exist yet.
    expect(t.runs.getRun(queued.id)).toMatchObject({ state: 'starting', terminalId: null });
    await t.runs.stop(queued.id);
    await launching;
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return t.runs.getRun(queued.id).state;
        },
        { timeout: 5_000 },
      )
      .toBe('failed');
    expect((await api('GET', '/api/terminals')).json()).toHaveLength(0);
  });

  it('fails runs stuck in starting without a terminal (watchdog)', async () => {
    const project = await createProject('Stuck', false);
    const queued = await t.runs.enqueue({ projectId: project.id, prompt: 'x' });
    t.db
      .update(runs)
      .set({ state: 'starting', stateChangedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(runs.id, queued.id))
      .run();
    await t.runs.reconcile();
    const after = t.runs.get(queued.id);
    expect(after).toMatchObject({ state: 'failed' });
    expect(after.endedAt).not.toBeNull();
    expect(after.events.map((e) => e.type)).toContain('spawn_lost');
  });

  it('ignores hook transcript paths outside the transcripts directory (S9)', async () => {
    const project = await createProject('Transcript', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'SessionStart', token, { session_id: 's', transcript_path: '/dev/zero' });
    expect(t.db.select().from(runs).where(eq(runs.id, run.id)).get()?.transcriptPath).toBeNull();
    const good = path.join(t.config.transcriptsDir, 'proj', 'run.jsonl');
    await hook(run.id, 'UserPromptSubmit', token, { transcript_path: good });
    expect(t.db.select().from(runs).where(eq(runs.id, run.id)).get()?.transcriptPath).toBe(good);
  });

  it('garbage collection keeps dirty worktrees and runs of tickets still under review', async () => {
    const project = await createProject('GC', true);
    const finish = async () => {
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(run.id);
      await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return t.runs.getRun(run.id).endedAt;
          },
          { timeout: 5_000 },
        )
        .not.toBeNull();
      return t.runs.getRun(run.id);
    };
    const clean = await finish();
    const dirty = await finish();
    const inReview = await finish();
    writeFileSync(path.join(dirty.worktreePath, 'unsaved.txt'), 'work in progress\n');
    const ticket = t.tickets.create(project.id, { title: 'Needs review', status: 'review' });
    t.db.update(runs).set({ ticketId: ticket.id }).where(eq(runs.id, inReview.id)).run();

    const res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
    expect(res.removedRuns).toBe(1);
    expect(existsSync(clean.worktreePath)).toBe(false);
    expect(readFileSync(path.join(dirty.worktreePath, 'unsaved.txt'), 'utf8')).toContain('work in progress');
    expect(existsSync(inReview.worktreePath)).toBe(true);
    expect(
      t.runs
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual([dirty.id, inReview.id].sort());
  });

  describe('garbage collection and shared worktrees', () => {
    const finishRun = async (projectId: string) => {
      const run: Run = (await api('POST', '/api/runs', { projectId })).json();
      await tokenFor(run.id);
      await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return t.runs.getRun(run.id).endedAt;
          },
          { timeout: 5_000 },
        )
        .not.toBeNull();
      return t.runs.getRun(run.id);
    };

    it('manual GC removes the predecessor row but keeps the worktree its successor still uses', async () => {
      const project = await createProject('GC shared', true);
      const predecessor = await finishRun(project.id);
      const lone = await finishRun(project.id);
      const successor: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(successor.id);
      // The still-active successor took over the predecessor's worktree (a handoff).
      t.db
        .update(runs)
        .set({ worktreePath: predecessor.worktreePath })
        .where(eq(runs.id, successor.id))
        .run();

      const res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0, pruneWorktrees: true });
      expect(res.removedRuns).toBe(2);
      const ids = t.runs.list().map((r) => r.id);
      expect(ids).toEqual([successor.id]);
      expect(existsSync(predecessor.worktreePath)).toBe(true);
      // An unshared worktree is pruned, so the guard is what kept the shared one.
      expect(existsSync(lone.worktreePath)).toBe(false);
    });

    it('auto-GC in reconcile removes the stale predecessor row but keeps a shared worktree', async () => {
      const project = await createProject('Auto GC', true);
      const lone = await finishRun(project.id);
      const predecessor = await finishRun(project.id);
      const successor = await finishRun(project.id);
      t.db
        .update(runs)
        .set({ worktreePath: predecessor.worktreePath })
        .where(eq(runs.id, successor.id))
        .run();
      t.db
        .update(runs)
        .set({ createdAt: new Date(1_000) })
        .where(eq(runs.id, lone.id))
        .run();
      t.db
        .update(runs)
        .set({ createdAt: new Date(2_000) })
        .where(eq(runs.id, predecessor.id))
        .run();
      t.db
        .update(runs)
        .set({ createdAt: new Date(5_000) })
        .where(eq(runs.id, successor.id))
        .run();
      // Nine newer finished rows plus the successor fill the ten kept slots.
      for (let i = 0; i < 9; i += 1) {
        t.db
          .insert(runs)
          .values({
            id: `synthetic-${i}`,
            projectId: project.id,
            agent: 'claude',
            state: 'done',
            worktreePath: project.path,
            hookTokenHash: 'x',
            stateChangedAt: new Date(10_000 + i),
            createdAt: new Date(10_000 + i),
            endedAt: new Date(10_000 + i),
          })
          .run();
      }
      // reconcile only reaches auto-GC while some run is still open; keep one alive.
      const live: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(live.id);
      // Elapse the interval gate (earlier reconciles already used it).
      (t.runs as unknown as { lastAutoGcAt: number }).lastAutoGcAt = 0;

      await t.runs.reconcile();
      const ids = t.runs.list().map((r) => r.id);
      expect(ids).not.toContain(lone.id);
      expect(ids).not.toContain(predecessor.id);
      expect(ids).toContain(successor.id);
      expect(existsSync(lone.worktreePath)).toBe(false);
      expect(existsSync(predecessor.worktreePath)).toBe(true);
    });
  });

  describe('garbage collection keeps unmerged work', () => {
    const finishRun = async (projectId: string) => {
      const run: Run = (await api('POST', '/api/runs', { projectId })).json();
      await tokenFor(run.id);
      await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return t.runs.getRun(run.id).endedAt;
          },
          { timeout: 5_000 },
        )
        .not.toBeNull();
      return t.runs.getRun(run.id);
    };
    const commitIn = (dir: string) =>
      execFileSync('git', [
        '-C',
        dir,
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'agent work',
      ]);

    it('manual GC keeps a worktree whose branch has commits outside the default branch, until it is merged', async () => {
      const project = await createProject('GC unmerged', true);
      const run = await finishRun(project.id);
      commitIn(run.worktreePath);

      const first = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(first.removedRuns).toBe(0);
      expect(first.keptWorktrees).toEqual([{ runId: run.id, reason: 'unmerged_commits' }]);
      expect(existsSync(run.worktreePath)).toBe(true);

      execFileSync('git', [
        '-C',
        project.path,
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'merge',
        '-q',
        '--no-ff',
        '-m',
        'merge',
        run.branch ?? '',
      ]);
      const second = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(second.removedRuns).toBe(1);
      expect(second.keptWorktrees).toEqual([]);
      expect(existsSync(run.worktreePath)).toBe(false);
    });

    it('measures "merged" against the branch the project has checked out, not the default-branch column', async () => {
      const project = await createProject('GC master', true);
      execFileSync('git', ['-C', project.path, 'branch', '-m', 'main', 'master']);
      const run = await finishRun(project.id);
      commitIn(run.worktreePath);
      const kept = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(kept.keptWorktrees).toEqual([{ runId: run.id, reason: 'unmerged_commits' }]);
      execFileSync('git', [
        '-C',
        project.path,
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'merge',
        '-q',
        '--no-ff',
        '-m',
        'merge',
        run.branch ?? '',
      ]);
      const done = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(done.removedRuns).toBe(1);
      expect(existsSync(run.worktreePath)).toBe(false);
    });

    it('reports uncommitted changes and a missing default branch as kept', async () => {
      const project = await createProject('GC kept reasons', true);
      const dirty = await finishRun(project.id);
      writeFileSync(path.join(dirty.worktreePath, 'unsaved.txt'), 'wip\n');
      const res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(res.keptWorktrees).toEqual([{ runId: dirty.id, reason: 'uncommitted_changes' }]);

      // A branch git cannot resolve (detached checkout, bogus fallback column) means "cannot prove it is merged": keep.
      const clean = await finishRun(project.id);
      execFileSync('git', ['-C', project.path, 'checkout', '-q', '--detach']);
      t.db.update(projects).set({ defaultBranch: 'no-such-branch' }).where(eq(projects.id, project.id)).run();
      const res2 = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(res2.keptWorktrees).toContainEqual({ runId: clean.id, reason: 'unmerged_commits' });
      expect(existsSync(clean.worktreePath)).toBe(true);
    });

    it('reports a worktree shared by a handoff predecessor and successor once, as the newest run', async () => {
      const project = await createProject('GC handoff kept', true);
      const predecessor = await finishRun(project.id);
      const successor = await finishRun(project.id);
      t.db
        .update(runs)
        .set({ worktreePath: predecessor.worktreePath })
        .where(eq(runs.id, successor.id))
        .run();
      t.db
        .update(runs)
        .set({ createdAt: new Date(1_000) })
        .where(eq(runs.id, predecessor.id))
        .run();
      t.db
        .update(runs)
        .set({ createdAt: new Date(2_000) })
        .where(eq(runs.id, successor.id))
        .run();
      commitIn(predecessor.worktreePath);
      const res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0 });
      expect(res.keptWorktrees).toEqual([{ runId: successor.id, reason: 'unmerged_commits' }]);
    });

    it('auto-GC re-checks a kept worktree at most every 10 minutes while its HEAD is unchanged', async () => {
      const project = await createProject('Auto GC cache', true);
      const stale = await finishRun(project.id);
      commitIn(stale.worktreePath);
      t.db
        .update(runs)
        .set({ createdAt: new Date(1_000) })
        .where(eq(runs.id, stale.id))
        .run();
      for (let i = 0; i < 10; i += 1) {
        t.db
          .insert(runs)
          .values({
            id: `synthetic-${i}`,
            projectId: project.id,
            agent: 'claude',
            state: 'done',
            worktreePath: project.path,
            hookTokenHash: 'x',
            stateChangedAt: new Date(10_000 + i),
            createdAt: new Date(10_000 + i),
            endedAt: new Date(10_000 + i),
          })
          .run();
      }
      const live: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(live.id);
      const autoGc = async () => {
        (t.runs as unknown as { lastAutoGcAt: number }).lastAutoGcAt = 0;
        await t.runs.reconcile();
        return t.runs.list().map((r) => r.id);
      };
      // HEAD is read from git's files, without spawning git.
      expect(await worktreeHeadSha(stale.worktreePath, project.path)).toBe(
        execFileSync('git', ['-C', stale.worktreePath, 'rev-parse', 'HEAD']).toString().trim(),
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        expect(await autoGc()).toContain(stale.id);
        // Merged meanwhile: the cached verdict stands until the re-check is due.
        execFileSync('git', [
          '-C',
          project.path,
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          'merge',
          '-q',
          '--no-ff',
          '-m',
          'merge',
          stale.branch ?? '',
        ]);
        vi.setSystemTime(Date.now() + 5 * 60_000);
        expect(await autoGc()).toContain(stale.id);
        vi.setSystemTime(Date.now() + 6 * 60_000);
        expect(await autoGc()).not.toContain(stale.id);
        expect(existsSync(stale.worktreePath)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('auto-GC keeps a stale worktree with unmerged commits', async () => {
      const project = await createProject('Auto GC unmerged', true);
      const stale = await finishRun(project.id);
      commitIn(stale.worktreePath);
      t.db
        .update(runs)
        .set({ createdAt: new Date(1_000) })
        .where(eq(runs.id, stale.id))
        .run();
      for (let i = 0; i < 10; i += 1) {
        t.db
          .insert(runs)
          .values({
            id: `synthetic-${i}`,
            projectId: project.id,
            agent: 'claude',
            state: 'done',
            worktreePath: project.path,
            hookTokenHash: 'x',
            stateChangedAt: new Date(10_000 + i),
            createdAt: new Date(10_000 + i),
            endedAt: new Date(10_000 + i),
          })
          .run();
      }
      const live: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(live.id);
      (t.runs as unknown as { lastAutoGcAt: number }).lastAutoGcAt = 0;
      await t.runs.reconcile();
      expect(t.runs.list().map((r) => r.id)).toContain(stale.id);
      expect(existsSync(stale.worktreePath)).toBe(true);
    });
  });

  it('keeps a finished run done when a follow-up cannot resume it (B19)', async () => {
    const project = await createProject('No session', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'UserPromptSubmit', token);
    await hook(run.id, 'Stop', token);
    await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
    await expect
      .poll(async () => {
        await t.runs.reconcile();
        return t.runs.getRun(run.id).endedAt;
      })
      .not.toBeNull();
    // No SessionStart hook ever carried a session id, like secondary CLIs.
    expect(t.runs.getRun(run.id).agentSessionId).toBeNull();
    expect((await api('POST', `/api/runs/${run.id}/resume`, { text: 'more' })).statusCode).toBe(409);
    expect(t.runs.getRun(run.id).state).toBe('done');
  });

  it('gives concurrent previews distinct ports and stops them with their run (B16)', async () => {
    const project = await createProject('Previews', true);
    const a: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const b: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const start = async (run: Run, port?: number) =>
      (
        await api('POST', `/api/runs/${run.id}/preview/start`, {
          command: 'sleep 30',
          ...(port ? { port } : {}),
        })
      ).json();
    // Occupy exactly the port b hashes to, so the allocator has to move b.
    let hash = 0;
    for (const ch of b.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const { first, last } = t.config.previewPorts.runner;
    const pa = await start(a, first + (hash % (last - first + 1)));
    const pb = await start(b);
    expect(pb.port).not.toBe(pa.port);
    expect(
      (await api('GET', '/api/terminals')).json().some((x: { id: string }) => x.id === pa.terminalId),
    ).toBe(true);

    await t.runs.stop(a.id);
    await api('DELETE', `/api/runs/${a.id}`);
    const terminals = (await api('GET', '/api/terminals')).json() as { id: string }[];
    expect(terminals.some((x) => x.id === pa.terminalId)).toBe(false);
    expect(terminals.some((x) => x.id === pb.terminalId)).toBe(true);
  });

  it("a running command preview reports its framing, probed on the runner's localhost", async () => {
    const probes: string[] = [];
    setCommandExecutor(async (request: ExecRequest) => {
      if (request.file === 'curl' && request.args.includes('-D')) {
        probes.push(request.args.at(-1) ?? '');
        return {
          exitCode: 0,
          signal: null,
          stdout: 'HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\n\r\n',
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      }
      return localCommandExecutor(request);
    });
    try {
      const project = await createProject('Framing', true);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      const started = (
        await api('POST', `/api/runs/${run.id}/preview/start`, { command: 'sleep 30' })
      ).json();
      expect(started.status).toBe('running');
      const status = (await api('GET', `/api/runs/${run.id}/preview`)).json();
      expect(status.framing).toEqual({ state: 'refused', reason: 'X-Frame-Options: DENY' });
      expect(probes).toEqual([`http://localhost:${started.port}/`]);
      await api('POST', `/api/runs/${run.id}/preview/stop`);
      expect((await api('GET', `/api/runs/${run.id}/preview`)).json().framing).toBeUndefined();
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
  });

  it('serves the terminal as plain text for fleet thumbnails', async () => {
    const project = await createProject('Thumb', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(run.id);
    await expect
      .poll(
        async () =>
          (await api('GET', `/api/runs/${run.id}/screen-text?lines=5`)).json().text as string | null,
      )
      .toContain('fake claude ready');
    const text = (await api('GET', `/api/runs/${run.id}/screen-text`)).json().text as string;
    expect(text).not.toContain(String.fromCharCode(27));
  });

  it('pushes run updates over /api/events', async () => {
    const project = await createProject('Events', false);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), {
      headers: { cookie, origin: address },
    });
    const events: { type: string; run?: Run }[] = [];
    ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'UserPromptSubmit', token);

    await expect
      .poll(() => events.some((e) => e.type === 'run' && e.run?.id === run.id && e.run.state === 'working'))
      .toBe(true);
    ws.close();
  });

  it('sends run updates over /api/events with their computed attention', async () => {
    const project = await createProject('Events attention', false);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), {
      headers: { cookie, origin: address },
    });
    const events: { type: string; run?: Run }[] = [];
    ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'UserPromptSubmit', token);
    await hook(run.id, 'Notification', token, {
      notification_type: 'permission_prompt',
      message: 'Allow rm?',
    });
    await expect
      .poll(
        () =>
          events.find((e) => e.type === 'run' && e.run?.id === run.id && e.run.state === 'waiting_input')?.run
            ?.attention,
      )
      .toMatchObject({ reason: 'permission', detail: 'Allow rm?' });
    expect(t.runs.getRun(run.id).attention?.reason).toBe('permission');
    ws.close();
  });

  it('rejects runs for unknown projects', async () => {
    expect((await api('POST', '/api/runs', { projectId: 'nope' })).statusCode).toBe(404);
  });

  it('keeps the final answer in full and recovers truncated ones from the transcript', async () => {
    const project = await createProject('Final answer', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    const answer = `Done. ${'All the details. '.repeat(200)}`.trim();
    await hook(run.id, 'Stop', token, { last_assistant_message: answer });
    expect(((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).finalMessage).toBe(answer);

    // A run recorded before the limits were raised has a clipped copy; the transcript has the rest.
    const transcript = path.join(t.config.transcriptsDir, 'proj', `${run.id}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    const full = `The whole answer ${'with every path and number '.repeat(40)}`.trim();
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'build it' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: full }] } }),
        '',
      ].join('\n'),
    );
    await hook(run.id, 'UserPromptSubmit', token, { transcript_path: transcript });
    await hook(run.id, 'Stop', token, { last_assistant_message: `${full.slice(0, 50)}…` });
    expect(((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).finalMessage).toBe(full);
  });

  it('keeps the last screen when the terminal closes', async () => {
    const project = await createProject('Last screen', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(run.id);
    await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).lastScreen;
        },
        { timeout: 5_000 },
      )
      .toContain('fake claude ready');
    const detail = (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;
    expect(detail.terminalId).toBeNull();
    expect(detail.lastEvent).not.toBe('last_screen');
    // The screen travels once, not inside the timeline entry.
    expect(detail.events.find((e) => e.type === 'last_screen')?.payload).toEqual({});
  });

  it('records an automatic stop as a system event with its reason', async () => {
    const project = await createProject('Auto stop', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(run.id);
    await t.runs.stop(run.id, { source: 'system', reason: 'factory_step_finished' });
    const detail = (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;
    expect(detail.events.find((e) => e.type === 'stop_requested')).toMatchObject({
      source: 'system',
      payload: { reason: 'factory_step_finished' },
    });
  });

  it('lists the deliverables a run built, including git-ignored build directories', async () => {
    const project = await createProject('Build outputs', true);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const wt = run.worktreePath;
    const put = (rel: string, bytes: number) => {
      mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
      writeFileSync(path.join(wt, rel), Buffer.alloc(bytes, 1));
    };
    writeFileSync(path.join(wt, '.gitignore'), 'build/\nnode_modules/\n');
    put('app/build/outputs/apk/debug/app-debug.apk', 2048);
    put('public/downloads/game.apk', 1024);
    put('node_modules/some-dep/fixture.apk', 10);
    put('notes/data.bin', 10); // a .bin outside build directories is not a deliverable
    put('.pio/build/esp32dev/firmware.bin', 512);
    execFileSync('git', ['-C', wt, 'add', '.gitignore', 'public/downloads/game.apk']);

    const res = (await api('GET', `/api/runs/${run.id}/build-outputs`)).json() as RunBuildOutputsResponse;
    expect(res.worktreePath).toBe(wt);
    expect(Object.fromEntries(res.outputs.map((o) => [o.path, o.tracked]))).toEqual({
      'app/build/outputs/apk/debug/app-debug.apk': false,
      'public/downloads/game.apk': true,
      '.pio/build/esp32dev/firmware.bin': false,
    });

    const download = await api(
      'GET',
      `/api/runs/${run.id}/build-outputs/download?path=app/build/outputs/apk/debug/app-debug.apk`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment; filename="app-debug.apk"');
    expect(download.rawPayload.length).toBe(2048);
    // Only deliverables can be downloaded through this route.
    expect((await api('GET', `/api/runs/${run.id}/build-outputs/download?path=.gitignore`)).statusCode).toBe(
      404,
    );
    expect(
      (await api('GET', `/api/runs/${run.id}/build-outputs/download?path=../../etc/passwd`)).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  it('neither lists nor serves build outputs of a worktree swapped for a symlink', async () => {
    const project = await createProject('Build outputs link', true);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const outside = mkdtempSync(path.join(tmpdir(), 'core-data-'));
    try {
      mkdirSync(path.join(outside, 'build'));
      writeFileSync(path.join(outside, 'build/x.apk'), 'core secrets');
      rmSync(run.worktreePath, { recursive: true, force: true });
      symlinkSync(outside, run.worktreePath);

      const res = (await api('GET', `/api/runs/${run.id}/build-outputs`)).json() as RunBuildOutputsResponse;
      expect(res.outputs).toEqual([]);
      const download = await api('GET', `/api/runs/${run.id}/build-outputs/download?path=build/x.apk`);
      expect(download.statusCode).toBe(404);
      expect(download.body).not.toContain('core secrets');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails a Claude run with a clear message instead of leaving it at the sign-in screen', async () => {
    const home = path.join(t.dir, 'runner-home');
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.EMBERLINE_RUNNER_HOME;
    process.env.EMBERLINE_RUNNER_HOME = home;
    const previousCommand = t.config.claudeCommand;
    t.config.claudeCommand = 'claude';
    try {
      const project = await createProject('Not signed in', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await expect
        .poll(async () => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).state, {
          timeout: 5_000,
        })
        .toBe('failed');
      const detail = (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;
      expect(detail.terminalId).toBeNull();
      expect(detail.events.find((e) => e.type === 'agent_not_signed_in')?.payload).toMatchObject({
        reason: 'not_signed_in',
      });
    } finally {
      t.config.claudeCommand = previousCommand;
      if (previousHome === undefined) delete process.env.EMBERLINE_RUNNER_HOME;
      else process.env.EMBERLINE_RUNNER_HOME = previousHome;
    }
  });

  describe('waiting_input watchdog (R6)', () => {
    async function waitingOnPermission(unattended: boolean) {
      const project = await createProject(unattended ? 'Cron Wait' : 'Manual Wait', true);
      const run: Run = unattended
        ? await t.scheduler.submit(
            { projectId: project.id, prompt: 'x', permissionMode: 'auto' },
            { unattended: 'cron' },
          )
        : (await api('POST', '/api/runs', { projectId: project.id })).json();
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: 's' });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });
      await hook(run.id, 'Notification', token, {
        notification_type: 'permission_prompt',
        message: 'needs permission',
      });
      expect(t.runs.getRun(run.id).state).toBe('waiting_input');
      return run;
    }
    const age = (id: string, ms: number) =>
      t.db
        .update(runs)
        .set({ stateChangedAt: new Date(Date.now() - ms) })
        .where(eq(runs.id, id))
        .run();

    it('fails an unattended run that waited on a permission prompt for over 30 minutes', async () => {
      const run = await waitingOnPermission(true);
      age(run.id, 10 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).state).toBe('waiting_input');
      age(run.id, 31 * 60_000);
      await t.runs.reconcile();
      const after = t.runs.get(run.id);
      expect(after).toMatchObject({ state: 'failed', lastEvent: 'waiting_input_timeout' });
      expect(after.endedAt).not.toBeNull();
      expect(after.events.map((e) => e.type)).toContain('waiting_input_timeout');
    });

    it('leaves an attended run waiting', async () => {
      const run = await waitingOnPermission(false);
      age(run.id, 3 * 60 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).state).toBe('waiting_input');
    });
  });

  describe('hook states without other coverage', () => {
    async function working(name: string) {
      const project = await createProject(name, false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: `s-${name}` });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });
      return { run, token };
    }

    it('leaves a turn that failed for a non-limit, non-temporary reason waiting for the user', async () => {
      const { run, token } = await working('Stop failure');
      const res = await hook(run.id, 'StopFailure', token, {
        error: 'invalid_request',
        error_details: 'prompt is too long',
      });
      expect(res.json()).toMatchObject({ state: 'waiting_input' });
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'waiting_input', autoRetry: null, endedAt: null });
      expect(t.runs.get(run.id).events.map((e) => e.type)).not.toContain('retry_scheduled');
    });

    it('treats SessionEnd of a live session as done', async () => {
      const { run, token } = await working('Session end');
      expect((await hook(run.id, 'SessionEnd', token, { reason: 'other' })).json()).toMatchObject({
        state: 'done',
      });
    });

    it('closes an idle finished session after its TTL and keeps the run resumable', async () => {
      const { run, token } = await working('Idle close');
      await hook(run.id, 'Stop', token);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'done', endedAt: null });
      t.db
        .update(runs)
        .set({ stateChangedAt: new Date(Date.now() - 3 * 60_000) })
        .where(eq(runs.id, run.id))
        .run();
      await t.runs.reconcile();
      const after = t.runs.get(run.id);
      expect(after).toMatchObject({ state: 'done', terminalId: null, resumable: true });
      expect(after.endedAt).not.toBeNull();
      expect(after.events.map((e) => e.type)).toContain('idle_session_closed');
    });

    it("closes a held run's session as resumable, not cancelled, and a prompt respawns it", async () => {
      const { run, token } = await working('Held close');
      await hook(run.id, 'Stop', token);
      const closed = await t.runs.closeHeldSession(run.id);
      expect(closed).toMatchObject({ state: 'done', resumable: true, cancelled: false });
      expect(closed.endedAt).not.toBeNull();
      const detail = t.runs.get(run.id);
      expect(detail.terminalId).toBeNull();
      expect(detail.events.find((e) => e.type === 'idle_session_closed')?.payload).toEqual({
        reason: 'held',
      });
      expect(detail.events.map((e) => e.type)).not.toContain('stop_requested');

      // Reconcile does not turn it into a cancelled or failed run.
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'done', resumable: true, cancelled: false });

      // Closing again is a no-op.
      await t.runs.closeHeldSession(run.id);
      expect(t.runs.get(run.id).events.filter((e) => e.type === 'idle_session_closed')).toHaveLength(1);

      // A prompt respawns the agent; the hooks of the resumed session are accepted. The first spawn's
      // token file goes first, so tokenFor waits for the respawned CLI's new token.
      rmSync(path.join(t.dir, `token-${run.id}`), { force: true });
      expect((await api('POST', `/api/runs/${run.id}/prompt`, { text: 'carry on' })).statusCode).toBe(200);
      const resumedToken = await tokenFor(run.id);
      const res = await hook(run.id, 'UserPromptSubmit', resumedToken, { prompt: 'carry on' });
      expect(res.statusCode).toBe(200);
      expect(t.runs.getRun(run.id)).toMatchObject({ endedAt: null, cancelled: false });
    });

    it('a held close leaves a session a person prompted meanwhile', async () => {
      const { run, token } = await working('Held close, prompted');
      await hook(run.id, 'Stop', token);
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'wait, also do X' });
      await t.runs.closeHeldSession(run.id);
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'working', endedAt: null });
      expect(t.runs.get(run.id).events.map((e) => e.type)).not.toContain('idle_session_closed');
    });

    it('a held close leaves a session whose typed prompt has not reached the agent yet', async () => {
      const { run, token } = await working('Held close, typed');
      await hook(run.id, 'Stop', token);
      // The prompt is typed and recorded; the CLI's UserPromptSubmit hook has not arrived.
      await t.runs.sendPrompt(run.id, 'one more thing');
      await t.runs.closeHeldSession(run.id);
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'done', endedAt: null });
      expect(t.runs.get(run.id).events.map((e) => e.type)).not.toContain('idle_session_closed');
    });

    it('a held close waits for a prompt being typed, then leaves the session open', async () => {
      const { run, token } = await working('Held close, typing');
      await hook(run.id, 'Stop', token);
      const typing = t.runs.sendPrompt(run.id, 'one more thing');
      const closing = t.runs.closeHeldSession(run.id);
      await Promise.all([typing, closing]);
      expect(t.runs.getRun(run.id).endedAt).toBeNull();
      expect(t.runs.get(run.id).events.map((e) => e.type)).not.toContain('idle_session_closed');
    });

    it('the idle sweep leaves a finished session whose typed prompt has not reached the agent yet', async () => {
      const { run, token } = await working('Idle close, typed');
      await hook(run.id, 'Stop', token);
      // A prompt typed into the CLI (this stand-in would exit on it, so it is only recorded).
      t.db
        .insert(runEvents)
        .values({
          runId: run.id,
          ts: new Date(),
          source: 'user',
          type: 'prompt_sent',
          payload: { length: 14 },
        })
        .run();
      t.db
        .update(runs)
        .set({ stateChangedAt: new Date(Date.now() - 3 * 60_000) })
        .where(eq(runs.id, run.id))
        .run();
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).endedAt).toBeNull();
      expect(t.runs.get(run.id).events.map((e) => e.type)).not.toContain('idle_session_closed');
    });

    it('does not type into a one-shot CLI that finished its turn and is about to exit', async () => {
      const project = await createProject('One-shot closing', false);
      const now = new Date();
      t.db
        .insert(runs)
        .values({
          id: 'gem-1',
          projectId: project.id,
          agent: 'gemini',
          permissionMode: 'auto',
          state: 'done',
          prompt: 'do it',
          worktreePath: project.path,
          hookTokenHash: 'h',
          ptydSessionId: 'pty-x',
          stateChangedAt: now,
          createdAt: now,
          endedAt: null,
        })
        .run();
      const write = vi.spyOn(t.ptyd.get(), 'write');
      await expect(t.runs.sendPrompt('gem-1', 'fix', { automatic: true })).rejects.toMatchObject({
        statusCode: 409,
        code: 'session_closing',
        message: 'The agent is finishing its turn; try again in a moment.',
      });
      expect(write).not.toHaveBeenCalled();
    });

    it('a prompt to a one-shot CLI whose process has exited notes the exit and respawns it', async () => {
      process.env.EMBERLINE_GEMINI_COMMAND = t.config.claudeCommand;
      try {
        const project = await createProject('One-shot exited', true);
        const now = new Date();
        t.db
          .insert(runs)
          .values({
            id: 'gem-2',
            projectId: project.id,
            agent: 'gemini',
            permissionMode: 'auto',
            state: 'done',
            prompt: 'do it',
            worktreePath: project.path,
            hookTokenHash: 'h',
            agentSessionId: 'gemini-gem-2',
            ptydSessionId: 'pty-gone',
            stateChangedAt: now,
            createdAt: now,
            endedAt: null,
          })
          .run();
        const run = await t.runs.prompt('gem-2', 'fix', { automatic: true });
        expect(run).toMatchObject({ state: 'starting', endedAt: null });
        expect(t.runs.get('gem-2').events.map((e) => e.type)).toContain('respawning');
        await tokenFor('gem-2');
      } finally {
        delete process.env.EMBERLINE_GEMINI_COMMAND;
      }
    });
  });

  describe('idle close and the completion pipeline', () => {
    it('does not idle-close a run while its pipeline is busy, and closes it afterwards', async () => {
      const project = await createProject('Idle busy', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: 's-idle-busy' });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });
      await hook(run.id, 'Stop', token);
      t.db
        .update(runs)
        .set({ stateChangedAt: new Date(Date.now() - 3 * 60_000) })
        .where(eq(runs.id, run.id))
        .run();
      t.runs.pipelineBusy(run.id, true);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).endedAt).toBeNull();
      expect(t.runs.get(run.id).events.map((e) => e.type)).not.toContain('idle_session_closed');
      t.runs.pipelineBusy(run.id, false);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).endedAt).not.toBeNull();
      expect(t.runs.get(run.id).events.map((e) => e.type)).toContain('idle_session_closed');
    });
  });

  describe('stall watchdog (R7)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('marks a working run with no hooks and a frozen screen for 20 minutes as waiting', async () => {
      const project = await createProject('Stalled', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: 's-stall' });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });
      const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);
      const state = async () => {
        await t.runs.reconcile();
        return t.runs.getRun(run.id).state;
      };
      vi.useFakeTimers({ toFake: ['Date'] });

      expect(await state()).toBe('working');
      later(10);
      // The screen changes (typed text is echoed): the agent is doing something.
      await t.ptyd.get().write(run.terminalId ?? '', 'x');
      await new Promise((r) => setTimeout(r, 300));
      expect(await state()).toBe('working');
      later(11);
      // 21 minutes without a hook, but the screen changed 11 minutes ago.
      expect(await state()).toBe('working');
      later(10);
      expect(await state()).toBe('waiting_input');
      const detail = t.runs.get(run.id);
      expect(detail.lastEvent).toBe('stall_detected');
      expect(detail.events.filter((e) => e.type === 'stall_detected')).toHaveLength(1);
      expect(detail.endedAt).toBeNull();

      // The agent was alive after all: its next hook moves it back as usual.
      expect((await hook(run.id, 'PreToolUse', token, { tool_name: 'Bash' })).json()).toMatchObject({
        state: 'working',
      });
      later(5);
      expect(await state()).toBe('working');
    });

    it('also watches a run stuck in starting with a live terminal, so prompts are taken again', async () => {
      const project = await createProject('Stuck start', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(run.id);
      vi.useFakeTimers({ toFake: ['Date'] });
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).state).toBe('starting');
      vi.setSystemTime(Date.now() + 21 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'waiting_input', lastEvent: 'stall_detected' });
      vi.useRealTimers(); // the login session would have expired in the faked future
      expect((await api('POST', `/api/runs/${run.id}/prompt`, { text: 'hello?' })).statusCode).toBe(200);
    });

    it('stops an unattended stalled run 30 minutes after the stall (R6)', async () => {
      const project = await createProject('Cron Stall', false);
      const run = await t.scheduler.submit(
        { projectId: project.id, prompt: 'x', permissionMode: 'auto' },
        { unattended: 'cron' },
      );
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: 's-cron-stall' });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });
      vi.useFakeTimers({ toFake: ['Date'] });
      await t.runs.reconcile();
      vi.setSystemTime(Date.now() + 21 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id)).toMatchObject({ state: 'waiting_input', lastEvent: 'stall_detected' });
      vi.setSystemTime(Date.now() + 29 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).state).toBe('waiting_input');
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await t.runs.reconcile();
      const after = t.runs.getRun(run.id);
      expect(after).toMatchObject({ state: 'failed', lastEvent: 'waiting_input_timeout' });
      expect(after.endedAt).not.toBeNull();
    });

    it('any hook restarts the stall timer', async () => {
      const project = await createProject('Busy', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: 's-busy' });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });
      vi.useFakeTimers({ toFake: ['Date'] });
      await t.runs.reconcile();
      vi.setSystemTime(Date.now() + 15 * 60_000);
      await hook(run.id, 'PostToolUse', token, { tool_name: 'Bash' });
      await t.runs.reconcile();
      vi.setSystemTime(Date.now() + 15 * 60_000);
      await t.runs.reconcile();
      expect(t.runs.getRun(run.id).state).toBe('working');
    });
  });

  describe('prompts wait for a ready CLI (R9)', () => {
    const screen = async (run: Run) => (await t.ptyd.get().snapshot(run.terminalId ?? '', 50)).data ?? '';

    it('refuses a follow-up prompt while the agent is still starting', async () => {
      const project = await createProject('Starting prompt', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      await tokenFor(run.id);
      expect(t.runs.getRun(run.id).state).toBe('starting');
      const res = await api('POST', `/api/runs/${run.id}/prompt`, { text: 'too early' });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/still starting/i);
      expect(await screen(run)).not.toContain('too early');
    });

    it('does not type CONTINUE into a working agent, but lets a user prompt through', async () => {
      const project = await createProject('Working resume', false);
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
      const token = await tokenFor(run.id);
      await hook(run.id, 'SessionStart', token, { session_id: 's-working' });
      await hook(run.id, 'UserPromptSubmit', token, { prompt: 'go' });

      expect((await api('POST', `/api/runs/${run.id}/resume`, {})).statusCode).toBe(409);
      await expect(t.runs.sendPrompt(run.id, 'nudge', { automatic: true })).rejects.toMatchObject({
        statusCode: 409,
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(await screen(run)).not.toMatch(/Continue where you left off|nudge/);
      expect(t.runs.getRun(run.id).state).toBe('working');

      // A person's prompt while the agent works is queued by the CLI.
      expect((await api('POST', `/api/runs/${run.id}/prompt`, { text: 'also this' })).statusCode).toBe(200);
    });
  });
});

describe('build output archive', () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);
  const finishRun = async (projectId: string) => {
    const run: Run = (await api('POST', '/api/runs', { projectId })).json();
    await tokenFor(run.id);
    await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return t.runs.getRun(run.id).endedAt;
        },
        { timeout: 5_000 },
      )
      .not.toBeNull();
    await t.runs.outputs.idle();
    return t.runs.getRun(run.id);
  };
  const putApk = (worktreePath: string, bytes: number) => {
    const rel = 'build/app/outputs/apk/release/app-release.apk';
    mkdirSync(path.dirname(path.join(worktreePath, rel)), { recursive: true });
    writeFileSync(path.join(worktreePath, rel), Buffer.alloc(bytes, 5));
  };
  /** The run ignores `build/`, commits that, and the branch is merged: GC may prune the worktree. */
  const mergeIgnoringBuild = (run: Run, projectPath: string) => {
    writeFileSync(path.join(run.worktreePath, '.gitignore'), 'build/\n');
    gitIn(run.worktreePath, 'add', '.gitignore');
    gitIn(run.worktreePath, 'commit', '-q', '-m', 'ignore build');
    gitIn(projectPath, 'merge', '-q', '--no-ff', '-m', 'merge', run.branch ?? '');
  };
  const expectArchivedApk = async (projectId: string, runId: string, bytes: number) => {
    const { outputs } = t.runs.outputs.list(projectId);
    expect(outputs).toEqual([expect.objectContaining({ name: 'app-release.apk', runId, sizeBytes: bytes })]);
    const file = await t.runs.outputs.open(outputs[0]?.id ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(bytes, 5));
  };
  const staleRunsBehindTenNewer = (projectId: string, projectPath: string, stale: Run[]) => {
    stale.forEach((r, i) =>
      t.db
        .update(runs)
        .set({ createdAt: new Date(1_000 + i) })
        .where(eq(runs.id, r.id))
        .run(),
    );
    for (let i = 0; i < 10; i += 1) {
      t.db
        .insert(runs)
        .values({
          id: `synthetic-${i}`,
          projectId,
          agent: 'claude',
          state: 'done',
          worktreePath: projectPath,
          hookTokenHash: 'x',
          stateChangedAt: new Date(10_000 + i),
          createdAt: new Date(10_000 + i),
          endedAt: new Date(10_000 + i),
        })
        .run();
    }
  };

  it('auto-GC archives an APK in a git-ignored build/ dir before it prunes the merged worktree', async () => {
    const project = await createProject('Archive auto GC', true);
    const stale = await finishRun(project.id);
    mergeIgnoringBuild(stale, project.path);
    putApk(stale.worktreePath, 4096);
    staleRunsBehindTenNewer(project.id, project.path, [stale]);
    const live: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(live.id);
    (t.runs as unknown as { lastAutoGcAt: number }).lastAutoGcAt = 0;

    await t.runs.reconcile();

    expect(t.runs.list().map((r) => r.id)).not.toContain(stale.id);
    expect(existsSync(stale.worktreePath)).toBe(false);
    await expectArchivedApk(project.id, stale.id, 4096);
    expect(t.runs.outputs.list(project.id).outputs[0]?.runExists).toBe(false);
  });

  it('manual GC archives before it prunes', async () => {
    const project = await createProject('Archive manual GC', true);
    const run = await finishRun(project.id);
    mergeIgnoringBuild(run, project.path);
    putApk(run.worktreePath, 3000);

    const res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0, pruneWorktrees: true });
    expect(res.prunedWorktrees).toBe(1);
    expect(existsSync(run.worktreePath)).toBe(false);
    await expectArchivedApk(project.id, run.id, 3000);
  });

  it('manual GC that keeps worktrees still archives the runs it removes', async () => {
    const project = await createProject('Archive GC keep worktrees', true);
    const run = await finishRun(project.id);
    mergeIgnoringBuild(run, project.path);
    putApk(run.worktreePath, 1200);

    const res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0, pruneWorktrees: false });
    expect(res.removedRuns).toBe(1);
    expect(existsSync(run.worktreePath)).toBe(true);
    await expectArchivedApk(project.id, run.id, 1200);
  });

  it('auto-GC spends one archive time budget per pass and leaves the rest for the next pass', async () => {
    const project = await createProject('Archive auto GC budget', true);
    const first = await finishRun(project.id);
    const second = await finishRun(project.id);
    for (const r of [first, second]) mergeIgnoringBuild(r, project.path);
    staleRunsBehindTenNewer(project.id, project.path, [second, first]);
    const live: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(live.id);
    const budgets: number[] = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    const spy = vi.spyOn(t.runs.outputs, 'archiveBeforePrune').mockImplementation(async (_id, timeoutMs) => {
      budgets.push(timeoutMs ?? -1);
      // This pass took 58 of the 60 seconds.
      vi.setSystemTime(Date.now() + 58_000);
      return 'archived';
    });
    try {
      (t.runs as unknown as { lastAutoGcAt: number }).lastAutoGcAt = 0;
      await t.runs.reconcile();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(budgets).toEqual([60_000]);
    const ids = t.runs.list().map((r) => r.id);
    expect(ids.filter((id) => id === first.id || id === second.id)).toHaveLength(1);
  });

  /** A stale, merged run behind ten newer ones, a live run, and a way to trigger auto-GC now. */
  const staleRunForAutoGc = async (name: string) => {
    const project = await createProject(name, true);
    const stale = await finishRun(project.id);
    mergeIgnoringBuild(stale, project.path);
    putApk(stale.worktreePath, 2048);
    staleRunsBehindTenNewer(project.id, project.path, [stale]);
    const live: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(live.id);
    const autoGc = async () => {
      (t.runs as unknown as { lastAutoGcAt: number }).lastAutoGcAt = 0;
      await t.runs.reconcile();
    };
    const failureNote = (ts: Date) =>
      t.db
        .insert(runEvents)
        .values({
          runId: stale.id,
          ts,
          source: 'system',
          type: 'build_outputs_archive_failed',
          payload: { message: 'Could not archive 1 build output(s): EACCES' },
        })
        .run();
    const kept = () => t.runs.list().some((r) => r.id === stale.id) && existsSync(stale.worktreePath);
    return { project, stale, autoGc, failureNote, kept };
  };

  it('auto-GC keeps a worktree whose archive timed out, or failed less than 24 h ago, and prunes it later', async () => {
    const { project, stale, autoGc, failureNote, kept } = await staleRunForAutoGc('Archive auto GC keeps');
    const spy = vi
      .spyOn(t.runs.outputs, 'archiveBeforePrune')
      .mockResolvedValueOnce('timeout')
      .mockImplementationOnce(async () => {
        failureNote(new Date(Date.now() - 23 * 3_600_000));
        return 'failed';
      });
    try {
      await autoGc();
      expect(kept()).toBe(true);
      await autoGc();
      expect(kept()).toBe(true);
      expect(spy.mock.calls.map((c) => c[2])).toEqual([{ keepOnTimeout: true }, { keepOnTimeout: true }]);
    } finally {
      spy.mockRestore();
    }
    await autoGc();
    expect(t.runs.list().map((r) => r.id)).not.toContain(stale.id);
    expect(existsSync(stale.worktreePath)).toBe(false);
    await expectArchivedApk(project.id, stale.id, 2048);
  });

  it('auto-GC prunes as before once archiving has failed for 24 h', async () => {
    const { stale, autoGc, failureNote, kept } = await staleRunForAutoGc('Archive auto GC gives up');
    failureNote(new Date(Date.now() - 25 * 3_600_000));
    // A later, deduplicated note does not restart the 24 hours.
    failureNote(new Date());
    const spy = vi.spyOn(t.runs.outputs, 'archiveBeforePrune').mockResolvedValue('failed');
    try {
      await autoGc();
    } finally {
      spy.mockRestore();
    }
    expect(kept()).toBe(false);
    expect(t.runs.list().map((r) => r.id)).not.toContain(stale.id);
    expect(existsSync(stale.worktreePath)).toBe(false);
  });

  it('manual GC keeps runs it could not archive within its time budget, as archive_pending', async () => {
    const project = await createProject('Archive manual GC budget', true);
    const first = await finishRun(project.id);
    const second = await finishRun(project.id);
    const third = await finishRun(project.id);
    for (const r of [first, second, third]) mergeIgnoringBuild(r, project.path);
    vi.useFakeTimers({ toFake: ['Date'] });
    const spy = vi
      .spyOn(t.runs.outputs, 'archiveBeforePrune')
      .mockImplementationOnce(async () => 'timeout')
      .mockImplementationOnce(async () => {
        // This pass took 58 of the 60 seconds: nothing is left for the third run.
        vi.setSystemTime(Date.now() + 58_000);
        return 'archived';
      });
    let res;
    let budgets: unknown[] = [];
    try {
      res = await t.runs.garbageCollect({ projectId: project.id, keepRecent: 0, pruneWorktrees: true });
      budgets = spy.mock.calls.map((c) => c[1]);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(budgets).toHaveLength(2);
    expect(budgets.every((b) => typeof b === 'number' && b <= 60_000)).toBe(true);
    expect(res.removedRuns).toBe(1);
    expect(res.keptWorktrees.map((k) => k.reason)).toEqual(['archive_pending', 'archive_pending']);
    const kept = res.keptWorktrees.map((k) => k.runId);
    expect(kept).toHaveLength(2);
    for (const id of kept) {
      expect(t.runs.list().map((r) => r.id)).toContain(id);
      expect(existsSync(t.runs.getRun(id).worktreePath)).toBe(true);
    }
  });

  it('a per-run prune archives first', async () => {
    const project = await createProject('Archive prune', true);
    const run = await finishRun(project.id);
    putApk(run.worktreePath, 2000);

    const res = await api('POST', `/api/runs/${run.id}/worktree/prune`, { force: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: true });
    expect(existsSync(run.worktreePath)).toBe(false);
    await expectArchivedApk(project.id, run.id, 2000);
  });

  it('archives when a run reaches done, in the background', async () => {
    const project = await createProject('Archive on done', true);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'UserPromptSubmit', token);
    putApk(run.worktreePath, 1000);

    expect((await hook(run.id, 'Stop', token)).statusCode).toBe(200);
    expect(t.runs.getRun(run.id).state).toBe('done');
    await t.runs.outputs.idle();
    await expectArchivedApk(project.id, run.id, 1000);
  });

  it('never makes the hook (and the pipeline behind it) wait for an archive pass', async () => {
    const project = await createProject('Archive async', true);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    await hook(run.id, 'UserPromptSubmit', token);
    let release: () => void = () => undefined;
    const spy = vi
      .spyOn(t.runs.outputs, 'archiveRun')
      .mockImplementation(
        () => new Promise((resolve) => (release = () => resolve({ archived: 0, skipped: 0, failed: 0 }))),
      );
    try {
      const res = await hook(run.id, 'Stop', token);
      expect(res.statusCode).toBe(200);
      expect(t.runs.getRun(run.id).state).toBe('done');
      await expect.poll(() => spy.mock.calls.map((c) => c[0])).toEqual([run.id]);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('archives when a run ends failed', async () => {
    const project = await createProject('Archive on failed', true);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(run.id);
    putApk(run.worktreePath, 1500);
    await t.ptyd.get().write(run.terminalId ?? '', 'fail\r');
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return t.runs.getRun(run.id).state;
        },
        { timeout: 5_000 },
      )
      .toBe('failed');
    await t.runs.outputs.idle();
    await expectArchivedApk(project.id, run.id, 1500);
  });

  it('deleting a project removes its archived outputs', async () => {
    const project = await createProject('Archive delete', true);
    const run = await finishRun(project.id);
    putApk(run.worktreePath, 100);
    await t.runs.outputs.archiveRun(run.id);
    const archiveDir = path.join(t.config.workspacesDir, '.emberline-outputs', project.id);
    expect(existsSync(archiveDir)).toBe(true);

    expect((await api('DELETE', `/api/projects/${project.id}`)).statusCode).toBe(200);
    expect(existsSync(archiveDir)).toBe(false);
    expect(t.runs.outputs.list(project.id).outputs).toEqual([]);
  });
});

describe('ticket_complete endpoint', () => {
  const complete = (runId: string, token: string | undefined, body: unknown) =>
    t.app.inject({
      method: 'POST',
      url: `/api/internal/runs/${runId}/complete`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });
  const eventsOf = (runId: string, type: string) =>
    t.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .all()
      .filter((e) => e.type === type);

  async function ticketRun(name = 'Complete') {
    const project = await createProject(name, false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const ticket = t.tickets.create(project.id, { title: 'Do it', status: 'in_progress' });
    t.db.update(runs).set({ ticketId: ticket.id }).where(eq(runs.id, run.id)).run();
    const token = await tokenFor(run.id);
    return { project, run, ticket, token };
  }
  const ticketOf = async (id: string) => (await api('GET', `/api/tickets/${id}`)).json();

  it('rejects a missing, wrong or other run token with 401, unknown run with 404', async () => {
    const a = await ticketRun('CompleteA');
    const b = await ticketRun('CompleteB');
    const body = { summary: 'done' };
    expect((await complete(a.run.id, undefined, body)).statusCode).toBe(401);
    expect((await complete(a.run.id, 'wrong', body)).statusCode).toBe(401);
    expect((await complete(a.run.id, b.token, body)).statusCode).toBe(401);
    expect((await complete('no-such-run', a.token, body)).statusCode).toBe(404);
    expect(eventsOf(a.run.id, 'ticket_complete')).toHaveLength(0);
  });

  it('answers 409 for an ended run', async () => {
    const { run, token } = await ticketRun('CompleteEnded');
    t.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, run.id)).run();
    expect((await complete(run.id, token, { summary: 'late' })).statusCode).toBe(409);
  });

  it('rejects payloads over the limits or without a summary with 400', async () => {
    const { run, token } = await ticketRun('CompleteLimits');
    const bad = [
      {},
      { summary: '' },
      { summary: 'x'.repeat(4001) },
      { summary: 's', handoff: 'x'.repeat(8001) },
      { summary: 's', blockers: Array.from({ length: 11 }, () => 'b') },
      { summary: 's', blockers: ['x'.repeat(501)] },
    ];
    for (const body of bad) expect((await complete(run.id, token, body)).statusCode).toBe(400);
    const edge = {
      summary: 'x'.repeat(4000),
      handoff: 'y'.repeat(8000),
      blockers: Array.from({ length: 10 }, () => 'z'.repeat(500)),
    };
    expect((await complete(run.id, token, edge)).statusCode).toBe(200);
  });

  it('stores the event and ticket.completion; the latest call wins', async () => {
    const { run, ticket, token } = await ticketRun('CompleteStore');
    expect((await complete(run.id, token, { summary: 'first' })).statusCode).toBe(200);
    expect(
      (await complete(run.id, token, { summary: 'second', handoff: 'h', blockers: ['b1'] })).statusCode,
    ).toBe(200);
    const events = eventsOf(run.id, 'ticket_complete');
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ summary: 'second', handoff: 'h', blockers: ['b1'] });
    const got = await ticketOf(ticket.id);
    expect(got.completion).toMatchObject({
      runId: run.id,
      summary: 'second',
      handoff: 'h',
      blockers: ['b1'],
    });
    expect(typeof got.completion.at).toBe('string');
  });

  it('a run without a ticket still records the event', async () => {
    const project = await createProject('CompleteNoTicket', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    expect((await complete(run.id, token, { summary: 'x' })).statusCode).toBe(200);
    expect(eventsOf(run.id, 'ticket_complete')).toHaveLength(1);
  });

  it('latestCompletion is only valid for the turn: a later UserPromptSubmit invalidates it', async () => {
    const { run, token } = await ticketRun('CompleteTurn');
    expect(t.runs.latestCompletion(run.id)).toBeNull();
    await complete(run.id, token, { summary: 'turn one' });
    expect(t.runs.latestCompletion(run.id)).toMatchObject({ summary: 'turn one', blockers: [] });
    await hook(run.id, 'UserPromptSubmit', token);
    expect(t.runs.latestCompletion(run.id)).toBeNull();
    await complete(run.id, token, { summary: 'turn two' });
    expect(t.runs.latestCompletion(run.id)).toMatchObject({ summary: 'turn two' });
  });

  it('event pruning keeps ticket_complete', async () => {
    const { run, token } = await ticketRun('CompletePrune');
    await complete(run.id, token, { summary: 'keep me' });
    t.db
      .insert(runEvents)
      .values(
        Array.from({ length: 5100 }, () => ({
          runId: run.id,
          ts: new Date(),
          source: 'hook',
          type: 'PreToolUse',
        })),
      )
      .run();
    t.runs.pruneRunEvents();
    expect(eventsOf(run.id, 'ticket_complete')).toHaveLength(1);
  });

  it('event pruning keeps the UserPromptSubmit turn boundary, so a stale signal stays stale', async () => {
    const { run, token } = await ticketRun('CompletePrunePrompt');
    // The first turn's prompt is kept anyway (first `working` event); the later one is the boundary.
    await hook(run.id, 'UserPromptSubmit', token);
    await complete(run.id, token, { summary: 'before the reply' });
    await hook(run.id, 'UserPromptSubmit', token);
    t.db
      .insert(runEvents)
      .values(
        Array.from({ length: 5100 }, () => ({
          runId: run.id,
          ts: new Date(),
          source: 'hook',
          type: 'PreToolUse',
        })),
      )
      .run();
    t.runs.pruneRunEvents();
    expect(eventsOf(run.id, 'UserPromptSubmit')).toHaveLength(2);
    expect(t.runs.latestCompletion(run.id)).toBeNull();
  });

  it('bumps the ticket updatedAt and broadcasts the ticket so the Board refreshes live', async () => {
    const { run, ticket, token } = await ticketRun('CompleteBroadcast');
    const seen: Ticket[] = [];
    t.tickets.on('ticket', (x) => seen.push(x));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await complete(run.id, token, { summary: 'live', handoff: 'next' })).statusCode).toBe(200);
    const pushed = seen.filter((x) => x.id === ticket.id).at(-1);
    expect(pushed?.completion).toMatchObject({ runId: run.id, summary: 'live', handoff: 'next' });
    expect(Date.parse(pushed?.updatedAt ?? '')).toBeGreaterThan(Date.parse(ticket.updatedAt));
    expect((await ticketOf(ticket.id)).updatedAt).toBe(pushed?.updatedAt);
  });
});

describe('completion-tool check-in endpoint', () => {
  const checkIn = (runId: string, token: string | undefined) =>
    t.app.inject({
      method: 'POST',
      url: `/api/internal/runs/${runId}/completion-tool`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const readyEvents = (runId: string) =>
    t.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .all()
      .filter((e) => e.type === 'completion_tool_ready');

  async function liveRun(name: string) {
    const project = await createProject(name, false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    const token = await tokenFor(run.id);
    return { run, token };
  }

  it('rejects a missing, wrong or other run token with 401, unknown run with 404', async () => {
    const a = await liveRun('ToolA');
    const b = await liveRun('ToolB');
    expect((await checkIn(a.run.id, undefined)).statusCode).toBe(401);
    expect((await checkIn(a.run.id, 'wrong')).statusCode).toBe(401);
    expect((await checkIn(a.run.id, b.token)).statusCode).toBe(401);
    expect((await checkIn('no-such-run', a.token)).statusCode).toBe(404);
    expect(readyEvents(a.run.id)).toHaveLength(0);
  });

  it('answers 409 for an ended run', async () => {
    const { run, token } = await liveRun('ToolEnded');
    t.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, run.id)).run();
    expect((await checkIn(run.id, token)).statusCode).toBe(409);
    expect(readyEvents(run.id)).toHaveLength(0);
  });

  it('records completion_tool_ready once per run; later check-ins are no-ops', async () => {
    const { run, token } = await liveRun('ToolOnce');
    expect((await checkIn(run.id, token)).statusCode).toBe(200);
    expect((await checkIn(run.id, token)).statusCode).toBe(200);
    expect(readyEvents(run.id)).toHaveLength(1);
    expect(t.runs.hasEvent(run.id, 'completion_tool_ready')).toBe(true);
  });

  it("does not become the run's last event (a waiting run keeps SessionStart)", async () => {
    const { run, token } = await liveRun('ToolLastEvent');
    await hook(run.id, 'SessionStart', token, { session_id: 's-tool' });
    const before = t.runs.get(run.id).lastEvent;
    expect((await checkIn(run.id, token)).statusCode).toBe(200);
    expect(t.runs.get(run.id).lastEvent).toBe(before);
  });

  it('event pruning keeps completion_tool_ready', async () => {
    const { run, token } = await liveRun('ToolPrune');
    await checkIn(run.id, token);
    t.db
      .insert(runEvents)
      .values(
        Array.from({ length: 5100 }, () => ({
          runId: run.id,
          ts: new Date(),
          source: 'hook',
          type: 'PreToolUse',
        })),
      )
      .run();
    t.runs.pruneRunEvents();
    expect(readyEvents(run.id)).toHaveLength(1);
  });
});
