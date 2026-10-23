import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, SchedulerState } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as orchestration from './factory/orchestration.js';
import { quotaWindows, runs as runsTable, tickets as ticketsTable } from './db/schema.js';
import { computeProjectRecommendations } from './factory/workspace-status.js';
import { updateFactorySettings } from './factory/settings.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { rmTemp } from './test-rm.js';

vi.mock('./factory/orchestration.js', async (orig) => {
  const actual = await orig<typeof orchestration>();
  return { ...actual, buildFactoryOrchestratorPrompt: vi.fn(actual.buildFactoryOrchestratorPrompt) };
});

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
      // One write: the tests read the env file as soon as it exists, so it appears whole.
      `printf 'key=%s\\ncredits=%s\\n' "\${ANTHROPIC_API_KEY:-none}" "\${EMBERLINE_USE_CREDITS:-unset}" > "${dir}/.env-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.env-$EMBERLINE_RUN_ID" "${dir}/env-$EMBERLINE_RUN_ID"`,
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
    antigravityTermsAcknowledged: true,
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
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc');
  } catch {
    return false; // no /proc: nothing to wait for
  }
  for (const pid of pids) {
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
  for (let i = 0; i < 100 && fakeCliAlive(t.dir); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
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
const getRun = async (id: string): Promise<RunDetail> => (await api('GET', `/api/runs/${id}`)).json();
const scheduler = async (): Promise<SchedulerState> => (await api('GET', '/api/scheduler')).json();
async function work(run: Run): Promise<string> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `sess-${run.id.slice(0, 4)}` });
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}
/** Autonomous by default: Antigravity, the ui_ux lane, refuses Ask and Accept edits. */
async function startTicket(
  title: string,
  persona = 'ui_ux',
  body: object = { permissionMode: 'auto' },
): Promise<{ ticketId: string; run: Run }> {
  const ticket = (
    await api('POST', `/api/projects/${projectId}/tickets`, { title, status: 'ready', persona })
  ).json();
  const res = await api('POST', `/api/tickets/${ticket.id}/start`, body);
  expect(res.statusCode).toBe(201);
  return { ticketId: ticket.id, run: res.json().run };
}
const AGY_QUOTA = {
  error: 'cli_exit',
  message:
    'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h43m5s. AGY_ERROR: RESOURCE_EXHAUSTED (code 429)',
};

describe('runs carry their route', () => {
  it("stores the persona chain, the route and starts the route's CLI", async () => {
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

    updateFactorySettings(t.db, {
      personaRoutes: { qa: [{ agent: 'claude', model: 'sonnet', credential: 'api_key' }] },
    });
    const { run: paid } = await startTicket('Paid', 'qa');
    expect(await waitFile(`env-${paid.id}`)).toContain('key=sk-ant-test');
  });

  it('tells the agy seed whether this run may use AI credits', async () => {
    updateFactorySettings(t.db, {
      personaRoutes: { ui_ux: [{ agent: 'antigravity', model: 'argon', credential: 'credits' }] },
    });
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
    const run: Run = (await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'auto' })).json()
      .run;
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
      antigravityTermsAcknowledged: true,
      anthropicApiKey: 'sk-ant-test',
      personaRoutes: { qa: [{ agent: 'antigravity', model: 'argon', credential: 'login' }] },
    });
    const run: Run = (
      await api('POST', '/api/runs', { projectId, persona: 'qa', agent: 'claude', prompt: 'hi' })
    ).json();
    expect(run.routes).toHaveLength(1);
    expect(run).toMatchObject({ agent: 'claude', credential: 'api_key' });
    expect(await waitFile(`env-${run.id}`)).toContain('key=sk-ant-test');
  });

  it("a model-only request keeps the persona's first agent and the rest of its chain", async () => {
    const run: Run = (
      await api('POST', '/api/runs', {
        projectId,
        persona: 'ui_ux',
        model: 'sonnet',
        prompt: 'hi',
        permissionMode: 'auto',
      })
    ).json();
    expect(run.routes[0]!.agent).toBe('antigravity');
    expect(run.agent).toBe('antigravity');
    updateFactorySettings(t.db, {
      personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    const coder: Run = (
      await api('POST', '/api/runs', { projectId, persona: 'coder', model: 'sonnet', prompt: 'hi' })
    ).json();
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
    const second = await t.runs.enqueue({ projectId, agent: 'claude', prompt: 'b' } as never, {
      worktree: { path: first.worktreePath, branch: first.branch },
    });
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branch).toBe(first.branch);
  });
});

describe('handoff', () => {
  it('keeps the ticket completion: the successor continues the same work', async () => {
    const { ticketId, run } = await startTicket('Keep my handoff');
    const token = await work(run);
    const completion = {
      runId: run.id,
      summary: 'half way',
      handoff: 'see notes.md',
      blockers: [],
      at: '2026-10-17T10:00:00.000Z',
    };
    t.db.update(ticketsTable).set({ completion }).where(eq(ticketsTable.id, ticketId)).run();
    await hook(run.id, 'StopFailure', token, AGY_QUOTA);
    const successor: Run = await t.runs.handOff(
      run.id,
      { agent: 'claude', model: 'opus', credential: 'login' },
      {
        reason: 'Individual quota reached',
        source: 'system',
        automatic: true,
      },
    );
    expect(successor.ticketId).toBe(ticketId);
    expect((await api('GET', `/api/tickets/${ticketId}`)).json().completion).toEqual(completion);
  });

  it('continues a run as a successor in the same worktree and branch', async () => {
    const { run } = await startTicket('Colour-blind cats');
    const token = await work(run);
    await hook(run.id, 'StopFailure', token, AGY_QUOTA);

    const successor: Run = await t.runs.handOff(
      run.id,
      { agent: 'claude', model: 'opus', credential: 'login' },
      {
        reason: 'Individual quota reached',
        source: 'system',
        automatic: true,
      },
    );
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
    await expect(
      t.runs.handOff(
        run.id,
        { agent: 'claude', model: 'opus', credential: 'login' },
        { reason: 'x', source: 'user', automatic: false },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('resumes a Gemini run without session support with the handoff prompt, not a bare "continue"', async () => {
    process.env.EMBERLINE_GEMINI_COMMAND = path.join(t.dir, 'fake-gemini');
    try {
      writeFake(t.dir, 'fake-gemini');
      updateFactorySettings(t.db, {
        enabledProviders: ['claude', 'antigravity', 'gemini'],
        antigravityTermsAcknowledged: true,
        personaRoutes: { qa: [{ agent: 'gemini', model: 'gemini-pro', credential: 'login' }] },
      });
      const { run } = await startTicket('Regression matrix', 'qa');
      const token = await work(run);
      await hook(run.id, 'Stop', token);
      await t.ptyd.get().write(run.terminalId ?? '', 'exit\r');
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return (await getRun(run.id)).endedAt;
          },
          { timeout: 5_000 },
        )
        .not.toBeNull();
      const resumed = await t.runs.resume(run.id);
      expect(resumed).toMatchObject({ id: run.id, agent: 'gemini' });
      await expect
        .poll(() => readFileSync(path.join(t.dir, `args-${run.id}`), 'utf8'), { timeout: 5_000 })
        .toContain('Your previous session on this task ended');
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
    const successor: Run = await t.runs.handOff(run.id, route, {
      reason: 'user',
      source: 'user',
      automatic: false,
    });
    expect(successor.routes).toHaveLength(3);
    expect(successor.routes[2]).toEqual(route);
    expect(successor).toMatchObject({ routeIndex: 2, model: 'sonnet' });
    expect(count(successor.id)).toBe(0);
  });

  it('an automatic handoff counts against the budget', async () => {
    const { run } = await stopped();
    const successor: Run = await t.runs.handOff(run.id, CLAUDE_OPUS, {
      reason: 'q',
      source: 'system',
      automatic: true,
    });
    expect(count(successor.id)).toBe(1);
  });

  it('refuses to hand off a stopped or a working run', async () => {
    const { run } = await startTicket('Working');
    await work(run);
    await expect(
      t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'x', source: 'user', automatic: false }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await t.runs.stop(run.id);
    await expect(
      t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'x', source: 'user', automatic: false }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('two concurrent handoffs of one run create exactly one successor', async () => {
    const { run, ticketId } = await stopped();
    const attempt = () =>
      t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'q', source: 'system', automatic: true });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409 });
    expect(
      t.runs.list().filter((r) => r.ticketId === ticketId && r.predecessorRunId === run.id),
    ).toHaveLength(1);
  });

  /** Holds the handoff while its context (worktree status, diff) is built, so a stop or resume can land in that gap. */
  function holdHandoffContext(): { reached: () => boolean; release: () => void } {
    const svc = t.runs as unknown as { handoffContext: (...args: unknown[]) => Promise<unknown> };
    const original = svc.handoffContext.bind(t.runs);
    let release: (() => void) | undefined;
    svc.handoffContext = async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    };
    return { reached: () => release !== undefined, release: () => release?.() };
  }

  it('a stop while the handoff prompt is being built wins: 409, no successor', async () => {
    const { run, ticketId } = await stopped();
    const gate = holdHandoffContext();
    const pending = t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'q', source: 'system', automatic: true });
    await expect.poll(gate.reached).toBe(true);
    await t.runs.stop(run.id);
    gate.release();
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(
      t.runs.list().filter((r) => r.ticketId === ticketId && r.predecessorRunId === run.id),
    ).toHaveLength(0);
    expect(await getRun(run.id)).toMatchObject({ handedOffTo: null, cancelled: true });
  });

  it('a resume while the handoff prompt is being built wins: 409, no successor, the run keeps working', async () => {
    const { run, ticketId } = await stopped();
    // An interactive session (started without a prompt) takes the typed continue; a one-shot `-p` one
    // is refused while it exits (session_closing) and respawned once it has.
    t.db.update(runsTable).set({ prompt: '' }).where(eq(runsTable.id, run.id)).run();
    const gate = holdHandoffContext();
    const pending = t.runs.handOff(run.id, CLAUDE_OPUS, { reason: 'q', source: 'system', automatic: true });
    await expect.poll(gate.reached).toBe(true);
    await t.runs.resume(run.id);
    gate.release();
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(
      t.runs.list().filter((r) => r.ticketId === ticketId && r.predecessorRunId === run.id),
    ).toHaveLength(0);
    expect(await getRun(run.id)).toMatchObject({ state: 'starting', handedOffTo: null, endedAt: null });
  });

  it('a handed-off run cannot be resumed, and a cancelled queued run cannot be re-bound', async () => {
    const { run } = await stopped();
    const successor: Run = await t.runs.handOff(run.id, CLAUDE_OPUS, {
      reason: 'q',
      source: 'system',
      automatic: true,
    });
    const before = t.runs.list().length;
    await expect(t.runs.resume(run.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(successor.id.slice(0, 8)),
    });
    expect(t.runs.list()).toHaveLength(before);
    expect((await getRun(run.id)).terminalId).toBe(run.terminalId);
    // The UI offers "Re-open" / "Resume now" for resumable runs; this one only refuses them.
    expect(await getRun(run.id)).toMatchObject({ handedOffTo: successor.id, resumable: false });
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
    expect(state.windows[0]).toMatchObject({
      agent: 'antigravity',
      credential: 'login',
      pool: '*',
      resetSource: 'hook',
    });

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
    updateFactorySettings(t.db, {
      personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    const coder = await startTicket('Coder', 'coder');
    const token = await work(coder.run);
    await hook(coder.run.id, 'StopFailure', token, {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`,
    });
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
    expect(await getRun(successorId)).toMatchObject({
      agent: 'claude',
      predecessorRunId: run.id,
      worktreePath: run.worktreePath,
    });
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
    const closed = await api('POST', `/api/runs/${run.id}/handoff`, {
      route: { agent: 'antigravity', model: 'gemini-pro', credential: 'login' },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('lane_exhausted');
    const ok = await api('POST', `/api/runs/${run.id}/handoff`, {
      route: { agent: 'claude', model: 'sonnet', credential: 'login' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ agent: 'claude', model: 'sonnet', predecessorRunId: run.id });
  });

  it('manual handoff: 404 for an unknown run, refuses routes that cannot run, and leaves the run alone', async () => {
    const { run } = await startTicket('Manual guards');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const missing = await api('POST', '/api/runs/no-such-run/handoff', {
      route: { agent: 'antigravity', model: 'argon', credential: 'login' },
    });
    expect(missing.statusCode).toBe(404);
    const unsupported = await api('POST', `/api/runs/${run.id}/handoff`, {
      route: { agent: 'antigravity', model: 'argon', credential: 'api_key' },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error).toBe('route_unsupported');
    const noKey = await api('POST', `/api/runs/${run.id}/handoff`, {
      route: { agent: 'claude', model: 'opus', credential: 'api_key' },
    });
    expect(noKey.statusCode).toBe(409);
    expect(noKey.json().error).toBe('route_unusable');
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
  });

  it('manual handoff: only for a waiting, failed or limited run whose worktree still exists', async () => {
    const route = { agent: 'claude', model: 'sonnet', credential: 'login' };
    t.scheduler.update({ maxConcurrentRuns: 6 }); // the successors take slots too
    const { run } = await startTicket('Finished');
    await work(run);
    t.db.update(runsTable).set({ state: 'done', endedAt: new Date() }).where(eq(runsTable.id, run.id)).run();
    const done = await api('POST', `/api/runs/${run.id}/handoff`, { route });
    expect(done.statusCode).toBe(409);
    expect(done.json().error).toBe('run_not_waiting');

    for (const state of ['failed', 'waiting_input'] as const) {
      const { run: other } = await startTicket(`Waiting ${state}`);
      await work(other);
      t.db.update(runsTable).set({ state }).where(eq(runsTable.id, other.id)).run();
      const ok = await api('POST', `/api/runs/${other.id}/handoff`, { route });
      expect(ok.statusCode, state).toBe(201);
    }

    const { run: pruned } = await startTicket('Pruned');
    await hook(pruned.id, 'StopFailure', await work(pruned), AGY_QUOTA);
    rmTemp(pruned.worktreePath);
    const missing = await api('POST', `/api/runs/${pruned.id}/handoff`, { route });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toBe('worktree_missing');
    expect(await getRun(pruned.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
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
    await expect
      .poll(async () => (await getRun(run.id)).events.map((e) => e.type), { timeout: 5_000 })
      .toContain('rate_limit_failed');
  });

  it('resume-now ends one lane only', async () => {
    const { run } = await startTicket('UI');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const coder = await startTicket('Coder', 'coder');
    await hook(coder.run.id, 'StopFailure', await work(coder.run), {
      error: 'rate_limit',
      last_assistant_message: '5-hour limit reached ∙ resets 11:59pm (UTC)',
    });
    expect((await scheduler()).windows).toHaveLength(2);
    const after: SchedulerState = (
      await api('POST', '/api/scheduler/resume', { agent: 'antigravity', credential: 'login', pool: '*' })
    ).json();
    expect(after.windows.map((w) => w.agent)).toEqual(['claude']);
  });

  it('a pre-0.2.0 Claude window (default lane columns) still pauses Claude and resumes it', async () => {
    t.db
      .insert(quotaWindows)
      .values({
        id: 'legacy',
        exhaustedAt: new Date(),
        resumeAt: new Date(Date.now() - 1_000),
        source: 'hook',
      })
      .run();
    const state = await scheduler();
    expect(state.windows[0]).toMatchObject({ agent: 'claude', credential: 'login', pool: '*' });
    await t.scheduler.tick();
    expect((await scheduler()).windows).toHaveLength(0);
  });

  it('a live pre-0.2.0 window (future resumeAt) holds Claude runs but not Antigravity runs', async () => {
    // Only the required columns: agent, credential and pool take their defaults (claude, login, *).
    t.db
      .insert(quotaWindows)
      .values({
        id: 'legacy-live',
        exhaustedAt: new Date(),
        resumeAt: new Date(Date.now() + 3_600_000),
        source: 'hook',
      })
      .run();
    const claude = await startTicket('Claude work', 'coder');
    const agy = await startTicket('Antigravity work', 'ui_ux');
    await expect.poll(async () => (await getRun(agy.run.id)).state, { timeout: 5_000 }).toBe('starting');
    expect(await getRun(agy.run.id)).toMatchObject({ agent: 'antigravity' });
    expect((await getRun(claude.run.id)).state).toBe('queued');
    await t.scheduler.tick();
    expect((await getRun(claude.run.id)).state).toBe('queued');
  });

  it('a legacy rate-limited row behind a legacy window waits while it is open and resumes once it has passed', async () => {
    const { run } = await startTicket('Legacy limit', 'coder');
    await work(run);
    // A pre-0.2.0 row: no stored chain, no model column, the column-default credential; and a window with default lane columns.
    t.db
      .update(runsTable)
      .set({ state: 'rate_limited', routes: [], model: null, credential: 'login' })
      .where(eq(runsTable.id, run.id))
      .run();
    t.db
      .insert(quotaWindows)
      .values({
        id: 'legacy-open',
        exhaustedAt: new Date(),
        resumeAt: new Date(Date.now() + 3_600_000),
        source: 'hook',
      })
      .run();
    await t.scheduler.tick();
    expect((await getRun(run.id)).state).toBe('rate_limited');
    expect((await scheduler()).windows).toMatchObject([{ agent: 'claude', credential: 'login', pool: '*' }]);

    t.db
      .update(quotaWindows)
      .set({ resumeAt: new Date(Date.now() - 1_000) })
      .where(eq(quotaWindows.id, 'legacy-open'))
      .run();
    await t.scheduler.tick();
    const resumed = await getRun(run.id);
    expect(resumed.state).toBe('starting');
    expect(resumed.events.map((e) => e.type)).toContain('resumed');
    await expect
      .poll(() => readFileSync(path.join(t.dir, `lines-${run.id}`), 'utf8'), { timeout: 5_000 })
      .toMatch(/continue/i);
  });

  it("a screen banner narrows the hook's reset-less window in place instead of adding a second one", async () => {
    updateFactorySettings(t.db, {
      personaRoutes: { coder: [{ agent: 'claude', model: 'opus', credential: 'login' }] },
    });
    const coder = await startTicket('Coder', 'coder');
    t.runs.screen = async () => 'Opus weekly limit reached ∙ resets Oct 30, 9am (UTC)\n';
    await hook(coder.run.id, 'StopFailure', await work(coder.run), { error: 'rate_limit' });
    await expect
      .poll(async () => (await scheduler()).windows[0]?.resetSource, { timeout: 5_000 })
      .toBe('screen');
    const windows = (await scheduler()).windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ agent: 'claude', pool: 'opus' });
    expect(windows[0]?.resetsAt).toBeTruthy();
  });

  it("forgets a run's route_skipped memory once the run ends", async () => {
    updateFactorySettings(t.db, {
      quotaPolicy: { inFlight: 'fallback' },
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'api_key' },
        ],
      },
    });
    const { run } = await startTicket('No key');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const skipped = (t.scheduler as unknown as { skipped: Set<string> }).skipped;
    await expect.poll(() => skipped.size, { timeout: 5_000 }).toBeGreaterThan(0);
    await t.runs.stop(run.id);
    await expect.poll(() => skipped.size, { timeout: 5_000 }).toBe(0);
  });

  it("keeps a waiting run's route_skipped memory after its agent process exited", async () => {
    updateFactorySettings(t.db, {
      quotaPolicy: { inFlight: 'fallback' },
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'api_key' },
        ],
      },
    });
    const { run } = await startTicket('No key');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    const skipped = (t.scheduler as unknown as { skipped: Set<string> }).skipped;
    await expect.poll(() => skipped.size, { timeout: 5_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await getRun(run.id)).state, { timeout: 5_000 }).toBe('rate_limited');
    // The process is gone while the run waits for the reset: it still waits, so the note stays once-only.
    t.db.update(runsTable).set({ endedAt: new Date() }).where(eq(runsTable.id, run.id)).run();
    t.runs.note(run.id, 'probe');
    expect(skipped.size).toBeGreaterThan(0);
    await t.scheduler.tick();
    expect((await getRun(run.id)).events.filter((e) => e.type === 'route_skipped')).toHaveLength(1);
  });

  it('skips an API-key fallback whose key was deleted', async () => {
    updateFactorySettings(t.db, {
      quotaPolicy: { inFlight: 'fallback' },
      personaRoutes: {
        ui_ux: [
          { agent: 'antigravity', model: 'argon', credential: 'login' },
          { agent: 'claude', model: 'opus', credential: 'api_key' },
        ],
      },
    });
    const { run } = await startTicket('No key');
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    await expect
      .poll(async () => (await getRun(run.id)).events.map((e) => e.type), { timeout: 5_000 })
      .toContain('route_skipped');
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
  });
});

describe('waiting runs follow the in-flight policy and reopening lanes', () => {
  /** An Antigravity run limited on its own lane, waiting as `rate_limited`. */
  async function waiting(title = 'Colour-blind cats'): Promise<Run> {
    const { run } = await startTicket(title);
    await hook(run.id, 'StopFailure', await work(run), AGY_QUOTA);
    await expect.poll(async () => (await getRun(run.id)).state, { timeout: 5_000 }).toBe('rate_limited');
    return run;
  }
  /** Closes the Claude lane too, so the run has no open fallback route. */
  const closeClaude = () =>
    t.db
      .insert(quotaWindows)
      .values({
        id: 'claude-closed',
        exhaustedAt: new Date(),
        resumeAt: new Date(Date.now() + 3_600_000),
        source: 'hook',
      })
      .run();

  it('a run waiting under "wait" is handed off once the policy is switched to fallback', async () => {
    const run = await waiting();
    await t.scheduler.tick();
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });

    const res = await api('PATCH', '/api/factory/settings', { quotaPolicy: { inFlight: 'fallback' } });
    expect(res.statusCode).toBe(200);
    // No explicit tick: changing the policy wakes the scheduler.
    await expect.poll(async () => (await getRun(run.id)).handedOffTo, { timeout: 5_000 }).not.toBeNull();
    const successor = await getRun((await getRun(run.id)).handedOffTo ?? '');
    expect(successor).toMatchObject({
      agent: 'claude',
      model: 'opus',
      routeIndex: 1,
      predecessorRunId: run.id,
      worktreePath: run.worktreePath,
    });
    expect(t.db.select().from(runsTable).where(eq(runsTable.id, successor.id)).get()?.handoffCount).toBe(1);
  });

  it('with every fallback lane closed the run waits, and is handed off when a fallback window expires', async () => {
    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    closeClaude();
    const run = await waiting();
    await t.scheduler.tick();
    expect(await getRun(run.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });

    t.db
      .update(quotaWindows)
      .set({ resumeAt: new Date(Date.now() - 1_000) })
      .where(eq(quotaWindows.id, 'claude-closed'))
      .run();
    await t.scheduler.tick();
    const after = await getRun(run.id);
    expect(after.handedOffTo).not.toBeNull();
    expect(await getRun(after.handedOffTo ?? '')).toMatchObject({
      agent: 'claude',
      predecessorRunId: run.id,
    });
  });

  it('does not re-evaluate a run without an open route on every pass, and hands it off once the fallback lane is resumed', async () => {
    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    closeClaude();
    const run = await waiting();
    await t.scheduler.tick();

    const sched = t.scheduler as unknown as { routeOpen: (runId: string, ...rest: unknown[]) => boolean };
    const original = sched.routeOpen.bind(t.scheduler);
    let checks = 0;
    sched.routeOpen = (runId, ...rest) => {
      if (runId === run.id) checks += 1;
      return original(runId, ...rest);
    };
    for (let i = 0; i < 3; i += 1) await t.scheduler.tick();
    expect(checks).toBe(0);
    expect((await getRun(run.id)).events.filter((e) => e.type === 'handoff_failed')).toHaveLength(0);

    await api('POST', '/api/scheduler/resume', { agent: 'claude', credential: 'login', pool: '*' });
    await expect.poll(async () => (await getRun(run.id)).handedOffTo, { timeout: 5_000 }).not.toBeNull();
    expect(checks).toBeGreaterThan(0);
  });

  it('re-reads each waiting run before its handoff: a run stopped during the pass is left alone', async () => {
    // Both start before the Antigravity lane closes.
    const { run: first } = await startTicket('First');
    const { run: second } = await startTicket('Second');
    const tokens = [await work(first), await work(second)];
    await hook(first.id, 'StopFailure', tokens[0]!, AGY_QUOTA);
    await hook(second.id, 'StopFailure', tokens[1]!, AGY_QUOTA);
    await t.scheduler.tick();
    const handOff = t.runs.handOff.bind(t.runs);
    const handed: string[] = [];
    (t.runs as unknown as { handOff: typeof t.runs.handOff }).handOff = async (id, ...rest) => {
      handed.push(id);
      // The first handoff of the pass stops the other waiting run.
      const other = id === first.id ? second.id : first.id;
      t.db
        .update(runsTable)
        .set({ cancelledAt: new Date(), state: 'failed', endedAt: new Date() })
        .where(eq(runsTable.id, other))
        .run();
      return handOff(id, ...rest);
    };
    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    await t.scheduler.tick();
    await expect.poll(() => handed.length, { timeout: 5_000 }).toBeGreaterThan(0);
    await t.scheduler.tick();
    expect(handed).toHaveLength(1);
    const other = handed[0] === first.id ? second : first;
    expect((await getRun(other.id)).events.map((e) => e.type)).not.toContain('handoff_failed');
    expect((await getRun(other.id)).handedOffTo).toBeNull();
  });

  it('respects MAX_HANDOFFS and never hands off a run waiting for its automatic retry', async () => {
    // Both start before the Antigravity lane closes (a queued run would wait for it under newRuns = wait).
    const { run: capped } = await startTicket('Ping pong');
    const { run: retrying } = await startTicket('Transient');
    const tokens = [await work(capped), await work(retrying)];
    await hook(capped.id, 'StopFailure', tokens[0]!, AGY_QUOTA);
    await hook(retrying.id, 'StopFailure', tokens[1]!, AGY_QUOTA);
    t.db.update(runsTable).set({ handoffCount: 3 }).where(eq(runsTable.id, capped.id)).run();
    t.db
      .update(runsTable)
      .set({ autoRetryAt: new Date(Date.now() + 3_600_000) })
      .where(eq(runsTable.id, retrying.id))
      .run();

    updateFactorySettings(t.db, { quotaPolicy: { inFlight: 'fallback' } });
    await t.scheduler.tick();
    await t.scheduler.tick();
    expect(await getRun(capped.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
    expect(await getRun(retrying.id)).toMatchObject({ state: 'rate_limited', handedOffTo: null });
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

  it('keeps the worktree while an ended successor is parked on a quota limit', async () => {
    const { run, successor } = await handedOff();
    await t.runs.stop(successor.id);
    await expect.poll(async () => (await getRun(successor.id)).endedAt, { timeout: 5_000 }).not.toBeNull();
    // Reconcile leaves a rate-limited run rate_limited with endedAt set; it still resumes here.
    t.db
      .update(runsTable)
      .set({ state: 'rate_limited', cancelledAt: null })
      .where(eq(runsTable.id, successor.id))
      .run();
    expect((await api('POST', `/api/runs/${run.id}/worktree/prune`)).statusCode).toBe(409);
    expect((await api('POST', `/api/runs/${successor.id}/worktree/prune`)).statusCode).toBe(409);
    expect(existsSync(successor.worktreePath)).toBe(true);
  });

  it('prunes the worktree once the successor has ended too', async () => {
    const { run, successor } = await handedOff();
    await t.runs.stop(successor.id);
    await expect.poll(async () => (await getRun(successor.id)).endedAt, { timeout: 5_000 }).not.toBeNull();
    const res = await api('POST', `/api/runs/${run.id}/worktree/prune`);
    expect(res.statusCode).toBe(200);
    expect(existsSync(successor.worktreePath)).toBe(false);
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

describe('headless agents refuse modes that would need to ask', () => {
  const ACCEPT_EDITS_MESSAGE =
    'Antigravity runs without a terminal to answer in, so in Accept edits mode it would refuse every command without telling anyone. Start it in Autonomous mode, or pick another agent.';

  it('a ticket started in Accept edits on an Antigravity lane gets a 409 and no run, worktree or ticket move', async () => {
    const ticket = (
      await api('POST', `/api/projects/${projectId}/tickets`, {
        title: 'Landing',
        status: 'ready',
        persona: 'ui_ux',
      })
    ).json();
    const res = await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'acceptEdits' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'headless_needs_auto', message: ACCEPT_EDITS_MESSAGE });
    expect(t.db.select().from(runsTable).where(eq(runsTable.ticketId, ticket.id)).all()).toHaveLength(0);
    expect((await api('GET', `/api/tickets/${ticket.id}`)).json().status).toBe('ready');
    expect(existsSync(path.join(t.config.workspacesDir, '.worktrees', 'quota'))).toBe(false);

    // Ask is refused the same way; Plan and Autonomous start.
    const ask = await api('POST', `/api/tickets/${ticket.id}/start`, {});
    expect(ask.statusCode).toBe(409);
    expect(ask.json().message).toContain('in Ask mode');
    const plan = await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'plan' });
    expect(plan.statusCode).toBe(201);
    expect(plan.json().run.agent).toBe('antigravity');
  });

  it('a direct run in Accept edits on an Antigravity lane gets a 409 and leaves no run or worktree', async () => {
    const res = await api('POST', '/api/runs', {
      projectId,
      persona: 'ui_ux',
      prompt: 'polish the header',
      permissionMode: 'acceptEdits',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'headless_needs_auto', message: ACCEPT_EDITS_MESSAGE });
    expect(t.db.select().from(runsTable).all()).toHaveLength(0);
    expect(existsSync(path.join(t.config.workspacesDir, '.worktrees', 'quota'))).toBe(false);
  });

  it('a factory request in Accept edits led by an Antigravity persona leaves no ticket, run or auto-chain', async () => {
    const res = await api('POST', `/api/projects/${projectId}/factory-request`, {
      prompt: 'A landing page',
      leadPersona: 'ui_ux',
      permissionMode: 'acceptEdits',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'headless_needs_auto', message: ACCEPT_EDITS_MESSAGE });
    expect(t.db.select().from(ticketsTable).where(eq(ticketsTable.projectId, projectId)).all()).toHaveLength(
      0,
    );
    expect(t.db.select().from(runsTable).all()).toHaveLength(0);
    expect(t.tickets.isAutoChainActive(projectId)).toBe(false);
    // A route tag in the request leads, as it does for the ticket it would create.
    const tagged = await api('POST', `/api/projects/${projectId}/factory-request`, {
      prompt: 'A landing page [Preferred Agent: antigravity · Model: argon]',
      leadPersona: 'product_owner',
      permissionMode: 'acceptEdits',
    });
    expect(tagged.statusCode).toBe(409);
    expect(t.db.select().from(ticketsTable).where(eq(ticketsTable.projectId, projectId)).all()).toHaveLength(
      0,
    );
  });

  it('a factory request whose generated ticket text routes to a headless agent leaves no [Factory] ticket', async () => {
    updateFactorySettings(t.db, { enabledProviders: ['claude', 'antigravity', 'gemini'] });
    const real = vi.mocked(orchestration.buildFactoryOrchestratorPrompt).getMockImplementation()!;
    vi.mocked(orchestration.buildFactoryOrchestratorPrompt).mockImplementation(
      (...args) => `${real(...args)}\n[Preferred Agent: gemini · Model: auto]`,
    );
    try {
      const res = await api('POST', `/api/projects/${projectId}/factory-request`, {
        prompt: 'A landing page',
        leadPersona: 'product_owner',
        permissionMode: 'acceptEdits',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'headless_needs_auto' });
      expect(
        t.db.select().from(ticketsTable).where(eq(ticketsTable.projectId, projectId)).all(),
      ).toHaveLength(0);
      expect(t.db.select().from(runsTable).all()).toHaveLength(0);
    } finally {
      vi.mocked(orchestration.buildFactoryOrchestratorPrompt).mockImplementation(real);
    }
  });

  it('a run without a prompt opens Antigravity interactively in any mode', async () => {
    const res = await api('POST', '/api/runs', {
      projectId,
      persona: 'ui_ux',
      permissionMode: 'acceptEdits',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent).toBe('antigravity');
  });

  it('a refused fresh attempt leaves the idle run it would replace alone', async () => {
    const { ticketId, run } = await startTicket('Colour-blind cats');
    t.db.update(runsTable).set({ state: 'waiting_input' }).where(eq(runsTable.id, run.id)).run();
    await expect(
      t.tickets.start(
        ticketId,
        { permissionMode: 'acceptEdits' },
        { byPerson: true, replaceIdleRun: { ids: [run.id], reason: 'review_new_run' } },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'headless_needs_auto' });
    expect(await getRun(run.id)).toMatchObject({ state: 'waiting_input', cancelled: false });
    expect(t.db.select().from(runsTable).where(eq(runsTable.ticketId, ticketId)).all()).toHaveLength(1);
  });

  async function failsHeadless(runId: string): Promise<void> {
    await expect.poll(async () => (await getRun(runId)).state, { timeout: 5_000 }).toBe('failed');
    const detail = await getRun(runId);
    expect(detail.agent).toBe('antigravity');
    const event = detail.events.find((e) => e.type === 'headless_needs_auto');
    expect(event?.payload).toEqual({ reason: 'headless_needs_auto', message: ACCEPT_EDITS_MESSAGE });
    // The CLI never started.
    expect(existsSync(path.join(t.dir, `args-${runId}`))).toBe(false);
  }

  it('a quota handoff from Claude to Antigravity in Accept edits fails visibly instead of running', async () => {
    updateFactorySettings(t.db, {
      quotaPolicy: { inFlight: 'fallback' },
      personaRoutes: {
        coder: [
          { agent: 'claude', model: 'opus', credential: 'login' },
          { agent: 'antigravity', model: 'argon', credential: 'login' },
        ],
      },
    });
    const ticket = (
      await api('POST', `/api/projects/${projectId}/tickets`, {
        title: 'Coder',
        status: 'ready',
        persona: 'coder',
      })
    ).json();
    const res = await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'acceptEdits' });
    expect(res.statusCode).toBe(201);
    const run: Run = res.json().run;
    expect(run.agent).toBe('claude');
    await hook(run.id, 'StopFailure', await work(run), {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`,
    });
    await expect.poll(async () => (await getRun(run.id)).handedOffTo, { timeout: 5_000 }).not.toBeNull();
    await failsHeadless((await getRun(run.id)).handedOffTo ?? '');
  });

  it('a queued run bound to an Antigravity fallback in Accept edits fails visibly instead of running', async () => {
    updateFactorySettings(t.db, {
      quotaPolicy: { newRuns: 'fallback' },
      personaRoutes: {
        coder: [
          { agent: 'claude', model: 'opus', credential: 'login' },
          { agent: 'antigravity', model: 'argon', credential: 'login' },
        ],
      },
    });
    const first = await startTicket('First', 'coder');
    await hook(first.run.id, 'StopFailure', await work(first.run), {
      error: 'rate_limit',
      last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`,
    });
    const second = await startTicket('Second', 'coder', { permissionMode: 'acceptEdits' });
    await failsHeadless(second.run.id);
    expect((await getRun(second.run.id)).events.map((e) => e.type)).toContain('route_bound');
  });
});
