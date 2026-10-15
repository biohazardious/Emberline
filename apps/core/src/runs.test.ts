import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunBuildOutputsResponse, RunDetail } from '@emberline/protocol';
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
    expect(t.runs.list().map((r) => r.id).sort()).toEqual([dirty.id, inReview.id].sort());
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
      (await api('POST', `/api/runs/${run.id}/preview/start`, { command: 'sleep 30', ...(port ? { port } : {}) })).json();
    // Occupy exactly the port b hashes to, so the allocator has to move b.
    let hash = 0;
    for (const ch of b.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const pa = await start(a, 3100 + (hash % 800));
    const pb = await start(b);
    expect(pb.port).not.toBe(pa.port);
    expect((await api('GET', '/api/terminals')).json().some((x: { id: string }) => x.id === pa.terminalId)).toBe(true);

    await t.runs.stop(a.id);
    await api('DELETE', `/api/runs/${a.id}`);
    const terminals = (await api('GET', '/api/terminals')).json() as { id: string }[];
    expect(terminals.some((x) => x.id === pa.terminalId)).toBe(false);
    expect(terminals.some((x) => x.id === pb.terminalId)).toBe(true);
  });

  it('serves the terminal as plain text for fleet thumbnails', async () => {
    const project = await createProject('Thumb', false);
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id })).json();
    await tokenFor(run.id);
    await expect
      .poll(async () => (await api('GET', `/api/runs/${run.id}/screen-text?lines=5`)).json().text as string | null)
      .toContain('fake claude ready');
    const text = (await api('GET', `/api/runs/${run.id}/screen-text`)).json().text as string;
    expect(text).not.toContain(String.fromCharCode(27));
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

    const download = await api('GET', `/api/runs/${run.id}/build-outputs/download?path=app/build/outputs/apk/debug/app-debug.apk`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment; filename="app-debug.apk"');
    expect(download.rawPayload.length).toBe(2048);
    // Only deliverables can be downloaded through this route.
    expect((await api('GET', `/api/runs/${run.id}/build-outputs/download?path=.gitignore`)).statusCode).toBe(404);
    expect((await api('GET', `/api/runs/${run.id}/build-outputs/download?path=../../etc/passwd`)).statusCode).toBeGreaterThanOrEqual(400);
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
        .poll(async () => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).state, { timeout: 5_000 })
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
});
