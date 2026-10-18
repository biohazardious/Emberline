import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewComment, Run, RunDetail, Ticket } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachAttention } from './runs/attention.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
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

const statusOf = async (id: string) => ((await api('GET', `/api/tickets/${id}`)).json() as Ticket).status;
const eventTypes = async (run: Run) => ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.map((e) => e.type);
const eventPayload = async (run: Run, type: string) =>
  ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.find((e) => e.type === type)?.payload;
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
  const ticket = (await api('POST', `/api/projects/${project.id}/tickets`, { title: 'A', status: 'ready' })).json() as Ticket;
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
  await t.app.inject({ method: 'POST', url: `/api/internal/runs/${run.id}/completion-tool`, headers: { authorization: `Bearer ${token}` } });
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
  const res = await api('POST', `/api/runs/${run.id}/review/comments`, { filePath: 'A.txt', line, body: 'x', priority });
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
    const forced = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id, force: true });
    expect(forced.json()).toMatchObject({ ok: true });
    expect(existsSync(path.join(project.path, 'A.txt'))).toBe(true);
    expect(await eventPayload(run, 'review_blocking_overridden')).toEqual({ count: 2 });
    expect(await eventTypes(run)).toContain('merged_by_person');
    expect(ticket.id).toBeTruthy();
  });

  it('a merge without blocking feedback carries no override note', async () => {
    const { project, run } = await factoryTicket();
    await comment(run, 'important');
    const res = await api('POST', `/api/projects/${project.id}/sync-worktree`, { runId: run.id, force: true });
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
    const many = attachAttention(counting, [base, ...Array.from({ length: 5 }, (_, i) => ({ ...base, id: `other-${i}` }))]);
    expect(reads).toBe(readsForOne);
    expect(one[0]?.reviewReady).toBe(false);
    expect(many.map((r) => r.reviewReady)).toHaveLength(6);
  });
});
