/**
 * M3 guards (PROJECT.md §6, AC-3.x): the operator's board workflow through the REST API the web
 * views call, every response parsed with its protocol schema.
 */
import { BulkTicketResult, CSRF_HEADER, Ticket, TicketExport } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runs } from './db/schema.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let projectId: string;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const api = (method: Method, url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  const { project } = (await api('POST', '/api/projects', { name: 'M3 Board', initGit: false })).json();
  projectId = (project as { id: string }).id;
});

afterEach(async () => {
  await t.close();
});

async function create(body: object): Promise<Ticket> {
  const res = await api('POST', `/api/projects/${projectId}/tickets`, body);
  expect(res.statusCode).toBe(201);
  return Ticket.parse(res.json());
}

async function patch(id: string, body: object): Promise<Ticket> {
  const res = await api('PATCH', `/api/tickets/${id}`, body);
  expect(res.statusCode).toBe(200);
  return Ticket.parse(res.json());
}

const board = async (): Promise<Ticket[]> =>
  Ticket.array().parse((await api('GET', `/api/projects/${projectId}/tickets`)).json());

interface SeededRun {
  live: boolean;
  branch: string | null;
  state?: string;
  ended?: boolean;
}

function seedRun(ticketId: string, { live, branch, state, ended = !live }: SeededRun): string {
  const now = new Date();
  const id = `run-${ticketId}`;
  t.db
    .insert(runs)
    .values({
      id,
      projectId,
      ticketId,
      agent: 'claude',
      state: state ?? (live ? 'working' : 'done'),
      branch,
      worktreePath: `${t.dir}/.worktrees/${ticketId}`,
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      endedAt: ended ? now : null,
    })
    .run();
  return id;
}

describe('M3 board workflow (AC-3.x)', () => {
  it('AC-3.1 creates tickets with priority and persona and moves them across every column', async () => {
    const ticket = await create({ title: 'Login form', priority: 3, persona: 'ui_ux' });
    expect(ticket).toMatchObject({ status: 'backlog', priority: 3, persona: 'ui_ux' });
    expect(ticket.key).toMatch(/^[A-Z0-9]+-\d+$/);

    for (const status of ['ready', 'in_progress', 'review', 'done'] as const) {
      expect((await patch(ticket.id, { status })).status).toBe(status);
    }
    expect((await board()).map((x) => [x.key, x.status])).toEqual([[ticket.key, 'done']]);
  });

  it('AC-3.1 rejects malformed bodies and unknown tickets without writing anything', async () => {
    const url = `/api/projects/${projectId}/tickets`;
    expect((await api('POST', url, { title: '' })).statusCode).toBe(400);
    expect((await api('POST', url, { title: 'x', priority: 9 })).statusCode).toBe(400);
    expect((await api('POST', url, { title: 'x', status: 'archived' })).statusCode).toBe(400);
    expect((await api('POST', '/api/projects/nope/tickets', { title: 'x' })).statusCode).toBe(404);
    expect((await api('PATCH', '/api/tickets/nope', { title: 'x' })).statusCode).toBe(404);
    expect(await board()).toEqual([]);
  });

  it('AC-3.2 links dependencies by key, refuses a cycle and unblocks once the dependency is done', async () => {
    const schema = await create({ title: 'Schema' });
    const api1 = await create({ title: 'API' });
    const waiting = await patch(api1.id, { dependsOn: [schema.key] });
    expect(waiting.dependsOn).toEqual([schema.id]);
    expect(waiting.blockedBy.map((b) => b.key)).toEqual([schema.key]);

    const cycle = await api('PATCH', `/api/tickets/${schema.id}`, { dependsOn: [api1.key] });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json()).toMatchObject({ error: 'dependency_cycle' });
    expect((await board()).find((x) => x.id === schema.id)?.dependsOn).toEqual([]);

    await patch(schema.id, { status: 'done' });
    expect((await board()).find((x) => x.id === api1.id)?.blockedBy).toEqual([]);
  });

  it('AC-3.3 refuses to delete a ticket with a live run, alone or in bulk', async () => {
    const live = await create({ title: 'Live' });
    seedRun(live.id, { live: true, branch: 'emberline/live' });

    const single = await api('DELETE', `/api/tickets/${live.id}`);
    expect(single.statusCode).toBe(409);
    expect(single.json()).toMatchObject({ error: 'run_active' });

    const bulk = BulkTicketResult.parse(
      (
        await api('POST', `/api/projects/${projectId}/tickets/bulk`, { action: 'delete', ids: [live.id] })
      ).json(),
    );
    expect(bulk.failed.map((f) => f.code)).toEqual(['run_active']);
    expect((await board()).map((x) => x.id)).toEqual([live.id]);
  });

  it('AC-3.3 a run paused on a usage limit still counts as live', async () => {
    const paused = await create({ title: 'Paused' });
    seedRun(paused.id, { live: true, branch: null, state: 'rate_limited', ended: true });
    expect((await api('DELETE', `/api/tickets/${paused.id}`)).json()).toMatchObject({ error: 'run_active' });
  });

  it('AC-3.3 a run whose turn finished while its session stays open does not block the delete', async () => {
    const held = await create({ title: 'Duplicate', status: 'review' });
    seedRun(held.id, { live: false, branch: null, state: 'done', ended: false });
    expect((await api('DELETE', `/api/tickets/${held.id}`)).statusCode).toBe(200);
  });

  it('AC-3.3 deletes a ticket whose runs ended and keeps those runs', async () => {
    const ticket = await create({ title: 'Finished' });
    const runId = seedRun(ticket.id, { live: false, branch: null });
    expect((await api('DELETE', `/api/tickets/${ticket.id}`)).statusCode).toBe(200);
    expect((await api('GET', `/api/tickets/${ticket.id}`)).statusCode).toBe(404);
    const kept = t.db.select({ ticketId: runs.ticketId }).from(runs).where(eq(runs.id, runId)).get();
    expect(kept).toEqual({ ticketId: null });
  });

  it('AC-3.4 a bulk close of a ticket with a run branch requires its merge', async () => {
    const branched = await create({ title: 'Branched', status: 'review' });
    seedRun(branched.id, { live: false, branch: 'emberline/branched' });
    const result = BulkTicketResult.parse(
      (
        await api('POST', `/api/projects/${projectId}/tickets/bulk`, {
          action: 'move',
          ids: [branched.key],
          status: 'done',
        })
      ).json(),
    );
    expect(result.failed.map((f) => [f.key, f.code])).toEqual([[branched.key, 'merge_required']]);
    expect((await board())[0]?.status).toBe('review');
  });

  it('AC-3.5 exports the board as schema-valid JSON with whole-board counts', async () => {
    const a = await create({ title: 'A', status: 'ready' });
    await create({ title: 'B', status: 'done' });
    const res = await api('GET', `/api/projects/${projectId}/tickets/export?format=json&status=ready`);
    expect(res.statusCode).toBe(200);
    const exported = TicketExport.parse(res.json());
    expect(exported.tickets.map((x) => x.key)).toEqual([a.key]);
    expect(exported.counts).toMatchObject({ ready: 1, done: 1 });
    expect((await api('GET', `/api/projects/${projectId}/tickets/export?format=xml`)).statusCode).toBe(400);
  });

  it('AC-3.6 board writes need a session and the CSRF header', async () => {
    const ticket = await create({ title: 'Guarded' });
    const writes: Array<{ method: Method; url: string; payload?: object }> = [
      { method: 'POST', url: `/api/projects/${projectId}/tickets`, payload: { title: 'x' } },
      { method: 'PATCH', url: `/api/tickets/${ticket.id}`, payload: { status: 'ready' } },
      { method: 'DELETE', url: `/api/tickets/${ticket.id}` },
      {
        method: 'POST',
        url: `/api/projects/${projectId}/tickets/bulk`,
        payload: { action: 'delete', ids: [ticket.id] },
      },
    ];
    for (const { method, url, payload } of writes) {
      const anonymous = await t.app.inject({ method, url, payload, headers: { [CSRF_HEADER]: '1' } });
      expect(anonymous.statusCode, `${method} ${url} anonymous`).toBe(401);
      const noCsrf = await t.app.inject({ method, url, payload, headers: { cookie } });
      expect(noCsrf.statusCode, `${method} ${url} without CSRF`).toBe(403);
    }
    expect((await board()).map((x) => [x.id, x.status])).toEqual([[ticket.id, 'backlog']]);
  });
});
