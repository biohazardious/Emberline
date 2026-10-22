import {
  CreateForgeAccountBody,
  FORGE_SCOPE_HINTS,
  type ForgeAccount,
  type ForgeAccountsResponse,
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
