import {
  CreateForgeAccountBody,
  FORGE_SCOPE_HINTS,
  type ForgeAccount,
  type ForgeAccountsResponse,
  type ForgeOwner,
  type ForgeOwnersResponse,
  type ForgeProvider,
  UpdateForgeAccountBody,
} from '@emberline/protocol';
import type { Db } from '../db/index.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import {
  deleteAccount,
  deriveApiUrl,
  findAccountRecord,
  type ForgeAccountRecord,
  insertAccountIfHostFree,
  legacyTokenUnmatched,
  listAccountRecords,
  migrateLegacyForgeToken,
  normalizeServerUrl,
  serverHost,
  setEnvironmentUsername,
  updateAccount,
} from './account-store.js';
import { authHeaders, type FetchLike, forgeFetch, readJson } from './issues.js';

export const TOKEN_REFUSED = 'The forge refused this token.';
const PROVIDER_LABELS: Record<ForgeProvider, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea' };
/** Longer than any forge allows; a longer "name" is not a user. */
const USERNAME_MAX = 200;
const READ_ONLY = 'This account comes from EMBERLINE_FORGE_TOKEN; change it in the environment.';

/** A URL as the person may see it: user info (a token pasted into the address) never leaves core. */
function withoutUserInfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//');
  }
}

export function accountView(a: ForgeAccountRecord): ForgeAccount {
  return {
    id: a.id,
    provider: a.provider,
    serverUrl: a.serverUrl,
    apiUrl: withoutUserInfo(a.apiUrl),
    username: a.username,
    tokenConfigured: Boolean(a.token),
    scopesHint: FORGE_SCOPE_HINTS[a.provider],
    source: a.source,
  };
}

/** zod issues without input values: a token must never be echoed in a 400. */
function invalid(issues: { path: PropertyKey[]; message: string }[]): HttpError {
  return badRequest(issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`).join('; '));
}

export class ForgeAccountsService {
  constructor(
    private readonly db: Db,
    private readonly fetch: FetchLike,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  list(): ForgeAccountsResponse {
    return {
      accounts: listAccountRecords(this.db, this.env).map(accountView),
      legacyTokenUnmatched: legacyTokenUnmatched(this.db),
    };
  }

  /** Start: migrate the old token, then fill usernames. Never throws: a failure is logged (no token) and the start goes on. */
  async start(log: (message: string) => void): Promise<void> {
    try {
      if (migrateLegacyForgeToken(this.db) === 'unmatched') {
        log(
          'forge: the earlier forge token could not be matched to one server; add it again in Settings → Forge accounts',
        );
      }
    } catch (error) {
      log(`forge: could not move the earlier forge token into an account: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.fillMissingUsernames(log).catch(() => undefined);
  }

  /** Start-up: stored accounts without a username (migrated) are checked once; failures are only logged. */
  async fillMissingUsernames(log: (message: string) => void): Promise<void> {
    for (const account of listAccountRecords(this.db, this.env).filter(
      (a) => a.source === 'settings' && !a.username,
    )) {
      try {
        await this.check(account.id);
      } catch (error) {
        log(
          `forge: could not check the account for ${serverHost(account.serverUrl)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  record(id: string): ForgeAccountRecord {
    const found = findAccountRecord(this.db, id, this.env);
    if (!found) throw notFound('no such forge account');
    return found;
  }

  async create(raw: unknown): Promise<ForgeAccount> {
    const parsed = CreateForgeAccountBody.safeParse(raw ?? {});
    if (!parsed.success) throw invalid(parsed.error.issues);
    const { provider, token, allowHttp } = parsed.data;
    const serverUrl = normalizeServerUrl(parsed.data.serverUrl);
    if (!serverUrl) throw badRequest("Enter the server's web address, such as https://gitea.example.com.");
    if (serverUrl.startsWith('http://') && !allowHttp) {
      throw new HttpError(
        400,
        'plain_http',
        'This server uses plain http://. Confirm that the token may be sent to it unencrypted.',
      );
    }
    const host = serverHost(serverUrl);
    this.assertHostFree(host);
    const apiUrl = deriveApiUrl(provider, serverUrl);
    const username = await this.currentUser(provider, apiUrl, token, host);
    // Another add for this host may have finished during the check: the insert checks again.
    const created = insertAccountIfHostFree(
      this.db,
      { provider, serverUrl, apiUrl, username, token },
      this.env,
    );
    if (!created) throw conflict(`An account for ${host} already exists.`);
    return accountView(created);
  }

  private assertHostFree(host: string): void {
    if (listAccountRecords(this.db, this.env).some((a) => serverHost(a.serverUrl) === host)) {
      throw conflict(`An account for ${host} already exists.`);
    }
  }

  async update(id: string, raw: unknown): Promise<ForgeAccount> {
    const account = this.record(id);
    if (account.source === 'environment') throw conflict(READ_ONLY, 'account_read_only');
    const parsed = UpdateForgeAccountBody.safeParse(raw ?? {});
    if (!parsed.success) throw invalid(parsed.error.issues);
    const token = parsed.data.token?.trim();
    if (!token) return accountView(account);
    const username = await this.currentUser(
      account.provider,
      account.apiUrl,
      token,
      serverHost(account.serverUrl),
    );
    updateAccount(this.db, id, { token, username });
    return accountView(this.record(id));
  }

  remove(id: string): void {
    const account = this.record(id);
    if (account.source === 'environment') throw conflict(READ_ONLY, 'account_read_only');
    deleteAccount(this.db, id);
  }

  async check(id: string): Promise<ForgeAccount> {
    const account = this.record(id);
    const username = await this.currentUser(
      account.provider,
      account.apiUrl,
      account.token,
      serverHost(account.serverUrl),
    );
    if (account.source === 'environment') setEnvironmentUsername(id, username);
    else updateAccount(this.db, id, { username });
    return accountView(this.record(id));
  }

  async owners(id: string): Promise<ForgeOwnersResponse> {
    const account = this.record(id);
    const user = account.username ?? (await this.check(id)).username!;
    const path = account.provider === 'gitlab' ? '/groups?min_access_level=30&per_page=100' : '/user/orgs?per_page=100';
    const res = await forgeFetch(this.fetch, `${account.apiUrl}${path}`, { headers: authHeaders(account.provider, account.token) });
    if (res.status === 401) throw new HttpError(400, 'token_refused', TOKEN_REFUSED);
    const rows = res.ok ? await readJson<Record<string, unknown>[]>(res).catch(() => []) : [];
    const orgs = (Array.isArray(rows) ? rows : []).flatMap((o): ForgeOwner[] => {
      const id = account.provider === 'gitlab' ? o.full_path : (o.login ?? o.name ?? o.username);
      return typeof id === 'string' && id ? [{ id, name: id, kind: 'organization' }] : [];
    });
    return { owners: [{ id: user, name: user, kind: 'user' }, ...orgs] };
  }

  /** Creates an empty repository; returns its `owner/name` path (origin is built from the account server, never the forge's clone URL). */
  async createRepository(
    account: ForgeAccountRecord,
    input: { owner: string; name: string; private: boolean; description?: string },
  ): Promise<{ fullPath: string }> {
    const forUser = input.owner === account.username;
    const headers = { ...authHeaders(account.provider, account.token), 'Content-Type': 'application/json' };
    let url: string;
    let body: Record<string, unknown>;
    if (account.provider === 'gitlab') {
      url = `${account.apiUrl}/projects`;
      body = { name: input.name, path: input.name, visibility: input.private ? 'private' : 'public', description: input.description ?? '' };
      if (!forUser) {
        const ns = await forgeFetch(this.fetch, `${account.apiUrl}/namespaces/${encodeURIComponent(input.owner)}`, { headers });
        const nsData = ns.ok ? await readJson<{ id?: unknown }>(ns).catch((): { id?: unknown } => ({})) : {};
        if (typeof nsData.id !== 'number') throw new HttpError(409, 'forge_create_refused', this.createRefused(account, input.owner));
        body.namespace_id = nsData.id;
      }
    } else {
      url = forUser ? `${account.apiUrl}/user/repos` : `${account.apiUrl}/orgs/${encodeURIComponent(input.owner)}/repos`;
      body = { name: input.name, private: input.private, description: input.description ?? '', auto_init: false };
    }
    const res = await forgeFetch(this.fetch, url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await readJson<Record<string, unknown>>(res).catch(() => ({}) as Record<string, unknown>);
    if (res.ok) {
      const fullPath = account.provider === 'gitlab' ? data.path_with_namespace : data.full_name;
      // Only a plain owner[/group…]/name path becomes part of origin; anything else falls back to what was asked for.
      const plain = typeof fullPath === 'string' && /^[\w.-]+(\/[\w.-]+)+$/.test(fullPath) && !/(^|\/)\.+(\/|$)/.test(fullPath);
      return { fullPath: plain ? fullPath : `${input.owner}/${input.name}` };
    }
    const text = JSON.stringify(data).split(account.token).join('[redacted]');
    if (res.status === 401) throw new HttpError(400, 'token_refused', TOKEN_REFUSED);
    if (res.status === 409 || /already (exists|been taken)/i.test(text)) {
      throw new HttpError(409, 'repo_name_taken', `A repository named ${input.name} already exists for ${input.owner}.`);
    }
    if (res.status === 403 || res.status === 404) throw new HttpError(409, 'forge_create_refused', this.createRefused(account, input.owner));
    const message = typeof data.message === 'string' ? `: ${data.message.split(account.token).join('[redacted]').slice(0, 200)}` : '';
    throw new HttpError(502, 'forge_error', `The forge could not create the repository (HTTP ${res.status})${message}.`);
  }

  private createRefused(account: ForgeAccountRecord, owner: string): string {
    return `The forge did not let this token create a repository under ${owner}. ${FORGE_SCOPE_HINTS[account.provider]}`;
  }

  /**
   * GET <api>/user; 401/403 → "The forge refused this token." (400). Never quotes the forge's body:
   * anything that is not a user (an HTML login page, `null`, no name) says the server URL is wrong.
   */
  private async currentUser(
    provider: ForgeProvider,
    apiUrl: string,
    token: string,
    host: string,
  ): Promise<string> {
    const notAForge = () =>
      new HttpError(
        502,
        'forge_error',
        `${host} did not answer like a ${PROVIDER_LABELS[provider]} server. Check the server URL.`,
      );
    let res: Response;
    try {
      res = await forgeFetch(this.fetch, `${apiUrl}/user`, { headers: authHeaders(provider, token) });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'forge_timeout') throw error;
      const message = error instanceof Error ? error.message : String(error);
      // forgeFetch follows only same-origin redirects; its own text names the remote and a removed setting.
      if (message.startsWith('the forge redirected')) {
        throw new HttpError(
          502,
          'forge_error',
          `${host} sent the check to another address. Check the server URL.`,
        );
      }
      throw new HttpError(
        502,
        'forge_error',
        `Couldn't check the token with ${host}: ${message.split(token).join('[redacted]')}`,
      );
    }
    if (
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0'))
    ) {
      throw new HttpError(
        429,
        'forge_rate_limited',
        `${host} is limiting requests right now. Try again in a few minutes.`,
      );
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'token_refused', TOKEN_REFUSED);
    if (!res.ok)
      throw new HttpError(
        502,
        'forge_error',
        `Couldn't check the token with ${host}: the forge answered ${res.status}.`,
      );
    let data: unknown;
    try {
      data = await readJson(res);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw notAForge();
    }
    const fields = data && typeof data === 'object' ? (data as { login?: unknown; username?: unknown }) : {};
    const name =
      typeof fields.login === 'string'
        ? fields.login
        : typeof fields.username === 'string'
          ? fields.username
          : null;
    if (!name || name.length > USERNAME_MAX) throw notAForge();
    return name;
  }
}
