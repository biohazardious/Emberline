import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectSettings, writeWizardTickets } from './db/project-settings.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

/**
 * The tickets-file loop: a `.emberline/new-tickets.json` that reached main was copied into every
 * new run's worktree and imported again by each run's pipeline.
 */

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

const TICKETS = '.emberline/new-tickets.json';

/** Claude stand-in that stays alive (a run that exits early is not merged like a finished one). */
function writeLivingClaude(dir: string): string {
  const file = path.join(dir, 'living-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
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

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

const hook = (runId: string, event: string, token: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${token}` },
    payload: { runId, event, receivedAt: new Date().toISOString(), payload },
  });

const wgit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

async function createProject() {
  const { project } = (await api('POST', '/api/projects', { name: 'Loop Project', initGit: false })).json();
  wgit(project.path, 'init', '-q', '-b', 'main');
  wgit(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
  // No dispatch of created tickets; the chain flag makes each finished run a factory run (gates + merge).
  await api('PATCH', '/api/factory/settings', { autoPickupReady: false });
  t.tickets.setAutoChain(project.id, true);
  return project as { id: string; path: string };
}

const draftsFile = (titles: string[]) => JSON.stringify({ autoDispatch: false, tickets: titles.map((title) => ({ title })) });

function writeTickets(cwd: string, content: string): void {
  mkdirSync(path.join(cwd, '.emberline'), { recursive: true });
  writeFileSync(path.join(cwd, TICKETS), content);
}

const titles = async (projectId: string) =>
  ((await api('GET', `/api/projects/${projectId}/tickets`)).json() as Ticket[]).map((x) => x.title);
const eventsOf = async (run: Run) => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events;
const eventTypes = async (run: Run) => (await eventsOf(run)).map((e) => e.type);

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

async function startTicket(projectId: string, title: string, persona?: string): Promise<Run> {
  const ticket = (await api('POST', `/api/projects/${projectId}/tickets`, { title, status: 'ready', persona })).json() as Ticket;
  const res = await api('POST', `/api/tickets/${ticket.id}/start`, persona ? { persona } : {});
  expect(res.statusCode).toBe(201);
  return (res.json() as { run: Run }).run;
}

/** One turn of the agent, ending with its Stop (no completion tool: Stop alone advances). */
async function finishTurn(run: Run): Promise<void> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  await hook(run.id, 'Stop', token);
}

describe('agent tickets files are imported once', { timeout: 30_000 }, () => {
  it('a tickets file the run inherited from main creates no tickets, and its merge removes the file from main', async () => {
    const project = await createProject();
    // What the bug left behind: a run-output commit that carried the agent's tickets file into main.
    writeTickets(project.path, draftsFile(['Core: booking store', 'UI/UX: sign-up flow']));
    wgit(project.path, 'add', '-A');
    wgit(project.path, 'commit', '-q', '-m', 'feat(YSS-1): factory run output');

    const run = await startTicket(project.id, 'Build the page');
    expect(existsSync(path.join(run.worktreePath, TICKETS))).toBe(true);
    writeFileSync(path.join(run.worktreePath, 'page.html'), '<h1>hi</h1>\n');
    await finishTurn(run);

    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('merged_to_main');
    const types = await eventTypes(run);
    expect(types.filter((x) => x === 'tickets_file_inherited')).toHaveLength(1);
    expect(await titles(project.id)).toEqual(['Build the page']);
    expect(existsSync(path.join(run.worktreePath, TICKETS))).toBe(false);
    // Self-healing: main no longer tracks the file, and the next run starts without it.
    expect(wgit(project.path, 'ls-files', '.emberline')).toBe('');
    expect(existsSync(path.join(project.path, TICKETS))).toBe(false);
    expect(wgit(project.path, 'ls-files', 'page.html')).toBe('page.html');
  });

  it('the same tickets file written by two runs is imported once', async () => {
    const project = await createProject();
    const content = draftsFile(['Child A', 'Child B']);

    const first = await startTicket(project.id, 'Plan one');
    writeTickets(first.worktreePath, content);
    await finishTurn(first);
    await expect.poll(() => titles(project.id), { timeout: 10_000 }).toEqual(expect.arrayContaining(['Child A', 'Child B']));
    await expect.poll(() => eventTypes(first), { timeout: 10_000 }).toContain('merged_to_main');

    const second = await startTicket(project.id, 'Plan two');
    writeTickets(second.worktreePath, content);
    await finishTurn(second);
    await expect.poll(() => eventTypes(second), { timeout: 10_000 }).toContain('tickets_file_duplicate');
    expect((await titles(project.id)).filter((x) => x.startsWith('Child'))).toEqual(['Child A', 'Child B']);
    expect(existsSync(path.join(second.worktreePath, TICKETS))).toBe(false);
    // The tickets are the first run's: only it is credited with them. The second created nothing and
    // changed nothing, so it is held for a person (no_changes) like any other empty run.
    expect(await eventTypes(first)).toContain('tickets_imported');
    expect(await eventTypes(first)).not.toContain('no_changes');
    await expect.poll(() => eventTypes(second), { timeout: 10_000 }).toContain('no_changes');
    expect(await eventTypes(second)).not.toContain('tickets_imported');
    expect(await eventTypes(second)).not.toContain('merged_to_main');
  });

  it("a product owner's new tickets file is imported once and remembered", async () => {
    const project = await createProject();
    const po = await startTicket(project.id, '[Factory] Plan the studio site', 'product_owner');
    writeTickets(po.worktreePath, draftsFile(['Core: store', 'QA: tests']));
    await finishTurn(po);

    await expect.poll(() => titles(project.id), { timeout: 10_000 }).toEqual(expect.arrayContaining(['Core: store', 'QA: tests']));
    await expect.poll(() => eventTypes(po), { timeout: 10_000 }).toContain('merged_to_main');
    expect((await titles(project.id)).filter((x) => x !== '[Factory] Plan the studio site').sort()).toEqual(['Core: store', 'QA: tests']);
    const types = await eventTypes(po);
    expect(types).not.toContain('tickets_file_inherited');
    expect(types).not.toContain('tickets_file_duplicate');
    expect(readProjectSettings(t.db, project.id).ingestedTicketFiles).toHaveLength(1);
    // Nothing of it reached main.
    expect(wgit(project.path, 'ls-files', '.emberline')).toBe('');
  });

  it('a tickets file the agent committed on its own branch is still imported', async () => {
    const project = await createProject();
    const run = await startTicket(project.id, 'Plan it');
    writeTickets(run.worktreePath, draftsFile(['Committed child']));
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'plan');
    await finishTurn(run);

    await expect.poll(() => titles(project.id), { timeout: 10_000 }).toContain('Committed child');
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('merged_to_main');
    expect(await eventTypes(run)).not.toContain('tickets_file_inherited');
    expect(wgit(project.path, 'ls-files', '.emberline')).toBe('');
  });

  it('with main checked out detached, a tickets file the agent committed on its branch is still imported', async () => {
    const project = await createProject();
    wgit(project.path, 'checkout', '-q', '--detach');
    const run = await startTicket(project.id, 'Plan it');
    writeTickets(run.worktreePath, draftsFile(['Detached child']));
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'plan');
    await finishTurn(run);

    await expect.poll(() => titles(project.id), { timeout: 10_000 }).toContain('Detached child');
    expect(await eventTypes(run)).not.toContain('tickets_file_inherited');
  });
});


describe('wizard projects have one planner', { timeout: 30_000 }, () => {
  async function wizardProject() {
    const project = await createProject();
    const factory = (
      await api('POST', `/api/projects/${project.id}/tickets`, { title: '[Factory] Build it', status: 'ready', persona: 'product_owner' })
    ).json() as Ticket;
    return { project, factory };
  }

  async function runWithTicketsFile(projectId: string, title: string) {
    const run = await startTicket(projectId, title, 'architect');
    writeTickets(run.worktreePath, draftsFile(['Core: store', 'UI: page']));
    writeFileSync(path.join(run.worktreePath, 'a.txt'), 'a\n');
    return run;
  }

  it("Bootstrap's tickets file while [Factory] is open creates no tickets", async () => {
    const { project, factory } = await wizardProject();
    const run = await startTicket(project.id, 'Bootstrap: skeleton', 'architect');
    writeWizardTickets(t.db, project.id, { bootstrap: run.ticketId!, factory: factory.id, bootstrapWritesWorktree: false });
    writeTickets(run.worktreePath, draftsFile(['Core: store', 'UI: page']));
    writeFileSync(path.join(run.worktreePath, 'a.txt'), 'a\n');
    await finishTurn(run);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_file_left_to_factory');
    expect((await eventsOf(run)).find((e) => e.type === 'tickets_file_left_to_factory')?.payload).toEqual({ drafts: 2 });
    expect(await eventTypes(run)).not.toContain('tickets_imported');
    expect((await titles(project.id)).sort()).toEqual(['Bootstrap: skeleton', '[Factory] Build it'].sort());
    expect(existsSync(path.join(run.worktreePath, TICKETS))).toBe(false);
    // consumed and claimed: the same content written again by another run is a duplicate
    expect(readProjectSettings(t.db, project.id).ingestedTicketFiles).toHaveLength(1);
  });

  it('the Deploy ticket is held to the same rule', async () => {
    const { project, factory } = await wizardProject();
    const run = await startTicket(project.id, 'Deploy: prepare', 'architect');
    writeWizardTickets(t.db, project.id, { bootstrap: factory.id, deploy: run.ticketId!, factory: factory.id, bootstrapWritesWorktree: false });
    writeTickets(run.worktreePath, draftsFile(['Core: store', 'UI: page']));
    writeFileSync(path.join(run.worktreePath, 'a.txt'), 'a\n');
    await finishTurn(run);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_file_left_to_factory');
    expect(await eventTypes(run)).not.toContain('tickets_imported');
    expect((await titles(project.id)).sort()).toEqual(['Deploy: prepare', '[Factory] Build it'].sort());
  });

  it('after [Factory] is done the file is imported', async () => {
    const { project, factory } = await wizardProject();
    await api('PATCH', `/api/tickets/${factory.id}`, { status: 'done' });
    const run = await startTicket(project.id, 'Bootstrap: skeleton', 'architect');
    writeWizardTickets(t.db, project.id, { bootstrap: run.ticketId!, factory: factory.id, bootstrapWritesWorktree: false });
    writeTickets(run.worktreePath, draftsFile(['Core: store', 'UI: page']));
    writeFileSync(path.join(run.worktreePath, 'a.txt'), 'a\n');
    await finishTurn(run);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_imported');
    expect(await eventTypes(run)).not.toContain('tickets_file_left_to_factory');
  });

  it('a deleted [Factory] ticket no longer blocks the import', async () => {
    const { project, factory } = await wizardProject();
    const run = await startTicket(project.id, 'Bootstrap: skeleton', 'architect');
    writeWizardTickets(t.db, project.id, { bootstrap: run.ticketId!, factory: factory.id, bootstrapWritesWorktree: false });
    expect((await api('DELETE', `/api/tickets/${factory.id}`)).statusCode).toBeLessThan(300);
    writeTickets(run.worktreePath, draftsFile(['Core: store', 'UI: page']));
    writeFileSync(path.join(run.worktreePath, 'a.txt'), 'a\n');
    await finishTurn(run);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_imported');
  });

  it('a non-wizard architect ticket imports as before', async () => {
    const project = await createProject();
    const run = await runWithTicketsFile(project.id, 'Architect: plan');
    await finishTurn(run);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_imported');
  });
});

describe('same-title drafts are skipped', { timeout: 30_000 }, () => {
  const rawDrafts = (tickets: object[]) => JSON.stringify({ autoDispatch: false, tickets });

  async function runWith(projectId: string, tickets: object[]) {
    const run = await startTicket(projectId, 'Plan');
    writeTickets(run.worktreePath, rawDrafts(tickets));
    writeFileSync(path.join(run.worktreePath, 'a.txt'), 'a\n');
    await finishTurn(run);
    return run;
  }
  const listTickets = async (projectId: string) => (await api('GET', `/api/projects/${projectId}/tickets`)).json() as Ticket[];

  it('a draft with the title of an open ticket is skipped; its dependents depend on that ticket', async () => {
    const project = await createProject();
    const open = (await api('POST', `/api/projects/${project.id}/tickets`, { title: 'Core: booking store', status: 'ready' })).json() as Ticket;
    const run = await runWith(project.id, [
      { ref: 'core', title: '  core:   Booking store.' },
      { ref: 'ui', title: 'UI: page', dependsOn: ['core'] },
    ]);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_imported');
    expect((await eventsOf(run)).find((e) => e.type === 'ticket_draft_duplicate')?.payload).toEqual({
      title: 'core:   Booking store.',
      existing: open.key,
    });
    const all = await listTickets(project.id);
    expect(all.filter((x) => x.title.toLowerCase().includes('booking store'))).toHaveLength(1);
    expect(all.find((x) => x.title === 'UI: page')?.dependsOn).toEqual([open.id]);
  });

  it('a done ticket with the same title does not block the draft', async () => {
    const project = await createProject();
    const old = (await api('POST', `/api/projects/${project.id}/tickets`, { title: 'Core: store', status: 'ready' })).json() as Ticket;
    await api('PATCH', `/api/tickets/${old.id}`, { status: 'done' });
    const run = await runWith(project.id, [{ title: 'Core: store' }]);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_imported');
    expect(await eventTypes(run)).not.toContain('ticket_draft_duplicate');
    expect((await titles(project.id)).filter((x) => x === 'Core: store')).toHaveLength(2);
  });

  it('a repeated title within one file keeps the first; dependents of the second depend on the first', async () => {
    const project = await createProject();
    const run = await runWith(project.id, [
      { ref: 'a', title: 'Store' },
      { ref: 'b', title: 'store' },
      { ref: 'c', title: 'Page', dependsOn: ['b'] },
    ]);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('tickets_imported');
    const all = await listTickets(project.id);
    const store = all.find((x) => x.title === 'Store')!;
    expect(all.map((x) => x.title).filter((x) => x === 'Store' || x === 'store' || x === 'Page').sort()).toEqual(['Page', 'Store']);
    expect(all.find((x) => x.title === 'Page')?.dependsOn).toEqual([store.id]);
    const dups = (await eventsOf(run)).filter((e) => e.type === 'ticket_draft_duplicate');
    expect(dups.map((e) => e.payload)).toEqual([{ title: 'store', existing: store.key }]);
  });

  it('when every draft is skipped there is no tickets_imported event', async () => {
    const project = await createProject();
    await api('POST', `/api/projects/${project.id}/tickets`, { title: 'Core: store', status: 'ready' });
    const run = await runWith(project.id, [{ title: 'core: store' }]);
    await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('ticket_draft_duplicate');
    expect(await eventTypes(run)).not.toContain('tickets_imported');
  });
});
