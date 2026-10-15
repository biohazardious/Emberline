import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { runs } from './db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

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
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/token-$EMBERLINE_RUN_ID"`,
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
  await t.close();
  await ptydServer.close();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

const hook = (runId: string, event: string, token: string | undefined, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

async function createProject(name: string, withGit: boolean) {
  const { project } = (await api('POST', '/api/projects', { name })).json();
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

describe('runs', () => {
  it('starts the agent in a fresh worktree on its own branch', async () => {
    const project = await createProject('Repo App', true);
    const res = await api('POST', '/api/runs', { projectId: project.id, prompt: 'hello' });
    expect(res.statusCode).toBe(201);
    const run: Run = res.json();

    expect(run.state).toBe('starting');
    expect(run.branch).toMatch(/^emberline\/run-[0-9a-f]{8}$/);
    expect(run.worktreePath).toBe(path.join(t.config.workspacesDir, '.worktrees', 'repo-app', run.id.slice(0, 8)));
    expect(existsSync(path.join(run.worktreePath, '.git'))).toBe(true);
    expect(run.terminalId).toBeTruthy();

    const terminals = (await api('GET', '/api/terminals')).json();
    expect(terminals).toContainEqual(expect.objectContaining({ id: run.terminalId, kind: 'agent', runId: run.id }));
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
      ['Notification', { notification_type: 'permission_prompt', message: 'needs permission' }, 'waiting_input'],
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
    expect(after).toMatchObject({ state: 'failed', resumable: false });
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

  it('pushes run updates over /api/events', async () => {
    const project = await createProject('Events', false);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, { headers: { cookie, origin: address } });
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

  it('rejects runs for unknown projects', async () => {
    expect((await api('POST', '/api/runs', { projectId: 'nope' })).statusCode).toBe(404);
  });
});
