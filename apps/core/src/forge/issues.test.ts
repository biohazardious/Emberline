import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from '../db/schema.js';
import { createTestApp, type TestApp } from '../test-utils.js';
import { IssuesClient, RateLimitError } from './issues.js';
import { ForgeService, type ParsedForgeRemote, parseForgeRemote } from './service.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body as string | undefined,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
  return { fn: fn as typeof fetch, calls };
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const gh = parseForgeRemote('git@github.com:acme/widget.git')!;
const gl = parseForgeRemote('https://gitlab.example.com/group/sub/app.git')!;
const gitea = parseForgeRemote('https://gitea.example.com/acme/widget.git')!;
const target = (remote: ParsedForgeRemote) => ({ remote, token: 'tok' });

const ghIssue = (n: number, extra: Record<string, unknown> = {}) => ({
  id: 9000 + n,
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  state: 'open',
  labels: [{ name: 'bug' }, 'plain'],
  html_url: `https://github.com/acme/widget/issues/${n}`,
  user: { login: 'octo' },
  updated_at: '2026-10-01T10:00:00Z',
  ...extra,
});

describe('IssuesClient GitHub', () => {
  it('normalises issues, excludes pull requests and sends the auth header with a 15s timeout', async () => {
    const { fn, calls } = fakeFetch(() =>
      json([ghIssue(1), ghIssue(2, { pull_request: { url: 'x' } }), ghIssue(3, { body: null, user: null })], {
        headers: { etag: 'W/"abc"', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1800000000' },
      }),
    );
    const res = await new IssuesClient({ fetch: fn }).list(target(gh), {});
    expect(res.items.map((i) => i.number)).toEqual([1, 3]);
    expect(res.items[0]).toEqual({
      externalId: '9001',
      number: 1,
      title: 'Issue 1',
      body: 'Body 1',
      labels: ['bug', 'plain'],
      url: 'https://github.com/acme/widget/issues/1',
      author: 'octo',
      updatedAt: '2026-10-01T10:00:00Z',
      state: 'open',
    });
    expect(res.items[1]).toMatchObject({ body: '', author: null });
    expect(res.etag).toBe('W/"abc"');
    expect(res.rateLimit).toEqual({ remaining: 4000, resetAt: 1800000000 * 1000, low: false });
    expect(res.nextPage).toBeNull();
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.github.com/repos/acme/widget/issues');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(url.searchParams.get('state')).toBe('open');
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('paginates through the Link header and passes labels and page', async () => {
    const { fn, calls } = fakeFetch(() =>
      json([ghIssue(1)], { headers: { link: '<https://api.github.com/x?page=3>; rel="next"' } }),
    );
    const res = await new IssuesClient({ fetch: fn }).list(target(gh), { labels: 'emberline,bug', page: 2, state: 'all' });
    expect(res.nextPage).toBe(3);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('labels')).toBe('emberline,bug');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('state')).toBe('all');
  });

  it('treats a full raw page as having a next page when no Link header is present', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ghIssue(i + 1, i === 0 ? { pull_request: {} } : {}));
    const { fn } = fakeFetch(() => json(page));
    const res = await new IssuesClient({ fetch: fn }).list(target(gh), { page: 1 });
    expect(res.items).toHaveLength(49);
    expect(res.nextPage).toBe(2);
  });

  it('uses the search API when a search term is given', async () => {
    const { fn, calls } = fakeFetch(() => json({ total_count: 1, items: [ghIssue(7)] }));
    const res = await new IssuesClient({ fetch: fn }).list(target(gh), { search: 'crash', labels: 'bug', state: 'open' });
    expect(res.items.map((i) => i.number)).toEqual([7]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/search/issues');
    const q = url.searchParams.get('q')!;
    expect(q).toContain('repo:acme/widget');
    expect(q).toContain('is:issue');
    expect(q).toContain('is:open');
    expect(q).toContain('label:"bug"');
    expect(q).toContain('crash');
  });

  it('sends If-None-Match and reports a 304 as not modified', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '4999' } }));
    const res = await new IssuesClient({ fetch: fn }).list(target(gh), { etag: 'W/"abc"' });
    expect(calls[0]!.headers['If-None-Match']).toBe('W/"abc"');
    expect(res).toMatchObject({ notModified: true, items: [], nextPage: null, etag: 'W/"abc"' });
    expect(res.rateLimit.remaining).toBe(4999);
  });

  it('flags low remaining quota', async () => {
    const { fn } = fakeFetch(() => json([], { headers: { 'x-ratelimit-remaining': '49', 'x-ratelimit-reset': '1800000000' } }));
    const res = await new IssuesClient({ fetch: fn }).list(target(gh), {});
    expect(res.rateLimit.low).toBe(true);
    const ok = fakeFetch(() => json([], { headers: { 'x-ratelimit-remaining': '50' } }));
    expect((await new IssuesClient({ fetch: ok.fn }).list(target(gh), {})).rateLimit.low).toBe(false);
  });

  it('throws RateLimitError on 403/429 with retry-after or x-ratelimit-reset', async () => {
    const now = 1_700_000_000_000;
    const a = fakeFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    const err = await new IssuesClient({ fetch: a.fn, now: () => now }).list(target(gh), {}).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetAt).toBe(now + 120_000);
    expect(err.statusCode).toBe(429);

    const b = fakeFetch(
      () => new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000500' } }),
    );
    const err2 = await new IssuesClient({ fetch: b.fn, now: () => now }).list(target(gh), {}).catch((e) => e);
    expect(err2).toBeInstanceOf(RateLimitError);
    expect(err2.resetAt).toBe(1_700_000_500_000);
  });

  it('hints at the token scope on 401/403 without rate-limit headers', async () => {
    for (const status of [401, 403]) {
      const { fn } = fakeFetch(() => new Response('Resource not accessible', { status }));
      const err = await new IssuesClient({ fetch: fn }).list(target(gh), {}).catch((e) => e);
      expect(err).not.toBeInstanceOf(RateLimitError);
      expect(err.statusCode).toBe(502);
      expect(err.code).toBe('forge_error');
      expect(err.message).toContain('the forge token needs issue read/write access');
    }
  });

  it('maps other provider errors to 502 forge_error with the first 300 chars', async () => {
    const { fn } = fakeFetch(() => new Response('x'.repeat(500), { status: 500 }));
    const err = await new IssuesClient({ fetch: fn }).list(target(gh), {}).catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('forge_error');
    expect(err.message).toContain('x'.repeat(300));
    expect(err.message).not.toContain('x'.repeat(301));
  });

  it('maps a timeout to 504', async () => {
    const { fn } = fakeFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const err = await new IssuesClient({ fetch: fn }).list(target(gh), {}).catch((e) => e);
    expect(err.statusCode).toBe(504);
    expect(err.code).toBe('forge_timeout');
  });

  it('gets one issue by number, comments and closes', async () => {
    const { fn, calls } = fakeFetch((c) =>
      c.method === 'GET' ? json(ghIssue(5)) : c.method === 'POST' ? json({ id: 1 }, { status: 201 }) : json(ghIssue(5, { state: 'closed' })),
    );
    const client = new IssuesClient({ fetch: fn });
    expect((await client.get(target(gh), 5)).externalId).toBe('9005');
    await client.comment(target(gh), 5, 'hello');
    await client.close(target(gh), 5);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/widget/issues/5');
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/acme/widget/issues/5/comments' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ body: 'hello' });
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/acme/widget/issues/5' });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ state: 'closed' });
    for (const c of calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a pull request as a single issue', async () => {
    const { fn } = fakeFetch(() => json(ghIssue(6, { pull_request: {} })));
    const err = await new IssuesClient({ fetch: fn }).get(target(gh), 6).catch((e) => e);
    expect(err.statusCode).toBe(404);
  });

  it('resolves external ids by scanning list pages, bounded', async () => {
    const { fn, calls } = fakeFetch((c) => {
      const page = Number(new URL(c.url).searchParams.get('page'));
      return json(page === 1 ? [ghIssue(1), ghIssue(2)] : [ghIssue(3)], {
        headers: page === 1 ? { link: '<u?page=2>; rel="next"' } : {},
      });
    });
    const found = await new IssuesClient({ fetch: fn }).findByExternalIds(target(gh), ['9003', '9001', '1']);
    expect(found.map((i) => i.number)).toEqual([1, 3]);
    expect(calls).toHaveLength(2);
  });
});

describe('IssuesClient GitLab', () => {
  const glIssue = (id: number, iid: number, extra: Record<string, unknown> = {}) => ({
    id,
    iid,
    title: `GL ${iid}`,
    description: `Desc ${iid}`,
    state: 'opened',
    labels: ['emberline', 'P1'],
    web_url: `https://gitlab.example.com/group/sub/app/-/issues/${iid}`,
    author: { username: 'gl-user' },
    updated_at: '2026-10-02T10:00:00Z',
    ...extra,
  });

  it('uses iid as number and id as externalId, encodes the project path and reads x-next-page', async () => {
    const { fn, calls } = fakeFetch(() =>
      json([glIssue(555, 12), glIssue(556, 13, { state: 'closed', description: null })], {
        headers: { 'x-next-page': '2', 'ratelimit-remaining': '10', 'ratelimit-reset': '1800000000', etag: '"e1"' },
      }),
    );
    const res = await new IssuesClient({ fetch: fn }).list(target(gl), { state: 'open', labels: 'emberline', search: 'foo' });
    expect(res.items[0]).toEqual({
      externalId: '555',
      number: 12,
      title: 'GL 12',
      body: 'Desc 12',
      labels: ['emberline', 'P1'],
      url: 'https://gitlab.example.com/group/sub/app/-/issues/12',
      author: 'gl-user',
      updatedAt: '2026-10-02T10:00:00Z',
      state: 'open',
    });
    expect(res.items[1]).toMatchObject({ state: 'closed', body: '' });
    expect(res.nextPage).toBe(2);
    expect(res.rateLimit).toMatchObject({ remaining: 10, low: true });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v4/projects/group%2Fsub%2Fapp/issues');
    expect(url.searchParams.get('state')).toBe('opened');
    expect(url.searchParams.get('search')).toBe('foo');
    expect(url.searchParams.get('labels')).toBe('emberline');
    expect(calls[0]!.headers['PRIVATE-TOKEN']).toBe('tok');
  });

  it('comments via notes and closes with state_event', async () => {
    const { fn, calls } = fakeFetch((c) => json(c.method === 'GET' ? glIssue(1, 4) : {}, { status: c.method === 'POST' ? 201 : 200 }));
    const client = new IssuesClient({ fetch: fn });
    await client.comment(target(gl), 4, 'hi');
    await client.close(target(gl), 4);
    await client.get(target(gl), 4);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/issues/4/notes' });
    expect(calls[1]).toMatchObject({ method: 'PUT', url: 'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/issues/4' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ state_event: 'close' });
    expect(calls[2]!.method).toBe('GET');
  });

  it('treats a 403 with retry-after as a rate limit', async () => {
    const { fn } = fakeFetch(() => new Response('', { status: 403, headers: { 'retry-after': '30' } }));
    await expect(new IssuesClient({ fetch: fn }).list(target(gl), {})).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('IssuesClient Gitea', () => {
  it('mirrors the GitHub paths, asks for type=issues and uses the token header', async () => {
    const { fn, calls } = fakeFetch(() =>
      json([ghIssue(1, { html_url: 'https://gitea.example.com/acme/widget/issues/1', pull_request: null }), ghIssue(2, { pull_request: { merged: false } })]),
    );
    const res = await new IssuesClient({ fetch: fn }).list(target(gitea), { search: 'x', labels: 'bug' });
    expect(res.items.map((i) => i.number)).toEqual([1]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/repos/acme/widget/issues');
    expect(url.searchParams.get('type')).toBe('issues');
    expect(url.searchParams.get('q')).toBe('x');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(calls[0]!.headers.Authorization).toBe('token tok');
  });

  it('comments and closes through the GitHub-shaped endpoints', async () => {
    const { fn, calls } = fakeFetch(() => json({}, { status: 201 }));
    const client = new IssuesClient({ fetch: fn });
    await client.comment(target(gitea), 3, 'yo');
    await client.close(target(gitea), 3);
    expect(calls[0]!.url).toBe('https://gitea.example.com/api/v1/repos/acme/widget/issues/3/comments');
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: 'https://gitea.example.com/api/v1/repos/acme/widget/issues/3' });
  });
});

describe('ForgeService.projectRemote', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
    delete process.env.EMBERLINE_FORGE_ALLOWED_HOSTS;
  });

  function addProject(id: string, repoUrl: string | null, origin?: string) {
    const dir = `${t.dir}/${id}`;
    execFileSync('mkdir', ['-p', dir]);
    if (origin !== undefined) {
      execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
      if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
    }
    t.db.insert(projects).values({ id, name: id, slug: id, repoUrl, path: dir, createdAt: new Date() }).run();
  }
  const configure = (forge: ForgeService, token: string | null, apiUrl: string | null = null) =>
    forge.updateSettings({ provider: 'auto', apiUrl, token });

  it('reads origin from the main workspace and returns remote plus token', async () => {
    addProject('p1', null, 'git@github.com:acme/widget.git');
    const forge = new ForgeService(t.db, t.runs);
    configure(forge, 'secret');
    const target = await forge.projectRemote('p1');
    expect(target.token).toBe('secret');
    expect(target.remote).toMatchObject({ provider: 'github', repoPath: 'acme/widget' });
  });

  it('falls back to projects.repoUrl when the workspace has no origin', async () => {
    addProject('p2', 'https://gitlab.example.com/g/s/app.git', '');
    const forge = new ForgeService(t.db, t.runs);
    configure(forge, 'secret');
    const target = await forge.projectRemote('p2');
    expect(target.remote).toMatchObject({ provider: 'gitlab', repoPath: 'g/s/app' });
  });

  it('409 with a hint when the token or the remote is missing', async () => {
    addProject('p3', null, 'git@github.com:acme/widget.git');
    addProject('p4', null, '');
    const forge = new ForgeService(t.db, t.runs);
    await expect(forge.projectRemote('p3')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/token/i) });
    configure(forge, 'secret');
    await expect(forge.projectRemote('p4')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/remote/i) });
    await expect(forge.projectRemote('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('applies the trust check to an untrusted host', async () => {
    addProject('p5', null, 'https://evil.example.org/acme/widget.git');
    const forge = new ForgeService(t.db, t.runs);
    configure(forge, 'secret');
    // origin host differs from projects.repoUrl (null), so it is not trusted.
    await expect(forge.projectRemote('p5')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not trusted/i) });
  });
});

describe('ForgeService fetch plumbing', () => {
  it('uses the injected fetch with a timeout signal for PR calls', async () => {
    const t = await createTestApp();
    try {
      const calls: Call[] = [];
      const fn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET', headers: {}, body: undefined, signal: init?.signal });
        return json({ state: 'success' });
      }) as typeof fetch;
      const forge = new ForgeService(t.db, t.runs, { fetch: fn });
      const res = await (forge as unknown as {
        fetchGithubCiStatus(r: ParsedForgeRemote, tok: string, sha: string): Promise<string>;
      }).fetchGithubCiStatus(gh, 'tok', 'abc');
      expect(res).toBe('success');
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await t.close();
    }
  });
});
