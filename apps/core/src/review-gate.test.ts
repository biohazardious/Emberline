import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewComment, Run, RunDetail, RunReviewState, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAttention } from './runs/attention.js';
import { eq } from 'drizzle-orm';
import { runs, tickets } from './db/schema.js';
import { reviewUnblockPending, stillHeld } from './runs/hold-outcome.js';
import { PRUNE_PROTECTED_EVENT_TYPES } from './runs/service.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import type { TicketService } from './tickets/service.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

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
  vi.restoreAllMocks();
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

const wgit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
  });

const statusOf = async (id: string) => ((await api('GET', `/api/tickets/${id}`)).json() as Ticket).status;
const eventTypes = async (run: Run) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type);
const eventPayload = async (run: Run, type: string) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.find((e) => e.type === type)
    ?.payload;
const followups = (run: Run) => {
  const file = path.join(t.dir, `followups-${run.id}`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

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

const settled = async (passes: Promise<void>[], n: number) => {
  await expect.poll(() => passes.length, { timeout: 10_000 }).toBe(n);
  await Promise.all(passes);
};

/** A factory ticket run with one commit of work, its session started. */
async function factoryTicket() {
  const { project } = (await api('POST', '/api/projects', { name: 'Gate', initGit: false })).json();
  wgit(project.path, 'init', '-q', '-b', 'main');
  wgit(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
  const ticket = (
    await api('POST', `/api/projects/${project.id}/tickets`, { title: 'A', status: 'ready' })
  ).json() as Ticket;
  await t.tickets.dispatchNextReadyTicket(project.id);
  const run = t.runs.list().find((r) => r.ticketId === ticket.id) as Run;
  mkdirSync(run.worktreePath, { recursive: true });
  writeFileSync(path.join(run.worktreePath, 'A.txt'), 'A\n');
  wgit(run.worktreePath, 'add', '-A');
  wgit(run.worktreePath, 'commit', '-q', '-m', 'A');
  await waitFile(`ready-${run.id}`);
  const token = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', token, { session_id: `s-${run.id}` });
  await api('POST', `/api/internal/runs/${run.id}/completion-tool`).catch(() => undefined);
  await t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${run.id}/completion-tool`,
    headers: { authorization: `Bearer ${token}` },
  });
  await hook(run.id, 'UserPromptSubmit', token);
  return { project: project as { id: string; path: string }, ticket, run, token };
}

async function finishTurn(run: Run, token: string) {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${run.id}/complete`,
    headers: { authorization: `Bearer ${token}` },
    payload: { summary: 'did A', handoff: 'A.txt' },
  });
  expect(res.statusCode).toBe(200);
  await hook(run.id, 'Stop', token);
}

const comment = async (run: Run, priority: string, line = 1): Promise<ReviewComment> => {
  const res = await api('POST', `/api/runs/${run.id}/review/comments`, {
    filePath: 'A.txt',
    line,
    body: 'x',
    priority,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
};

const runRow = async (run: Run): Promise<Run> => {
  const res = (await api('GET', '/api/runs')).json() as Run[] | { runs: Run[] };
  const all = Array.isArray(res) ? res : res.runs;
  return all.find((r) => r.id === run.id) as Run;
};

describe('blocking review comments close the merge gate', () => {
  it('holds the pipeline before the merge, without prompting the agent', async () => {
    const { project, ticket, run, token } = await factoryTicket();
    await comment(run, 'blocking');
    await comment(run, 'suggestion', 2);
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    expect(await eventTypes(run)).toContain('review_blocked');
    expect(await eventTypes(run)).not.toContain('merged_to_main');
    expect(await eventPayload(run, 'review_blocked')).toEqual({ count: 1 });
    expect(await statusOf(ticket.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
    expect(followups(run)).toEqual([]);
    const row = await runRow(run);
    expect(row.attention).toMatchObject({ reason: 'held', detail: 'Blocking review comments' });
    expect(row.reviewReady).toBe(false);
  });

  it('resolving the last blocking comment unblocks; the next pass merges', async () => {
    const { project, ticket, run, token } = await factoryTicket();
    const a = await comment(run, 'blocking');
    const b = await comment(run, 'blocking', 2);
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    await api('PATCH', `/api/runs/${run.id}/review/comments/${a.id}`, { status: 'resolved' });
    expect(await eventTypes(run)).not.toContain('review_unblocked');
    await api('PATCH', `/api/runs/${run.id}/review/comments/${b.id}`, { status: 'resolved' });
    expect((await eventTypes(run)).filter((x) => x === 'review_unblocked')).toHaveLength(1);
    // The hold is over for attention and the ticket is ready for review again.
    const row = await runRow(run);
    expect(row.attention).toBeNull();
    expect(row.reviewReady).toBe(true);
    await hook(run.id, 'UserPromptSubmit', token);
    await finishTurn(run, token);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
  });

  it('deleting or downgrading the last blocking comment also unblocks', async () => {
    const { run, token } = await factoryTicket();
    const a = await comment(run, 'blocking');
    const b = await comment(run, 'blocking', 2);
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    await api('PATCH', `/api/runs/${run.id}/review/comments/${a.id}`, { priority: 'important' });
    expect(await eventTypes(run)).not.toContain('review_unblocked');
    expect((await api('DELETE', `/api/runs/${run.id}/review/comments/${b.id}`)).statusCode).toBeLessThan(300);
    expect((await eventTypes(run)).filter((x) => x === 'review_unblocked')).toHaveLength(1);
  });

  it('no unblocked note when no blocking hold is current', async () => {
    const { run } = await factoryTicket();
    const a = await comment(run, 'blocking');
    await api('PATCH', `/api/runs/${run.id}/review/comments/${a.id}`, { status: 'resolved' });
    expect(await eventTypes(run)).not.toContain('review_unblocked');
  });

  it('a person merge answers 409 with the count, force merges and notes the override', async () => {
    const { project, ticket, run } = await factoryTicket();
    await comment(run, 'blocking');
    await comment(run, 'blocking', 2);
    const refused = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ blocking: 2 });
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
    const forced = await api('POST', `/api/projects/${project.id}/sync-worktree`, {
      runId: run.id,
      force: true,
    });
    expect(forced.json()).toMatchObject({ ok: true });
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
    expect(await eventPayload(run, 'review_blocking_overridden')).toEqual({ count: 2 });
    expect(await eventTypes(run)).toContain('merged_by_person');
    expect(ticket.id).toBeTruthy();
  });

  it('a merge without blocking feedback carries no override note', async () => {
    const { project, run } = await factoryTicket();
    await comment(run, 'important');
    const res = await api('POST', `/api/projects/${project.id}/sync-worktree`, {
      runId: run.id,
      force: true,
    });
    expect(res.json()).toMatchObject({ ok: true });
    expect(await eventTypes(run)).not.toContain('review_blocking_overridden');
  });

  it('the list path reads blocking feedback in one batched query, however many runs', async () => {
    const { run, token } = await factoryTicket();
    await comment(run, 'blocking');
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    const base = await runRow(run);
    let reads = 0;
    const counting = new Proxy(t.db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if ((prop === 'select' || prop === 'all') && typeof value === 'function') {
          return (...args: unknown[]) => {
            reads += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const one = attachAttention(counting, [base]);
    const readsForOne = reads;
    reads = 0;
    const many = attachAttention(counting, [
      base,
      ...Array.from({ length: 5 }, (_, i) => ({ ...base, id: `other-${i}` })),
    ]);
    expect(reads).toBe(readsForOne);
    expect(one[0]?.reviewReady).toBe(false);
    expect(many.map((r) => r.reviewReady)).toHaveLength(6);
  });

  it('counts blocking feedback across a handoff: the successor is held, a person merge refused, unblocking notes it on the successor', async () => {
    const { project, ticket, run: a } = await factoryTicket();
    const c = await comment(a, 'blocking');
    t.db.update(runs).set({ state: 'rate_limited' }).where(eq(runs.id, a.id)).run();
    const b = await t.runs.handOff(
      a.id,
      { agent: 'claude', model: 'opus', credential: 'login' },
      { reason: 'quota', source: 'system', automatic: true },
    );
    await t.scheduler.tick();
    await waitFile(`ready-${b.id}`);
    const tokenB = await waitFile(`token-${b.id}`);
    await hook(b.id, 'SessionStart', tokenB, { session_id: `s-${b.id}` });
    await t.app.inject({
      method: 'POST',
      url: `/api/internal/runs/${b.id}/completion-tool`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    await hook(b.id, 'UserPromptSubmit', tokenB);
    const passes = trackPipelines();
    await finishTurn(b, tokenB);
    await settled(passes, 1);
    expect(await eventPayload(b, 'review_blocked')).toEqual({ count: 1 });
    expect(await eventTypes(b)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
    const rowB = await runRow(b);
    expect(rowB.attention).toMatchObject({ reason: 'held', detail: 'Blocking review comments' });
    expect(rowB.reviewReady).toBe(false);
    const refused = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: b.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ blocking: 1 });

    await api('PATCH', `/api/runs/${a.id}/review/comments/${c.id}`, { status: 'resolved' });
    expect(await eventTypes(b)).toContain('review_unblocked');
    await hook(b.id, 'UserPromptSubmit', tokenB);
    await finishTurn(b, tokenB);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
  });

  it('unblocking lets a dispatch finalization re-run the pipeline even when it ran before', async () => {
    const { project, ticket, run, token } = await factoryTicket();
    const c = await comment(run, 'blocking');
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    (t.tickets as unknown as { resumedPipelines: Set<string> }).resumedPipelines.add(run.id);
    await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, { status: 'resolved' });
    await t.tickets.dispatchNextReadyTicket(project.id);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(await eventTypes(run)).toContain('merged_to_main');
  });

  it('an unblock does not end another hold', async () => {
    const { run } = await factoryTicket();
    const c = await comment(run, 'blocking');
    t.runs.note(run.id, 'merge_failed', {});
    t.runs.note(run.id, 'review_blocked', { count: 1 });
    await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, { status: 'resolved' });
    expect(await eventTypes(run)).toContain('review_unblocked');
  });

  it('a merge that is already in main is a no-op, not a 409', async () => {
    const { project, run } = await factoryTicket();
    expect(
      (await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id })).json(),
    ).toMatchObject({ ok: true });
    await comment(run, 'blocking');
    const again = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, alreadyMerged: true });
    expect(await eventTypes(run)).not.toContain('review_blocking_overridden');
  });

  it('stillHeld: an unblock ends only the review_blocked hold of an earlier pass', async () => {
    const { run, token } = await factoryTicket();
    t.runs.note(run.id, 'merge_failed', {});
    t.runs.note(run.id, 'review_blocked', { count: 1 });
    t.runs.note(run.id, 'review_unblocked', {});
    await hook(run.id, 'Stop', token);
    expect(stillHeld(t.db, run.id)).toBe(true);
  });

  it('stillHeld: an unblocked review_blocked is no hold', async () => {
    const { run, token } = await factoryTicket();
    t.runs.note(run.id, 'review_blocked', { count: 1 });
    t.runs.note(run.id, 'review_unblocked', {});
    await hook(run.id, 'Stop', token);
    expect(stillHeld(t.db, run.id)).toBe(false);
  });
});

/** Starts the agent session of a run the scheduler launched (token, session, completion tool, a turn). */
async function startSession(run: Run): Promise<string> {
  await t.scheduler.tick();
  await waitFile(`ready-${run.id}`);
  const tok = await waitFile(`token-${run.id}`);
  await hook(run.id, 'SessionStart', tok, { session_id: `s-${run.id}` });
  await t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${run.id}/completion-tool`,
    headers: { authorization: `Bearer ${tok}` },
  });
  await hook(run.id, 'UserPromptSubmit', tok);
  return tok;
}

const reviewState = async (run: Run) =>
  (await api('GET', `/api/runs/${run.id}/review`)).json() as RunReviewState;

describe('a missing worktree on a person merge', () => {
  it('is no merge to make when the run branch is already in main', async () => {
    const { project, run } = await factoryTicket();
    expect(
      (await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id })).json(),
    ).toMatchObject({ ok: true });
    rmSync(run.worktreePath, { recursive: true, force: true });
    const again = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, alreadyMerged: true });
    // Only the first, real merge is a person's merge.
    expect((await eventTypes(run)).filter((x) => x === 'merged_by_person')).toHaveLength(1);
  });

  it('answers 409 worktree_missing when its work is not in main', async () => {
    const { project, ticket, run } = await factoryTicket();
    rmSync(run.worktreePath, { recursive: true, force: true });
    const res = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'worktree_missing', ticketId: ticket.id });
    expect(res.json().message).toBe("the run's worktree is gone and its work isn't in main");
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
  });
});

describe('a new run that carried blocking feedback', () => {
  async function carried() {
    const { project, ticket, run: a, token } = await factoryTicket();
    await comment(a, 'blocking');
    await comment(a, 'important', 2);
    const passes = trackPipelines();
    await finishTurn(a, token);
    await settled(passes, 1);
    const res = await api('POST', `/api/runs/${a.id}/review/request-changes`, { target: 'new' });
    expect(res.statusCode).toBe(200);
    const b = (res.json() as { run: Run }).run;
    const tokenB = await startSession(b);
    writeFileSync(path.join(b.worktreePath, 'B.txt'), 'B\n');
    wgit(b.worktreePath, 'add', '-A');
    wgit(b.worktreePath, 'commit', '-q', '-m', 'B');
    return { project, ticket, a, b, tokenB, passes };
  }

  it('notes the carried blocking count on the new run and keeps its gate closed until a person verifies', async () => {
    const { project, ticket, a, b, tokenB, passes } = await carried();
    expect(await eventPayload(b, 'review_carried_blocking')).toEqual({ count: 1, fromRun: a.id });
    expect(await reviewState(b)).toMatchObject({
      blockingOpen: 1,
      carriedBlocking: { count: 1, fromRun: a.id },
    });

    const refused = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: b.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'review_blocked', blocking: 1 });

    // The person started B; a running chain makes its completion a factory pass.
    t.tickets.setAutoChain(project.id, true);
    await finishTurn(b, tokenB);
    await settled(passes, 2);
    expect(await eventPayload(b, 'review_blocked')).toEqual({ count: 1 });
    expect(await eventTypes(b)).not.toContain('merged_to_main');
    expect(await statusOf(ticket.id)).toBe('review');
    expect((await runRow(b)).reviewReady).toBe(false);

    const verified = await api('POST', `/api/runs/${b.id}/review/verify-carried`);
    expect(verified.statusCode).toBe(200);
    expect((await eventTypes(b)).filter((x) => x === 'review_unblocked')).toHaveLength(1);
    expect(await reviewState(b)).toMatchObject({ blockingOpen: 0, carriedBlocking: null });
    expect((await runRow(b)).reviewReady).toBe(true);
    expect((await api('POST', `/api/runs/${b.id}/review/verify-carried`)).statusCode).toBe(409);

    await t.tickets.dispatchNextReadyTicket(project.id);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
    expect(existsSync(path.join(project.path, 'B.txt'))).toBe(true);
  });

  it('a verified carried marker leaves the run held while its own blocking comment is open', async () => {
    const { project, ticket, b, tokenB, passes } = await carried();
    const own = await comment(b, 'blocking');
    t.tickets.setAutoChain(project.id, true);
    await finishTurn(b, tokenB);
    await settled(passes, 2);
    expect(await eventPayload(b, 'review_blocked')).toEqual({ count: 2 });

    expect((await api('POST', `/api/runs/${b.id}/review/verify-carried`)).statusCode).toBe(200);
    expect(await eventTypes(b)).toContain('review_carried_verified');
    expect(await eventTypes(b)).not.toContain('review_unblocked');
    expect(await reviewState(b)).toMatchObject({ blockingOpen: 1, carriedBlocking: null });
    expect((await runRow(b)).reviewReady).toBe(false);
    expect(
      (await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: b.id })).json(),
    ).toMatchObject({ blocking: 1 });

    // Resolving its own comment then opens the gate.
    await api('PATCH', `/api/runs/${b.id}/review/comments/${own.id}`, { status: 'resolved' });
    expect(await eventTypes(b)).toContain('review_unblocked');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('verify-carried is a 409 for a run that carried no blocking feedback', async () => {
    const { run } = await factoryTicket();
    expect((await api('POST', `/api/runs/${run.id}/review/verify-carried`)).statusCode).toBe(409);
    expect(await eventTypes(run)).not.toContain('review_unblocked');
  });

  it('keeps the carried marker through event pruning', () => {
    expect(PRUNE_PROTECTED_EVENT_TYPES).toContain('review_carried_blocking');
    expect(PRUNE_PROTECTED_EVENT_TYPES).toContain('review_carried_verified');
  });
});

describe('review prompts and the completion signal', () => {
  it('a second review round holds as review_blocked, not completion_missing, and passes after signal and resolve', async () => {
    const { ticket, run, token } = await factoryTicket();
    const c = await comment(run, 'blocking');
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);

    const sent: string[] = [];
    vi.spyOn(t.runs, 'prompt').mockImplementation(async (id: string, text: string) => {
      sent.push(text);
      return t.runs.getRun(id);
    });
    expect((await api('POST', `/api/runs/${run.id}/review/request-changes`, {})).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/\n\nWhen finished, call `ticket_complete` again\.$/);

    await hook(run.id, 'UserPromptSubmit', token);
    await finishTurn(run, token);
    await settled(passes, 2);
    const types = await eventTypes(run);
    expect(types.filter((x) => x === 'review_blocked')).toHaveLength(2);
    expect(types).not.toContain('completion_missing');
    expect(types).not.toContain('completion_nudged');

    expect(
      (await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, { status: 'resolved' })).statusCode,
    ).toBe(200);
    await hook(run.id, 'UserPromptSubmit', token);
    await finishTurn(run, token);
    await expect.poll(() => statusOf(ticket.id), { timeout: 10_000 }).toBe('done');
  });
});

describe('a review_blocked pass', () => {
  it('skips merge and Done for its ticket but still dispatches the next ready ticket', async () => {
    await api('PATCH', '/api/factory/settings', { maxParallelTicketsPerProject: 1 });
    const { project } = (await api('POST', '/api/projects', { name: 'Chain', initGit: false })).json();
    wgit(project.path, 'init', '-q', '-b', 'main');
    wgit(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
    const a = (
      await api('POST', `/api/projects/${project.id}/tickets`, { title: 'A', status: 'ready', priority: 3 })
    ).json() as Ticket;
    const b = (
      await api('POST', `/api/projects/${project.id}/tickets`, { title: 'B', status: 'ready', priority: 1 })
    ).json() as Ticket;
    await t.tickets.dispatchNextReadyTicket(project.id);
    const runA = t.runs.list().find((r) => r.ticketId === a.id) as Run;
    expect(t.runs.list().some((r) => r.ticketId === b.id)).toBe(false);
    mkdirSync(runA.worktreePath, { recursive: true });
    writeFileSync(path.join(runA.worktreePath, 'A.txt'), 'A\n');
    wgit(runA.worktreePath, 'add', '-A');
    wgit(runA.worktreePath, 'commit', '-q', '-m', 'A');
    const tokenA = await startSession(runA);
    await comment(runA, 'blocking');
    const passes = trackPipelines();
    await finishTurn(runA, tokenA);
    await settled(passes, 1);
    expect(await eventTypes(runA)).toContain('review_blocked');
    expect(await eventTypes(runA)).not.toContain('merged_to_main');
    expect(await statusOf(a.id)).toBe('review');
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(false);
    await expect.poll(() => t.runs.list().some((r) => r.ticketId === b.id), { timeout: 10_000 }).toBe(true);
  });
});

describe('a lifted review hold keeps a run in the factory only until the next outcome', () => {
  /** A person's own follow-up turn: new work, no completion signal. */
  async function followUp(run: Run, token: string, file: string) {
    await hook(run.id, 'UserPromptSubmit', token);
    writeFileSync(path.join(run.worktreePath, file), `${file}\n`);
    wgit(run.worktreePath, 'add', '-A');
    wgit(run.worktreePath, 'commit', '-q', '-m', file);
    await hook(run.id, 'Stop', token);
  }

  it('reviewUnblockPending: only while the newest outcome is an unblock of a review hold', async () => {
    const { run, token } = await factoryTicket();
    t.runs.note(run.id, 'review_blocked', { count: 1 });
    t.runs.note(run.id, 'review_unblocked', {});
    await hook(run.id, 'Stop', token);
    expect(reviewUnblockPending(t.db, run.id)).toBe(true);
    t.runs.note(run.id, 'completion_accepted', {});
    await hook(run.id, 'UserPromptSubmit', token);
    await hook(run.id, 'Stop', token);
    expect(reviewUnblockPending(t.db, run.id)).toBe(false);
  });

  it('after an unblocked, accepted pass with merging off, a follow-up in a quiet project is not piped', async () => {
    await api('PATCH', '/api/factory/settings', { autoSyncToMain: false, autoMoveToDone: false });
    const { project, ticket, run, token } = await factoryTicket();
    const c = await comment(run, 'blocking');
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, { status: 'resolved' });
    // The session stays at its prompt (the step's close is skipped), so the person can follow up in it.
    vi.spyOn(t.runs, 'stop').mockImplementation(async (id: string) => t.runs.getRun(id));
    await hook(run.id, 'UserPromptSubmit', token);
    await finishTurn(run, token);
    await settled(passes, 2);
    expect(await eventTypes(run)).toContain('completion_accepted');
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);

    await followUp(run, token, 'C.txt');
    await settled(passes, 3);
    const types = await eventTypes(run);
    expect(types).not.toContain('completion_nudged');
    expect(types).not.toContain('completion_missing');
    expect(await statusOf(ticket.id)).toBe('review');
  });

  it('after Merge anyway and Done, a reopened ticket’s follow-up is not merged automatically', async () => {
    const { project, ticket, run, token } = await factoryTicket();
    const c = await comment(run, 'blocking');
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    expect(
      (await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id, force: true })).json(),
    ).toMatchObject({ ok: true });
    await api('PATCH', `/api/tickets/${ticket.id}`, { status: 'done' });
    await api('PATCH', `/api/runs/${run.id}/review/comments/${c.id}`, { status: 'resolved' });
    await api('PATCH', `/api/tickets/${ticket.id}`, { status: 'review' });

    await followUp(run, token, 'C.txt');
    await settled(passes, 2);
    const types = await eventTypes(run);
    expect(types).not.toContain('merged_to_main');
    expect(types).not.toContain('completion_nudged');
    expect(existsSync(path.join(project.path, 'C.txt'))).toBe(false);
  });
});

describe('a headless run in Accept edits', () => {
  beforeEach(() => {
    process.env.EMBERLINE_GEMINI_COMMAND = t.config.claudeCommand;
  });
  afterEach(() => {
    delete process.env.EMBERLINE_GEMINI_COMMAND;
  });

  async function headlessReview() {
    const { ticket, run, token } = await factoryTicket();
    await comment(run, 'important');
    const passes = trackPipelines();
    await finishTurn(run, token);
    await settled(passes, 1);
    t.db
      .update(tickets)
      .set({ body: '[Preferred Agent: gemini · Model: auto]' })
      .where(eq(tickets.id, ticket.id))
      .run();
    t.db
      .update(runs)
      .set({ agent: 'gemini', permissionMode: 'acceptEdits', endedAt: new Date(), cancelledAt: null })
      .where(eq(runs.id, run.id))
      .run();
    return run;
  }

  it('a send to the same run says a new run needs Autonomous mode; a new run needs the person to choose it', async () => {
    const run = await headlessReview();
    const same = await api('POST', `/api/runs/${run.id}/review/request-changes`, { target: 'same' });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ error: 'headless_needs_auto', needsAutonomous: true });

    const bare = await api('POST', `/api/runs/${run.id}/review/request-changes`, { target: 'new' });
    expect(bare.statusCode).toBe(409);
    expect(bare.json()).toMatchObject({ error: 'headless_needs_auto' });
    expect(t.runs.list().filter((r) => r.ticketId === run.ticketId)).toHaveLength(1);

    const chosen = await api('POST', `/api/runs/${run.id}/review/request-changes`, {
      target: 'new',
      permissionMode: 'auto',
    });
    expect(chosen.statusCode).toBe(200);
    expect((chosen.json() as { run: Run }).run.permissionMode).toBe('auto');
  });
});

describe('request changes', () => {
  it('a mode for the same run is a 400 and sends nothing', async () => {
    const { run } = await factoryTicket();
    for (const body of [{ permissionMode: 'auto' }, { target: 'same', permissionMode: 'auto' }]) {
      const res = await api('POST', `/api/runs/${run.id}/review/request-changes`, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'bad_request',
        message: 'a mode can be chosen only for a new run',
      });
    }
    expect(followups(run)).toEqual([]);
  });
});
