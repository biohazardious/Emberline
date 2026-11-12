import { BulkTicketResult, CSRF_HEADER, type Ticket } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runs } from './db/schema.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let projectId: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  const { project } = (await api('POST', '/api/projects', { name: 'Bulk Demo', initGit: false })).json();
  projectId = (project as { id: string }).id;
});

afterEach(async () => {
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

async function addTicket(title: string, extra: object = {}): Promise<Ticket> {
  return (await api('POST', `/api/projects/${projectId}/tickets`, { title, ...extra })).json();
}

async function bulk(payload: object): Promise<BulkTicketResult> {
  const res = await api('POST', `/api/projects/${projectId}/tickets/bulk`, payload);
  expect(res.statusCode).toBe(200);
  return BulkTicketResult.parse(res.json());
}

function seedRun(ticketId: string, { live, branch }: { live: boolean; branch: string | null }): void {
  const now = new Date();
  t.db
    .insert(runs)
    .values({
      id: `run-${ticketId}`,
      projectId,
      ticketId,
      agent: 'claude',
      state: live ? 'working' : 'done',
      branch,
      worktreePath: `${t.dir}/.worktrees/${ticketId}`,
      hookTokenHash: 'h',
      stateChangedAt: now,
      createdAt: now,
      endedAt: live ? null : now,
    })
    .run();
}

const listBoard = async (): Promise<Ticket[]> =>
  (await api('GET', `/api/projects/${projectId}/tickets`)).json();

describe('POST /api/projects/:projectId/tickets/bulk', () => {
  it('moves tickets in board order to the bottom of the target column', async () => {
    const a = await addTicket('First');
    const b = await addTicket('Second');
    const existing = await addTicket('Already ready', { status: 'ready' });
    const result = await bulk({ action: 'move', ids: [b.id, a.key, existing.id], status: 'ready' });
    expect(result.updated.map((x) => x.key)).toEqual([a.key, b.key]);
    expect(result.unchanged).toEqual([existing.id]);
    expect(result.failed).toEqual([]);
    const ready = (await listBoard())
      .filter((x) => x.status === 'ready')
      .sort((x, y) => x.position - y.position);
    expect(ready.map((x) => x.key)).toEqual([existing.key, a.key, b.key]);
  });

  it('closing a dependency in bulk unblocks the ticket waiting for it', async () => {
    const dep = await addTicket('Dependency');
    const waiting = await addTicket('Waiting');
    await api('PATCH', `/api/tickets/${waiting.id}`, { dependsOn: [dep.key] });
    const result = await bulk({ action: 'move', ids: [dep.id], status: 'done' });
    expect(result.updated).toHaveLength(1);
    const after = (await listBoard()).find((x) => x.id === waiting.id);
    expect(after?.blockedBy).toEqual([]);
  });

  it('sets priority and persona, reporting tickets that already had the value', async () => {
    const a = await addTicket('One', { priority: 1 });
    const b = await addTicket('Two', { priority: 3, persona: 'qa' });
    const prio = await bulk({ action: 'priority', ids: [a.id, b.id], priority: 3 });
    expect(prio.updated.map((x) => [x.id, x.priority])).toEqual([[a.id, 3]]);
    expect(prio.unchanged).toEqual([b.id]);
    const persona = await bulk({ action: 'persona', ids: [a.id, b.id], persona: 'qa' });
    expect(persona.updated.map((x) => x.persona)).toEqual(['qa']);
    expect(persona.unchanged).toEqual([b.id]);
  });

  it('refuses tickets with a live run and closing tickets whose work would skip a merge', async () => {
    const live = await addTicket('Live');
    const branched = await addTicket('Branched', { status: 'review' });
    const plain = await addTicket('Plain');
    seedRun(live.id, { live: true, branch: 'emberline/live' });
    seedRun(branched.id, { live: false, branch: 'emberline/branched' });
    const result = await bulk({ action: 'move', ids: [live.id, branched.id, plain.id], status: 'done' });
    expect(result.updated.map((x) => x.id)).toEqual([plain.id]);
    expect(result.failed.map((f) => [f.key, f.code])).toEqual([
      [live.key, 'run_active'],
      [branched.key, 'merge_required'],
    ]);
    const board = await listBoard();
    expect(board.find((x) => x.id === branched.id)?.status).toBe('review');

    const back = await bulk({ action: 'move', ids: [branched.id], status: 'backlog' });
    expect(back.updated.map((x) => x.status)).toEqual(['backlog']);
  });

  it('deletes idle tickets, keeps live ones and names unknown ids once', async () => {
    const idle = await addTicket('Idle');
    const live = await addTicket('Live');
    seedRun(live.id, { live: true, branch: null });
    const result = await bulk({ action: 'delete', ids: [idle.id, live.id, 'nope', 'nope'] });
    expect(result.removed).toEqual([idle.id]);
    expect(result.failed.map((f) => [f.id, f.code])).toEqual([
      ['nope', 'not_found'],
      [live.id, 'run_active'],
    ]);
    expect((await listBoard()).map((x) => x.id)).toEqual([live.id]);
  });

  it('never touches another project’s tickets', async () => {
    const { project } = (await api('POST', '/api/projects', { name: 'Other', initGit: false })).json();
    const foreign: Ticket = (
      await api('POST', `/api/projects/${(project as { id: string }).id}/tickets`, { title: 'Foreign' })
    ).json();
    const result = await bulk({ action: 'delete', ids: [foreign.id] });
    expect(result.failed.map((f) => f.code)).toEqual(['not_found']);
    expect((await api('GET', `/api/tickets/${foreign.id}`)).statusCode).toBe(200);
  });

  it('rejects invalid bodies, unknown projects and anonymous or CSRF-less callers', async () => {
    const a = await addTicket('A');
    const url = `/api/projects/${projectId}/tickets/bulk`;
    expect((await api('POST', url, { action: 'move', ids: [a.id] })).statusCode).toBe(400);
    expect((await api('POST', url, { action: 'archive', ids: [a.id] })).statusCode).toBe(400);
    expect((await api('POST', url, { action: 'delete', ids: [] })).statusCode).toBe(400);
    expect(
      (await api('POST', '/api/projects/nope/tickets/bulk', { action: 'delete', ids: [a.id] })).statusCode,
    ).toBe(404);
    const anonymous = await t.app.inject({
      method: 'POST',
      url,
      payload: { action: 'delete', ids: [a.id] },
      headers: { [CSRF_HEADER]: '1' },
    });
    expect(anonymous.statusCode).toBe(401);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url,
      payload: { action: 'delete', ids: [a.id] },
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
