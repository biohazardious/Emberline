import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, SchedulerState } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quotaWindows, runs as runsTable } from './db/schema.js';
import { computeProjectRecommendations } from './factory/workspace-status.js';
import { updateFactorySettings } from './factory/settings.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;
let projectId = '';

/** A CLI stand-in: writes its token, args and env, then echoes lines until "exit". */
function writeFake(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      `echo "${name} $*" >> "${dir}/args-$EMBERLINE_RUN_ID"`,
      `echo "key=\${ANTHROPIC_API_KEY:-none}" >> "${dir}/env-$EMBERLINE_RUN_ID"`,
      `echo "credits=\${EMBERLINE_USE_CREDITS:-unset}" >> "${dir}/env-$EMBERLINE_RUN_ID"`,
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

beforeEach(async () => {
  t = await createTestApp();
  t.config.claudeCommand = writeFake(t.dir, 'fake-claude');
  process.env.EMBERLINE_ANTIGRAVITY_COMMAND = writeFake(t.dir, 'fake-agy');
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
  projectId = (await api('POST', '/api/projects', { name: 'Quota' })).json().project.id;
  updateFactorySettings(t.db, {
    enabledProviders: ['claude', 'antigravity'],
    personaRoutes: {
      ui_ux: [
        { agent: 'antigravity', model: 'argon', credential: 'login' },
        { agent: 'claude', model: 'opus', credential: 'login' },
      ],
    },
  });
});

/** True while a fake CLI started from this test's directory is still running. */
function fakeCliAlive(dir: string): boolean {
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir)) return true;
    } catch {
      // the process exited while we looked
    }
  }
  return false;
}

afterEach(async () => {
  delete process.env.EMBERLINE_ANTIGRAVITY_COMMAND;
  // Stop the agent sessions and let the fake CLIs exit before the directory is removed; under full-suite
  // load a process that is still writing makes the removal fail with ENOTEMPTY.
  t.scheduler.dispose();
  for (const run of t.runs.list()) {
    if (!run.endedAt) await t.runs.stop(run.id).catch(() => undefined);
  }
  await ptydServer.close();
  for (let i = 0; i < 100 && fakeCliAlive(t.dir); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  await t.close();
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
async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}
const getRun = async (id: string): Promise<RunDetail> => (await api('GET', `/api/runs/${id}`)).json();
const scheduler = async (): Promise<SchedulerState> => (await api('GET', '/api/scheduler')).json();
async function work(run: Run): Promise<string> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `sess-${run.id.slice(0, 4)}` });
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}
async function startTicket(title: string, persona = 'ui_ux'): Promise<{ ticketId: string; run: Run }> {
  const ticket = (await api('POST', `/api/projects/${projectId}/tickets`, { title, status: 'ready', persona })).json();
  const res = await api('POST', `/api/tickets/${ticket.id}/start`, {});
  expect(res.statusCode).toBe(201);
  return { ticketId: ticket.id, run: res.json().run };
}
const AGY_QUOTA = {
  error: 'cli_exit',
  message: 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h43m5s. AGY_ERROR: RESOURCE_EXHAUSTED (code 429)',
};

describe('runs carry their route', () => {
  it('stores the persona chain, the route and starts the route\'s CLI', async () => {
    const { run } = await startTicket('Colour-blind cats');
    expect(run).toMatchObject({ agent: 'antigravity', model: 'argon', credential: 'login', routeIndex: 0 });
    expect(run.routes).toEqual([
      { agent: 'antigravity', model: 'argon', credential: 'login' },
      { agent: 'claude', model: 'opus', credential: 'login' },
    ]);
    expect(run.prompt).not.toContain('[Preferred Agent:');
    expect(await waitFile(`args-${run.id}`)).toContain('fake-agy');
  });

  it('a login route gets no API key even when one is stored; an api_key route does', async () => {
    updateFactorySettings(t.db, {
      anthropicApiKey: 'sk-ant-test',
      personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    const { run } = await startTicket('Login only', 'coder');
    expect(await waitFile(`env-${run.id}`)).toContain('key=none');

    updateFactorySettings(t.db, { personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'api_key' }] } });
    const { run: paid } = await startTicket('Paid', 'qa');
    expect(await waitFile(`env-${paid.id}`)).toContain('key=sk-ant-test');
  });

  it('tells the agy seed whether this run may use AI credits', async () => {
    updateFactorySettings(t.db, { personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'credits' }] } });
    const { run } = await startTicket('Credits run');
    expect(run.credential).toBe('credits');
    expect(await waitFile(`env-${run.id}`)).toContain('credits=1');
  });

  it('a tagged ticket leads with the tag (even a disabled provider), strips it and keeps the persona chain after it', async () => {
    updateFactorySettings(t.db, { enabledProviders: ['claude'] });
    const ticket = (
      await api('POST', `/api/projects/${projectId}/tickets`, {
        title: 'Tagged',
        status: 'ready',
        persona: 'ui_ux',
        body: '[Preferred Agent: antigravity · Model: argon]\n\nDo the thing',
      })
    ).json();
    const run: Run = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json().run;
    expect(run.agent).toBe('antigravity');
    expect(run.routes).toEqual([
      { agent: 'antigravity', model: 'argon', credential: 'login' },
      { agent: 'claude', model: 'opus', credential: 'login' },
    ]);
    expect(run.prompt).not.toContain('[Preferred Agent:');
    expect(run.prompt).toContain('Do the thing');
  });

  it('a hand-picked agent runs alone and keeps the stored key on a key-only install', async () => {
    updateFactorySettings(t.db, {
      enabledProviders: ['antigravity'],
      anthropicApiKey: 'sk-ant-test',
      personaRoutes: { qa: [{ agent: 'antigravity', model: 'argon', credential: 'login' }] },
    });
    const run: Run = (await api('POST', '/api/runs', { projectId, persona: 'qa', agent: 'claude', prompt: 'hi' })).json();
    expect(run.routes).toHaveLength(1);
    expect(run).toMatchObject({ agent: 'claude', credential: 'api_key' });
    expect(await waitFile(`env-${run.id}`)).toContain('key=sk-ant-test');
  });

  it('a model-only request keeps the persona\'s first agent and the rest of its chain', async () => {
    const run: Run = (await api('POST', '/api/runs', { projectId, persona: 'ui_ux', model: 'sonnet', prompt: 'hi' })).json();
    expect(run.routes[0]!.agent).toBe('antigravity');
    expect(run.agent).toBe('antigravity');
    updateFactorySettings(t.db, { personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] } });
    const coder: Run = (await api('POST', '/api/runs', { projectId, persona: 'coder', model: 'sonnet', prompt: 'hi' })).json();
    expect(coder).toMatchObject({ agent: 'claude', model: 'sonnet' });
  });

  it('a legacy run row (no stored routes) still gets the stored key when it is launched', async () => {
    updateFactorySettings(t.db, { anthropicApiKey: 'sk-ant-test' });
    const queued = await t.runs.enqueue({ projectId, agent: 'claude', prompt: 'old' } as never);
    t.db.update(runsTable).set({ routes: [], credential: 'login' }).where(eq(runsTable.id, queued.id)).run();
    await t.runs.launch(queued.id);
    expect(await waitFile(`env-${queued.id}`)).toContain('key=sk-ant-test');
  });

  it('enqueue continues in a given worktree instead of creating one', async () => {
    const first: Run = (await api('POST', '/api/runs', { projectId, agent: 'claude', prompt: 'a' })).json();
    const second = await t.runs.enqueue(
      { projectId, agent: 'claude', prompt: 'b' } as never,
      { worktree: { path: first.worktreePath, branch: first.branch } },
    );
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branch).toBe(first.branch);
  });
});

describe('handoff', () => {
  it('continues a run as a successor in the same worktree and branch', async () => {
    const { run } = await startTicket('Colour-blind cats');
    const token = await work(run);
    await hook(run.id, 'StopFailure', token, AGY_QUOTA);

    const successor: Run = await t.runs.handOff(run.id, { agent: 'claude', model: 'opus', credential: 'login' }, {
      reason: 'Individual quota reached',
      source: 'system',
      automatic: true,
    });
    expect(successor).toMatchObject({
      agent: 'claude',
      model: 'opus',
      routeIndex: 1,
      predecessorRunId: run.id,
      worktreePath: run.worktreePath,
      branch: run.branch,
      ticketId: run.ticketId,
    });
    expect(successor.prompt).toContain('You are taking over a task from another agent, antigravity (argon)');

    const before = await getRun(run.id);
    expect(before).toMatchObject({ state: 'done', handedOffTo: successor.id });
    expect(before.endedAt).not.toBeNull();
    expect(before.events.at(-1)).toMatchObject({ type: 'handed_off', payload: { toRunId: successor.id } });
    // Only one live run on the ticket, and it is the successor.
    expect(t.runs.activeRunForTicket(run.ticketId ?? '')?.id).toBe(successor.id);
    // Twice is refused.
    await expect(t.runs.handOff(run.id, { agent: 'claude', model: 'opus', credential: 'login' }, { reason: 'x', source: 'user', automatic: false })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('resumes a Gemini run without session support with the handoff prompt, not a bare "continue"', async () => {
    process.env.EMBERLINE_GEMINI_COMMAND = path.join(t.dir, 'fake-gemini');
    try {
      writeFake(t.dir, 'fake-gemini');
      updateFactorySettings(t.db, { enabledProviders: ['claude', 'antigravity', 'gemini'], personaRoutes: { qa: [{ agent: 'gemini', model: 'gemini-pro', credential: 'login' }] } });
      const { run } = await startTicket('Regression matrix', 'qa');
      const token = await work(run);
      await hook(run.id, 'Stop', token);
      await t.ptyd.get().write(run.terminalId ?? '', 'exit\r');
      await expect.poll(async () => { await t.runs.reconcile(); return (await getRun(run.id)).endedAt; }, { timeout: 5_000 }).not.toBeNull();
      const resumed = await t.runs.resume(run.id);
      expect(resumed).toMatchObject({ id: run.id, agent: 'gemini' });
      await expect.poll(() => readFileSync(path.join(t.dir, `args-${run.id}`), 'utf8'), { timeout: 5_000 }).toContain('Your previous session on this task ended');
      expect(readFileSync(path.join(t.dir, `args-${run.id}`), 'utf8')).not.toContain('--resume');
    } finally {
      delete process.env.EMBERLINE_GEMINI_COMMAND;
    }
  });

  const CLAUDE_OPUS = { agent: 'claude', model: 'opus', credential: 'login' } as const;

  const count = (id: string) => t.db.select().from(runsTable).where(eq(runsTable.id, id)).get()?.handoffCount;

  async function stopped(): Promise<{ run: Run; ticketId: string }> {
    const { run, ticketId } = await startTicket('Colour-blind cats');
    const token = await work(run);
    await hook(run.id, 'StopFailure', token, AGY_QUOTA);
    return { run, ticketId };
  }

  it('a manual handoff to a route outside the chain appends it and does not count against the budget', async () => {
    const { run } = await stopped();
    const route = { agent: 'claude', model: 'sonnet', credential: 'login' } as const;
    const successor: Run = await t.runs.handOff(run.id, route, { reason: 'user', source: 'user', automatic: false });
    expect(successor.routes).toHaveLength(3);
    expect(successor.routes[2]).toEqual(route);
    expect(successor).toMatchObject({ routeIndex: 2, model: 'sonnet' });
    expect(count(successor.id)).toBe(0);
  });

  it('an automatic handoff counts against the budget', async () => {
    const { run } = await stopped();
    const successor: Run = await t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'q', source: 'system', automatic: true });
    expect(count(successor.id)).toBe(1);
  });

  it('refuses to hand off a stopped or a working run', async () => {
    const { run } = await startTicket('Working');
    await work(run);
    await expect(t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'x', source: 'user', automatic: false })).rejects.toMatchObject({ statusCode: 409 });
    await t.runs.stop(run.id);
    await expect(t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'x', source: 'user', automatic: false })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('two concurrent handoffs of one run create exactly one successor', async () => {
    const { run, ticketId } = await stopped();
    const attempt = () => t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'q', source: 'system', automatic: true });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409 });
    expect(t.runs.list().filter((r) => r.ticketId === ticketId && r.predecessorRunId === run.id)).toHaveLength(1);
  });

  it('a handed-off run cannot be resumed, and a cancelled queued run cannot be re-bound', async () => {
    const { run } = await stopped();
    const successor: Run = await t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'q', source: 'system', automatic: true });
    const before = t.runs.list().length;
    await expect(t.runs.resume(run.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(successor.id.slice(0, 8)) });
    expect(t.runs.list()).toHaveLength(before);
    expect((await getRun(run.id)).terminalId).toBe(run.terminalId);
    const queued = await t.runs.enqueue({ projectId, agent: 'claude', prompt: 'q' } as never);
    t.db.update(runsTable).set({ cancelledAt: new Date() }).where(eq(runsTable.id, queued.id)).run();
    expect(() => t.runs.bindRoute(queued.id, 0)).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

describe('lanes and policy', () => {
  it('an Antigravity quota waits on its own lane while Claude keeps dispatching (wait policy)', async () => {
    const { run } = await startTicket('Colour-blind cats');
    const token = await work(run);
    const res = await hook(run.id, 'StopFailure', token, AGY_QUOTA);
    expect(res.json().state).toBe('rate_limited');

    const state = await scheduler();
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]).toMatchObject({ agent: 'antigravity', credential: 'login', pool: '*', resetSource: 'hook' });

    // Claude work is not paused…
    const coder = await startTicket('Coder work', 'coder');
    await expect.poll(async () => (await getRun(coder.run.id)).state, { timeout: 5_000 }).toBe('starting');
    // …but new Antigravity work waits (policy newRuns = wait).
    const second = await startTicket('More UI', 'ui_ux');
    expect((await getRun(second.run.id)).state).toBe('queued');
    // and the limited run was not handed off (policy inFlight = wait).
    expect((await getRun(run.id)).handedOffTo).toBeNull();
  });

  it('a Claude provider-wide window does not stop Antigravity', async () => {
    updateFactorySettings(t.db, { personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] } });
    const coder = await startTicket('Coder', 'coder');
    const token = await work(coder.run);
    await hook(coder.run.id, 'StopFailure', token, { error: 'rate_limit', last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}` });
    const ui = await startTicket('UI', 'ui_ux');
    await expect.poll(async () => (await getRun(ui.run.id)).state, { timeout: 5_000 }).toBe('starting');
  });

  it('newRuns = fallback starts a queued run on the next open route', async () => {
    updateFactorySettings(t.db, { quotaPolicy: { newRuns: 'fallback' } });
    const first = await startTicket('First UI');
    await hook(first.run.id, 'StopFailure', await work(first.run), AGY_QUOTA);
    const second = await startTicket('Second UI');
    await expect.poll(async () => (await getRun(second.run.id)).state, { timeout: 5_000 }).toBe('starting');
    const bound = await getRun(second.run.id);
    expect(bound).toMatchObject({ agent: 'claude', model: 'opus', routeIndex: 1 });
    expect(bound.events.map((e) => e.type)).toContain('route_bound');
    expect(await waitFile(`args-${second.run.id}`)).toContain('fake-claude');
  });

  it('inFlight = fallback hands a limited run off to the next route at once', async () => {
    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    const { run } = await startTicket('Colour-blind cats');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    await expect.poll(async () => (await getRun(run.id)).handedOffTo, { timeout: 5_000 }).not.toBeNull();
    const successorId = (await getRun(run.id)).handedOffTo ?? '';
    await expect.poll(async () => (await getRun(successorId)).state, { timeout: 5_000 }).toBe('starting');
    expect(await getRun(successorId)).toMatchObject({ agent: 'claude', predecessorRunId: run.id, worktreePath: run.worktreePath });
  });

  it('stops handing off after MAX_HANDOFFS and waits instead', async () => {
    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    const { run } = await startTicket('Ping pong');
    t.db.update(runsTable).set({ handoffCount: 3 }).where(eq(runsTable.id, run.id)).run();
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
  });

  it('manual handoff: refused onto a closed lane, accepted onto an open one', async () => {
    const { run } = await startTicket('Manual');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const closed = await api('POST', `/api/runs/${run.id}/handoff`, { route: { agent: 'antigravity', model: 'gemini-pro', credential: 'login' } });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('lane_exhausted');
    const ok = await api('POST', `/api/runs/${run.id}/handoff`, { route: { agent: 'claude', model: 'sonnet', credential: 'login' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ agent: 'claude', model: 'sonnet', predecessorRunId: run.id });
  });

  it('manual handoff: 404 for an unknown run, refuses routes that cannot run, and leaves the run alone', async () => {
    const { run } = await startTicket('Manual guards');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const missing = await api('POST', '/api/runs/no-such-run/handoff', { route: { agent: 'antigravity', model: 'argon', credential: 'login' } });
    expect(missing.statusCode).toBe(404);
    const unsupported = await api('POST', `/api/runs/${run.id}/handoff`, { route: { agent: 'antigravity', model: 'argon', credential: 'api_key' } });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error).toBe('route_unsupported');
    const noKey = await api('POST', `/api/runs/${run.id}/handoff`, { route: { agent: 'claude', model: 'opus', credential: 'api_key' } });
    expect(noKey.statusCode).toBe(409);
    expect(noKey.json().error).toBe('route_unusable');
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
  });

  it('resume-now rejects an empty lane field instead of resuming every lane', async () => {
    const { run } = await startTicket('UI');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const res = await api('POST', '/api/scheduler/resume', { agent: '' });
    expect(res.statusCode).toBe(400);
    expect((await scheduler()).windows).toHaveLength(1);
  });

  it('a failure while recording a limit is noted on the run, not left as an unhandled rejection', async () => {
    const { run } = await startTicket('Broken DB');
    const token = await work(run);
    const sched = t.scheduler as unknown as { recordLimit: () => void };
    sched.recordLimit = () => {
      throw new Error('disk I/O error');
    };
    await hook(run.id, 'StopFailure', token, AGY_QUOTA);
    await expect.poll(async () => (await getRun(run.id)).events.map((e) => e.type), { timeout: 5_000 }).toContain('rate_limit_failed');
  });

  it('resume-now ends one lane only', async () => {
    const { run } = await startTicket('UI');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const coder = await startTicket('Coder', 'coder');
    await hook(coder.run.id, 'StopFailure', await work(coder.run), { error: 'rate_limit', last_assistant_message: '5-hour limit reached ∙ resets 11:59pm (UTC)' });
    expect((await scheduler()).windows).toHaveLength(2);
    const after: SchedulerState = (await api('POST', '/api/scheduler/resume', { agent: 'antigravity', credential: 'login', pool: '*' })).json();
    expect(after.windows.map((w) => w.agent)).toEqual(['claude']);
  });

  it('a pre-0.2.0 Claude window (default lane columns) still pauses Claude and resumes it', async () => {
    t.db.insert(quotaWindows).values({ id: 'legacy', exhaustedAt: new Date(), resumeAt: new Date(Date.now() - 1_000), source: 'hook' }).run();
    const state = await scheduler();
    expect(state.windows[0]).toMatchObject({ agent: 'claude', credential: 'login', pool: '*' });
    await t.scheduler.tick();
    expect((await scheduler()).windows).toHaveLength(0);
  });

  it('skips an API-key fallback whose key was deleted', async () => {
    updateFactorySettings(t.db, {
      quotaPolicy: { inFlight: 'fallback' },
      personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'login' }, { agent: 'claude', model: 'opus', credential: 'api_key' }] },
    });
    const { run } = await startTicket('No key');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    await expect.poll(async () => (await getRun(run.id)).events.map((e) => e.type), { timeout: 5_000 }).toContain('route_skipped');
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
  });
});

describe('handed-off runs are not finished work', () => {
  async function handedOff(seen: string[] = [], pipeline: string[] = []) {
    const { ticketId, run } = await startTicket('Colour-blind cats');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    // The successor's own events move the ticket back to in_progress, so watch every transition.
    t.tickets.on('ticket', (tk) => seen.push(tk.status));
    const tickets = t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> };
    const original = tickets.handleRunCompleted.bind(t.tickets);
    tickets.handleRunCompleted = (r) => {
      pipeline.push(r.id);
      return original(r);
    };
    const successor = await t.runs.handOff(
      run.id,
      { agent: 'claude', model: 'opus', credential: 'login' },
      { reason: 'quota', source: 'system', automatic: true },
    );
    return { ticketId, run, successor };
  }

  it('does not run the pipeline or move the ticket; the successor finishing does', async () => {
    const seen: string[] = [];
    const pipeline: string[] = [];
    const { ticketId, run, successor } = await handedOff(seen, pipeline);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pipeline).not.toContain(run.id);
    expect(seen).not.toContain('review');
    expect(seen).not.toContain('done');
    const events = (await getRun(run.id)).events.map((e) => e.type);
    expect(events).not.toContain('merged_to_main');
    expect(events).not.toContain('pipeline_failed');
    expect((await api('GET', `/api/tickets/${ticketId}`)).json().status).toBe('in_progress');

    const token = await work(successor);
    await hook(successor.id, 'Stop', token);
    await expect
      .poll(async () => (await api('GET', `/api/tickets/${ticketId}`)).json().status, { timeout: 5_000 })
      .not.toBe('in_progress');
  });

  it('does not count successors against the daily auto-run budget', async () => {
    const { run } = await handedOff();
    expect(t.tickets.runsLast24h(run.projectId)).toBe(1);
  });

  it('GC keeps the worktree the successor is working in', async () => {
    const { run, successor } = await handedOff();
    const res = await api('POST', `/api/runs/${run.id}/worktree/prune`);
    expect(res.statusCode).toBe(409);
    expect(existsSync(successor.worktreePath)).toBe(true);
  });
});

describe('workspace status ignores handed-off runs', () => {
  it('a handed-off coder run does not trigger the QA recommendation', () => {
    const recommend = (handedOffTo: string | null) =>
      computeProjectRecommendations(
        { id: 'p' } as never,
        { exists: true, content: 'x'.repeat(200) } as never,
        [],
        [{ id: 'r', state: 'done', persona: 'coder', handedOffTo }] as never,
      ).map((r) => r.id);
    expect(recommend(null)).toContain('run-qa-verification');
    expect(recommend('successor')).not.toContain('run-qa-verification');
  });
});

export { api, AGY_QUOTA, getRun, hook, scheduler, startTicket, waitFile, work };
