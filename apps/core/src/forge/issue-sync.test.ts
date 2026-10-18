import { execFileSync } from 'node:child_process';
import { IssueSyncSettings, type Ticket } from '@emberline/protocol';
import { and, eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeIssueSync } from '../db/project-settings.js';
import { projects, runEvents, runs, tickets } from '../db/schema.js';
import { PRUNE_PROTECTED_EVENT_TYPES } from '../runs/service.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from '../test-utils.js';
import { ISSUE_SYNC_INTERVAL_MS, IssueSyncService, SYNC_TICK_REQUEST_CAP } from './issue-sync.js';

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeRepo {
  issues: Record<string, unknown>[];
  /** Bumped on every change; the ETag follows it. */
  version: number;
  /** Extra response headers for list calls (rate limit). */
  headers?: Record<string, string>;
  /** Replaces the list answer, e.g. a 429. */
  respond?: () => Response;
}

let t: TestApp;
let calls: Call[];
let repos: Map<string, FakeRepo>;
let failComments: boolean;
let failClose: boolean;
let clock: number;
let logs: string[];
let sync: IssueSyncService;

const T0 = Date.parse('2026-10-18T12:00:00Z');

const ghIssue = (repo: string, n: number, extra: Record<string, unknown> = {}) => ({
  id: 9000 + n,
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  state: 'open',
  labels: [{ name: 'emberline' }],
  html_url: `https://github.com/acme/${repo}/issues/${n}`,
  user: { login: 'stranger' },
  updated_at: '2026-10-01T10:00:00Z',
  ...extra,
});

const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

function installForge() {
  t.forgeFetch.current = async (raw, init) => {
    const url = new URL(raw);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { method: init?.method ?? 'GET', url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const list = /^\/repos\/acme\/([^/]+)\/issues$/.exec(url.pathname);
    if (list && call.method === 'GET') {
      const repo = repos.get(list[1]!);
      if (!repo) return reply({ message: 'Not Found' }, 404);
      if (repo.respond) return repo.respond();
      const etag = `W/"${list[1]}-${repo.version}"`;
      const extra = { etag, ...repo.headers };
      if (headers['If-None-Match'] === etag) return reply(null, 304, extra);
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const rows = repo.issues.slice((page - 1) * per, page * per);
      const more = repo.issues.length > page * per;
      return reply(rows, 200, more ? { ...extra, link: `<https://api.github.com/repos/acme/${list[1]}/issues?page=${page + 1}>; rel="next"` } : extra);
    }
    if (/\/issues\/\d+\/comments$/.test(url.pathname) && call.method === 'POST') {
      return failComments ? reply({ message: 'boom' }, 500) : reply({ id: 1 }, 201);
    }
    if (/\/issues\/\d+$/.test(url.pathname) && call.method === 'PATCH') {
      return failClose ? reply({ message: 'nope' }, 500) : reply({ state: 'closed' });
    }
    if (/\/pulls$/.test(url.pathname) && call.method === 'POST') {
      return reply({ number: 7, title: 'PR', html_url: 'https://github.com/acme/widget/pull/7', state: 'open', head: { sha: 'abc' } }, 201);
    }
    if (/\/commits\/[^/]+\/status$/.test(url.pathname)) return reply({ state: 'success' });
    return reply({ message: 'unexpected' }, 404);
  };
}

function addProject(id: string, repo: string, settings: Partial<IssueSyncSettings> | null = {}) {
  const dir = `${t.dir}/${id}`;
  execFileSync('mkdir', ['-p', dir]);
  t.db
    .insert(projects)
    .values({ id, name: `Proj ${id}`, slug: id, repoUrl: `https://github.com/acme/${repo}.git`, path: dir, createdAt: new Date() })
    .run();
  if (settings) writeIssueSync(t.db, id, IssueSyncSettings.parse({ enabled: true, label: 'emberline', ...settings }));
  if (!repos.has(repo)) repos.set(repo, { issues: [], version: 1 });
  return repos.get(repo)!;
}

const listCalls = () => calls.filter((c) => c.method === 'GET' && /\/issues$/.test(c.url.pathname));
const ticketsOf = (projectId: string): Ticket[] => t.tickets.list(projectId);
const newSync = () => {
  const s = new IssueSyncService(t.db, t.tickets, t.runs, t.forge, { now: () => clock, log: (m) => logs.push(m) });
  s.start();
  return s;
};

beforeEach(async () => {
  t = await createTestApp();
  // The server's own instance would answer the same notes; the tests drive their own.
  t.issueSync.stop();
  calls = [];
  repos = new Map();
  failComments = false;
  failClose = false;
  clock = T0;
  logs = [];
  t.forge.updateSettings({ provider: 'auto', apiUrl: null, token: 'secret' });
  installForge();
  sync = newSync();
});

afterEach(async () => {
  sync.stop();
  vi.useRealTimers();
  await t.close();
});

describe('label sync', () => {
  it('imports unlinked open issues with the label, sorted by updated, 100 per page', async () => {
    const repo = addProject('p1', 'widget');
    repo.issues = [ghIssue('widget', 1), ghIssue('widget', 2)];
    await sync.tick();
    expect(ticketsOf('p1').map((tk) => [tk.title, tk.external?.number])).toEqual(
      expect.arrayContaining([
        ['Issue 1', 1],
        ['Issue 2', 2],
      ]),
    );
    const q = listCalls()[0]!.url.searchParams;
    expect([q.get('labels'), q.get('state'), q.get('sort'), q.get('direction'), q.get('per_page')]).toEqual([
      'emberline',
      'all',
      'updated',
      'desc',
      '100',
    ]);
    // A second tick with the same content imports nothing new.
    await sync.tick();
    expect(ticketsOf('p1')).toHaveLength(2);
  });

  it('untrusted authors land in backlog; trusted ones (any case) in the configured status', async () => {
    const repo = addProject('p1', 'widget', { status: 'ready', trustedAuthors: ['Octo'] });
    repo.issues = [ghIssue('widget', 1, { user: { login: 'oCTO' } }), ghIssue('widget', 2, { user: { login: 'mallory' } }), ghIssue('widget', 3, { user: null })];
    await sync.tick();
    const byNumber = new Map(ticketsOf('p1').map((tk) => [tk.external?.number, tk.status]));
    expect(Object.fromEntries(byNumber)).toEqual({ 1: 'ready', 2: 'backlog', 3: 'backlog' });
  });

  it('reads at most 2 pages per project', async () => {
    const repo = addProject('p1', 'widget');
    repo.issues = Array.from({ length: 250 }, (_, i) => ghIssue('widget', i + 1));
    await sync.tick();
    expect(listCalls().map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(ticketsOf('p1')).toHaveLength(200);
  });

  it('sends the stored ETag; a 304 costs one request and changes nothing', async () => {
    const repo = addProject('p1', 'widget');
    repo.issues = [ghIssue('widget', 1)];
    await sync.tick();
    expect(listCalls()[0]!.headers['If-None-Match']).toBeUndefined();
    const before = ticketsOf('p1');
    clock += ISSUE_SYNC_INTERVAL_MS;
    await sync.tick();
    expect(listCalls()).toHaveLength(2);
    expect(listCalls()[1]!.headers['If-None-Match']).toBe('W/"widget-1"');
    expect(ticketsOf('p1')).toEqual(before);
    expect(sync.status('p1').lastSyncAt).toBe(new Date(clock).toISOString());
    // A change on the forge is picked up again.
    repo.issues.push(ghIssue('widget', 2));
    repo.version++;
    await sync.tick();
    expect(ticketsOf('p1')).toHaveLength(2);
  });

  it('a new label invalidates the ETag', async () => {
    const repo = addProject('p1', 'widget');
    repo.issues = [ghIssue('widget', 1)];
    await sync.tick();
    writeIssueSync(t.db, 'p1', IssueSyncSettings.parse({ enabled: true, label: 'other' }));
    await sync.tick();
    expect(listCalls()[1]!.headers['If-None-Match']).toBeUndefined();
    expect(listCalls()[1]!.url.searchParams.get('labels')).toBe('other');
  });

  it('a closed issue updates state and labels on its ticket, never moving or deleting it', async () => {
    const repo = addProject('p1', 'widget');
    repo.issues = [ghIssue('widget', 1)];
    await sync.tick();
    const [ticket] = ticketsOf('p1');
    t.tickets.update(ticket!.id, { status: 'in_progress' });
    repo.issues = [ghIssue('widget', 1, { state: 'closed', labels: [{ name: 'emberline' }, { name: 'wontfix' }] }), ghIssue('widget', 2, { state: 'closed' })];
    repo.version++;
    clock += 1000;
    await sync.tick();
    const after = ticketsOf('p1');
    // The closed issue that was never imported is not imported.
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: ticket!.id, status: 'in_progress', external: { state: 'closed', labels: ['emberline', 'wontfix'] } });
    const row = t.db.select().from(tickets).where(eq(tickets.id, ticket!.id)).get()!;
    expect(row.externalSyncedAt?.getTime()).toBe(clock);
  });

  it('skips disabled projects and records errors per project without stopping the others', async () => {
    addProject('p0', 'off', { enabled: false });
    addProject('p1', 'gone');
    repos.delete('gone');
    const ok = addProject('p2', 'widget');
    ok.issues = [ghIssue('widget', 1)];
    await sync.tick();
    expect(listCalls().some((c) => c.url.pathname.includes('/off/'))).toBe(false);
    expect(sync.status('p1').lastError).toMatch(/404/);
    expect(sync.status('p1').lastSyncAt).toBeNull();
    expect(ticketsOf('p2')).toHaveLength(1);
    expect(sync.status('p2')).toEqual({ lastSyncAt: new Date(T0).toISOString(), lastError: null, pausedUntil: null });
  });
});

describe('budget', () => {
  it('pauses all sync below 50 remaining requests until the reset, logged once, then resumes', async () => {
    const reset = T0 + 30 * 60_000;
    const a = addProject('p1', 'a');
    a.headers = { 'x-ratelimit-remaining': '49', 'x-ratelimit-reset': String(reset / 1000) };
    a.issues = [ghIssue('a', 1)];
    addProject('p2', 'b');
    await sync.tick();
    // The answer that reported the low quota is still used; the next project waits.
    expect(ticketsOf('p1')).toHaveLength(1);
    expect(listCalls()).toHaveLength(1);
    expect(sync.status('p2').pausedUntil).toBe(new Date(reset).toISOString());
    clock = reset - 1000;
    await sync.tick();
    await sync.tick();
    expect(listCalls()).toHaveLength(1);
    expect(logs.filter((l) => /paused/.test(l))).toHaveLength(1);
    a.headers = { 'x-ratelimit-remaining': '4000' };
    clock = reset + 1;
    await sync.tick();
    expect(listCalls().length).toBe(3);
    expect(sync.status('p1').pausedUntil).toBeNull();
  });

  it('a 429 pauses all sync until the reset', async () => {
    const paused = T0 + 120_000;
    const a = addProject('p1', 'a');
    a.respond = () => reply({ message: 'slow down' }, 429, { 'x-ratelimit-reset': String(paused / 1000) });
    addProject('p2', 'b');
    await sync.tick();
    expect(listCalls()).toHaveLength(1);
    expect(sync.status('p2').pausedUntil).toBe(new Date(paused).toISOString());
    expect(sync.status('p1').lastError).toMatch(/rate limit/);
    expect(logs.filter((l) => /paused/.test(l))).toHaveLength(1);
    clock = paused - 1;
    await sync.tick();
    expect(listCalls()).toHaveLength(1);
    a.respond = undefined;
    clock = paused + 1;
    await sync.tick();
    expect(listCalls()).toHaveLength(3);
  });

  it(`never makes more than ${SYNC_TICK_REQUEST_CAP} requests per tick across projects, and continues where it stopped`, async () => {
    for (let i = 10; i < 25; i++) {
      const repo = addProject(`p${i}`, `r${i}`);
      repo.issues = Array.from({ length: 101 }, (_, n) => ghIssue(`r${i}`, n + 1));
    }
    await sync.tick();
    expect(listCalls()).toHaveLength(SYNC_TICK_REQUEST_CAP);
    const first = new Set(listCalls().map((c) => c.url.pathname));
    expect(first.size).toBe(10);
    calls = [];
    await sync.tick();
    expect(listCalls()).toHaveLength(SYNC_TICK_REQUEST_CAP);
    const second = listCalls().map((c) => c.url.pathname);
    // The five projects left out last time come first.
    for (const p of second.slice(0, 10)) expect(first.has(p)).toBe(false);
  });
});

describe('poller lifecycle and status', () => {
  it('ticks every 10 minutes on an unref’d interval until stopped', async () => {
    sync.stop();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = new IssueSyncService(t.db, t.tickets, t.runs, t.forge, { now: () => clock });
    const tick = vi.spyOn(s, 'tick').mockResolvedValue();
    s.start();
    s.start();
    vi.advanceTimersByTime(ISSUE_SYNC_INTERVAL_MS - 1);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ISSUE_SYNC_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    s.stop();
    vi.advanceTimersByTime(ISSUE_SYNC_INTERVAL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('GET /api/projects/:id/issue-sync carries the sync status', async () => {
    const cookie = await setupAndLogin(t.app);
    const repo = addProject('p1', 'widget');
    repo.issues = [ghIssue('widget', 1)];
    const get = async () => (await t.app.inject({ method: 'GET', url: '/api/projects/p1/issue-sync', headers: { cookie } })).json();
    expect((await get()).syncStatus).toEqual({ lastSyncAt: null, lastError: null, pausedUntil: null });
    await t.issueSync.tick();
    const body = await get();
    expect(body).toMatchObject({ enabled: true, label: 'emberline' });
    expect(body.syncStatus.lastSyncAt).toEqual(expect.any(String));
    expect(body.syncStatus.lastError).toBeNull();
    const patched = await t.app.inject({ method: 'PATCH', url: '/api/projects/p1/issue-sync', headers: { ...CSRF, cookie }, payload: { status: 'ready' } });
    expect(patched.json().syncStatus.lastSyncAt).toBe(body.syncStatus.lastSyncAt);
  });
});

describe('write-back', () => {
  const now = new Date();

  /** p1 with issue #5 imported as a ticket, and a run of that ticket. */
  function linkedRun(settings: Partial<IssueSyncSettings> = {}, runId = 'run-1') {
    addProject('p1', 'widget', settings);
    const { created } = t.tickets.importIssues(
      'p1',
      'github',
      [{ externalId: '9005', number: 5, title: 'Five', body: 'b', labels: [], url: 'https://github.com/acme/widget/issues/5', author: 'x', updatedAt: '', state: 'open' }],
      'backlog',
    );
    const ticket = created[0]!;
    t.db
      .insert(runs)
      .values({ id: runId, projectId: 'p1', ticketId: ticket.id, agent: 'claude', state: 'done', worktreePath: `${t.dir}/none`, branch: 'emberline/run-1', hookTokenHash: 'h', stateChangedAt: now, createdAt: now, title: 'Five' })
      .run();
    return ticket;
  }

  const comments = () => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/comments'));
  const notes = () =>
    t.db
      .select()
      .from(runEvents)
      .where(like(runEvents.type, 'issue_%'))
      .all()
      .map((e) => ({ type: e.type, payload: e.payload }));

  it('comments once when a PR is created, also after repeats and a restart', async () => {
    const ticket = linkedRun();
    await t.forge.createPullRequest('run-1', {});
    await sync.settled();
    expect(comments().map((c) => [c.url.pathname, c.body])).toEqual([
      ['/repos/acme/widget/issues/5/comments', { body: `Emberline opened https://github.com/acme/widget/pull/7 for ${ticket.key}.` }],
    ]);
    expect(notes()).toEqual([{ type: 'issue_commented', payload: { kind: 'pr', ticketKey: ticket.key, ref: 'https://github.com/acme/widget/pull/7' } }]);
    await t.forge.createPullRequest('run-1', {});
    await sync.settled();
    expect(comments()).toHaveLength(1);
    sync.stop();
    sync = newSync();
    await t.forge.createPullRequest('run-1', {});
    await sync.settled();
    expect(comments()).toHaveLength(1);
  });

  it('comments once per merged sha, saying the merge is local', async () => {
    const ticket = linkedRun();
    t.runs.note('run-1', 'merged_to_main', { summary: 's', commitSha: 'abc1234', branch: 'main' });
    t.runs.note('run-1', 'merged_to_main', { summary: 's', commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    expect(comments().map((c) => c.body)).toEqual([
      { body: `Emberline merged ${ticket.key} into \`main\` locally (abc1234). It reaches the remote when the branch is pushed.` },
    ]);
    sync.stop();
    sync = newSync();
    t.runs.note('run-1', 'merged_to_main', { summary: 's', commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    expect(comments()).toHaveLength(1);
    t.runs.note('run-1', 'merged_to_main', { summary: 's', commitSha: 'def5678', branch: 'main' });
    await sync.settled();
    expect(comments()).toHaveLength(2);
  });

  it('leaves the parenthesis out when the sha is unknown, and falls back to the project branch', async () => {
    const ticket = linkedRun();
    t.runs.note('run-1', 'merged_to_main', { summary: 's' });
    await sync.settled();
    expect(comments()[0]!.body).toEqual({
      body: `Emberline merged ${ticket.key} into \`main\` locally. It reaches the remote when the branch is pushed.`,
    });
  });

  it('stays quiet with commentOnProgress off and for tickets without an issue', async () => {
    linkedRun({ commentOnProgress: false });
    t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    const plain = t.tickets.create('p1', { title: 'Board ticket' });
    t.db
      .insert(runs)
      .values({ id: 'run-2', projectId: 'p1', ticketId: plain.id, agent: 'claude', state: 'done', worktreePath: '/x', hookTokenHash: 'h', stateChangedAt: now, createdAt: now, title: 'B' })
      .run();
    writeIssueSync(t.db, 'p1', IssueSyncSettings.parse({ enabled: true, label: 'emberline' }));
    t.runs.note('run-2', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    expect(comments()).toEqual([]);
    expect(notes()).toEqual([]);
  });

  it('a failed comment is noted, never thrown, and a later note retries', async () => {
    const ticket = linkedRun();
    failComments = true;
    expect(() => t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' })).not.toThrow();
    await sync.settled();
    expect(notes()).toEqual([
      { type: 'issue_comment_failed', payload: { kind: 'merge', ticketKey: ticket.key, ref: 'abc1234', message: expect.stringMatching(/500/) } },
    ]);
    failComments = false;
    t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    expect(notes().map((n) => n.type)).toEqual(['issue_comment_failed', 'issue_commented']);
  });

  it('closeOnDone closes the issue with a comment once the merged ticket is Done', async () => {
    const ticket = linkedRun({ closeOnDone: true, commentOnProgress: false });
    // Done without a merge: nothing to close yet.
    t.tickets.update(ticket.id, { status: 'done' });
    await sync.settled();
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    t.tickets.update(ticket.id, { status: 'review' });
    t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    t.tickets.update(ticket.id, { status: 'done' });
    await sync.settled();
    t.tickets.update(ticket.id, { priority: 2 });
    await sync.settled();
    const closes = calls.filter((c) => c.method === 'PATCH');
    expect(closes.map((c) => [c.url.pathname, c.body])).toEqual([['/repos/acme/widget/issues/5', { state: 'closed' }]]);
    expect(comments().map((c) => c.body)).toEqual([{ body: `Emberline closed this issue because ${ticket.key} is done.` }]);
    expect(notes()).toContainEqual({ type: 'issue_closed', payload: { ticketKey: ticket.key, ref: 'abc1234' } });
    expect(t.tickets.get(ticket.id).external?.state).toBe('closed');
  });

  it('a failed close is noted once and not retried', async () => {
    const ticket = linkedRun({ closeOnDone: true, commentOnProgress: false });
    failClose = true;
    t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    expect(() => t.tickets.update(ticket.id, { status: 'done' })).not.toThrow();
    await sync.settled();
    t.tickets.update(ticket.id, { priority: 2 });
    await sync.settled();
    sync.stop();
    sync = newSync();
    t.tickets.update(ticket.id, { priority: 3 });
    await sync.settled();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(notes()).toEqual([{ type: 'issue_close_failed', payload: { ticketKey: ticket.key, ref: 'abc1234', message: expect.stringMatching(/500/) } }]);
    expect(comments()).toEqual([]);
    expect(t.tickets.get(ticket.id)).toMatchObject({ status: 'done', external: { state: 'open' } });
  });

  it('never writes to an issue of another repository than the one it was imported from', async () => {
    const ticket = linkedRun();
    t.db.update(projects).set({ repoUrl: 'https://github.com/acme/other.git' }).where(eq(projects.id, 'p1')).run();
    t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    expect(comments()).toEqual([]);
    expect(notes()).toEqual([{ type: 'issue_comment_failed', payload: { kind: 'merge', ticketKey: ticket.key, ref: 'abc1234', message: expect.stringMatching(/repository/) } }]);
  });

  it('write-back notes survive event pruning and do not become the run’s last event', async () => {
    for (const type of ['issue_commented', 'issue_closed', 'issue_close_failed']) expect(PRUNE_PROTECTED_EVENT_TYPES).toContain(type);
    linkedRun();
    t.runs.note('run-1', 'merged_to_main', { commitSha: 'abc1234', branch: 'main' });
    await sync.settled();
    expect(t.db.select().from(runs).where(and(eq(runs.id, 'run-1'))).get()!.lastEvent).toBe('merged_to_main');
  });
});
