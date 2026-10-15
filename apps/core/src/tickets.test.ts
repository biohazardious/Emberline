import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { keyPrefix, statusForRunState, ticketPrompt } from './tickets/service.js';

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
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      'read line',
      `printf %s "$line" > "${dir}/line-$EMBERLINE_RUN_ID"`,
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

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

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
    expect(ticketPrompt({ key: 'DP-1', title: 'Fix it', body: ' details \n' })).toBe('DP-1: Fix it\n\ndetails');
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
    const reordered: Ticket = (await api('PATCH', `/api/tickets/${a.id}`, { position: -5, title: 'Renamed' })).json();
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
    expect(run).toMatchObject({ ticketId: ticket.id, branch: 'emberline/dp-1-add-a-readme', permissionMode: 'plan' });
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
      .poll(async () => ((await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[]).map((x) => x.title))
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
    const titles = async () => ((await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[]);

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
      .poll(async () => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type))
      .toContain('ticket_depth_limit');
    expect((await titles()).some((t) => t.title === 'Too deep')).toBe(false);
  });

  it('stops auto-dispatch once the daily run budget is used and reports usage', async () => {
    const project = await createProject();
    await api('PATCH', '/api/factory/settings', { maxAutoRunsPerProjectPerDay: 1 });
    await createTicket(project.id, { title: 'First', status: 'ready' });
    await createTicket(project.id, { title: 'Second', status: 'ready' });
    const first = await t.tickets.dispatchNextReadyTicket(project.id);
    expect(first).not.toBeNull();
    await t.runs.stop(first!.run.id);
    await expect
      .poll(async () => {
        await t.runs.reconcile();
        return t.runs.getRun(first!.run.id).endedAt;
      })
      .not.toBeNull();
    expect(await t.tickets.dispatchNextReadyTicket(project.id)).toBeNull();

    const usage = (await api('GET', `/api/projects/${project.id}/usage?days=3`)).json();
    expect(usage).toMatchObject({ runsLast24h: 1, maxAutoRunsPerProjectPerDay: 1, budgetExhausted: true });
    expect(usage.days).toHaveLength(3);
    expect(usage.days.at(-1).runs).toBe(1);
    expect(usage.days.at(-1).estimatedRuns).toBe(1);
  });

  it('dispatches one ticket per project even when dispatches race', async () => {
    const project = await createProject();
    await createTicket(project.id, { title: 'First', status: 'ready' });
    await createTicket(project.id, { title: 'Second', status: 'ready' });
    const results = await Promise.all([
      t.tickets.dispatchNextReadyTicket(project.id),
      t.tickets.dispatchNextReadyTicket(project.id),
      t.tickets.dispatchNextReadyTicket(project.id),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(t.runs.list().filter((r) => r.projectId === project.id)).toHaveLength(1);
  });

  it('refuses a second start of the same ticket while the first is still preparing', async () => {
    const project = await createProject();
    const ticket = await createTicket(project.id, { title: 'Only once', status: 'ready' });
    const results = await Promise.allSettled([t.tickets.start(ticket.id, {}), t.tickets.start(ticket.id, {})]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toMatch(/already has a running agent/);
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
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`, { headers: { cookie, origin: address } });
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
});
