import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, SchedulerState } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quotaWindows, runs as runsTable } from './db/schema.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/**
 * Claude stand-in: records its args per spawn, prints a limit banner when the prompt asks for
 * it, then appends every line it reads to a file until it reads "exit".
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
      `echo "$*" >> "${dir}/args-$EMBERLINE_RUN_ID"`,
      'case "$*" in *BANNER*) echo "  ⎿  5-hour limit reached ∙ resets 11:58pm (UTC)";; esac',
      'echo "fake claude ready"',
      'while read line; do',
      `  echo "$line" >> "${dir}/lines-$EMBERLINE_RUN_ID"`,
      '  [ "$line" = "exit" ] && exit 0',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

async function start(schedulerOptions = {}) {
  t = await createTestApp({}, schedulerOptions);
  t.config.claudeCommand = writeFakeClaude(t.dir);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await ptydServer.close();
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

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

const readLines = (runId: string) => {
  const file = path.join(t.dir, `lines-${runId}`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};

const getRun = async (id: string): Promise<RunDetail> => (await api('GET', `/api/runs/${id}`)).json();
const scheduler = async (): Promise<SchedulerState> => (await api('GET', '/api/scheduler')).json();

let projectId: string;
async function submit(prompt = 'do it'): Promise<Run> {
  if (!projectId) projectId = (await api('POST', '/api/projects', { name: 'Sched' })).json().project.id;
  const res = await api('POST', '/api/runs', { projectId, prompt });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Drives a run to `working` like Claude would. */
async function work(run: Run): Promise<string> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `sess-${run.id.slice(0, 4)}` });
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}

describe('scheduler', () => {
  beforeEach(() => {
    projectId = '';
  });

  it('queues runs beyond the concurrency limit and starts them as slots free up', async () => {
    expect((await api('PATCH', '/api/scheduler', { maxConcurrentRuns: 1 })).json()).toMatchObject({
      maxConcurrentRuns: 1,
    });
    expect((await api('PATCH', '/api/scheduler', { maxConcurrentRuns: 0 })).statusCode).toBe(400);

    const a = await submit();
    const b = await submit();
    expect(a.state).toBe('starting');
    expect(b.state).toBe('queued');
    expect(b.terminalId).toBeNull();
    expect(await scheduler()).toMatchObject({ busy: 1, queued: 1, window: null });

    const tokenA = await work(a);
    expect((await getRun(b.id)).state).toBe('queued');

    // A finishing its turn frees the slot.
    await hook(a.id, 'Stop', tokenA);
    await expect.poll(async () => (await getRun(b.id)).state, { timeout: 5_000 }).toBe('starting');
  });

  it('pauses on a rate limit and resumes everything at the reset time', async () => {
    const a = await submit();
    const tokenA = await work(a);

    const resetAt = Math.floor(Date.now() / 1000) + 2;
    const res = await hook(a.id, 'StopFailure', tokenA, {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${resetAt}`,
    });
    expect(res.json().state).toBe('rate_limited');

    const paused = await scheduler();
    expect(paused.window).toMatchObject({ resetSource: 'hook', resumedAt: null });
    expect(paused.window?.resetsAt).toBe(new Date(resetAt * 1000).toISOString());
    expect(paused.rateLimited).toBe(1);

    // New work queues while the window is exhausted, even though a slot is free.
    const b = await submit();
    expect(b.state).toBe('queued');

    // After the reset: the rate-limited run gets the continue prompt first, then the queue runs.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await t.scheduler.tick();
    expect((await scheduler()).window).toBeNull();
    await expect.poll(() => readLines(a.id), { timeout: 5_000 }).toContain('Continue where you left off.');
    expect((await getRun(a.id)).state).toBe('starting');
    expect((await getRun(b.id)).state).toBe('starting');
    expect((await getRun(a.id)).events.map((e) => e.type)).toContain('resumed');

    const windows = t.db.select().from(quotaWindows).all();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.resumedAt).not.toBeNull();
  });

  it('reads the reset time from the screen when the hook has none, else probes', async () => {
    const a = await submit('BANNER please');
    const tokenA = await work(a);
    await hook(a.id, 'StopFailure', tokenA, {
      error: 'rate_limit',
      last_assistant_message: 'API Error: Rate limit reached',
    });

    // Right away the window exists (probe), then the banner refines it.
    expect((await scheduler()).window?.resetSource).toBe('probe');
    await expect.poll(async () => (await scheduler()).window?.resetSource, { timeout: 5_000 }).toBe('screen');
    const window = (await scheduler()).window;
    expect(window?.resetsAt?.endsWith('T23:58:00.000Z')).toBe(true);
    expect(window?.message).toBe('5-hour limit reached ∙ resets 11:58pm (UTC)');
  });

  it('a screen refine only narrows: a wider screen pool sets the reset on the existing window and keeps its pool', async () => {
    const a = await submit();
    const recordLimit = (
      lane: { agent: string; credential: string; pool: string },
      info: unknown,
      refinePool?: string,
    ) =>
      (t.scheduler as unknown as { recordLimit(...args: unknown[]): void }).recordLimit(
        a.id,
        lane,
        info,
        info ? 'screen' : 'hook',
        refinePool,
      );
    const base = { agent: a.agent, credential: a.credential };
    recordLimit({ ...base, pool: 'opus' }, undefined);
    recordLimit(
      { ...base, pool: '*' },
      { resetsAt: new Date(Date.now() + 3_600_000), pool: '*', message: 'wide' },
      'opus',
    );
    const windows = t.db.select().from(quotaWindows).all();
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ pool: 'opus', source: 'screen' });
    expect(windows[0]?.resetsAt).not.toBeNull();
  });

  it('probes after the probe interval when no reset time is known, and re-opens on a repeat hit', async () => {
    await ptydServer.close();
    await t.close();
    await start({ probeMs: 1_000 });

    const a = await submit();
    const tokenA = await work(a);
    await hook(a.id, 'StopFailure', tokenA, { error: 'rate_limit' });
    const first = (await scheduler()).window;
    expect(first).toMatchObject({ resetSource: 'probe', resetsAt: null });

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await t.scheduler.tick();
    await expect.poll(() => readLines(a.id), { timeout: 5_000 }).toContain('Continue where you left off.');

    // Still limited: the same window re-opens instead of a new one.
    await hook(a.id, 'UserPromptSubmit', tokenA);
    await hook(a.id, 'StopFailure', tokenA, { error: 'rate_limit' });
    const again = (await scheduler()).window;
    expect(again?.id).toBe(first?.id);
    expect(again?.resumedAt).toBeNull();
    expect(t.db.select().from(quotaWindows).all()).toHaveLength(1);
  });

  it('resumes from a persisted window after a restart', async () => {
    const a = await submit();
    const tokenA = await work(a);
    await hook(a.id, 'StopFailure', tokenA, { error: 'rate_limit' });
    // Simulate time passing across a core restart: the stored resume time is now in the past.
    t.db
      .update(quotaWindows)
      .set({ resumeAt: new Date(Date.now() - 1_000) })
      .run();
    await t.scheduler.tick();
    expect((await scheduler()).window).toBeNull();
    await expect.poll(() => readLines(a.id), { timeout: 5_000 }).toContain('Continue where you left off.');
  });

  it('lets the user end the pause early', async () => {
    const a = await submit();
    const tokenA = await work(a);
    await hook(a.id, 'StopFailure', tokenA, {
      error: 'rate_limit',
      last_assistant_message: 'resets 11:59pm (UTC)',
    });
    expect((await scheduler()).window).not.toBeNull();
    const res = await api('POST', '/api/scheduler/resume');
    expect(res.json().window).toBeNull();
    await expect.poll(() => readLines(a.id), { timeout: 5_000 }).toContain('Continue where you left off.');
  });

  it('resumes an ended session with claude --resume in the same worktree', async () => {
    const a = await submit();
    const tokenA = await work(a);
    await hook(a.id, 'Stop', tokenA);
    await t.ptyd.get().write(a.terminalId ?? '', 'exit\r');
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return (await getRun(a.id)).resumable;
        },
        { timeout: 5_000 },
      )
      .toBe(true);

    const res = await api('POST', `/api/runs/${a.id}/resume`, { text: 'one more thing' });
    expect(res.statusCode).toBe(200);
    const resumed: Run = res.json();
    expect(resumed).toMatchObject({ state: 'starting', endedAt: null, resumable: false });
    expect(resumed.terminalId).not.toBe(a.terminalId);
    await expect
      .poll(
        () =>
          readFileSync(path.join(t.dir, `args-${a.id}`), 'utf8')
            .trim()
            .split('\n')
            .at(-1),
        { timeout: 5_000 },
      )
      .toContain(`--resume sess-${a.id.slice(0, 4)} -- one more thing`);
    expect((await api('GET', '/api/terminals')).json()).toHaveLength(1);
  });

  it('a stopped rate-limited run is final: the reset never resumes it', async () => {
    const a = await submit();
    const tokenA = await work(a);
    const resetAt = Math.floor(Date.now() / 1000) + 2;
    await hook(a.id, 'StopFailure', tokenA, {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${resetAt}`,
    });
    expect((await getRun(a.id)).state).toBe('rate_limited');

    await api('POST', `/api/runs/${a.id}/stop`);
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return (await getRun(a.id)).state;
        },
        { timeout: 5_000 },
      )
      .toBe('failed');
    // The agent's exit hooks arrive late; they must not revive the run.
    await hook(a.id, 'SessionEnd', tokenA);
    await hook(a.id, 'UserPromptSubmit', tokenA);

    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await t.scheduler.tick();
    const after = await getRun(a.id);
    expect(after).toMatchObject({ state: 'failed', resumable: false });
    expect(after.events.map((e) => e.type)).toContain('cancelled');
    expect(after.events.map((e) => e.type)).not.toContain('resumed');
    expect((await api('POST', `/api/runs/${a.id}/resume`, { text: 'go on' })).statusCode).toBe(409);
  });

  it('ends a rate-limited run whose process already exited when stopped', async () => {
    const a = await submit();
    const tokenA = await work(a);
    await hook(a.id, 'StopFailure', tokenA, {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`,
    });
    await t.ptyd.get().write((await getRun(a.id)).terminalId ?? '', 'exit\r');
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return (await getRun(a.id)).endedAt;
        },
        { timeout: 5_000 },
      )
      .not.toBeNull();
    expect((await getRun(a.id)).state).toBe('rate_limited');

    const stopped: Run = (await api('POST', `/api/runs/${a.id}/stop`)).json();
    expect(stopped).toMatchObject({ state: 'failed', resumable: false });
    expect((await scheduler()).rateLimited).toBe(0);
  });

  it('does not start a second run on a ticket whose rate-limited run is waiting (B11)', async () => {
    await submit();
    const ticket = (
      await api('POST', `/api/projects/${projectId}/tickets`, { title: 'Limited', status: 'ready' })
    ).json();
    const started = await api('POST', `/api/tickets/${ticket.id}/start`, {});
    expect(started.statusCode).toBe(201);
    const run: Run = started.json().run;
    await expect.poll(async () => (await getRun(run.id)).state, { timeout: 5_000 }).not.toBe('queued');
    const token = await work(run);
    await hook(run.id, 'StopFailure', token, {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`,
    });
    await t.ptyd.get().write((await getRun(run.id)).terminalId ?? '', 'exit\r');
    await expect
      .poll(
        async () => {
          await t.runs.reconcile();
          return (await getRun(run.id)).endedAt;
        },
        { timeout: 5_000 },
      )
      .not.toBeNull();
    expect((await getRun(run.id)).state).toBe('rate_limited');
    expect((await api('POST', `/api/tickets/${ticket.id}/start`, {})).statusCode).toBe(409);
  });

  it('cancels a queued run on stop', async () => {
    await api('PATCH', '/api/scheduler', { maxConcurrentRuns: 1 });
    await submit();
    const b = await submit();
    const stopped: Run = (await api('POST', `/api/runs/${b.id}/stop`)).json();
    expect(stopped).toMatchObject({ state: 'failed' });
    expect(stopped.endedAt).not.toBeNull();
    expect((await scheduler()).queued).toBe(0);
  });

  describe('automatic retries after temporary provider errors', () => {
    const outage = {
      error: 'cli_exit',
      message: 'error: failed to send message: UNAVAILABLE (code 503): The service is currently unavailable.',
    };
    /** Simulates the wait: the stored retry time is now in the past. */
    const retryDue = (id: string) =>
      t.db
        .update(runsTable)
        .set({ autoRetryAt: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.id, id))
        .run();

    it('waits without pausing the queue, then continues the turn', async () => {
      const a = await submit();
      const tokenA = await work(a);
      await hook(a.id, 'StopFailure', tokenA, outage);

      const waiting = await getRun(a.id);
      expect(waiting).toMatchObject({ state: 'rate_limited', autoRetry: { attempt: 1, max: 3 } });
      expect(Date.parse(waiting.autoRetry?.at ?? '') - Date.now()).toBeGreaterThan(50_000);
      expect(waiting.events.find((e) => e.type === 'retry_scheduled')?.payload).toMatchObject({
        attempt: 1,
        max: 3,
        reason: expect.stringContaining('UNAVAILABLE (code 503)'),
      });
      expect((await scheduler()).window).toBeNull();

      // Not before its time.
      await t.scheduler.tick();
      expect(readLines(a.id)).not.toContain('Continue where you left off.');

      retryDue(a.id);
      await t.scheduler.tick();
      await expect.poll(() => readLines(a.id), { timeout: 5_000 }).toContain('Continue where you left off.');
      expect((await getRun(a.id)).autoRetry).toBeNull();
    });

    it('respawns an agent whose process exited after the error', async () => {
      const a = await submit();
      const tokenA = await work(a);
      await hook(a.id, 'StopFailure', tokenA, outage);
      await t.ptyd.get().write(a.terminalId ?? '', 'exit\r');
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return (await getRun(a.id)).endedAt;
          },
          { timeout: 5_000 },
        )
        .not.toBeNull();
      expect((await getRun(a.id)).state).toBe('rate_limited');

      retryDue(a.id);
      await t.scheduler.tick();
      await expect
        .poll(
          () =>
            readFileSync(path.join(t.dir, `args-${a.id}`), 'utf8')
              .trim()
              .split('\n')
              .at(-1),
          { timeout: 5_000 },
        )
        .toContain(`--resume sess-${a.id.slice(0, 4)} -- Continue where you left off.`);
    });

    it('gives up after three retries, and a finished turn earns them back', async () => {
      const a = await submit();
      const token = await work(a);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await hook(a.id, 'StopFailure', token, outage);
        expect((await getRun(a.id)).autoRetry?.attempt).toBe(attempt);
        retryDue(a.id);
        await t.scheduler.tick();
        await expect.poll(async () => (await getRun(a.id)).state, { timeout: 5_000 }).toBe('starting');
        await hook(a.id, 'UserPromptSubmit', token);
      }
      await hook(a.id, 'StopFailure', token, outage);
      const gaveUp = await getRun(a.id);
      expect(gaveUp).toMatchObject({ state: 'waiting_input', autoRetry: null });
      expect(gaveUp.events.at(-1)).toMatchObject({ type: 'retry_gave_up', payload: { attempts: 3 } });

      await hook(a.id, 'UserPromptSubmit', token);
      await hook(a.id, 'Stop', token);
      await hook(a.id, 'UserPromptSubmit', token);
      await hook(a.id, 'StopFailure', token, outage);
      expect((await getRun(a.id)).autoRetry?.attempt).toBe(1);
    });

    it('never retries sign-in errors, and a stop cancels a pending retry', async () => {
      const a = await submit();
      const tokenA = await work(a);
      await hook(a.id, 'StopFailure', tokenA, {
        error: 'cli_exit',
        message: 'Error: 401 Unauthorized, please log in',
      });
      expect(await getRun(a.id)).toMatchObject({ state: 'waiting_input', autoRetry: null });

      await hook(a.id, 'UserPromptSubmit', tokenA);
      await hook(a.id, 'StopFailure', tokenA, outage);
      expect((await getRun(a.id)).state).toBe('rate_limited');
      await api('POST', `/api/runs/${a.id}/stop`);
      retryDue(a.id);
      await t.scheduler.tick();
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return (await getRun(a.id)).state;
          },
          { timeout: 5_000 },
        )
        .toBe('failed');
      expect((await getRun(a.id)).events.map((e) => e.type)).not.toContain('resumed');
    });
  });
});
