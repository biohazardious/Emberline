import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { runs, settings } from './db/schema.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp, wsProtocols } from './test-utils.js';
import { keyPrefix, statusForRunState, TicketService, ticketPrompt } from './tickets/service.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/** Claude stand-in: leaks its hook token, echoes the first line it reads, then exits. */
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
      `printf %s "$line" > "${dir}/.line-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.line-$EMBERLINE_RUN_ID" "${dir}/line-$EMBERLINE_RUN_ID"`,
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

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

const hook = (runId: string, event: string, token: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${token}` },
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

async function createProject(name = 'Demo Project') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return project as { id: string; path: string };
}

const createTicket = async (projectId: string, body: object): Promise<Ticket> =>
  (await api('POST', `/api/projects/${projectId}/tickets`, body)).json();

const getTicket = async (id: string): Promise<Ticket> => (await api('GET', `/api/tickets/${id}`)).json();

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

describe('ticket helpers', () => {
  it('derives key prefixes from the project slug', () => {
    expect(keyPrefix('demo-project')).toBe('DP');
    expect(keyPrefix('emberline')).toBe('EMB');
    expect(keyPrefix('my-big-fat-web-app')).toBe('MBFW');
    expect(keyPrefix('42')).toBe('T');
  });

  it('builds the agent prompt from title and body', () => {
    expect(ticketPrompt({ key: 'DP-1', title: 'Fix it', body: '' })).toBe('DP-1: Fix it');
    expect(ticketPrompt({ key: 'DP-1', title: 'Fix it', body: ' details \n' })).toBe(
      'DP-1: Fix it\n\ndetails',
    );
  });

  it('maps run states to columns', () => {
    expect(statusForRunState('working')).toBe('in_progress');
    expect(statusForRunState('waiting_input')).toBe('in_progress');
    expect(statusForRunState('done')).toBe('review');
    expect(statusForRunState('failed')).toBeNull();
  });
});

describe('tickets', () => {
  it('creates, lists, updates and moves tickets', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'First' });
    const b = await createTicket(project.id, { title: 'Second', priority: 3 });
    expect(a).toMatchObject({ key: 'DP-1', status: 'backlog', priority: 1 });
    expect(b).toMatchObject({ key: 'DP-2', priority: 3 });
    expect(b.position).toBeGreaterThan(a.position);

    const moved: Ticket = (await api('PATCH', `/api/tickets/${b.id}`, { status: 'ready' })).json();
    expect(moved.status).toBe('ready');
    const reordered: Ticket = (
      await api('PATCH', `/api/tickets/${a.id}`, { position: -5, title: 'Renamed' })
    ).json();
    expect(reordered).toMatchObject({ position: -5, title: 'Renamed', key: 'DP-1' });

    const list: Ticket[] = (await api('GET', `/api/projects/${project.id}/tickets`)).json();
    expect(list.map((x) => x.key)).toEqual(['DP-1', 'DP-2']);

    expect((await api('POST', `/api/projects/${project.id}/tickets`, { title: '' })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/tickets/${a.id}`, { status: 'nope' })).statusCode).toBe(400);
    expect((await api('GET', '/api/projects/nope/tickets')).statusCode).toBe(404);
  });

  it('starts a run that the ticket then follows through the board', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Add a README!', body: 'Short one.' });

    const res = await api('POST', `/api/tickets/${ticket.id}/start`, { permissionMode: 'plan' });
    expect(res.statusCode).toBe(201);
    const { ticket: started, run } = res.json() as { ticket: Ticket; run: Run };
    expect(started.status).toBe('in_progress');
    expect(run).toMatchObject({
      ticketId: ticket.id,
      branch: 'emberline/dp-1-add-a-readme',
      permissionMode: 'plan',
    });
    expect(run.prompt).toBe('DP-1: Add a README!\n\nShort one.');

    expect((await api('POST', `/api/tickets/${ticket.id}/start`, {})).statusCode).toBe(409);

    const token = await waitFile(`token-${run.id}`);
    await hook(run.id, 'SessionStart', token, { session_id: 's1' });
    await hook(run.id, 'UserPromptSubmit', token);
    expect((await getTicket(ticket.id)).status).toBe('in_progress');
    await hook(run.id, 'Stop', token);
    expect((await getTicket(ticket.id)).status).toBe('review');

    // A follow-up goes into the live PTY and pulls the ticket back to In progress.
    const prompt = await api('POST', `/api/tickets/${ticket.id}/prompt`, { text: 'also add a license' });
    expect(prompt.statusCode).toBe(200);
    expect((prompt.json() as { ticket: Ticket }).ticket.status).toBe('in_progress');
    expect(await waitFile(`line-${run.id}`)).toBe('also add a license');
    const detail: RunDetail = (await api('GET', `/api/runs/${run.id}`)).json();
    expect(detail.events.map((e) => e.type)).toContain('prompt_sent');
  });

  it('ingests agent ticket drafts even when one sits at the body limit', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Plan the work', status: 'ready' });
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
    mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
    writeFileSync(
      path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
      JSON.stringify({
        autoDispatch: false,
        tickets: [
          { title: 'Huge draft', body: 'x'.repeat(20_000), preferredAgent: 'codex' },
          { title: 'Normal draft', body: 'small' },
        ],
      }),
    );
    const token = await waitFile(`token-${run.id}`);
    await hook(run.id, 'SessionStart', token, { session_id: 's-drafts' });
    await hook(run.id, 'UserPromptSubmit', token);
    await hook(run.id, 'Stop', token);

    await expect
      .poll(async () =>
        ((await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[]).map((x) => x.title),
      )
      .toEqual(expect.arrayContaining(['Huge draft', 'Normal draft']));
    const huge = ((await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[]).find(
      (x) => x.title === 'Huge draft',
    );
    expect(huge?.body.length).toBeLessThanOrEqual(20_000);
    expect(huge?.body).toContain('[Preferred Agent: codex');
  });

  it('limits agent ticket generations to maxTicketDepth (S16)', async () => {
    const project = await createProject();
    await api('PATCH', '/api/factory/settings', { maxTicketDepth: 2, autoPickupReady: false });
    const runTicketWithDrafts = async (ticket: Ticket, titles: string[]) => {
      const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
      mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
      writeFileSync(
        path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
        JSON.stringify({ autoDispatch: false, tickets: titles.map((title) => ({ title })) }),
      );
      const token = await waitFile(`token-${run.id}`);
      await hook(run.id, 'SessionStart', token, { session_id: `s-${ticket.key}` });
      await hook(run.id, 'UserPromptSubmit', token);
      await hook(run.id, 'Stop', token);
      return run;
    };
    const titles = async () => (await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[];

    const root = await createTicket(project.id, { title: 'Human ticket', status: 'ready' });
    expect(root.depth).toBe(0);
    await runTicketWithDrafts(root, ['Child']);
    await expect.poll(async () => (await titles()).find((t) => t.title === 'Child')?.depth).toBe(1);

    const child = (await titles()).find((t) => t.title === 'Child')!;
    await runTicketWithDrafts(child, ['Grandchild']);
    await expect.poll(async () => (await titles()).find((t) => t.title === 'Grandchild')?.depth).toBe(2);

    const grandchild = (await titles()).find((t) => t.title === 'Grandchild')!;
    const run = await runTicketWithDrafts(grandchild, ['Too deep']);
    await expect
      .poll(async () =>
        ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type),
      )
      .toContain('ticket_depth_limit');
    expect((await titles()).some((t) => t.title === 'Too deep')).toBe(false);
  });

  it('stops auto-dispatch once the daily run budget is used and reports usage', async () => {
    const project = await createProject();
    await api('PATCH', '/api/factory/settings', { maxAutoRunsPerProjectPerDay: 1 });
    await createTicket(project.id, { title: 'First', status: 'ready' });
    await createTicket(project.id, { title: 'Second', status: 'ready' });
    // Two parallel slots, but the budget counts each run the pass starts.
    const [first, ...more] = await t.tickets.dispatchNextReadyTicket(project.id);
    expect(first).toBeDefined();
    expect(more).toEqual([]);
    await t.runs.stop(first!.run.id);
    await expect
      .poll(async () => {
        await t.runs.reconcile();
        return t.runs.getRun(first!.run.id).endedAt;
      })
      .not.toBeNull();
    expect(await t.tickets.dispatchNextReadyTicket(project.id)).toEqual([]);

    const usage = (await api('GET', `/api/projects/${project.id}/usage?days=3`)).json();
    expect(usage).toMatchObject({ runsLast24h: 1, maxAutoRunsPerProjectPerDay: 1, budgetExhausted: true });
    expect(usage.days).toHaveLength(3);
    expect(usage.days.at(-1).runs).toBe(1);
    expect(usage.days.at(-1).estimatedRuns).toBe(1);
  });

  it('dispatches one ticket per project even when dispatches race', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    const project = await createProject();
    await createTicket(project.id, { title: 'First', status: 'ready' });
    await createTicket(project.id, { title: 'Second', status: 'ready' });
    const results = await Promise.all([
      t.tickets.dispatchNextReadyTicket(project.id),
      t.tickets.dispatchNextReadyTicket(project.id),
      t.tickets.dispatchNextReadyTicket(project.id),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(t.runs.list().filter((r) => r.projectId === project.id)).toHaveLength(1);
  });

  it('refuses a second start of the same ticket while the first is still preparing', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Only once', status: 'ready' });
    const results = await Promise.allSettled([
      t.tickets.start(ticket.id, {}),
      t.tickets.start(ticket.id, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toMatch(/already has a running agent/);
    // Let the started agent finish spawning: it writes into the test directory, which teardown removes.
    const started = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ run: Run }>;
    await waitFile(`token-${started.value.run.id}`);
  });

  it('never pulls a ticket out of Done', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Ship' });
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
    const token = await waitFile(`token-${run.id}`);

    await api('PATCH', `/api/tickets/${ticket.id}`, { status: 'done' });
    await hook(run.id, 'UserPromptSubmit', token);
    await hook(run.id, 'Stop', token);
    expect((await getTicket(ticket.id)).status).toBe('done');
  });

  it('rejects follow-ups without a live run', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Idle' });
    expect((await api('POST', `/api/tickets/${ticket.id}/prompt`, { text: 'hi' })).statusCode).toBe(409);
    expect((await api('POST', `/api/tickets/${ticket.id}/prompt`, { text: '  ' })).statusCode).toBe(400);
  });

  it('never reuses the key of a deleted ticket', async () => {
    const project = await createProject();
    const first = await createTicket(project.id, { title: 'One' });
    const second = await createTicket(project.id, { title: 'Two' });
    expect([first.key, second.key]).toEqual(['DP-1', 'DP-2']);
    expect((await api('DELETE', `/api/tickets/${second.id}`)).statusCode).toBe(200);
    expect((await createTicket(project.id, { title: 'Three' })).key).toBe('DP-3');
    // Created at once, they still get one number each.
    const batch = await Promise.all(['A', 'B', 'C', 'D'].map((title) => createTicket(project.id, { title })));
    expect(batch.map((x) => x.key).sort()).toEqual(['DP-4', 'DP-5', 'DP-6', 'DP-7']);
  });

  it('starts the key sequence of an existing project after its highest ticket number', async () => {
    const project = await createProject();
    await createTicket(project.id, { title: 'One' });
    await createTicket(project.id, { title: 'Two' });
    // A database from before the sequence existed.
    t.db
      .delete(settings)
      .where(eq(settings.key, `tickets.seq.${project.id}`))
      .run();
    expect((await createTicket(project.id, { title: 'Three' })).key).toBe('DP-3');
  });

  it("drops a deleted project's ticket number sequence", async () => {
    const project = await createProject();
    await createTicket(project.id, { title: 'One' });
    const seq = () =>
      t.db
        .select()
        .from(settings)
        .where(eq(settings.key, `tickets.seq.${project.id}`))
        .get();
    expect(seq()?.value).toBe(1);
    expect((await api('DELETE', `/api/projects/${project.id}?deleteFiles=0`)).statusCode).toBe(200);
    expect(seq()).toBeUndefined();
  });

  it('keeps runs when their ticket is deleted', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Temp' });
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };

    expect((await api('DELETE', `/api/tickets/${ticket.id}`)).statusCode).toBe(200);
    expect((await api('GET', `/api/tickets/${ticket.id}`)).statusCode).toBe(404);
    const after: Run = (await api('GET', `/api/runs/${run.id}`)).json();
    expect(after.ticketId).toBeNull();
  });

  it('pushes ticket updates over /api/events', async () => {
    const project = await createProject();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, wsProtocols(cookie), {
      headers: { cookie, origin: address },
    });
    const events: { type: string; ticket?: Ticket; id?: string }[] = [];
    ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const ticket = await createTicket(project.id, { title: 'Live' });
    await api('DELETE', `/api/tickets/${ticket.id}`);
    await expect
      .poll(() => events.map((e) => e.type))
      .toEqual(expect.arrayContaining(['ticket', 'ticket_removed']));
    ws.close();
  });

  it('exposes ticket key + title on run and accepts direct /api/runs/:id/prompt', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Ship workbench' });
    const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
    expect(run.title).toBe('DP-1 Ship workbench');

    const token = await waitFile(`token-${run.id}`);
    await hook(run.id, 'Stop', token);
    expect((await getTicket(ticket.id)).status).toBe('review');

    const promptRes = await api('POST', `/api/runs/${run.id}/prompt`, { text: 'Please add tests' });
    expect(promptRes.statusCode).toBe(200);
    expect((promptRes.json() as Run).lastEvent).toBe('prompt_sent');
    expect((await getTicket(ticket.id)).status).toBe('in_progress');
  });

  it('marks factory-dispatched runs unattended and nudges a stalled one once, across restarts (R5, R9)', async () => {
    const project = await createProject();
    await createTicket(project.id, { title: 'Auto', status: 'ready' });
    const [started] = await t.tickets.dispatchNextReadyTicket(project.id);
    const runId = started!.run.id;
    expect(t.runs.get(runId).events.find((e) => e.type === 'queued')?.payload).toMatchObject({
      unattended: 'factory',
    });
    // A manually started ticket run is attended.
    const manual = await createTicket(project.id, { title: 'Manual', status: 'backlog' });
    const manualRun: Run = (await api('POST', `/api/tickets/${manual.id}/start`, {})).json().run;
    expect(
      t.runs.get(manualRun.id).events.find((e) => e.type === 'queued')?.payload ?? {},
    ).not.toHaveProperty('unattended');

    const token = await waitFile(`token-${runId}`);
    await hook(runId, 'SessionStart', token, { session_id: 's' });
    await hook(runId, 'UserPromptSubmit', token, { prompt: 'go' });
    await hook(runId, 'Notification', token, { notification_type: 'permission_prompt', message: 'ok?' });
    await expect
      .poll(() => t.runs.get(runId).events.filter((e) => e.type === 'auto_nudged').length, { timeout: 5_000 })
      .toBe(1);
    const prompts = () => t.runs.get(runId).events.filter((e) => e.type === 'prompt_sent').length;
    await expect.poll(prompts, { timeout: 5_000 }).toBe(1);

    // A restarted TicketService has no memory of the nudge, only the run's events.
    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    t.runs.emit('run', { ...t.runs.getRun(runId), state: 'waiting_input', lastEvent: 'Notification' }, true);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.runs.get(runId).events.filter((e) => e.type === 'auto_nudged')).toHaveLength(1);
    expect(prompts()).toBe(1);
    void restarted;
  });

  it('stops a factory run whose auto-nudge did not clear the permission prompt after 30 minutes (R6)', async () => {
    // This stand-in stays alive and swallows typed input, like a select dialog that ignores text.
    const stubborn = path.join(t.dir, 'stubborn-claude.sh');
    writeFileSync(
      stubborn,
      [
        '#!/bin/sh',
        `printf %s "$EMBERLINE_HOOK_TOKEN" > "${t.dir}/.token-$EMBERLINE_RUN_ID"`,
        `mv "${t.dir}/.token-$EMBERLINE_RUN_ID" "${t.dir}/token-$EMBERLINE_RUN_ID"`,
        'while read line; do :; done',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    t.config.claudeCommand = stubborn;
    const project = await createProject();
    await createTicket(project.id, { title: 'Stuck', status: 'ready' });
    const [started] = await t.tickets.dispatchNextReadyTicket(project.id);
    const runId = started!.run.id;
    const token = await waitFile(`token-${runId}`);
    await hook(runId, 'SessionStart', token, { session_id: 's-stuck' });
    await hook(runId, 'UserPromptSubmit', token, { prompt: 'go' });
    await hook(runId, 'Notification', token, { notification_type: 'permission_prompt', message: 'ok?' });
    await expect
      .poll(() => t.runs.get(runId).events.filter((e) => e.type === 'prompt_sent').length, { timeout: 5_000 })
      .toBe(1);
    expect(t.runs.get(runId).events.filter((e) => e.type === 'auto_nudged')).toHaveLength(1);
    // The nudge was typed, but no hook followed: the run still waits, and its last event is a note.
    expect(t.runs.getRun(runId).state).toBe('waiting_input');
    expect(t.runs.getRun(runId).lastEvent).not.toBe('Notification');

    const age = (ms: number) =>
      t.db
        .update(runs)
        .set({ stateChangedAt: new Date(Date.now() - ms) })
        .where(eq(runs.id, runId))
        .run();
    age(10 * 60_000);
    await t.runs.reconcile();
    expect(t.runs.getRun(runId).state).toBe('waiting_input');
    age(31 * 60_000);
    await t.runs.reconcile();
    const after = t.runs.get(runId);
    expect(after).toMatchObject({ state: 'failed', lastEvent: 'waiting_input_timeout' });
    expect(after.endedAt).not.toBeNull();
  });

  describe('pipeline settle (R8)', () => {
    const SETTLE_MS = 400;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    beforeEach(async () => {
      // Rebuilt with a short settle window; the default for tests is no wait.
      await ptydServer.close();
      await t.close();
      t = await createTestApp({}, {}, { pipelineSettleMs: SETTLE_MS });
      t.config.claudeCommand = writeFakeClaude(t.dir);
      ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
      await ptydServer.listen();
      t.ptyd.start();
      await t.ptyd.waitUntilConnected();
      cookie = await setupAndLogin(t.app);
    });

    /** Counts completion pipeline passes (gates, merge, Done). */
    function trackPipelines(): Run[] {
      const passes: Run[] = [];
      const svc = t.tickets as unknown as { handleRunCompleted(r: Run, opts?: object): Promise<void> };
      const original = svc.handleRunCompleted.bind(t.tickets);
      svc.handleRunCompleted = (r, opts) => {
        passes.push(r);
        return original(r, opts);
      };
      return passes;
    }

    it('waits for the agent to settle before gates and merge; a turn that resumes skips them', async () => {
      const project = await createProject();
      const ticket = await createTicket(project.id, { title: 'Settle' });
      const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
      const passes = trackPipelines();
      const token = await waitFile(`token-${run.id}`);
      await hook(run.id, 'SessionStart', token, { session_id: 's-settle' });
      await hook(run.id, 'UserPromptSubmit', token);

      await hook(run.id, 'Stop', token);
      // Review follows the Stop at once; only the pipeline waits.
      expect((await getTicket(ticket.id)).status).toBe('review');
      expect(passes).toHaveLength(0);
      // The CLI wakes up for background work inside the window.
      await hook(run.id, 'PreToolUse', token, { tool_name: 'Bash' });
      await pause(SETTLE_MS * 2);
      expect(passes).toHaveLength(0);

      // Two Stops inside one window: one pass, for the last one.
      await hook(run.id, 'Stop', token);
      await hook(run.id, 'UserPromptSubmit', token);
      await hook(run.id, 'Stop', token);
      await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(1);
      await pause(SETTLE_MS * 2);
      expect(passes).toHaveLength(1);
      expect(passes[0]).toMatchObject({ id: run.id, state: 'done' });
    });

    async function workingTicketRun(title: string) {
      const project = await createProject();
      const ticket = await createTicket(project.id, { title });
      const { run } = (await api('POST', `/api/tickets/${ticket.id}/start`, {})).json() as { run: Run };
      const token = await waitFile(`token-${run.id}`);
      await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
      await hook(run.id, 'UserPromptSubmit', token);
      return { project, ticket, run, token };
    }

    it('runs the pipeline at once when the agent process has already exited', async () => {
      const { run } = await workingTicketRun('Exited');
      const passes = trackPipelines();
      await t.ptyd.get().write(run.terminalId ?? '', 'bye\r');
      await expect
        .poll(
          async () => {
            await t.runs.reconcile();
            return t.runs.getRun(run.id).state;
          },
          { timeout: 5_000 },
        )
        .toBe('done');
      // No settle wait: an exited CLI cannot wake up again.
      expect(passes).toHaveLength(1);
      expect(passes[0]?.endedAt).not.toBeNull();
    });

    it('a dispatch during the settle window leaves the run to its own, single pass', async () => {
      const { project, ticket, run, token } = await workingTicketRun('Settling');
      const passes = trackPipelines();
      await hook(run.id, 'Stop', token);
      expect((await getTicket(ticket.id)).status).toBe('review');
      // Finalizing leftover Review tickets must not pick up a run that is still settling.
      await t.tickets.dispatchNextReadyTicket(project.id);
      expect(passes).toHaveLength(0);
      await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(1);
      await pause(SETTLE_MS * 2);
      expect(passes).toHaveLength(1);
    });

    it('dispose drops pending settle waits', async () => {
      const { run, token } = await workingTicketRun('Disposed');
      const passes = trackPipelines();
      await hook(run.id, 'Stop', token);
      t.tickets.dispose();
      await pause(SETTLE_MS * 2);
      expect(passes).toHaveLength(0);
    });
  });
});
