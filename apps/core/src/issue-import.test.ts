import { execFileSync } from 'node:child_process';
import type { ForgeIssueListResponse, ImportIssuesResponse, IssueSyncResponse, IssueSyncSettings, Ticket } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projects, tickets } from './db/schema.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let seen: { url: string; method: string }[];

const ghIssue = (n: number, extra: Record<string, unknown> = {}) => ({
  id: 9000 + n,
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  state: 'open',
  labels: [{ name: 'bug' }],
  html_url: `https://github.com/acme/widget/issues/${n}`,
  user: { login: 'octo' },
  updated_at: '2026-10-01T10:00:00Z',
  ...extra,
});

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A tiny GitHub: issues 1..5 (3 is a pull request, 4 has labels), anything else is 404. */
function installForge(overrides: Record<number, Record<string, unknown>> = {}) {
  t.forgeFetch.current = async (url, init) => {
    seen.push({ url, method: init?.method ?? 'GET' });
    const u = new URL(url);
    const m = /\/repos\/acme\/widget\/issues(?:\/(\d+))?$/.exec(u.pathname);
    if (!m) return reply({ message: 'nope' }, 404);
    const all: Record<number, Record<string, unknown>> = {
      1: ghIssue(1),
      2: ghIssue(2),
      3: ghIssue(3, { pull_request: { url: 'x' } }),
      4: ghIssue(4, { labels: [{ name: 'P0' }, { name: 'persona:qa' }], body: 'x'.repeat(18_100) }),
      5: ghIssue(5),
      ...overrides,
    };
    if (m[1]) {
      const issue = all[Number(m[1])];
      return issue ? reply(issue) : reply({ message: 'Not Found' }, 404);
    }
    return reply(Object.values(all));
  };
}

const post = (url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: { ...CSRF, cookie }, payload: payload as object });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
const patch = (url: string, payload: unknown) =>
  t.app.inject({ method: 'PATCH', url, headers: { ...CSRF, cookie }, payload: payload as object });

const sel = (...numbers: number[]) => ({ issues: numbers.map((n) => ({ externalId: String(9000 + n), number: n })) });

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  seen = [];
  const dir = `${t.dir}/proj`;
  execFileSync('mkdir', ['-p', dir]);
  t.db
    .insert(projects)
    .values({ id: 'p1', name: 'Demo Project', slug: 'demo-project', repoUrl: 'https://github.com/acme/widget.git', path: dir, createdAt: new Date() })
    .run();
  t.forge.updateSettings({ provider: 'auto', apiUrl: null, token: 'secret' });
  installForge();
});

afterEach(async () => {
  await t.close();
});

describe('GET /api/projects/:id/issues', () => {
  it('lists normalised issues without pull requests, passing the filters on', async () => {
    const res = await get('/api/projects/p1/issues?state=closed&labels=bug&page=2');
    expect(res.statusCode).toBe(200);
    const body = res.json<ForgeIssueListResponse>();
    expect(body.provider).toBe('github');
    expect(body.items.map((i) => i.number)).toEqual([1, 2, 4, 5]);
    expect(body.items[0]).toEqual({
      externalId: '9001',
      number: 1,
      title: 'Issue 1',
      labels: ['bug'],
      url: 'https://github.com/acme/widget/issues/1',
      author: 'octo',
      updatedAt: '2026-10-01T10:00:00Z',
      state: 'open',
      linkedTicketKey: null,
    });
    expect(body.items[0]).not.toHaveProperty('body');
    const q = new URL(seen[0]!.url).searchParams;
    expect([q.get('state'), q.get('labels'), q.get('page')]).toEqual(['closed', 'bug', '2']);
  });

  it('shows the ticket key of imported issues, with one query for the page', async () => {
    await post('/api/projects/p1/issues/import', sel(2, 5));
    const body = (await get('/api/projects/p1/issues')).json<ForgeIssueListResponse>();
    expect(body.items.map((i) => [i.number, i.linkedTicketKey])).toEqual([
      [1, null],
      [2, 'DP-1'],
      [4, null],
      [5, 'DP-2'],
    ]);
  });

  it('409 with a hint without a token, 404 for an unknown project, 400 for a bad query', async () => {
    t.forge.updateSettings({ provider: 'auto', apiUrl: null, token: null });
    const res = await get('/api/projects/p1/issues');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/token/i);
    expect((await get('/api/projects/nope/issues')).statusCode).toBe(404);
    t.forge.updateSettings({ provider: 'auto', apiUrl: null, token: 'secret' });
    expect((await get('/api/projects/p1/issues?state=bogus')).statusCode).toBe(400);
  });
});

describe('POST /api/projects/:id/issues/import', () => {
  it('creates a ticket per issue from the forge content, with the mapping and the link', async () => {
    const events: Ticket[] = [];
    t.tickets.on('ticket', (tk) => events.push(tk));
    const res = await post('/api/projects/p1/issues/import', { ...sel(1, 4), status: 'ready' });
    expect(res.statusCode).toBe(200);
    const out = res.json<ImportIssuesResponse>();
    expect(out.existing).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.created.map((c) => c.key)).toEqual(['DP-1', 'DP-2']);
    const [one, four] = out.created as [Ticket, Ticket];
    expect(one).toMatchObject({
      title: 'Issue 1',
      body: expect.stringMatching(/^Imported from github issue #1 by @octo\. .*\n\n---\nBody 1\n---\n\nSource: https:\/\/github\.com\/acme\/widget\/issues\/1$/s),
      persona: 'coder',
      priority: 1,
      status: 'ready',
      external: { source: 'github', number: 1, url: 'https://github.com/acme/widget/issues/1', state: 'open', labels: ['bug'] },
    });
    expect(four).toMatchObject({ persona: 'qa', priority: 3, external: { number: 4, labels: ['P0', 'persona:qa'] } });
    expect(four.body).toContain(`\n---\n${'x'.repeat(18_000)}…\n---\n\nSource: https://github.com/acme/widget/issues/4`);
    expect(events.map((e) => e.key)).toEqual(['DP-1', 'DP-2']);
    const row = t.db.select().from(tickets).where(eq(tickets.id, one.id)).get()!;
    expect(row).toMatchObject({ externalSource: 'github', externalId: '9001', externalNumber: 1, externalState: 'open' });
    expect(row.externalSyncedAt).toBeInstanceOf(Date);
    // Board-created tickets have no link.
    const board = await post('/api/projects/p1/tickets', { title: 'by hand' });
    expect(board.json<Ticket>().external).toBeNull();
  });

  it('defaults to backlog', async () => {
    const out = (await post('/api/projects/p1/issues/import', sel(1))).json<ImportIssuesResponse>();
    expect(out.created[0]!.status).toBe('backlog');
  });

  it('a second import returns the existing ticket and creates none, without asking the forge again', async () => {
    const first = (await post('/api/projects/p1/issues/import', sel(1, 2))).json<ImportIssuesResponse>();
    const callsAfterFirst = seen.length;
    const second = (await post('/api/projects/p1/issues/import', sel(1, 2, 5))).json<ImportIssuesResponse>();
    expect(second.existing.map((e) => e.id)).toEqual(first.created.map((c) => c.id));
    expect(second.created.map((c) => c.key)).toEqual(['DP-3']);
    expect(seen.length - callsAfterFirst).toBe(1);
    expect(t.db.select().from(tickets).all()).toHaveLength(3);
  });

  it('two concurrent imports of the same issue produce exactly one ticket', async () => {
    // Hold each request at its first issue fetch until both have arrived, so they interleave.
    const inner = t.forgeFetch.current;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.forgeFetch.current = async (url, init) => {
      if (/\/issues\/1$/.test(url) && ++arrived >= 2) release();
      if (/\/issues\/1$/.test(url)) await gate;
      return inner(url, init);
    };
    const [a, b] = await Promise.all([
      post('/api/projects/p1/issues/import', sel(1, 2)),
      post('/api/projects/p1/issues/import', sel(1, 2)),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const outs = [a.json<ImportIssuesResponse>(), b.json<ImportIssuesResponse>()];
    expect(outs.reduce((n, o) => n + o.created.length, 0)).toBe(2);
    expect(outs.reduce((n, o) => n + o.existing.length, 0)).toBe(2);
    // Both requests fetched both issues before either created: the imports really interleaved.
    expect(seen).toHaveLength(4);
    expect(t.db.select().from(tickets).all()).toHaveLength(2);
  });

  it('a unique violation from a concurrent writer resolves to the existing ticket', () => {
    const issue = { externalId: '9001', number: 1, title: 'a', body: '', labels: [], url: 'u', author: null, updatedAt: '', state: 'open' as const };
    const first = t.tickets.importIssues('p1', 'github', [issue], 'backlog');
    const lookup = vi.spyOn(t.tickets, 'linkedTickets').mockImplementationOnce(() => new Map());
    const again = t.tickets.importIssues('p1', 'github', [issue], 'backlog');
    expect(lookup).toHaveBeenCalled();
    expect(again.created).toEqual([]);
    expect(again.existing.map((e) => e.id)).toEqual(first.created.map((c) => c.id));
    expect(t.db.select().from(tickets).all()).toHaveLength(1);
  });

  it('validates every mapped ticket before creating any', () => {
    const ok = { externalId: '1', number: 1, title: 'a', body: '', labels: [], url: 'u', author: null, updatedAt: '', state: 'open' as const };
    const bad = { ...ok, externalId: '2', number: 2 };
    Object.defineProperty(bad, 'labels', { get: () => { throw new Error('boom'); } });
    expect(() => t.tickets.importIssues('p1', 'github', [ok, bad], 'backlog')).toThrow('boom');
    expect(t.db.select().from(tickets).all()).toHaveLength(0);
  });

  it('the unique index rejects a second link for the same issue', () => {
    t.tickets.importIssues('p1', 'github', [
      { externalId: '9001', number: 1, title: 'a', body: '', labels: [], url: 'u', author: null, updatedAt: '', state: 'open' },
    ], 'backlog');
    expect(() =>
      t.db
        .insert(tickets)
        .values({
          id: 'dup', projectId: 'p1', number: 99, key: 'DP-99', title: 'x', status: 'backlog', position: 1,
          externalSource: 'github', externalId: '9001', createdAt: new Date(), updatedAt: new Date(),
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('skips an issue whose fetched id does not match, and one gone from the forge', async () => {
    installForge({ 2: ghIssue(2, { id: 12345 }) });
    const out = (await post('/api/projects/p1/issues/import', sel(1, 2, 7))).json<ImportIssuesResponse>();
    expect(out.created.map((c) => c.external?.number)).toEqual([1]);
    expect(out.skipped).toEqual([
      { externalId: '9002', reason: expect.stringMatching(/does not match/) },
      { externalId: '9007', reason: expect.stringMatching(/not found/) },
    ]);
    expect(t.db.select().from(tickets).all()).toHaveLength(1);
  });

  it('skips a pull request', async () => {
    const out = (await post('/api/projects/p1/issues/import', sel(3))).json<ImportIssuesResponse>();
    expect(out.created).toEqual([]);
    expect(out.skipped).toEqual([{ externalId: '9003', reason: expect.stringMatching(/pull request/) }]);
  });

  it('validates the body: 1 to 50 issues, known status', async () => {
    expect((await post('/api/projects/p1/issues/import', { issues: [] })).statusCode).toBe(400);
    expect((await post('/api/projects/p1/issues/import', sel(...Array.from({ length: 51 }, (_, i) => i + 1)))).statusCode).toBe(400);
    expect((await post('/api/projects/p1/issues/import', { ...sel(1), status: 'done' })).statusCode).toBe(400);
    expect((await post('/api/projects/p1/issues/import', { externalIds: ['9001'] })).statusCode).toBe(400);
  });

  it('accepts exactly 50', async () => {
    const all: Record<number, Record<string, unknown>> = {};
    for (let n = 1; n <= 50; n++) all[n] = ghIssue(n);
    installForge(all);
    const out = (await post('/api/projects/p1/issues/import', sel(...Array.from({ length: 50 }, (_, i) => i + 1)))).json<ImportIssuesResponse>();
    expect(out.created).toHaveLength(50);
  });

  it('409 without a token or when the trust check fails', async () => {
    t.forge.updateSettings({ provider: 'auto', apiUrl: null, token: null });
    expect((await post('/api/projects/p1/issues/import', sel(1))).statusCode).toBe(409);
    t.forge.updateSettings({ provider: 'auto', apiUrl: null, token: 'secret' });
    // An origin the agent pointed at another host is not sent the token.
    execFileSync('git', ['-C', `${t.dir}/proj`, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', `${t.dir}/proj`, 'remote', 'add', 'origin', 'https://evil.example.org/acme/widget.git']);
    t.db.update(projects).set({ repoUrl: null }).where(eq(projects.id, 'p1')).run();
    const res = await post('/api/projects/p1/issues/import', sel(1));
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/not trusted/);
    expect(seen).toEqual([]);
  });
});

/** The settings of an issue-sync response, without the sync status. */
const settingsOf = (res: { json(): IssueSyncResponse }): IssueSyncSettings => {
  const { syncStatus: _syncStatus, ...settings } = res.json();
  return settings;
};

describe('issue-sync settings', () => {
  it('defaults, round trip and partial updates', async () => {
    const def = settingsOf(await get('/api/projects/p1/issue-sync'));
    expect(def).toEqual({ enabled: false, label: '', status: 'backlog', closeOnDone: false, commentOnProgress: true, trustedAuthors: [] });
    const set = await patch('/api/projects/p1/issue-sync', { enabled: true, label: ' emberline ', status: 'ready' });
    expect(set.statusCode).toBe(200);
    expect(settingsOf(set)).toEqual({ enabled: true, label: 'emberline', status: 'ready', closeOnDone: false, commentOnProgress: true, trustedAuthors: [] });
    const more = await patch('/api/projects/p1/issue-sync', { closeOnDone: true });
    expect(settingsOf(more)).toEqual({ enabled: true, label: 'emberline', status: 'ready', closeOnDone: true, commentOnProgress: true, trustedAuthors: [] });
    const trusted = await patch('/api/projects/p1/issue-sync', { trustedAuthors: ['octo'] });
    expect(trusted.json().trustedAuthors).toEqual(['octo']);
    expect((await patch('/api/projects/p1/issue-sync', { trustedAuthors: Array.from({ length: 51 }, (_, i) => `u${i}`) })).statusCode).toBe(400);
    await patch('/api/projects/p1/issue-sync', { trustedAuthors: [] });
    expect(settingsOf(await get('/api/projects/p1/issue-sync'))).toEqual(settingsOf(more));
  });

  it('400 when enabling without a label, and the stored settings stay untouched', async () => {
    const bad = await patch('/api/projects/p1/issue-sync', { enabled: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/label/);
    expect((await patch('/api/projects/p1/issue-sync', { enabled: true, label: '   ' })).statusCode).toBe(400);
    expect((await get('/api/projects/p1/issue-sync')).json().enabled).toBe(false);
    await patch('/api/projects/p1/issue-sync', { enabled: true, label: 'x' });
    expect((await patch('/api/projects/p1/issue-sync', { label: '' })).statusCode).toBe(400);
  });

  it('400 for an unknown status, 404 for an unknown project', async () => {
    expect((await patch('/api/projects/p1/issue-sync', { status: 'done' })).statusCode).toBe(400);
    expect((await get('/api/projects/nope/issue-sync')).statusCode).toBe(404);
    expect((await patch('/api/projects/nope/issue-sync', { label: 'x' })).statusCode).toBe(404);
  });
});
