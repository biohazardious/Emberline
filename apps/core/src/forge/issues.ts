import type { ForgeIssue, ForgeProvider } from '@emberline/protocol';
import { HttpError, notFound } from '../errors.js';
import type { ParsedForgeRemote } from './service.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Every forge request is cut off after this long. */
export const FORGE_FETCH_TIMEOUT_MS = 15_000;
/** Issues per list page (GitHub `per_page`, GitLab `per_page`, Gitea `limit`). */
export const ISSUES_PAGE_SIZE = 50;
/** The most a provider returns per page (GitHub and GitLab cap `per_page` at 100). */
export const ISSUES_PAGE_SIZE_MAX = 100;
/** Below this many remaining requests the caller should stop syncing until the reset time. */
export const RATE_LIMIT_LOW_WATER = 50;

const PROVIDER_NAMES: Record<ForgeProvider, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea' };
export const TOKEN_SCOPE_HINT = 'the forge token needs issue read/write access';

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function timeoutError(): HttpError {
  return new HttpError(504, 'forge_timeout', `the forge did not answer within ${FORGE_FETCH_TIMEOUT_MS / 1000} seconds`);
}

/**
 * fetch with the shared 15 s timeout; a timeout becomes a 504. Redirects are not followed (a
 * GitLab PRIVATE-TOKEN header would survive a cross-origin redirect), a 3xx becomes a 502.
 */
export async function forgeFetch(fetchFn: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FORGE_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (isAbort(err)) throw timeoutError();
    throw err;
  }
  if (res.status >= 300 && res.status < 400 && res.status !== 304) {
    throw new HttpError(502, 'forge_error', 'forge API redirected; set the API URL');
  }
  return res;
}

/** Reads a JSON body; the request's timeout also covers the body, so an abort here is a 504 too. */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbort(err)) throw timeoutError();
    throw err;
  }
}

export interface ForgeTarget {
  remote: ParsedForgeRemote;
  token: string;
}

export interface RateLimitState {
  /** Requests left in the current window, when the forge says. */
  remaining: number | null;
  /** Epoch ms when the window resets, when the forge says. */
  resetAt: number | null;
  /** True when `remaining` is below the low-water mark. */
  low: boolean;
}

/** Thrown on 429, or 403 with retry-after / an exhausted quota: stop all forge sync until `resetAt`. */
export class RateLimitError extends HttpError {
  constructor(
    readonly resetAt: number,
    detail: string,
  ) {
    super(429, 'forge_rate_limited', `forge rate limit reached; retry after ${new Date(resetAt).toISOString()}${detail ? `: ${detail}` : ''}`);
    this.name = 'RateLimitError';
  }
}

export interface IssueListQuery {
  state?: 'open' | 'closed' | 'all';
  labels?: string;
  search?: string;
  page?: number;
  /** Issues per page, at most {@link ISSUES_PAGE_SIZE_MAX}; {@link ISSUES_PAGE_SIZE} by default. */
  perPage?: number;
  /** ETag from an earlier identical request; a 304 comes back as `notModified`. */
  etag?: string | null;
}

export interface IssueListResult {
  items: ForgeIssue[];
  nextPage: number | null;
  notModified: boolean;
  etag: string | null;
  rateLimit: RateLimitState;
}

export interface IssuesClientOptions {
  fetch?: FetchLike;
  now?: () => number;
}

function authHeaders(provider: ForgeProvider, token: string): Record<string, string> {
  if (provider === 'gitlab') return { 'PRIVATE-TOKEN': token, 'User-Agent': 'Emberline-Core' };
  if (provider === 'gitea') return { Authorization: `token ${token}`, 'User-Agent': 'Emberline-Core' };
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'Emberline-Core' };
}

function numberHeader(res: Response, ...names: string[]): number | null {
  for (const name of names) {
    const raw = res.headers.get(name);
    if (raw === null || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readRateLimit(res: Response): RateLimitState {
  const remaining = numberHeader(res, 'x-ratelimit-remaining', 'ratelimit-remaining');
  const reset = numberHeader(res, 'x-ratelimit-reset', 'ratelimit-reset');
  return {
    remaining,
    resetAt: reset === null ? null : reset * 1000,
    low: remaining !== null && remaining < RATE_LIMIT_LOW_WATER,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const l of raw) {
    if (typeof l === 'string') out.push(l);
    else if (l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string') out.push((l as { name: string }).name);
  }
  return out;
}

type Raw = Record<string, unknown>;

/** GitHub and Gitea share a shape. Returns null for pull requests. */
function normaliseGithubLike(raw: Raw): ForgeIssue | null {
  if (raw.pull_request) return null;
  const user = raw.user as { login?: unknown } | null | undefined;
  return {
    externalId: String(raw.id),
    number: Number(raw.number),
    title: str(raw.title),
    body: str(raw.body),
    labels: labelNames(raw.labels),
    url: str(raw.html_url),
    author: typeof user?.login === 'string' ? user.login : null,
    updatedAt: str(raw.updated_at),
    state: raw.state === 'closed' ? 'closed' : 'open',
  };
}

function normaliseGitlab(raw: Raw): ForgeIssue {
  const author = raw.author as { username?: unknown } | null | undefined;
  return {
    externalId: String(raw.id),
    number: Number(raw.iid),
    title: str(raw.title),
    body: str(raw.description),
    labels: labelNames(raw.labels),
    url: str(raw.web_url),
    author: typeof author?.username === 'string' ? author.username : null,
    updatedAt: str(raw.updated_at),
    state: raw.state === 'closed' ? 'closed' : 'open',
  };
}

function nextPageFrom(res: Response, page: number, rawCount: number, perPage: number): number | null {
  const link = res.headers.get('link');
  if (link !== null) {
    const m = /<([^>]*)>\s*;\s*rel="next"/.exec(link);
    if (!m) return null;
    const p = Number(new URL(m[1]!, 'http://x').searchParams.get('page'));
    return Number.isInteger(p) && p > page ? p : page + 1;
  }
  const gl = res.headers.get('x-next-page');
  if (gl !== null) {
    const p = Number(gl);
    return Number.isInteger(p) && p > 0 ? p : null;
  }
  return rawCount >= perPage ? page + 1 : null;
}

/** Issue reads and write-back for GitHub, GitLab and Gitea. Stateless: pass the target on every call. */
export class IssuesClient {
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(options: IssuesClientOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  async list(target: ForgeTarget, query: IssueListQuery = {}): Promise<IssueListResult> {
    const { remote } = target;
    const page = query.page ?? 1;
    const state = query.state ?? 'open';
    const labels = query.labels?.trim() ?? '';
    const search = query.search?.trim() ?? '';
    const perPage = String(Math.min(Math.max(1, Math.trunc(query.perPage ?? ISSUES_PAGE_SIZE)), ISSUES_PAGE_SIZE_MAX));
    const params = new URLSearchParams();
    let path: string;
    if (remote.provider === 'github' && search) {
      const q = [`repo:${remote.repoPath}`, 'is:issue'];
      if (state !== 'all') q.push(`is:${state}`);
      for (const l of labels.split(',').map((s) => s.trim()).filter(Boolean)) q.push(`label:"${l.replace(/"/g, '')}"`);
      q.push(search);
      params.set('q', q.join(' '));
      params.set('sort', 'updated');
      params.set('order', 'desc');
      params.set('per_page', perPage);
      params.set('page', String(page));
      path = '/search/issues';
    } else if (remote.provider === 'gitlab') {
      params.set('state', state === 'open' ? 'opened' : state);
      if (labels) params.set('labels', labels);
      if (search) params.set('search', search);
      params.set('order_by', 'updated_at');
      params.set('sort', 'desc');
      params.set('per_page', perPage);
      params.set('page', String(page));
      path = `/projects/${encodeURIComponent(remote.repoPath)}/issues`;
    } else if (remote.provider === 'gitea') {
      params.set('type', 'issues');
      params.set('state', state);
      if (labels) params.set('labels', labels);
      if (search) params.set('q', search);
      params.set('limit', perPage);
      params.set('page', String(page));
      path = `/repos/${remote.repoPath}/issues`;
    } else {
      params.set('state', state);
      if (labels) params.set('labels', labels);
      params.set('sort', 'updated');
      params.set('direction', 'desc');
      params.set('per_page', perPage);
      params.set('page', String(page));
      path = `/repos/${remote.repoPath}/issues`;
    }

    const headers = authHeaders(remote.provider, target.token);
    if (query.etag) headers['If-None-Match'] = query.etag;
    const res = await this.send(remote, `${path}?${params}`, { headers });
    const rateLimit = readRateLimit(res);
    if (res.status === 304) {
      return { items: [], nextPage: null, notModified: true, etag: query.etag ?? null, rateLimit };
    }
    const data = await readJson(res);
    const rows = (Array.isArray(data) ? data : ((data as { items?: unknown }).items ?? [])) as Raw[];
    const items: ForgeIssue[] = [];
    for (const row of rows) {
      const issue = remote.provider === 'gitlab' ? normaliseGitlab(row) : normaliseGithubLike(row);
      if (issue) items.push(issue);
    }
    return {
      items,
      nextPage: nextPageFrom(res, page, rows.length, Number(perPage)),
      notModified: false,
      etag: res.headers.get('etag'),
      rateLimit,
    };
  }

  /** One issue by its visible number (GitLab iid). Pull requests are not issues. */
  async get(target: ForgeTarget, number: number): Promise<ForgeIssue> {
    const { remote } = target;
    const res = await this.send(remote, this.issuePath(remote, number), {
      headers: authHeaders(remote.provider, target.token),
      notFoundIsMissing: true,
    });
    const raw = await readJson<Raw>(res);
    const issue = remote.provider === 'gitlab' ? normaliseGitlab(raw) : normaliseGithubLike(raw);
    if (!issue) throw notFound(`#${number} is a pull request, not an issue`);
    return issue;
  }

  async comment(target: ForgeTarget, number: number, text: string): Promise<void> {
    const { remote } = target;
    const suffix = remote.provider === 'gitlab' ? 'notes' : 'comments';
    await this.send(remote, `${this.issuePath(remote, number)}/${suffix}`, {
      method: 'POST',
      headers: { ...authHeaders(remote.provider, target.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
  }

  async close(target: ForgeTarget, number: number): Promise<void> {
    const { remote } = target;
    const gitlab = remote.provider === 'gitlab';
    await this.send(remote, this.issuePath(remote, number), {
      method: gitlab ? 'PUT' : 'PATCH',
      headers: { ...authHeaders(remote.provider, target.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(gitlab ? { state_event: 'close' } : { state: 'closed' }),
    });
  }

  private issuePath(remote: ParsedForgeRemote, number: number): string {
    return remote.provider === 'gitlab'
      ? `/projects/${encodeURIComponent(remote.repoPath)}/issues/${number}`
      : `/repos/${remote.repoPath}/issues/${number}`;
  }

  /** One request: timeout, rate-limit and scope detection, error mapping. Returns 2xx and 304. */
  private async send(
    remote: ParsedForgeRemote,
    pathAndQuery: string,
    init: RequestInit & { notFoundIsMissing?: boolean },
  ): Promise<Response> {
    const { notFoundIsMissing, ...fetchInit } = init;
    const res = await forgeFetch(this.fetch, `${remote.apiBaseUrl}${pathAndQuery}`, fetchInit);
    if (res.ok || res.status === 304) return res;

    const text = await res.text().catch(() => '');
    const retryAfter = numberHeader(res, 'retry-after');
    const limit = readRateLimit(res);
    const limited =
      res.status === 429 ||
      (res.status === 403 && (retryAfter !== null || (limit.resetAt !== null && (limit.remaining === null || limit.remaining === 0))));
    if (limited) {
      const resetAt = retryAfter !== null ? this.now() + retryAfter * 1000 : (limit.resetAt ?? this.now() + 60_000);
      throw new RateLimitError(resetAt, text.slice(0, 300));
    }
    if (notFoundIsMissing && res.status === 404) throw notFound('issue not found on the forge');
    const name = PROVIDER_NAMES[remote.provider];
    const hint = res.status === 401 || res.status === 403 ? `: ${TOKEN_SCOPE_HINT}` : '';
    throw new HttpError(502, 'forge_error', `${name} issues request failed (${res.status})${hint} ${text.slice(0, 300)}`.trimEnd());
  }
}
