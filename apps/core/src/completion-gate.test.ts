import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runs, tickets } from './db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import {
  DEPENDENCY_BLOCK_MAX,
  DEPENDENCY_SECTION_MAX,
  dependencyContextSection,
  type FinishedDependency,
} from './tickets/dependency-context.js';
import type { TicketService } from './tickets/service.js';

const NUDGE =
  'You stopped without calling `ticket_complete`. If the ticket is finished, call it now with a summary and handoff. If something blocks you, call it with `blockers`. If you need an answer from a person, ask the question plainly and stop.';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

/** Claude stand-in that stays alive and logs every line typed into it (the start prompt is an argument). */
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

async function waitFile(name: string): Promise<string> {
  const file = path.join(t.dir, name);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return readFileSync(file, 'utf8');
}

const wgit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], { encoding: 'utf8' });

async function createProject(name = 'Gate Project') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  wgit(project.path, 'init', '-q', '-b', 'main');
  wgit(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return project as { id: string; path: string };
}

const createTicket = async (projectId: string, body: object): Promise<Ticket> =>
  (await api('POST', `/api/projects/${projectId}/tickets`, body)).json();
const statusOf = async (id: string) => ((await api('GET', `/api/tickets/${id}`)).json() as Ticket).status;
const runsFor = (ticketId: string) => t.runs.list().filter((r) => r.ticketId === ticketId);
const eventTypes = async (run: Run) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type);
const eventPayload = async (run: Run, type: string) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.find((e) => e.type === type)?.payload;
const followups = (run: Run) => {
  const file = path.join(t.dir, `followups-${run.id}`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

const complete = async (run: Run, body: { summary: string; handoff?: string; blockers?: string[] }) => {
  const token = await waitFile(`token-${run.id}`);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${run.id}/complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
};

/** Records every pipeline pass so a test can wait for all of them. */
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

/** Starts the agent's session and its first turn. */
async function begin(run: Run): Promise<string> {
  await waitFile(`ready-${run.id}`);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await hook(run.id, 'UserPromptSubmit', token);
  return token;
}

/** Ends the current turn; `signal` calls ticket_complete first. */
async function stop(run: Run, signal?: { summary: string; handoff?: string; blockers?: string[] }) {
  if (signal) await complete(run, signal);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'Stop', token);
}

/** A new turn (a person's reply or an automatic prompt reaching the agent), then its stop. */
async function nextTurn(run: Run, signal?: { summary: string; handoff?: string; blockers?: string[] }) {
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'UserPromptSubmit', token);
  await stop(run, signal);
}

/** A factory ticket run with one commit of work in its worktree. */
async function factoryTicket(title = 'A') {
  const project = await createProject();
  const ticket = await createTicket(project.id, { title, status: 'ready' });
  await t.tickets.dispatchNextReadyTicket(project.id);
  const run = runsFor(ticket.id)[0] as Run;
  writeFileSync(path.join(run.worktreePath, `${title}.txt`), `${title}\n`);
  wgit(run.worktreePath, 'add', '-A');
  wgit(run.worktreePath, 'commit', '-q', '-m', title);
  return { project, ticket, run };
}

const settled = async (passes: Promise<void>[], n: number) => {
  await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(n);
  await Promise.all(passes);
};

describe('completion gate', () => {
  it('1. a valid signal without blockers continues: merged and Done', async () => {
    const { project, ticket, run } = await factoryTicket();
    await begin(run);
    await stop(run, { summary: 'did A', handoff: 'A.txt exists' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
    expect(await eventTypes(run)).not.toContain('completion_nudged');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
  });

  it('2. a signal with blockers holds the ticket in Review without merging', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run, { summary: 'half', blockers: ['No signing key'] });
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('completion_blocked');
    expect(types).not.toContain('merged_to_main');
    expect(types).not.toContain('completion_nudged');
    expect(await eventPayload(run, 'completion_blocked')).toEqual({ blockers: ['No signing key'] });
    expect(await statusOf(ticket.id)).toBe('review');
    expect(followups(run)).toEqual([]);
    // Held: a later dispatch does not merge it behind the hold.
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
  });

  it('3. no signal: one automatic nudge, the ticket waits', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run), { timeout: 10_000 }).toEqual([NUDGE]);
    const types = await eventTypes(run);
    expect(types).toContain('completion_nudged');
    expect(types).not.toContain('completion_missing');
    expect(types).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).not.toBe('done');
    expect(t.runs.get(run.id).endedAt).toBeNull();
  });

  it('a valid signal after the nudge continues normally', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'confirmed' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
    expect(followups(run)).toHaveLength(1);
  });

  it('a signal from before the nudge does not count for the next turn', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    // Signalled, then the person (or a gate) spoke: the old signal is stale.
    await complete(run, { summary: 'stale' });
    await nextTurn(run);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('completion_nudged');
    expect(await statusOf(ticket.id)).not.toBe('done');
  });

  it('4. still no signal after the nudge: held, no second nudge, a later dispatch does not merge', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run);
    await settled(passes, 2);
    const types = await eventTypes(run);
    expect(types).toContain('completion_missing');
    expect(types.filter((x) => x === 'completion_nudged')).toHaveLength(1);
    expect(types).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
    expect(followups(run)).toHaveLength(1);

    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(2);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);

    // A second unsignalled turn (e.g. the agent answered a person without finishing): held again, no nudge.
    await nextTurn(run);
    await settled(passes, 3);
    expect((await eventTypes(run)).filter((x) => x === 'completion_missing')).toHaveLength(2);
    expect((await eventTypes(run)).filter((x) => x === 'completion_nudged')).toHaveLength(1);
    expect(followups(run)).toHaveLength(1);

    // The person's reply leads to a signalled turn: the hold is lifted and the ticket goes through.
    await nextTurn(run, { summary: 'finished after the answer' });
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
  });

  it('a hold that was later merged does not keep the run a factory run: a follow-up in a quiet project is not piped', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    // The pipeline closes a finished CLI (which also makes it final); here it stays open, so a
    // person can still continue the session after the ticket reached Done.
    const runsSvc = t.runs as unknown as { stop(id: string, opts?: { reason?: string }): Promise<Run> };
    const realStop = runsSvc.stop.bind(t.runs);
    runsSvc.stop = async (id, opts) => (opts?.reason === 'factory_step_finished' ? t.runs.get(id) : realStop(id, opts));
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    await expect.poll(() => followups(run).length, { timeout: 10_000 }).toBe(1);
    await nextTurn(run, { summary: 'confirmed' });
    await settled(passes, 2);
    expect(await statusOf(ticket.id)).toBe('done');
    // Quiet project: the chain ended with the empty queue, no ready or [Factory] tickets.
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);

    // A person continues the Done ticket's session later.
    await t.tickets.prompt(ticket.id, 'one more tweak');
    const before = await eventTypes(run);
    await nextTurn(run);
    await settled(passes, 3);
    const after = await eventTypes(run);
    const count = (types: string[], type: string) => types.filter((x) => x === type).length;
    expect(count(after, 'merged_to_main')).toBe(count(before, 'merged_to_main'));
    expect(count(after, 'completion_missing')).toBe(0);
    expect(count(after, 'completion_nudged')).toBe(1);
    expect(followups(run)).toEqual([NUDGE, 'one more tweak']);
  });

  it('a run that cannot take a prompt any more is held at once instead of nudged', async () => {
    const { ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    // Not promptable: the process is gone and its session cannot be resumed.
    const svc = t.tickets as unknown as { runPipeline(r: Run, o: object): Promise<void> };
    const original = svc.runPipeline.bind(t.tickets);
    svc.runPipeline = (r, o) => original({ ...r, endedAt: new Date().toISOString(), resumable: false }, o);
    await stop(run);
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('completion_missing');
    expect(types).not.toContain('completion_nudged');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('a nudge that cannot be delivered holds the ticket for a person', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    (t.runs as unknown as { prompt(id: string, text: string): Promise<Run> }).prompt = async () => {
      throw new Error('no live session');
    };
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    const types = await eventTypes(run);
    expect(types).toContain('completion_nudged');
    expect(types).toContain('completion_missing');
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
  });

  it('while the agent answers the nudge, a dispatch does not finalize the ticket behind it', async () => {
    const { project, ticket, run } = await factoryTicket();
    const passes = trackPipelines();
    await begin(run);
    await stop(run);
    await settled(passes, 1);
    // The nudge was typed but its UserPromptSubmit has not arrived: the run is still `done`, and
    // its ticket may sit in Review (here put back by hand), where a dispatch finalizes leftovers.
    expect(t.runs.get(run.id).state).toBe('done');
    t.db.update(tickets).set({ status: 'review' }).where(eq(tickets.id, ticket.id)).run();
    await t.tickets.dispatchNextReadyTicket(project.id);
    expect(passes).toHaveLength(1);
    expect(await eventTypes(run)).not.toContain('completion_missing');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  describe('exemptions keep the old behaviour', () => {
    it('setting off: Stop alone advances the ticket', async () => {
      await api('PATCH', '/api/factory/settings', { requireCompletionSignal: false });
      const { ticket, run } = await factoryTicket();
      await begin(run);
      await stop(run);
      await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
      const types = await eventTypes(run);
      expect(types).toContain('merged_to_main');
      expect(types.some((x) => x.startsWith('completion_'))).toBe(false);
      expect(followups(run)).toEqual([]);
    });

    it('a secondary CLI run (its exit code is its signal)', async () => {
      const { ticket, run } = await factoryTicket();
      await begin(run);
      t.db.update(runs).set({ agent: 'codex' }).where(eq(runs.id, run.id)).run();
      await stop(run);
      await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
      expect((await eventTypes(run)).some((x) => x.startsWith('completion_'))).toBe(false);
    });

    it('the [Factory] product-owner orchestrator ticket (its tickets file is its signal)', async () => {
      const project = await createProject();
      const po = await createTicket(project.id, { title: '[Factory] Plan it', status: 'ready', persona: 'product_owner' });
      const { run } = (await api('POST', `/api/tickets/${po.id}/start`, { persona: 'product_owner' })).json() as { run: Run };
      mkdirSync(path.join(run.worktreePath, '.emberline'), { recursive: true });
      writeFileSync(
        path.join(run.worktreePath, '.emberline', 'new-tickets.json'),
        JSON.stringify({ autoDispatch: false, tickets: [{ title: 'Child' }] }),
      );
      await begin(run);
      await stop(run);
      await expect.poll(() => statusOf(po.id), { timeout: 10_000 }).toBe('done');
      expect((await eventTypes(run)).some((x) => x.startsWith('completion_'))).toBe(false);
    });

    it('a run without a ticket', async () => {
      const project = await createProject();
      t.tickets.setAutoChain(project.id, true);
      const passes = trackPipelines();
      const run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'look around' })).json() as Run;
      await begin(run);
      await stop(run);
      await settled(passes, 1);
      expect((await eventTypes(run)).some((x) => x.startsWith('completion_'))).toBe(false);
      expect(followups(run)).toEqual([]);
    });

    it('a brainstorm run', async () => {
      const project = await createProject();
      await createTicket(project.id, { title: '[Factory] Plan it', status: 'done' });
      const passes = trackPipelines();
      const run = await t.tickets.startBrainstormRun(project.id, { prompt: 'ideas' });
      await begin(run);
      await stop(run);
      await settled(passes, 1);
      expect((await eventTypes(run)).some((x) => x.startsWith('completion_'))).toBe(false);
      expect(followups(run)).toEqual([]);
    });
  });
});

describe('dependency context in the dependent prompt', () => {
  const setCompletion = (id: string, summary: string, handoff: string, at: string) =>
    t.db
      .update(tickets)
      .set({ completion: { runId: 'r', summary, handoff, blockers: [], at } })
      .where(eq(tickets.id, id))
      .run();

  it('lists the finished direct dependencies, oldest first; not transitive ones', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const b = await createTicket(project.id, { title: 'API', status: 'done' });
    const c = await createTicket(project.id, { title: 'Auth', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog', body: 'Build the screen.' });
    await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.id] });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [b.id, c.id] });
    setCompletion(a.id, 'made the schema', 'tables: users', '2026-10-17T10:00:00.000Z');
    setCompletion(b.id, 'added /api/users', 'GET /api/users returns a list', '2026-10-17T12:00:00.000Z');
    setCompletion(c.id, 'login works', '', '2026-10-17T11:00:00.000Z');

    const { run } = (await api('POST', `/api/tickets/${d.id}/start`, {})).json() as { run: Run };
    await waitFile(`token-${run.id}`);
    const prompt = t.runs.get(run.id).prompt;
    expect(prompt).toBe(
      [
        `${d.key}: Screen`,
        '',
        'Build the screen.',
        '',
        '## Context from finished dependencies',
        '',
        `### ${c.key}: Auth`,
        'Summary: login works',
        '',
        `### ${b.key}: API`,
        'Summary: added /api/users',
        'Handoff: GET /api/users returns a list',
      ].join('\n'),
    );
    expect(prompt).not.toContain('made the schema');
  });

  it('adds nothing when no dependency has a completion', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog' });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [a.id] });
    const { run } = (await api('POST', `/api/tickets/${d.id}/start`, {})).json() as { run: Run };
    await waitFile(`token-${run.id}`);
    expect(t.runs.get(run.id).prompt).toBe(`${d.key}: Screen`);
  });

  it('keeps the whole prompt within the run prompt limit', async () => {
    const project = await createProject();
    const a = await createTicket(project.id, { title: 'Schema', status: 'done' });
    const d = await createTicket(project.id, { title: 'Screen', status: 'backlog', body: 'x'.repeat(15_000) });
    await api('PATCH', `/api/tickets/${d.id}`, { dependsOn: [a.id] });
    setCompletion(a.id, 's'.repeat(4000), 'h'.repeat(8000), '2026-10-17T10:00:00.000Z');
    const res = await api('POST', `/api/tickets/${d.id}/start`, {});
    expect(res.statusCode).toBeLessThan(300);
    const { run } = res.json() as { run: Run };
    await waitFile(`token-${run.id}`);
    const prompt = t.runs.get(run.id).prompt;
    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toContain('## Context from finished dependencies');
  });
});

describe('dependencyContextSection', () => {
  const dep = (key: string, at: string, summary: string, handoff = ''): FinishedDependency => ({
    key,
    title: `Title ${key}`,
    completion: { summary, handoff, at },
  });

  it('is empty without dependencies', () => {
    expect(dependencyContextSection([])).toBe('');
  });

  it('orders oldest first and omits an empty handoff', () => {
    const section = dependencyContextSection([
      dep('B', '2026-10-17T12:00:00.000Z', 'b sum', 'b hand'),
      dep('A', '2026-10-17T10:00:00.000Z', 'a sum'),
    ]);
    expect(section).toBe(
      '## Context from finished dependencies\n\n### A: Title A\nSummary: a sum\n\n### B: Title B\nSummary: b sum\nHandoff: b hand',
    );
  });

  it('caps each dependency at 3000 chars with an ellipsis', () => {
    const section = dependencyContextSection([dep('A', '2026-10-17T10:00:00.000Z', 's'.repeat(4000), 'h'.repeat(8000))]);
    const block = section.split('\n\n').slice(1).join('\n\n');
    expect(block.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect(block.startsWith('### A: Title A\nSummary: sss')).toBe(true);
    expect(block.endsWith('…')).toBe(true);
  });

  it('caps the section at 10000 chars, shortening the oldest dependencies first', () => {
    const deps = ['A', 'B', 'C', 'D', 'E'].map((key, i) =>
      dep(key, `2026-10-17T1${i}:00:00.000Z`, key.toLowerCase().repeat(4000)),
    );
    const section = dependencyContextSection(deps);
    expect(section.length).toBeLessThanOrEqual(DEPENDENCY_SECTION_MAX);
    const blocks = section.split('\n\n').slice(1);
    // Every dependency still has its heading.
    expect(blocks.map((b) => b.split('\n')[0])).toEqual(['A', 'B', 'C', 'D', 'E'].map((k) => `### ${k}: Title ${k}`));
    // The newest ones are whole (at the per-dependency cap), the oldest ones were shortened.
    expect(blocks[4]?.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect(blocks[3]?.length).toBe(DEPENDENCY_BLOCK_MAX);
    expect((blocks[0]?.length ?? 0) < (blocks[4]?.length ?? 0)).toBe(true);
    expect(blocks[0]?.endsWith('…')).toBe(true);
  });

  it('honours a smaller budget and returns nothing when not even the heading fits', () => {
    const deps = [dep('A', '2026-10-17T10:00:00.000Z', 'a'.repeat(2000))];
    const small = dependencyContextSection(deps, 500);
    expect(small.length).toBe(500);
    expect(small.startsWith('## Context from finished dependencies\n\n### A: Title A\nSummary: aaa')).toBe(true);
    expect(small.endsWith('…')).toBe(true);
    expect(dependencyContextSection(deps, 20)).toBe('');
  });
});
