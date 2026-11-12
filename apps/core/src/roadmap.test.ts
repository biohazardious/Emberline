import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectNotice, ProjectRoadmapState } from '@emberline/protocol';
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

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

async function createProject(): Promise<{ id: string; path: string }> {
  return (await api('POST', '/api/projects', { name: 'Roadmap App' })).json().project;
}

const itemTitles = (state: ProjectRoadmapState) =>
  state.milestones.flatMap((m) => m.items.map((i) => i.title));

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

describe('roadmap-generated.json from an agent', () => {
  const GENERATED = '.emberline/roadmap-generated.json';
  const REJECTED = '.emberline/roadmap-generated.rejected.json';

  async function readWith(content: string) {
    const project = await createProject();
    await api('GET', `/api/projects/${project.id}/roadmap`);
    const notices: ProjectNotice[] = [];
    t.tickets.on('notice', (n) => notices.push(n));
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, GENERATED), content);
    const res = await api('GET', `/api/projects/${project.id}/roadmap`);
    expect(res.statusCode).toBe(200);
    return { project, state: res.json() as ProjectRoadmapState, notices };
  }

  const plan = (item: object) =>
    JSON.stringify({
      visionSummary: 'A booking studio.',
      milestones: [{ code: 'M7', title: 'Bookings', items: [item] }],
    });

  it('merges a valid plan and consumes the file', async () => {
    const { project, state, notices } = await readWith(
      plan({ title: 'Booking calendar', description: 'Pick a slot.', persona: 'ui_ux', priority: 1 }),
    );
    expect(state.visionSummary).toBe('A booking studio.');
    const ms = state.milestones.find((m) => m.code === 'M7')!;
    expect(ms.title).toBe('Bookings');
    expect(ms.items).toEqual([
      expect.objectContaining({
        title: 'Booking calendar',
        description: 'Pick a slot.',
        persona: 'ui_ux',
        priority: 1,
      }),
    ]);
    expect(notices).toEqual([]);
    expect(existsSync(path.join(project.path, GENERATED))).toBe(false);
    expect(existsSync(path.join(project.path, REJECTED))).toBe(false);
  });

  it('keeps malformed JSON as rejected and says why', async () => {
    const content = '{"milestones": [ truncated';
    const { project, state, notices } = await readWith(content);
    expect(itemTitles(state)).not.toContain('truncated');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'agent_file_rejected',
      projectId: project.id,
      file: GENERATED,
      rejectedAs: REJECTED,
    });
    expect(notices[0]!.issue).toMatch(/^invalid JSON: /);
    expect(existsSync(path.join(project.path, GENERATED))).toBe(false);
    expect(readFileSync(path.join(project.path, REJECTED), 'utf8')).toBe(content);
  });

  it('rejects an unknown persona, naming the item it is on', async () => {
    const { project, state, notices } = await readWith(plan({ title: 'Design pass', persona: 'designer' }));
    expect(itemTitles(state)).not.toContain('Design pass');
    expect(state.milestones.some((m) => m.code === 'M7')).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.issue).toMatch(/^milestones\.0\.items\.0\.persona: /);
    expect(existsSync(path.join(project.path, REJECTED))).toBe(true);
  });

  it('rejects a description longer than a roadmap item may be', async () => {
    const { state, notices } = await readWith(plan({ title: 'Huge', description: 'x'.repeat(10_001) }));
    expect(itemTitles(state)).not.toContain('Huge');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.issue).toMatch(/^milestones\.0\.items\.0\.description: /);
  });

  it('a rejected file is read once: the next read neither notices nor merges it again', async () => {
    const { project, notices } = await readWith(plan({ title: 'Bad', persona: 'designer' }));
    await api('GET', `/api/projects/${project.id}/roadmap`);
    expect(notices).toHaveLength(1);
  });
});

describe('brainstorm-suggestions.json from an agent', () => {
  it('rejects an unknown persona and keeps the file', async () => {
    const project = await createProject();
    await api('GET', `/api/projects/${project.id}/roadmap`);
    const notices: ProjectNotice[] = [];
    t.tickets.on('notice', (n) => notices.push(n));
    writeFileSync(
      path.join(project.path, '.emberline', 'brainstorm-suggestions.json'),
      JSON.stringify({ suggestions: [{ title: 'Dark mode', persona: 'designer' }] }),
    );
    const state: ProjectRoadmapState = (await api('GET', `/api/projects/${project.id}/roadmap`)).json();
    expect(state.suggestions.map((s) => s.title)).not.toContain('Dark mode');
    expect(notices.map((n) => [n.file, n.rejectedAs])).toEqual([
      ['.emberline/brainstorm-suggestions.json', '.emberline/brainstorm-suggestions.rejected.json'],
    ]);
    expect(notices[0]!.issue).toMatch(/^suggestions\.0\.persona: /);
  });

  it('adds valid suggestions', async () => {
    const project = await createProject();
    await api('GET', `/api/projects/${project.id}/roadmap`);
    writeFileSync(
      path.join(project.path, '.emberline', 'brainstorm-suggestions.json'),
      JSON.stringify({ suggestions: [{ title: 'Dark mode', persona: 'ui_ux', rationale: 'Night use.' }] }),
    );
    const state: ProjectRoadmapState = (await api('GET', `/api/projects/${project.id}/roadmap`)).json();
    expect(state.suggestions.find((s) => s.title === 'Dark mode')).toMatchObject({
      persona: 'ui_ux',
      rationale: 'Night use.',
    });
  });
});
