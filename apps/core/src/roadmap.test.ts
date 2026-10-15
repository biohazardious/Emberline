import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectRoadmapState } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

async function createProject(): Promise<{ id: string; path: string }> {
  return (await api('POST', '/api/projects', { name: 'Roadmap App' })).json().project;
}

const itemTitles = (state: ProjectRoadmapState) => state.milestones.flatMap((m) => m.items.map((i) => i.title));

describe('roadmap.json', () => {
  it('keeps every item when edits arrive concurrently', async () => {
    const project = await createProject();
    const titles = Array.from({ length: 12 }, (_, i) => `Concurrent item ${i}`);
    const responses = await Promise.all([
      ...titles.map((title) => api('POST', `/api/projects/${project.id}/roadmap/items`, { title })),
      api('GET', `/api/projects/${project.id}/roadmap`),
      api('GET', `/api/projects/${project.id}/roadmap`),
    ]);
    for (const res of responses) expect(res.statusCode).toBeLessThan(300);

    const state: ProjectRoadmapState = (await api('GET', `/api/projects/${project.id}/roadmap`)).json();
    expect(itemTitles(state)).toEqual(expect.arrayContaining(titles));
    expect(readdirSync(path.join(project.path, '.emberline')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('backs up an unreadable roadmap.json instead of silently replacing it', async () => {
    const project = await createProject();
    const file = path.join(project.path, '.emberline', 'roadmap.json');
    await api('GET', `/api/projects/${project.id}/roadmap`);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, '{"milestones": [ truncated');

    const res = await api('GET', `/api/projects/${project.id}/roadmap`);
    expect(res.statusCode).toBe(200);
    const backups = readdirSync(path.dirname(file)).filter((f) => f.startsWith('roadmap.json.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('re-creates the ticket of a dispatched item when it was deleted from the board', async () => {
    const project = await createProject();
    const added: ProjectRoadmapState = (
      await api('POST', `/api/projects/${project.id}/roadmap/items`, { title: 'Ship the thing' })
    ).json();
    const item = added.milestones.flatMap((m) => m.items).find((i) => i.title === 'Ship the thing')!;
    const dispatch = () =>
      api('POST', `/api/projects/${project.id}/roadmap/dispatch`, { itemIds: [item.id], autoStart: false });

    const first = await dispatch();
    expect(first.statusCode).toBe(200);
    const ticketId = first.json().createdTickets[0].id as string;
    expect((await api('DELETE', `/api/tickets/${ticketId}`)).statusCode).toBeLessThan(300);

    const second = await dispatch();
    expect(second.statusCode).toBe(200);
    expect(second.json().createdTickets).toHaveLength(1);
    expect(second.json().createdTickets[0].id).not.toBe(ticketId);
  });
});
