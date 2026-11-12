import { type Ticket, TicketExport } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

async function seedBoard(): Promise<{ projectId: string; tickets: Ticket[] }> {
  const { project } = (await api('POST', '/api/projects', { name: 'Export Demo', initGit: false })).json();
  const projectId = (project as { id: string }).id;
  const a: Ticket = (await api('POST', `/api/projects/${projectId}/tickets`, { title: '=cmd|calc' })).json();
  const b: Ticket = (
    await api('POST', `/api/projects/${projectId}/tickets`, { title: 'Ship, "fast"', status: 'ready' })
  ).json();
  await api('PATCH', `/api/tickets/${b.id}`, { dependsOn: [a.key] });
  const c: Ticket = (
    await api('POST', `/api/projects/${projectId}/tickets`, { title: 'Done one', status: 'done' })
  ).json();
  return { projectId, tickets: [a, b, c] };
}

describe('GET /api/projects/:projectId/tickets/export', () => {
  it('downloads the board as validated JSON with status counts', async () => {
    const { projectId, tickets } = await seedBoard();
    const res = await api('GET', `/api/projects/${projectId}/tickets/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="emberline-export-demo-tickets-/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = TicketExport.parse(res.json());
    expect(doc.counts).toEqual({ backlog: 1, ready: 1, in_progress: 0, review: 0, done: 1 });
    expect(doc.doneRatio).toBeCloseTo(1 / 3);
    expect(doc.tickets.map((x) => x.key)).toEqual(tickets.map((x) => x.key));
    expect(doc.tickets[1]).toMatchObject({ dependsOn: [tickets[0]?.key], blockedBy: [tickets[0]?.key] });
  });

  it('downloads a status-filtered CSV with formulas neutralised', async () => {
    const { projectId } = await seedBoard();
    const res = await api('GET', `/api/projects/${projectId}/tickets/export?format=csv&status=backlog,ready`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/\.csv"/);
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^key,title,status,/);
    expect(lines[1]).toMatch(/^ED-1,'=cmd\|calc,backlog,/);
    expect(lines[2]).toMatch(/^ED-2,"Ship, ""fast""",ready,1,coder,0,ED-1,ED-1,/);
  });

  it('rejects invalid queries and unknown projects', async () => {
    const { projectId } = await seedBoard();
    const url = `/api/projects/${projectId}/tickets/export`;
    expect((await api('GET', `${url}?format=xlsx`)).statusCode).toBe(400);
    expect((await api('GET', `${url}?status=shipped`)).statusCode).toBe(400);
    expect((await api('GET', `${url}?limit=5`)).statusCode).toBe(400);
    expect((await api('GET', '/api/projects/nope/tickets/export')).statusCode).toBe(404);
  });

  it('requires a session', async () => {
    const { projectId } = await seedBoard();
    const res = await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/tickets/export` });
    expect(res.statusCode).toBe(401);
  });
});
