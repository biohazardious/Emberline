import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { TicketService } from './tickets/service.js';

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


type Draft = { ref?: string; title: string; persona?: string; dependsOn?: string[] };

/** Runs a PO ticket that writes `drafts` into its worktree and lets its Stop ingest them. */
async function ingestDrafts(projectId: string, drafts: Draft[]): Promise<{ run: Run; tickets: Ticket[] }> {
  await api('PATCH', '/api/factory/settings', { autoPickupReady: false });
  const po = await createTicket(projectId, { title: 'Plan the work', status: 'ready' });
  const { run } = (await api('POST', `/api/tickets/${po.id}/start`, {})).json() as { run: Run };
  mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
  writeFileSync(
    path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
    JSON.stringify({ autoDispatch: false, tickets: drafts }),
  );
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  await hook(run.id, 'Stop', token);
  const list = async () =>
    ((await api('GET', `/api/projects/${projectId}/tickets`)).json() as Ticket[]).filter((x) => x.id !== po.id);
  await expect.poll(async () => (await list()).length).toBe(drafts.length);
  // The edges are written right after the tickets: wait for the run note.
  await expect
    .poll(async () => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type))
    .toContain('dependencies_applied');
  return { run, tickets: await list() };
}

const byTitle = (tickets: Ticket[], title: string) => tickets.find((x) => x.title === title) as Ticket;

describe('ticket dependencies', () => {
  it('ingests PO drafts with refs into dependsOn edges and blockedBy', async () => {
    const project = await createProject();
    const { run, tickets } = await ingestDrafts(project.id, [
      { ref: 'brand-assets', title: 'Brand assets', persona: 'ui_ux' },
      { ref: 'android-shell', title: 'Android shell', persona: 'coder' },
      { ref: 'apk-build', title: 'APK build', persona: 'coder', dependsOn: ['brand-assets', 'android-shell'] },
      { ref: 'qa', title: 'QA pass', persona: 'qa', dependsOn: ['apk-build'] },
    ]);
    expect(tickets).toHaveLength(4);
    const [assets, shell, apk, qa] = ['Brand assets', 'Android shell', 'APK build', 'QA pass'].map((x) => byTitle(tickets, x));
    expect([...(apk as Ticket).dependsOn].sort()).toEqual([(assets as Ticket).id, (shell as Ticket).id].sort());
    expect((qa as Ticket).blockedBy.map((b) => b.key)).toEqual([(apk as Ticket).key]);
    expect((assets as Ticket).blockedBy).toEqual([]);
    const detail: RunDetail = (await api('GET', `/api/runs/${run.id}`)).json();
    const applied = detail.events.find((e) => e.type === 'dependencies_applied');
    expect(applied?.payload).toMatchObject({
      edges: expect.arrayContaining([{ ticket: (qa as Ticket).key, dependsOn: (apk as Ticket).key }]),
    });
  });

  it('creates every ticket and drops unknown refs and cycles with notes', async () => {
    const project = await createProject();
    const { run, tickets } = await ingestDrafts(project.id, [
      { ref: 'a', title: 'A', dependsOn: ['b', 'ghost'] },
      { ref: 'b', title: 'B', dependsOn: ['a'] },
    ]);
    const a = byTitle(tickets, 'A');
    const b = byTitle(tickets, 'B');
    expect(a.dependsOn).toEqual([b.id]);
    expect(b.dependsOn).toEqual([]);
    const detail: RunDetail = (await api('GET', `/api/runs/${run.id}`)).json();
    const dropped = detail.events.filter((e) => e.type === 'dependency_dropped').map((e) => e.payload);
    expect(dropped).toEqual(
      expect.arrayContaining([
        { ticket: a.key, ref: 'ghost', reason: 'unknown' },
        { ticket: b.key, ref: 'a', reason: 'cycle' },
      ]),
    );
  });

  it('applies the default tiers when no draft declares dependsOn', async () => {
    const project = await createProject();
    const { tickets } = await ingestDrafts(project.id, [
      { title: 'Build', persona: 'coder' },
      { title: 'Design', persona: 'ui_ux' },
      { title: 'Verify', persona: 'qa' },
    ]);
    const verify = byTitle(tickets, 'Verify');
    expect([...verify.dependsOn].sort()).toEqual([byTitle(tickets, 'Build').id, byTitle(tickets, 'Design').id].sort());
    expect(byTitle(tickets, 'Build').dependsOn).toEqual([]);
    expect(byTitle(tickets, 'Design').dependsOn).toEqual([]);
  });

  it('sets dependencies through PATCH by key or id and reports errors', async () => {
    const project = await createProject();
    const other = await createProject('Other Project');
    const a = await createTicket(project.id, { title: 'A' });
    const b = await createTicket(project.id, { title: 'B' });
    const c = await createTicket(project.id, { title: 'C' });
    const foreign = await createTicket(other.id, { title: 'Foreign' });

    const ok = await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [a.key.toLowerCase(), b.id] });
    expect(ok.statusCode).toBe(200);
    const patched = ok.json() as Ticket;
    expect([...patched.dependsOn].sort()).toEqual([a.id, b.id].sort());
    expect(patched.blockedBy.map((x) => x.key).sort()).toEqual([a.key, b.key].sort());
    expect((await getTicket(c.id)).blockedBy).toHaveLength(2);

    const unknown = await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: ['NOPE-99'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'unknown_dependency' });
    expect((await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [foreign.id] })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [foreign.key] })).statusCode).toBe(400);

    const self = await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [c.key] });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: 'dependency_cycle' });
    // c waits for a and b: a waiting for c closes a cycle.
    expect((await api('PATCH', `/api/tickets/${a.id}`, { dependsOn: [c.id] })).statusCode).toBe(409);
    // A rejected update leaves the stored set alone.
    expect([...(await getTicket(c.id)).dependsOn].sort()).toEqual([a.id, b.id].sort());

    const cleared = (await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [] })).json() as Ticket;
    expect(cleared.dependsOn).toEqual([]);
    expect(cleared.blockedBy).toEqual([]);
  });

  it('drops a blocker from blockedBy once the dependency is done', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A' });
    const b = await createTicket(project.id, { title: 'B' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    const list = async () => (await api('GET', `/api/projects/${project.id}/tickets`)).json() as Ticket[];
    expect((await list()).find((x) => x.id === b.id)?.blockedBy.map((x) => x.id)).toEqual([a.id]);
    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    const after = (await list()).find((x) => x.id === b.id) as Ticket;
    expect(after.blockedBy).toEqual([]);
    expect(after.dependsOn).toEqual([a.id]);
    expect((await getTicket(b.id)).blockedBy).toEqual([]);
  });
});

/** Ticket runs of the project, oldest first. */
const ticketRuns = (projectId: string) =>
  t.runs
    .list()
    .filter((r) => r.projectId === projectId && r.ticketId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const runsFor = (ticketId: string) => t.runs.list().filter((r) => r.ticketId === ticketId);
const ACTIVE = new Set<Run['state']>(['queued', 'starting', 'working', 'waiting_input', 'rate_limited']);

/** Lets a started agent work and finish its turn; the pipeline then moves its ticket on. */
async function finish(run: Run): Promise<void> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  await hook(run.id, 'Stop', token);
}

/** Records every pipeline pass so a test can wait for all of them, dispatch included. */
function trackPipelines(): Promise<void>[] {
  const passes: Promise<void>[] = [];
  const svc = t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> };
  const original = svc.handleRunCompleted.bind(t.tickets);
  svc.handleRunCompleted = (r) => {
    const pass = original(r);
    passes.push(pass);
    return pass;
  };
  return passes;
}

const statusOf = async (id: string) => (await getTicket(id)).status;

/** The started agents write into the test directory; let them get there before teardown. */
const settle = (projectId: string) =>
  Promise.all(
    t.runs
      .list()
      .filter((r) => r.projectId === projectId && r.state !== 'queued')
      .map((r) => waitFile(`token-${r.id}`)),
  );

describe('dependency-aware dispatch', () => {
  it('starts a dependent ticket only after its dependency is done', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready', priority: 1 });
    const b = await createTicket(project.id, { title: 'B', status: 'ready', priority: 3 });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).map((r) => r.ticketId)).toEqual([a.id]);

    await finish(runsFor(a.id)[0] as Run);
    await expect.poll(() => statusOf(a.id), { timeout: 10_000 }).toBe('done');
    await expect.poll(() => runsFor(b.id).length, { timeout: 10_000 }).toBe(1);
    await settle(project.id);
  });

  it('starts independent tickets up to the per-project limit and fills a freed slot', async () => {
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready' });
    const z = await createTicket(project.id, { title: 'Z', status: 'ready' });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).map((r) => r.ticketId)).toEqual([x.id, y.id]);
    expect(await t.tickets.dispatchNextReadyTicket(project.id)).toEqual([]);

    await finish(runsFor(x.id)[0] as Run);
    await expect.poll(() => runsFor(z.id).length, { timeout: 10_000 }).toBe(1);
    expect(runsFor(y.id)).toHaveLength(1);
    await settle(project.id);
  });

  it('starts one ticket at a time with maxParallelTicketsPerProject 1', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready' });

    const first = await t.tickets.dispatchNextReadyTicket(project.id);
    expect(first.map((s) => s.ticket.id)).toEqual([x.id]);
    expect(await t.tickets.dispatchNextReadyTicket(project.id)).toEqual([]);
    expect(runsFor(y.id)).toHaveLength(0);

    await finish(runsFor(x.id)[0] as Run);
    await expect.poll(() => runsFor(y.id).length, { timeout: 10_000 }).toBe(1);
    await settle(project.id);
  });

  it('does not count a ticket-less run of the project as busy', async () => {
    const project = await createProject();
    const manual = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'look around' })).json() as Run;
    expect(manual.ticketId).toBeNull();
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready' });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).map((r) => r.ticketId)).toEqual([x.id, y.id]);
    await waitFile(`token-${manual.id}`);
    await settle(project.id);
  });

  it('reads edges and statuses only from the database (a restarted core still waits)', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready', priority: 1 });
    const b = await createTicket(project.id, { title: 'B', status: 'ready', priority: 3 });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });

    // A fresh service has no in-memory state: what it knows comes from the DB.
    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    await restarted.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).map((r) => r.ticketId)).toEqual([a.id]);
    const again = new TicketService(t.db, t.runs, t.scheduler);
    expect(await again.dispatchNextReadyTicket(project.id)).toEqual([]);
    expect(runsFor(b.id)).toHaveLength(0);
    await settle(project.id);
  });

  it('two runs finishing at once start no ticket twice and never exceed the limit', async () => {
    const project = await createProject();
    const created: Ticket[] = [];
    for (const title of ['P1', 'P2', 'P3', 'P4']) created.push(await createTicket(project.id, { title, status: 'ready' }));
    let maxBusy = 0;
    t.runs.on('run', () => {
      const busy = t.runs
        .list()
        .filter((r) => r.projectId === project.id && r.ticketId && !r.handedOffTo && ACTIVE.has(r.state)).length;
      maxBusy = Math.max(maxBusy, busy);
    });
    const passes = trackPipelines();

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id)).toHaveLength(2);
    const [r1, r2] = ticketRuns(project.id) as [Run, Run];
    const [k1, k2] = await Promise.all([waitFile(`token-${r1.id}`), waitFile(`token-${r2.id}`)]);
    for (const [run, token] of [
      [r1, k1],
      [r2, k2],
    ] as const) {
      await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
      await hook(run.id, 'UserPromptSubmit', token);
    }
    await Promise.all([hook(r1.id, 'Stop', k1), hook(r2.id, 'Stop', k2)]);
    await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(2);
    await Promise.all(passes);

    for (const ticket of created) expect(runsFor(ticket.id)).toHaveLength(1);
    expect(maxBusy).toBeLessThanOrEqual(2);
    await settle(project.id);
  });

  it('another dispatch leaves a Review ticket whose own pipeline is still running alone', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const merges: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const svc = t.tickets as unknown as { mergeRunIntoMain(r: Run, main: string, key: string | null): Promise<boolean> };
    const merge = svc.mergeRunIntoMain.bind(t.tickets);
    svc.mergeRunIntoMain = async (r, main, key) => {
      merges.push(r.id);
      if (merges.length === 1) await gate;
      return merge(r, main, key);
    };

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    await finish(run);
    // A's pipeline now waits inside its merge; its ticket sits in Review with a done run.
    await expect.poll(() => merges.length, { timeout: 5_000 }).toBe(1);
    expect(await statusOf(a.id)).toBe('review');
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(merges).toEqual([run.id]);

    release();
    await Promise.all(passes);
    expect(merges).toEqual([run.id]);
    expect(await statusOf(a.id)).toBe('done');
  });

  it("starts at most the limit of an upgraded project's ready tickets without edges", async () => {
    const project = await createProject();
    for (const title of ['U1', 'U2', 'U3', 'U4']) await createTicket(project.id, { title, status: 'ready' });
    await Promise.all([t.tickets.dispatchNextReadyTicket(project.id), t.tickets.dispatchNextReadyTicket(project.id)]);
    expect(ticketRuns(project.id)).toHaveLength(2);
    await settle(project.id);
  });

  it('a manual move of a dependency to done dispatches the unblocked ticket', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });

    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    await expect.poll(() => runsFor(b.id).length, { timeout: 5_000 }).toBe(1);
    expect(runsFor(a.id)).toHaveLength(0);
    await settle(project.id);
  });

  it('republishes dependents when their dependency moves to done', async () => {
    await api('PATCH', '/api/factory/settings', { autoPickupReady: false });
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    const seen: Ticket[] = [];
    t.tickets.on('ticket', (tk) => seen.push(tk));

    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    const forB = seen.filter((tk) => tk.id === b.id);
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.at(-1)?.blockedBy).toEqual([]);
    expect(forB.at(-1)?.dependsOn).toEqual([a.id]);
  });

  it('runs the APK example in dependency order', async () => {
    const project = await createProject();
    const { run: po, tickets } = await ingestDrafts(project.id, [
      { ref: 'brand-assets', title: 'Brand assets', persona: 'ui_ux' },
      { ref: 'android-shell', title: 'Android shell', persona: 'coder' },
      { ref: 'apk-build', title: 'APK build', persona: 'coder', dependsOn: ['brand-assets', 'android-shell'] },
      { ref: 'qa', title: 'QA pass', persona: 'qa', dependsOn: ['apk-build'] },
    ]);
    const assets = byTitle(tickets, 'Brand assets');
    const shell = byTitle(tickets, 'Android shell');
    const apk = byTitle(tickets, 'APK build');
    const qa = byTitle(tickets, 'QA pass');
    await expect.poll(() => statusOf(po.ticketId as string), { timeout: 10_000 }).toBe('done');
    await api('PATCH', '/api/factory/settings', { autoPickupReady: true });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).filter((r) => r.id !== po.id).map((r) => r.ticketId).sort()).toEqual([assets.id, shell.id].sort());

    await finish(runsFor(shell.id)[0] as Run);
    await expect.poll(() => statusOf(shell.id), { timeout: 10_000 }).toBe('done');
    // Serialized behind any dispatch the pipeline started: apk-build still waits for brand-assets.
    expect(await t.tickets.dispatchNextReadyTicket(project.id)).toEqual([]);
    expect(runsFor(apk.id)).toHaveLength(0);

    await finish(runsFor(assets.id)[0] as Run);
    await expect.poll(() => runsFor(apk.id).length, { timeout: 10_000 }).toBe(1);
    expect(runsFor(qa.id)).toHaveLength(0);

    await finish(runsFor(apk.id)[0] as Run);
    await expect.poll(() => runsFor(qa.id).length, { timeout: 10_000 }).toBe(1);
    await settle(project.id);
  });
});
