import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from './db/index.js';
import { runs, settings, tickets as ticketRows } from './db/schema.js';
import type * as FactoryService from './factory/service.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { CONFLICT_ATTEMPT_CAP, TicketService } from './tickets/service.js';

/** A critic verdict for the next pipelines to get instead of running the real critic (null: the real one). */
const critic = vi.hoisted(() => ({
  result: null as null | { verdict: 'PASS' | 'NEEDS_FIX'; followUpPrompt: string | null },
  calls: 0,
  /** The next call never answers (core goes down meanwhile). */
  hang: false,
  /** The next call answers once this settles. */
  held: null as null | Promise<void>,
}));
/** A build gate result for the next pipelines to get instead of building (null: the real build). */
const build = vi.hoisted(() => ({ result: null as null | { ok: boolean; output: string }, calls: 0 }));
vi.mock('./factory/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryService>();
  return {
    ...actual,
    runCrossProviderCritic: (async (params) => {
      critic.calls += 1;
      if (critic.hang) {
        critic.hang = false;
        return new Promise(() => undefined);
      }
      if (critic.held) {
        const held = critic.held;
        critic.held = null;
        await held;
      }
      return critic.result ?? actual.runCrossProviderCritic(params);
    }) as typeof actual.runCrossProviderCritic,
    buildWorkspaceDemo: (async (params) => {
      build.calls += 1;
      return build.result
        ? { ...build.result, targetId: params.targetId, demoEntryRelPath: null, demoUrl: null }
        : actual.buildWorkspaceDemo(params);
    }) as typeof actual.buildWorkspaceDemo,
  };
});

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
  critic.result = null;
  critic.calls = 0;
  critic.hang = false;
  critic.held = null;
  build.result = null;
  build.calls = 0;
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

/**
 * The agent's `ticket_complete` call: Claude ticket runs in a factory advance only with it. Its
 * `emberline-mcp` checks in first (once per run, as on startup), so the run is gated like a real one.
 */
const signal = async (runId: string, token: string, summary = 'done') => {
  const headers = { authorization: `Bearer ${token}` };
  await t.app.inject({ method: 'POST', url: `/api/internal/runs/${runId}/completion-tool`, headers });
  return t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${runId}/complete`,
    headers,
    payload: { summary },
  });
};

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

/** `ref` and `dependsOn` are loose on purpose: the PO writes them by hand. */
type Draft = { ref?: unknown; title: string; persona?: string; dependsOn?: unknown };

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
  await signal(run.id, token);
  await hook(run.id, 'Stop', token);
  const list = async () =>
    ((await api('GET', `/api/projects/${projectId}/tickets`)).json() as Ticket[]).filter(
      (x) => x.id !== po.id,
    );
  await expect.poll(async () => (await list()).length).toBe(drafts.length);
  // The edges are written right after the tickets: wait for the run note.
  await expect
    .poll(async () =>
      ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type),
    )
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
      {
        ref: 'apk-build',
        title: 'APK build',
        persona: 'coder',
        dependsOn: ['brand-assets', 'android-shell'],
      },
      { ref: 'qa', title: 'QA pass', persona: 'qa', dependsOn: ['apk-build'] },
    ]);
    expect(tickets).toHaveLength(4);
    const [assets, shell, apk, qa] = ['Brand assets', 'Android shell', 'APK build', 'QA pass'].map((x) =>
      byTitle(tickets, x),
    );
    expect([...(apk as Ticket).dependsOn].sort()).toEqual(
      [(assets as Ticket).id, (shell as Ticket).id].sort(),
    );
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

  it('keeps the whole batch when a ref or dependsOn is malformed', async () => {
    const project = await createProject();
    const { tickets } = await ingestDrafts(project.id, [
      { ref: 'brand_assets', title: 'Brand assets', persona: 'ui_ux' },
      { ref: 7, title: 'Android shell', persona: 'coder' },
      { ref: 'apk-build', title: 'APK build', persona: 'coder', dependsOn: ['brand_assets', 7] },
      { ref: 'qa', title: 'QA pass', persona: 'qa', dependsOn: 'apk-build' },
    ]);
    expect(tickets).toHaveLength(4);
    const apk = byTitle(tickets, 'APK build');
    expect([...apk.dependsOn].sort()).toEqual(
      [byTitle(tickets, 'Brand assets').id, byTitle(tickets, 'Android shell').id].sort(),
    );
    expect(byTitle(tickets, 'QA pass').dependsOn).toEqual([apk.id]);
  });

  it('notes a tickets file it cannot read on the run instead of dropping it silently', async () => {
    await api('PATCH', '/api/factory/settings', { autoPickupReady: false });
    const project = await createProject();
    for (const content of [
      '{ "tickets": [ { "title": "A" ',
      JSON.stringify({ autoDispatch: false, tickets: [] }),
    ]) {
      const po = await createTicket(project.id, { title: 'Plan the work', status: 'ready' });
      const { run } = (await api('POST', `/api/tickets/${po.id}/start`, {})).json() as { run: Run };
      const file = path.join(run.worktreePath, '.emberline', 'new-tickets.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      const token = await waitFile(`token-${run.id}`);
      await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
      await hook(run.id, 'UserPromptSubmit', token);
      await hook(run.id, 'Stop', token);
      await expect
        .poll(async () =>
          ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type),
        )
        .toContain('tickets_file_rejected');
      const detail = (await api('GET', `/api/runs/${run.id}`)).json() as RunDetail;
      const note = detail.events.find((e) => e.type === 'tickets_file_rejected')?.payload as {
        message: string;
      };
      expect(note.message.length).toBeGreaterThan(0);
      expect(note.message.length).toBeLessThanOrEqual(500);
      expect(existsSync(file)).toBe(false);
    }
  });

  it('orders tickets delegated through the API like ingested ones', async () => {
    const project = await createProject();
    const delegate = async (tickets: object[]) => {
      const res = await api('POST', `/api/projects/${project.id}/delegate-tickets`, {
        autoDispatch: false,
        tickets,
      });
      expect(res.statusCode).toBe(201);
      return res.json() as Ticket[];
    };

    // No dependsOn anywhere: the default tiers put QA after the code.
    const [coder, qa] = await delegate([
      { title: 'Code it', persona: 'coder' },
      { title: 'Test it', persona: 'qa' },
    ]);
    expect(qa?.dependsOn).toEqual([coder?.id]);
    expect(qa?.blockedBy.map((b) => b.key)).toEqual([coder?.key]);
    expect((await getTicket((qa as Ticket).id)).dependsOn).toEqual([coder?.id]);

    // Explicit refs, and the key of an existing ticket.
    const [shell, apk] = await delegate([
      { ref: 'shell', title: 'Shell', persona: 'coder' },
      { ref: 'apk', title: 'APK', persona: 'coder', dependsOn: ['shell', (coder as Ticket).key] },
    ]);
    expect([...(apk as Ticket).dependsOn].sort()).toEqual([shell?.id, coder?.id].sort());
    expect(shell?.dependsOn).toEqual([]);
  });

  it('applies the default tiers when no draft declares dependsOn', async () => {
    const project = await createProject();
    const { tickets } = await ingestDrafts(project.id, [
      { title: 'Build', persona: 'coder' },
      { title: 'Design', persona: 'ui_ux' },
      { title: 'Verify', persona: 'qa' },
    ]);
    const verify = byTitle(tickets, 'Verify');
    expect([...verify.dependsOn].sort()).toEqual(
      [byTitle(tickets, 'Build').id, byTitle(tickets, 'Design').id].sort(),
    );
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

/** Lets a started agent work and finish its turn (signalled); the pipeline then moves its ticket on. */
async function finish(run: Run): Promise<void> {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  await signal(run.id, token);
  await hook(run.id, 'Stop', token);
}

/** Records every pipeline pass so a test can wait for all of them, dispatch included. */
function trackPipelines(service: TicketService = t.tickets): Promise<void>[] {
  const passes: Promise<void>[] = [];
  const svc = service as unknown as { handleRunCompleted(r: Run, opts?: object): Promise<void> };
  const original = svc.handleRunCompleted.bind(service);
  svc.handleRunCompleted = (r, opts) => {
    const pass = original(r, opts);
    passes.push(pass);
    return pass;
  };
  return passes;
}

const statusOf = async (id: string) => (await getTicket(id)).status;

/** Waits until every dispatch pass queued for the project so far is through. */
const dispatchesDone = (projectId: string) =>
  (
    t.tickets as unknown as { dispatchLock: { run(key: string, fn: () => Promise<void>): Promise<void> } }
  ).dispatchLock.run(projectId, async () => undefined);

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

  it('still finishes a parallel ticket whose sibling emptied the queue first', async () => {
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready' });
    const passes = trackPipelines();

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).map((r) => r.ticketId)).toEqual([x.id, y.id]);

    // X finishes first; its dispatch finds nothing left to start while Y is still working.
    await finish(runsFor(x.id)[0] as Run);
    await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(1);
    await Promise.all(passes);
    expect(await statusOf(x.id)).toBe('done');

    // Y's completion is still part of the factory chain: merged and moved to Done, not left in Review.
    await finish(runsFor(y.id)[0] as Run);
    await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(2);
    await Promise.all(passes);
    expect(await statusOf(y.id)).toBe('done');
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
    const manual = (
      await api('POST', '/api/runs', { projectId: project.id, prompt: 'look around' })
    ).json() as Run;
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
    for (const title of ['P1', 'P2', 'P3', 'P4'])
      created.push(await createTicket(project.id, { title, status: 'ready' }));
    let maxBusy = 0;
    t.runs.on('run', () => {
      const busy = t.runs
        .list()
        .filter(
          (r) => r.projectId === project.id && r.ticketId && !r.handedOffTo && ACTIVE.has(r.state),
        ).length;
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
      await signal(run.id, token);
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
    const svc = t.tickets as unknown as {
      mergeRunIntoMain(
        r: Run,
        main: string,
        key: string | null,
      ): Promise<{ ok: boolean; conflicts: string[] }>;
    };
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
    await Promise.all([
      t.tickets.dispatchNextReadyTicket(project.id),
      t.tickets.dispatchNextReadyTicket(project.id),
    ]);
    expect(ticketRuns(project.id)).toHaveLength(2);
    await settle(project.id);
  });

  it('a manual move of a dependency to done starts only the tickets waiting for it', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    const c = await createTicket(project.id, { title: 'C', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });

    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    await expect.poll(() => runsFor(b.id).length, { timeout: 5_000 }).toBe(1);
    await dispatchesDone(project.id);
    expect(runsFor(a.id)).toHaveLength(0);
    expect(runsFor(c.id)).toHaveLength(0);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    await settle(project.id);
  });

  it('a manual move to done in a chaining project dispatches the whole queue', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    const c = await createTicket(project.id, { title: 'C', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    t.tickets.setAutoChain(project.id, true);

    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    await expect.poll(() => runsFor(b.id).length + runsFor(c.id).length, { timeout: 5_000 }).toBe(2);
    await settle(project.id);
  });

  it('removing the last blocker starts only the ticket it unblocked', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'backlog' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    const c = await createTicket(project.id, { title: 'C', status: 'ready' });
    const d = await createTicket(project.id, { title: 'D', status: 'ready' });
    const e = await createTicket(project.id, { title: 'E', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    await api('PATCH', `/api/tickets/${c.id}`, { dependsOn: [a.id] });

    // Its dependsOn changed and nothing blocks it any more.
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [] });
    await expect.poll(() => runsFor(b.id).length, { timeout: 5_000 }).toBe(1);
    // The ticket it waited for is deleted.
    await api('DELETE', `/api/tickets/${a.id}`);
    await expect.poll(() => runsFor(c.id).length, { timeout: 5_000 }).toBe(1);
    await dispatchesDone(project.id);
    expect(runsFor(d.id)).toHaveLength(0);
    expect(runsFor(e.id)).toHaveLength(0);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    await settle(project.id);
  });

  it('removing a blocker in a chaining project dispatches the queue', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'backlog' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    t.tickets.setAutoChain(project.id, true);

    await api('DELETE', `/api/tickets/${a.id}`);
    await expect.poll(() => runsFor(b.id).length, { timeout: 5_000 }).toBe(1);
    await settle(project.id);
  });

  it('a manual move to done in a plain project starts nothing', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    await createTicket(project.id, { title: 'B', status: 'ready' });
    // update() calls dispatch synchronously when it dispatches at all, so a spy sees it right away.
    const calls: string[] = [];
    const dispatch = t.tickets.dispatchNextReadyTicket.bind(t.tickets);
    t.tickets.dispatchNextReadyTicket = (projectId) => {
      calls.push(projectId);
      return dispatch(projectId);
    };

    expect((await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' })).statusCode).toBe(200);
    expect(calls).toEqual([]);
    expect(ticketRuns(project.id)).toEqual([]);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
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
      {
        ref: 'apk-build',
        title: 'APK build',
        persona: 'coder',
        dependsOn: ['brand-assets', 'android-shell'],
      },
      { ref: 'qa', title: 'QA pass', persona: 'qa', dependsOn: ['apk-build'] },
    ]);
    const assets = byTitle(tickets, 'Brand assets');
    const shell = byTitle(tickets, 'Android shell');
    const apk = byTitle(tickets, 'APK build');
    const qa = byTitle(tickets, 'QA pass');
    await expect.poll(() => statusOf(po.ticketId as string), { timeout: 10_000 }).toBe('done');
    await api('PATCH', '/api/factory/settings', { autoPickupReady: true });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(
      ticketRuns(project.id)
        .filter((r) => r.id !== po.id)
        .map((r) => r.ticketId)
        .sort(),
    ).toEqual([assets.id, shell.id].sort());

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

/** Like the usual stand-in, but it stays alive and logs every line typed into it (the start prompt is an argument). */
function writeLivingClaude(dir: string): string {
  const file = path.join(dir, 'living-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      `: > "${dir}/ready-$EMBERLINE_RUN_ID"`,
      `while read line; do printf '%s\\n' "$line" >> "${dir}/followups-$EMBERLINE_RUN_ID"; done`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

const wgit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
  });

const followups = (run: Run) => {
  const file = path.join(t.dir, `followups-${run.id}`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};
const eventTypes = async (run: Run) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type);

/** Records the automatic prompts instead of typing them (both services share the run service). */
function recordPrompts(): string[] {
  const sent: string[] = [];
  (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async (id, text) => {
    sent.push(text);
    return t.runs.getRun(id);
  };
  return sent;
}

/** A new (signalled) turn of the agent, e.g. after a gate's follow-up. */
const stopAgain = async (run: Run) => {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'UserPromptSubmit', token);
  await signal(run.id, token);
  await hook(run.id, 'Stop', token);
};

describe('one automatic merge-conflict resolution', () => {
  const FOLLOW_UP = (files: string, branch = 'main') =>
    `${branch} has moved on while you worked and your branch no longer merges cleanly (conflicts in: ${files}). Merge ${branch} into your branch (git merge ${branch}), resolve every conflict keeping the intent of both changes, run the project's checks, commit, and finish. When finished, call \`ticket_complete\` again.`;

  /** Two tickets editing the same line; A has been merged into main, B conflicts with it. */
  async function conflictingPair(branch = 'main') {
    t.config.claudeCommand = writeLivingClaude(t.dir);
    const project = await createProject();
    writeFileSync(path.join(project.path, 'app.js'), 'one\ntwo\nthree\n');
    wgit(project.path, 'add', '-A');
    wgit(project.path, 'commit', '-q', '-m', 'app');
    if (branch !== 'main') wgit(project.path, 'branch', '-m', branch);
    // A factory project: a finished orchestrator ticket keeps the pipeline on for A and B.
    await createTicket(project.id, { title: '[Factory] Plan', status: 'done' });
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    await t.tickets.dispatchNextReadyTicket(project.id);
    const runA = runsFor(a.id)[0] as Run;
    const runB = runsFor(b.id)[0] as Run;
    writeFileSync(path.join(runA.worktreePath, 'app.js'), 'one\nfrom-a\nthree\n');
    writeFileSync(path.join(runB.worktreePath, 'app.js'), 'one\nfrom-b\nthree\n');
    // Typed input is only safe once the stand-in is reading.
    await Promise.all([waitFile(`ready-${runA.id}`), waitFile(`ready-${runB.id}`)]);
    for (const run of [runA, runB]) {
      const token = await waitFile(`token-${run.id}`);
      await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
      await hook(run.id, 'UserPromptSubmit', token);
    }
    await stopAgain(runA);
    await expect.poll(() => statusOf(a.id), { timeout: 10_000 }).toBe('done');
    // Backlog tickets are picked up by a dispatch only; creating one starts nothing by itself.
    await api('PATCH', '/api/factory/settings', { autoPickupBacklog: true });
    return { project, a, b, runA, runB };
  }

  it('asks the agent once to resolve the conflict, then merges the resolution', async () => {
    const { project, b, runB } = await conflictingPair();
    const passes = trackPipelines();
    await stopAgain(runB);
    await expect.poll(() => followups(runB).length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes); // pass 1 fully done before the next turn
    expect(followups(runB)).toEqual([FOLLOW_UP('app.js')]);
    const events = (await api('GET', `/api/runs/${runB.id}`)).json() as RunDetail;
    expect(events.events.find((e) => e.type === 'conflict_resolution_requested')?.payload).toEqual({
      conflicts: ['app.js'],
      mainHead: wgit(project.path, 'rev-parse', 'HEAD').trim(),
    });
    expect(await statusOf(b.id)).not.toBe('done');
    expect(t.runs.get(runB.id).endedAt).toBeNull();

    // The agent merges main into its branch and commits the resolution.
    try {
      wgit(runB.worktreePath, 'merge', 'main');
    } catch {
      // conflicts are expected
    }
    writeFileSync(path.join(runB.worktreePath, 'app.js'), 'one\nfrom-a\nfrom-b\nthree\n');
    wgit(runB.worktreePath, 'add', '-A');
    wgit(runB.worktreePath, 'commit', '-q', '-m', 'resolve');
    await stopAgain(runB);

    await expect.poll(() => statusOf(b.id), { timeout: 10_000 }).toBe('done');
    expect(readFileSync(path.join(runB.worktreePath, 'app.js'), 'utf8')).toContain('from-b');
    expect(await eventTypes(runB)).toContain('merged_to_main');
    expect(followups(runB)).toHaveLength(1);
  });

  it('a conflict the agent was asked to resolve is no attention and no page', async () => {
    const { runB } = await conflictingPair();
    const pages = await pagesOf();
    await stopAgain(runB);
    await expect.poll(() => followups(runB).length, { timeout: 10_000 }).toBe(1);
    expect(pages.sent).toEqual([]);
    expect(t.runs.getRun(runB.id).attention).toBeNull();
    const failed = await noteOf(runB, 'merge_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ autoFix: true, conflicts: ['app.js'] });
    pages.stop();
  });

  it('a conflict whose resolution request could not be sent is held for a person and pages once', async () => {
    const { project, b, runB } = await conflictingPair();
    const passes = trackPipelines();
    const pages = await pagesOf();
    failPrompts();
    await stopAgain(runB);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    const failed = await noteOf(runB, 'merge_failed');
    expect(failed.map((n) => (n as { autoFix?: boolean }).autoFix)).toEqual([true, false]);
    expect(failed[1]).toMatchObject({ conflicts: ['app.js'] });
    expect(await statusOf(b.id)).toBe('review');
    expect(t.runs.getRun(runB.id).attention).toMatchObject({ reason: 'held', detail: 'Merge failed' });
    await expect.poll(() => pages.sent.length).toBe(1);
    pages.stop();
    // The held run's session is closed, not cancelled: a person's prompt respawns the agent.
    await expect.poll(() => t.runs.get(runB.id).endedAt, { timeout: 10_000 }).not.toBeNull();
    expect(t.runs.getRun(runB.id)).toMatchObject({ resumable: true, cancelled: false });
    const types = await eventTypes(runB);
    expect(types).toContain('idle_session_closed');
    expect(types).not.toContain('stop_requested');
    delete (t.runs as unknown as Record<string, unknown>).prompt;
    delete (t.runs as unknown as Record<string, unknown>).sendPrompt;
    expect((await api('POST', `/api/runs/${runB.id}/prompt`, { text: 'resolve it' })).statusCode).toBe(200);
    await settle(project.id);
  });

  it('a merged factory run is still stopped by the pipeline, not kept resumable', async () => {
    const { runA } = await conflictingPair();
    await expect.poll(() => t.runs.get(runA.id).endedAt, { timeout: 10_000 }).not.toBeNull();
    expect(t.runs.getRun(runA.id)).toMatchObject({ resumable: false });
    expect(t.runs.getRun(runA.id).cancelled).toBe(true);
    const detail = (await api('GET', `/api/runs/${runA.id}`)).json() as RunDetail;
    expect(detail.events.find((e) => e.type === 'stop_requested')?.payload).toMatchObject({
      reason: 'factory_step_finished',
    });
  });

  it('names the branch the main workspace is on, not main', async () => {
    const { runB } = await conflictingPair('trunk');
    await stopAgain(runB);
    await expect.poll(() => followups(runB).length, { timeout: 10_000 }).toBe(1);
    expect(followups(runB)).toEqual([FOLLOW_UP('app.js', 'trunk')]);
  });

  it('a second conflict lands in Review, asks nothing again and dispatches the next ticket', async () => {
    const { project, b, runB } = await conflictingPair();
    const passes = trackPipelines();
    await stopAgain(runB);
    await expect.poll(() => followups(runB).length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    const c = await createTicket(project.id, { title: 'C', status: 'backlog' });
    expect(runsFor(c.id)).toHaveLength(0);

    await stopAgain(runB);
    await expect.poll(() => runsFor(c.id).length, { timeout: 10_000 }).toBe(1);
    expect(await statusOf(b.id)).toBe('review');
    expect(await eventTypes(runB)).toContain('merge_failed');
    expect((await eventTypes(runB)).filter((x) => x === 'conflict_resolution_requested')).toHaveLength(1);
    expect(followups(runB)).toHaveLength(1);
    // Main did not move, so the second failure is for a person.
    const failed = await noteOf(runB, 'merge_failed');
    expect(failed.at(-1)).toMatchObject({ conflicts: ['app.js'] });
    expect((failed.at(-1) as { autoFix?: boolean }).autoFix).toBeUndefined();
    await settle(project.id);
  });

  /** Another run lands a change in main: the head moves and the conflict with B stays. */
  const moveMain = (dir: string, n: number) => {
    writeFileSync(path.join(dir, 'app.js'), `one\nfrom-a${n}\nthree\n`);
    wgit(dir, 'add', '-A');
    wgit(dir, 'commit', '-q', '-m', `main ${n}`);
  };
  const requestedHeads = async (run: Run) =>
    ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events
      .filter((e) => e.type === 'conflict_resolution_requested')
      .map((e) => (e.payload as { mainHead?: string | null }).mainHead);

  it('asks again when main moved after the first attempt and the merge conflicts again', async () => {
    const { project, runB } = await conflictingPair();
    const passes = trackPipelines();
    await stopAgain(runB);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes); // pass 1 fully done: note written, busy released
    const firstHead = wgit(project.path, 'rev-parse', 'HEAD').trim();
    expect(await requestedHeads(runB)).toEqual([firstHead]); // recorded, not just typed
    expect(followups(runB)).toHaveLength(1);
    moveMain(project.path, 2);
    const movedHead = wgit(project.path, 'rev-parse', 'HEAD').trim();
    await stopAgain(runB);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(2);
    await Promise.all(passes);
    expect(await requestedHeads(runB)).toEqual([firstHead, movedHead]);
    expect(followups(runB)).toHaveLength(2);
    expect(movedHead).not.toBe(firstHead);
  });

  /** The pass has written the line to the terminal; the stand-in logs it to its file a moment later. */
  const typedLines = (run: Run, n: number) =>
    expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(n);

  it('stops asking after three attempts even when main keeps moving', async () => {
    const { project, runB } = await conflictingPair();
    const passes = trackPipelines();
    await stopAgain(runB);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    await typedLines(runB, 1);
    for (const n of [2, 3]) {
      moveMain(project.path, n);
      await stopAgain(runB);
      await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(n);
      await Promise.all(passes);
      await typedLines(runB, n);
    }
    expect(CONFLICT_ATTEMPT_CAP).toBe(3);
    moveMain(project.path, 4);
    await stopAgain(runB);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(4);
    await Promise.all(passes);
    expect((await eventTypes(runB)).filter((x) => x === 'merge_failed')).toHaveLength(4);
    await typedLines(runB, 3); // the stand-in logs a typed line a moment after the pass wrote it
    expect(followups(runB)).toHaveLength(3);
    expect(await requestedHeads(runB)).toHaveLength(3);
  });

  it('counts an old request without a main head as one attempt and retries once main has moved', async () => {
    const { project, runB } = await conflictingPair();
    t.runs.note(runB.id, 'conflict_resolution_requested', { conflicts: ['app.js'] });
    await stopAgain(runB);
    await expect.poll(() => followups(runB).length, { timeout: 10_000 }).toBe(1);
    expect((await requestedHeads(runB)).at(-1)).toBe(wgit(project.path, 'rev-parse', 'HEAD').trim());
  });

  it('asks a run whose process already ended but can be resumed', async () => {
    const { b, runB } = await conflictingPair();
    // A one-shot agent: its process exited before the merge, the session id stays.
    t.db.update(runs).set({ endedAt: new Date(), ptydSessionId: null }).where(eq(runs.id, runB.id)).run();
    expect(t.runs.getRun(runB.id)).toMatchObject({ resumable: true });
    const svc = t.runs as unknown as { resume(id: string, text?: string): Promise<Run> };
    const original = svc.resume.bind(t.runs);
    const resumed: string[] = [];
    svc.resume = async (id, text) => {
      resumed.push(text ?? '');
      return original(id, text);
    };
    // The pipeline starts from a run that is already ended (the stop hook of a one-shot CLI).
    const pipeline = t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> };
    await pipeline.handleRunCompleted(t.runs.get(runB.id));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain('conflicts in: app.js');
    expect(await eventTypes(runB)).toContain('conflict_resolution_requested');
    expect(await statusOf(b.id)).not.toBe('done');
  });

  it('a later dispatch leaves a ticket whose merge failed in Review and does not retry the merge', async () => {
    const { project, b, runB } = await conflictingPair();
    const passes = trackPipelines();
    await stopAgain(runB);
    await expect.poll(() => followups(runB).length, { timeout: 10_000 }).toBe(1);
    await stopAgain(runB);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(2);
    await Promise.all(passes);
    // The pipeline stopped the agent: nothing is resolving the conflict any more.
    await expect.poll(() => t.runs.get(runB.id).endedAt, { timeout: 10_000 }).not.toBeNull();
    const failedMerges = async () => (await eventTypes(runB)).filter((x) => x === 'merge_failed').length;
    const before = await failedMerges();

    await t.tickets.dispatchNextReadyTicket(project.id);
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(await failedMerges()).toBe(before);
    expect(await statusOf(b.id)).toBe('review');
    await settle(project.id);
  });

  it('resumes a session that was idle-closed before the conflict showed up', async () => {
    const { b, runB } = await conflictingPair();
    // The idle sweep closes the finished session while the checks are still running.
    const busy = t.runs.pipelineBusy.bind(t.runs);
    t.runs.pipelineBusy = (id, on) => {
      if (on && id === runB.id)
        t.db.update(runs).set({ endedAt: new Date(), ptydSessionId: null }).where(eq(runs.id, id)).run();
      busy(id, on);
    };
    const svc = t.runs as unknown as { resume(id: string, text?: string): Promise<Run> };
    const original = svc.resume.bind(t.runs);
    const resumed: string[] = [];
    svc.resume = async (id, text) => {
      resumed.push(text ?? '');
      return original(id, text);
    };
    await stopAgain(runB);
    await expect.poll(() => resumed.length, { timeout: 10_000 }).toBe(1);
    expect(resumed[0]).toBe(FOLLOW_UP('app.js'));
    await expect.poll(() => eventTypes(runB), { timeout: 10_000 }).toContain('conflict_resolution_requested');
    expect(await eventTypes(runB)).not.toContain('conflict_resolution_failed');
    expect(await statusOf(b.id)).not.toBe('done');
  });

  it('falls back to Review at once when the agent can no longer receive a prompt', async () => {
    const { project, b, runB } = await conflictingPair();
    const svc = t.runs as unknown as { sendPrompt(id: string, text: string): Promise<Run> };
    svc.sendPrompt = async () => {
      throw new Error('no live session');
    };
    const c = await createTicket(project.id, { title: 'C', status: 'backlog' });
    await stopAgain(runB);
    await expect.poll(() => runsFor(c.id).length, { timeout: 10_000 }).toBe(1);
    expect(await statusOf(b.id)).toBe('review');
    expect(await eventTypes(runB)).toContain('merge_failed');
    // The request was never delivered, so it is not recorded as requested; the failure is.
    const types = await eventTypes(runB);
    expect(types).not.toContain('conflict_resolution_requested');
    expect(types).toContain('conflict_resolution_failed');
    const detail = (await api('GET', `/api/runs/${runB.id}`)).json() as RunDetail;
    expect(detail.events.find((e) => e.type === 'conflict_resolution_failed')?.payload).toMatchObject({
      message: 'no live session',
    });
    await settle(project.id);
  });
});

/** A stand-in that leaves its hook token and then crashes. */
function writeFailingClaude(dir: string): string {
  const file = path.join(dir, 'failing-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'exit 3',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

/** A stand-in that gets to work and crashes (exit 3) on the first line typed into it. */
function writeCrashingClaude(dir: string): string {
  const file = path.join(dir, 'crashing-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      `: > "${dir}/ready-$EMBERLINE_RUN_ID"`,
      'read line',
      'exit 3',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

/** Tests run no reconciler loop: notice a run's end by hand. */
const settledState = async (runId: string) => {
  await t.runs.reconcile();
  return t.runs.get(runId).state;
};

/** Lets a crashing stand-in's run start working, then crash; resolves once the run is failed. */
async function crashAfterWork(run: Run): Promise<void> {
  await waitFile(`ready-${run.id}`);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  await t.runs.sendPrompt(run.id, 'crash');
  await expect.poll(() => settledState(run.id), { timeout: 10_000 }).toBe('failed');
}

const commitSecret = (worktreePath: string) => {
  writeFileSync(path.join(worktreePath, '.env'), 'API_TOKEN=abc\n');
  wgit(worktreePath, 'add', '-A');
  wgit(worktreePath, 'commit', '-q', '-m', 'env');
};

describe('factory chain robustness', () => {
  it('a restarted core keeps an active chain and resumes it', async () => {
    const project = await createProject();
    const other = await createProject('Other Project');
    t.tickets.setAutoChain(project.id, true);
    t.tickets.setAutoChain(other.id, true);
    t.tickets.setAutoChain(other.id, false);
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    const y = await createTicket(other.id, { title: 'Y', status: 'ready' });

    // A fresh service knows only what the database holds.
    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    expect(restarted.isAutoChainActive(project.id)).toBe(true);
    expect(restarted.isAutoChainActive(other.id)).toBe(false);
    await restarted.resumeChains();
    expect(runsFor(x.id)).toHaveLength(1);
    expect(runsFor(y.id)).toHaveLength(0);
    await settle(project.id);
  });

  it('the first start after an upgrade (no remembered chains) resumes projects with factory tickets waiting', async () => {
    const project = await createProject();
    const board = await createProject('Board Project');
    await createTicket(project.id, { title: '[Factory] Build the app', status: 'done' });
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    // No factory ticket: a hand-run board, not a chain to resume.
    const y = await createTicket(board.id, { title: 'Y', status: 'ready' });
    // 0.1.3 kept its chains in memory only: the database has no key.
    t.db.delete(settings).where(eq(settings.key, 'factory.activeChains')).run();

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    expect(restarted.isAutoChainActive(project.id)).toBe(true);
    expect(restarted.isAutoChainActive(board.id)).toBe(false);
    await restarted.resumeChains();
    expect(runsFor(x.id)).toHaveLength(1);
    expect(runsFor(y.id)).toHaveLength(0);
    await settle(project.id);
  });

  it('a remembered empty chain list is not seeded again', async () => {
    const project = await createProject();
    await createTicket(project.id, { title: '[Factory] Build the app', status: 'done' });
    const x = await createTicket(project.id, { title: 'X', status: 'ready' });
    setSetting(t.db, 'factory.activeChains', []);

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    expect(restarted.isAutoChainActive(project.id)).toBe(false);
    await restarted.resumeChains();
    expect(runsFor(x.id)).toHaveLength(0);
  });

  it('a failed ticket run lets the chain go on with the other ready tickets', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    t.config.claudeCommand = writeCrashingClaude(t.dir);
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready', priority: 3 });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready', priority: 1 });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(ticketRuns(project.id).map((r) => r.ticketId)).toEqual([x.id]);
    await crashAfterWork(runsFor(x.id)[0] as Run);
    await expect.poll(() => runsFor(y.id).length, { timeout: 10_000 }).toBe(1);
    // The failed ticket stays where it is and is not started again.
    expect(runsFor(x.id)).toHaveLength(1);
    expect(await statusOf(x.id)).toBe('in_progress');
    await settle(project.id);
  });

  it('pauses the chain after two ticket runs in a row failed', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    t.config.claudeCommand = writeCrashingClaude(t.dir);
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready', priority: 3 });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready', priority: 2 });
    const z = await createTicket(project.id, { title: 'Z', status: 'ready', priority: 1 });

    await t.tickets.dispatchNextReadyTicket(project.id);
    const runX = runsFor(x.id)[0] as Run;
    await crashAfterWork(runX);
    await expect.poll(() => runsFor(y.id).length, { timeout: 10_000 }).toBe(1);
    const runY = runsFor(y.id)[0] as Run;
    await crashAfterWork(runY);
    await expect.poll(() => eventTypes(runY), { timeout: 10_000 }).toContain('factory_chain_paused');
    await dispatchesDone(project.id);

    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    expect(runsFor(z.id)).toHaveLength(0);
    expect(await eventTypes(runX)).not.toContain('factory_chain_paused');
    const detail = (await api('GET', `/api/runs/${runY.id}`)).json() as RunDetail;
    expect(detail.events.find((e) => e.type === 'factory_chain_paused')?.payload).toMatchObject({
      message: '2 ticket runs failed in a row; the factory paused — fix the cause and click Run pipeline',
    });
    await settle(project.id);
  });

  it('pauses the chain when a ticket run fails before it ever got to work', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    t.config.claudeCommand = writeFailingClaude(t.dir);
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready', priority: 3 });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready', priority: 1 });

    await t.tickets.dispatchNextReadyTicket(project.id);
    const runX = runsFor(x.id)[0] as Run;
    await expect.poll(() => settledState(runX.id), { timeout: 10_000 }).toBe('failed');
    await expect.poll(() => eventTypes(runX), { timeout: 10_000 }).toContain('factory_chain_paused');
    await dispatchesDone(project.id);

    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    expect(runsFor(y.id)).toHaveLength(0);
    await settle(project.id);
  });

  it('runs that ended because the session was lost do not count toward pausing the chain', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    t.config.claudeCommand = writeCrashingClaude(t.dir);
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready', priority: 3 });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready', priority: 2 });
    const z = await createTicket(project.id, { title: 'Z', status: 'ready', priority: 1 });

    const loseSession = async (run: Run) => {
      await waitFile(`ready-${run.id}`);
      const token = await waitFile(`token-${run.id}`);
      await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
      await hook(run.id, 'UserPromptSubmit', token);
      const sessionId = t.runs.get(run.id).terminalId as string;
      await t.ptyd.get().remove(sessionId);
      await expect.poll(() => settledState(run.id), { timeout: 10_000 }).toBe('failed');
      expect(await eventTypes(run)).toContain('session_lost');
    };

    await t.tickets.dispatchNextReadyTicket(project.id);
    await loseSession(runsFor(x.id)[0] as Run);
    await expect.poll(() => runsFor(y.id).length, { timeout: 10_000 }).toBe(1);
    await loseSession(runsFor(y.id)[0] as Run);
    await expect.poll(() => runsFor(z.id).length, { timeout: 10_000 }).toBe(1);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(true);
    expect(await eventTypes(runsFor(y.id)[0] as Run)).not.toContain('factory_chain_paused');
    await settle(project.id);
  });

  it('a ticket run a person stopped does not start the next ticket', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    const project = await createProject();
    const x = await createTicket(project.id, { title: 'X', status: 'ready', priority: 3 });
    const y = await createTicket(project.id, { title: 'Y', status: 'ready', priority: 1 });

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(x.id)[0] as Run;
    await waitFile(`token-${run.id}`);
    await api('POST', `/api/runs/${run.id}/stop`);
    await expect.poll(() => t.runs.get(run.id).state, { timeout: 10_000 }).toBe('failed');
    await dispatchesDone(project.id);
    expect(runsFor(y.id)).toHaveLength(0);
    await settle(project.id);
  });

  it('a ticket started by a narrow dispatch starts its own dependents, not the queue, when it finishes', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const b = await createTicket(project.id, { title: 'B', status: 'ready' });
    const c = await createTicket(project.id, { title: 'C', status: 'ready' });
    const e = await createTicket(project.id, { title: 'E', status: 'ready' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    await api('PATCH', `/api/tickets/${e.id}`, { dependsOn: [b.id] });
    const passes = trackPipelines();

    // A person closes A: only B, which waited for it, starts.
    await api('PATCH', `/api/tickets/${a.id}`, { status: 'done' });
    await expect.poll(() => runsFor(b.id).length, { timeout: 5_000 }).toBe(1);
    await finish(runsFor(b.id)[0] as Run);
    await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(1);
    await Promise.all(passes);
    // B's pipeline moved it to Done: E, which waited for B, starts too.
    await expect.poll(() => runsFor(e.id).length, { timeout: 5_000 }).toBe(1);
    await dispatchesDone(project.id);

    expect(await statusOf(b.id)).toBe('done');
    expect(runsFor(c.id)).toHaveLength(0);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    await settle(project.id);
  });

  it('a ticket started by hand does not turn the chain on when it finishes', async () => {
    const project = await createProject();
    const c = await createTicket(project.id, { title: 'C', status: 'ready' });
    const d = await createTicket(project.id, { title: 'D', status: 'ready' });
    const passes = trackPipelines();

    const { run } = (await api('POST', `/api/tickets/${c.id}/start`, {})).json() as { run: Run };
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 5_000 }).toBe(1);
    await Promise.all(passes);
    await dispatchesDone(project.id);

    expect(runsFor(d.id)).toHaveLength(0);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    await settle(project.id);
  });

  it('a later dispatch leaves a ticket the secret guard held in Review', async () => {
    t.config.claudeCommand = writeLivingClaude(t.dir);
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    commitSecret(run.worktreePath);
    await waitFile(`ready-${run.id}`);
    const token = await waitFile(`token-${run.id}`);
    await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
    await stopAgain(run);
    // The guard first asks the agent to clean up; it stops again with the leak still there. Its
    // next turn starts once the request is recorded (the fake reads the line before core notes it).
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect
      .poll(async () => (await eventTypes(run)).includes('prompt_sent'), { timeout: 10_000 })
      .toBe(true);
    await stopAgain(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(2);
    await Promise.all(passes);
    expect(await statusOf(a.id)).toBe('review');
    await expect.poll(() => t.runs.get(run.id).endedAt, { timeout: 10_000 }).not.toBeNull();
    // A secret-guard hold that fell through keeps the run resumable.
    expect(t.runs.getRun(run.id)).toMatchObject({ resumable: true, cancelled: false });

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(await statusOf(a.id)).toBe('review');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(existsSync(path.join(project.path, '.env'))).toBe(false);
    expect(await eventTypes(run)).toContain('secret_guard_blocked');
    await settle(project.id);
  });

  it('the secret guard holds the ticket even when its clean-up request cannot be delivered', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async () => {
      throw new Error('no live session');
    };

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    commitSecret(run.worktreePath);
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(await eventTypes(run)).toContain('secret_guard_blocked');

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(a.id)).toBe('review');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(existsSync(path.join(project.path, '.env'))).toBe(false);
    await settle(project.id);
  });

  it('the anti-slop gate holds the ticket even when its clean-up request cannot be delivered', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async () => {
      throw new Error('no live session');
    };

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    writeFileSync(
      path.join(run.worktreePath, 'slop.ts'),
      'export const x: any = 1;\n// @ts-ignore\nexport const y = x.z;\n',
    );
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'slop');
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(await eventTypes(run)).toContain('slop_guard_blocked');

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(a.id)).toBe('review');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    await settle(project.id);
  });

  it('the critic holds the ticket even when its follow-up request cannot be delivered', async () => {
    await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
    critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async () => {
      throw new Error('no live session');
    };

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(await eventTypes(run)).toContain('critic_blocked');

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(a.id)).toBe('review');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    await settle(project.id);
  });

  it('a second stop while the critic works on its verdict leaves the decision to the pass waiting for it', async () => {
    await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
    critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
    let answer!: () => void;
    critic.held = new Promise<void>((resolve) => (answer = resolve));
    const sent = recordPrompts();
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    await finish(run);
    await expect.poll(() => critic.calls, { timeout: 10_000 }).toBe(1);

    // The agent stops again while the first pass still waits for the critic.
    await stopAgain(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(2);
    await passes[1];
    expect(await eventTypes(run)).not.toContain('merged_to_main');

    answer();
    await Promise.all(passes);
    expect(critic.calls).toBe(1);
    expect(await eventTypes(run)).toContain('critic_blocked');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(sent).toEqual(['Fix the findings of the review.' + t.tickets.completionReminder(run, '\n\n')]);
    expect(await statusOf(a.id)).toBe('review');
    await settle(project.id);
  });

  it('a second stop while the critic works merges once, after a passing verdict', async () => {
    await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
    critic.result = { verdict: 'PASS', followUpPrompt: null };
    let answer!: () => void;
    critic.held = new Promise<void>((resolve) => (answer = resolve));
    recordPrompts();
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    await finish(run);
    await expect.poll(() => critic.calls, { timeout: 10_000 }).toBe(1);
    await stopAgain(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(2);
    await passes[1];
    expect(await eventTypes(run)).not.toContain('merged_to_main');

    answer();
    await Promise.all(passes);
    expect(critic.calls).toBe(1);
    expect((await eventTypes(run)).filter((type) => type === 'merged_to_main')).toHaveLength(1);
    expect(await statusOf(a.id)).toBe('done');
    await settle(project.id);
  });

  it('a Review ticket whose pipeline was cut off gets the gates on resume, not a plain merge', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    // Core goes down before the completion pipeline of A's run gets to run.
    (t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> }).handleRunCompleted = async () =>
      undefined;

    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    commitSecret(run.worktreePath);
    await finish(run);
    await expect.poll(() => statusOf(a.id), { timeout: 10_000 }).toBe('review');

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    const passes = trackPipelines(restarted);
    await restarted.resumeChains();
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);

    expect(await eventTypes(run)).toContain('secret_guard_blocked');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(a.id)).not.toBe('done');
    expect(existsSync(path.join(project.path, '.env'))).toBe(false);
    await settle(project.id);
  });

  it('a hand-started run in a project without an active chain gets its cut-off pipeline after a restart', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    // Another ticket waits in Ready: A's completion is a factory step, gated and merged.
    await createTicket(project.id, { title: 'B', status: 'ready' });
    (t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> }).handleRunCompleted = async () =>
      undefined;

    const { run } = (await api('POST', `/api/tickets/${a.id}/start`, {})).json() as { run: Run };
    commitSecret(run.worktreePath);
    await finish(run);
    await expect.poll(() => statusOf(a.id), { timeout: 10_000 }).toBe('review');

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    expect(restarted.isAutoChainActive(project.id)).toBe(false);
    const passes = trackPipelines(restarted);
    await restarted.resumeChains();
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);

    expect(await eventTypes(run)).toContain('secret_guard_blocked');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(a.id)).toBe('review');
    await settle(project.id);
  });

  it('a restart does not run again a pipeline that ended, though the board changed since', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const { run } = (await api('POST', `/api/tickets/${a.id}/start`, {})).json() as { run: Run };
    await finish(run);
    // Nothing else waits in Ready: A's run is no factory step, and its ticket stays in Review for its person.
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(await statusOf(a.id)).toBe('review');
    // Later a ticket lands in Ready (which would make A's run look like a factory step; set in the
    // database so nothing starts it), and core restarts.
    await createTicket(project.id, { title: 'B', status: 'backlog' });
    t.db.update(ticketRows).set({ status: 'ready' }).where(eq(ticketRows.title, 'B')).run();

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    const resumed = trackPipelines(restarted);
    await restarted.resumeChains();
    expect(resumed).toHaveLength(0);
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(a.id)).toBe('review');
    await settle(project.id);
  });

  it("the first dispatch after a restart does not merge a person's Review run whose pass ended without an outcome", async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const { run } = (await api('POST', `/api/tickets/${a.id}/start`, {})).json() as { run: Run };
    await finish(run);
    // No factory step (chain off, Ready empty): the pass ends without an outcome, the ticket stays in Review.
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(await statusOf(a.id)).toBe('review');
    // The factory is switched on later, with a ticket waiting; then core restarts.
    t.tickets.setAutoChain(project.id, true);
    await createTicket(project.id, { title: 'B', status: 'backlog' });
    t.db.update(ticketRows).set({ status: 'ready' }).where(eq(ticketRows.title, 'B')).run();

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    const resumed = trackPipelines(restarted);
    await restarted.resumeChains();
    expect(resumed).toHaveLength(0);
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(a.id)).toBe('review');
    await settle(project.id);
  });

  describe('a pass resumed after a restart does not repeat what the cut-off pass did', () => {
    /** Pass 1 ran in full; the agent's next stop is cut off by a restart; a new service resumes it. */
    async function restartAfterSecondStop(run: Run): Promise<void> {
      (t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> }).handleRunCompleted = async () =>
        undefined;
      await stopAgain(run);
      const restarted = new TicketService(t.db, t.runs, t.scheduler);
      const resumed = trackPipelines(restarted);
      await restarted.resumeChains();
      await expect.poll(() => resumed.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(resumed);
    }

    it('the secret guard asks for its clean-up once', async () => {
      const sent = recordPrompts();
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      const passes = trackPipelines();
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      commitSecret(run.worktreePath);
      await finish(run);
      await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(passes);
      expect(sent).toHaveLength(1);

      await restartAfterSecondStop(run);
      expect(sent).toHaveLength(1);
      const asked = ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.filter(
        (e) => e.type === 'secret_guard_blocked' && (e.payload as { autoFix?: boolean }).autoFix === true,
      );
      expect(asked).toHaveLength(1);
      expect(await eventTypes(run)).not.toContain('merged_to_main');
      await settle(project.id);
    });

    it('the critic runs once', async () => {
      await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
      critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
      const sent = recordPrompts();
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      const passes = trackPipelines();
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      await finish(run);
      await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(passes);
      expect(critic.calls).toBe(1);

      await restartAfterSecondStop(run);
      expect(critic.calls).toBe(1);
      expect(sent).toEqual(['Fix the findings of the review.' + t.tickets.completionReminder(run, '\n\n')]);
      await settle(project.id);
    });

    it('a pass cut off while the critic ran asks the critic again instead of merging without its verdict', async () => {
      await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
      critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
      critic.hang = true;
      const sent = recordPrompts();
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      await finish(run);
      // Core goes down while the critic is still working on its verdict.
      await expect.poll(() => critic.calls, { timeout: 10_000 }).toBe(1);

      const restarted = new TicketService(t.db, t.runs, t.scheduler);
      const resumed = trackPipelines(restarted);
      await restarted.resumeChains();
      await expect.poll(() => resumed.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(resumed);
      expect(critic.calls).toBe(2);
      expect(await eventTypes(run)).toContain('critic_blocked');
      expect(await eventTypes(run)).not.toContain('merged_to_main');
      expect(sent).toEqual(['Fix the findings of the review.' + t.tickets.completionReminder(run, '\n\n')]);
      expect(await statusOf(a.id)).toBe('review');
      await settle(project.id);
    });

    it("the critic's follow-up that never went out is sent when the pass resumes", async () => {
      await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
      critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
      const sent: string[] = [];
      (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async (id, text) => {
        sent.push(text);
        // Core goes down while the follow-up is being typed: it never arrives, and the pass never ends.
        if (sent.length === 1) return new Promise<Run>(() => undefined);
        return t.runs.getRun(id);
      };
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      await finish(run);
      await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(1);
      expect(await eventTypes(run)).toContain('critic_blocked');

      const restarted = new TicketService(t.db, t.runs, t.scheduler);
      const resumed = trackPipelines(restarted);
      await restarted.resumeChains();
      await expect.poll(() => resumed.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(resumed);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(critic.calls).toBe(1);
      expect(await eventTypes(run)).not.toContain('merged_to_main');
      expect(await statusOf(a.id)).toBe('review');
      await settle(project.id);
    });

    it("the critic's follow-up that went out before the restart is not sent again", async () => {
      await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
      critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
      const sent: string[] = [];
      (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async (id, text) => {
        sent.push(text);
        // Typed into the session (recorded as sendPrompt does), then core goes down before the pass ends.
        t.runs.note(id, 'prompt_sent', { length: text.length });
        return new Promise<Run>(() => undefined);
      };
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      await finish(run);
      await expect.poll(() => eventTypes(run), { timeout: 10_000 }).toContain('prompt_sent');
      expect(await eventTypes(run)).toContain('critic_blocked');

      const restarted = new TicketService(t.db, t.runs, t.scheduler);
      const resumed = trackPipelines(restarted);
      await restarted.resumeChains();
      expect(resumed).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(await eventTypes(run)).not.toContain('merged_to_main');
      expect(await statusOf(a.id)).toBe('review');
      await settle(project.id);
    });

    it('a worktree-commands fix request from before 0.5.0 does not count as a build fix request', async () => {
      build.result = { ok: false, output: 'boom' };
      recordPrompts();
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      const passes = trackPipelines();
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      writeFileSync(
        path.join(run.worktreePath, 'package.json'),
        JSON.stringify({ scripts: { build: 'true' } }),
      );
      wgit(run.worktreePath, 'add', '-A');
      wgit(run.worktreePath, 'commit', '-q', '-m', 'build');
      // Such a note named no check.
      t.runs.note(run.id, 'build_gate_failed', {
        autoFix: true,
        output:
          '.emberline/worktree.yml is missing: this ticket asks for the setup, build, lint and test commands and the preview service.',
      });
      await finish(run);
      await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(passes);
      expect(build.calls).toBe(1);
      await settle(project.id);
    });

    it('the build gate builds and asks for a fix once', async () => {
      build.result = { ok: false, output: 'boom' };
      const sent = recordPrompts();
      const project = await createProject();
      const a = await createTicket(project.id, { title: 'A', status: 'ready' });
      const passes = trackPipelines();
      await t.tickets.dispatchNextReadyTicket(project.id);
      const run = runsFor(a.id)[0] as Run;
      writeFileSync(
        path.join(run.worktreePath, 'package.json'),
        JSON.stringify({ scripts: { build: 'true' } }),
      );
      wgit(run.worktreePath, 'add', '-A');
      wgit(run.worktreePath, 'commit', '-q', '-m', 'build');
      await finish(run);
      await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(passes);
      expect(build.calls).toBe(1);
      expect(sent).toHaveLength(1);

      await restartAfterSecondStop(run);
      expect(build.calls).toBe(1);
      expect(sent).toHaveLength(1);
      await settle(project.id);
    });

    it("the PO's nudge that never went out is sent, and the pass stops there as the cut-off one would have", async () => {
      const sent: string[] = [];
      let first = true;
      (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async (id, text) => {
        sent.push(text);
        if (first) {
          first = false;
          // Core goes down while the nudge is being typed: it never arrives, and the pass never ends.
          return new Promise<Run>(() => undefined);
        }
        return t.runs.getRun(id);
      };
      const project = await createProject();
      const po = await createTicket(project.id, {
        title: '[Factory] Plan it',
        status: 'ready',
        persona: 'product_owner',
      });
      const passes = trackPipelines();
      const { run } = (
        await api('POST', `/api/tickets/${po.id}/start`, { persona: 'product_owner' })
      ).json() as {
        run: Run;
      };
      await finish(run);
      await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(1);
      expect(passes).toHaveLength(1);
      expect(await eventTypes(run)).toContain('auto_nudged');

      const restarted = new TicketService(t.db, t.runs, t.scheduler);
      const resumed = trackPipelines(restarted);
      await restarted.resumeChains();
      await expect.poll(() => resumed.length, { timeout: 10_000 }).toBe(1);
      await Promise.all(resumed);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(await eventTypes(run)).not.toContain('merged_to_main');
      expect(await statusOf(po.id)).not.toBe('done');
      await settle(project.id);
    });
  });

  it("after a restart, a person's run in a project without a factory is not merged by the finalization", async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    (t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> }).handleRunCompleted = async () =>
      undefined;

    const { run } = (await api('POST', `/api/tickets/${a.id}/start`, {})).json() as { run: Run };
    await finish(run);
    await expect.poll(() => statusOf(a.id), { timeout: 10_000 }).toBe('review');

    const restarted = new TicketService(t.db, t.runs, t.scheduler);
    const passes = trackPipelines(restarted);
    await restarted.resumeChains();
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);

    // Its pass decides as the cut-off one would have: no factory step, so no gates and no merge.
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(a.id)).toBe('review');
    await settle(project.id);
  });
});

/** Pages a NotificationService on the test app would send for "waiting on you" (sending stubbed). */
async function pagesOf() {
  const { NotificationService } = await import('./notifications/service.js');
  const service = new NotificationService(t.db, t.runs);
  service.getSettings = () => ({
    enabled: true,
    provider: 'webhook',
    url: 'http://127.0.0.1:9/unused',
    token: null,
    onRateLimited: false,
    onQuotaResumed: false,
    onWaitingInput: true,
    onRunFinished: false,
  });
  const sent: string[] = [];
  service.dispatch = async (_cfg, msg) => {
    sent.push(msg.body);
    return { ok: true, status: 200, error: null };
  };
  return { sent, stop: () => service.stop() };
}

const noteOf = async (run: Run, type: string) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events
    .filter((e) => e.type === type)
    .map((e) => e.payload);

const failPrompts = () => {
  const fail = async () => {
    throw new Error('no live session');
  };
  Object.assign(t.runs as object, { prompt: fail, sendPrompt: fail });
};

describe('a hold the agent is already fixing does not need you', () => {
  /** A worktree with a build target, so the self-healing build gate runs. */
  const buildable = (worktreePath: string) =>
    writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({ scripts: { build: 'exit 1' } }));

  async function livingRun(project: { id: string }, ticketId: string): Promise<Run> {
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(ticketId)[0] as Run;
    await waitFile(`ready-${run.id}`);
    const token = await waitFile(`token-${run.id}`);
    await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
    return run;
  }

  it('build gate: the fix request went out, so no attention and no page', async () => {
    t.config.claudeCommand = writeLivingClaude(t.dir);
    build.result = { ok: false, output: 'error TS2322' };
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const pages = await pagesOf();
    const run = await livingRun(project, a.id);
    buildable(run.worktreePath);
    await stopAgain(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(pages.sent).toEqual([]);
    expect(t.runs.getRun(run.id).attention).toBeNull();
    expect(await noteOf(run, 'build_gate_failed')).toEqual([{ autoFix: true, output: 'error TS2322' }]);
    pages.stop();
    await settle(project.id);
  });

  it('build gate: the fix request could not be sent, so the hold is attention and pages once', async () => {
    build.result = { ok: false, output: 'error TS2322' };
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const pages = await pagesOf();
    failPrompts();
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    buildable(run.worktreePath);
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(await noteOf(run, 'build_gate_failed')).toEqual([
      { autoFix: true, output: 'error TS2322' },
      { autoFix: false, output: 'error TS2322' },
    ]);
    expect(await statusOf(a.id)).toBe('review');
    expect(t.runs.getRun(run.id).attention).toMatchObject({ reason: 'held', detail: 'Build checks failed' });
    await expect.poll(() => pages.sent.length).toBe(1);
    expect(pages.sent[0]).toContain('Build checks failed');
    pages.stop();
    await settle(project.id);
  });

  it('slop guard: a delivered clean-up request is no attention and no page', async () => {
    t.config.claudeCommand = writeLivingClaude(t.dir);
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const pages = await pagesOf();
    const run = await livingRun(project, a.id);
    writeFileSync(
      path.join(run.worktreePath, 'slop.ts'),
      'export const x: any = 1;\n// @ts-ignore\nexport const y = x.z;\n',
    );
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', 'slop');
    await stopAgain(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    expect(pages.sent).toEqual([]);
    expect(t.runs.getRun(run.id).attention).toBeNull();
    const slopNotes = await noteOf(run, 'slop_guard_blocked');
    expect(slopNotes).toHaveLength(1);
    expect(slopNotes[0]).toMatchObject({ autoFix: true, autoFixPrompt: expect.stringContaining('slop.ts') });
    pages.stop();
    await settle(project.id);
  });

  it('critic: an undelivered follow-up is noted again for a person and pages once', async () => {
    await api('PATCH', '/api/factory/settings', { crossProviderCritic: true });
    critic.result = { verdict: 'NEEDS_FIX', followUpPrompt: 'Fix the findings of the review.' };
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const pages = await pagesOf();
    failPrompts();
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    const followUpPrompt = 'Fix the findings of the review.';
    expect(await noteOf(run, 'critic_blocked')).toEqual([
      { autoFix: true, followUpPrompt },
      { autoFix: false, followUpPrompt },
    ]);
    expect(t.runs.getRun(run.id).attention).toMatchObject({ reason: 'held' });
    await expect.poll(() => pages.sent.length).toBe(1);
    pages.stop();
    await settle(project.id);
  });

  it('secret guard: an undelivered clean-up request is noted again for a person and pages once', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'A', status: 'ready' });
    const passes = trackPipelines();
    const pages = await pagesOf();
    failPrompts();
    await t.tickets.dispatchNextReadyTicket(project.id);
    const run = runsFor(a.id)[0] as Run;
    commitSecret(run.worktreePath);
    await finish(run);
    await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(1);
    await Promise.all(passes);
    const notes = await noteOf(run, 'secret_guard_blocked');
    expect(notes.map((n) => (n as { autoFix?: boolean }).autoFix)).toEqual([true, false]);
    for (const n of notes)
      expect((n as { autoFixPrompt?: string }).autoFixPrompt?.length ?? 0).toBeGreaterThan(0);
    expect(t.runs.getRun(run.id).attention).toMatchObject({ reason: 'held' });
    await expect.poll(() => pages.sent.length).toBe(1);
    pages.stop();
    await settle(project.id);
  });
});
