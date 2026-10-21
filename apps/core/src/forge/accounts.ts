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
  insertAccount,
  listAccountRecords,
  normalizeServerUrl,
  serverHost,
  setEnvironmentUsername,
  updateAccount,
} from './account-store.js';
import { authHeaders, type FetchLike, forgeFetch, readJson } from './issues.js';

export const TOKEN_REFUSED = 'The forge refused this token.';
const READ_ONLY = 'This account comes from EMBERLINE_FORGE_TOKEN; change it in the environment.';

export function accountView(a: ForgeAccountRecord): ForgeAccount {
  return {
    id: a.id,
    provider: a.provider,
    serverUrl: a.serverUrl,
    apiUrl: a.apiUrl,
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
    return { accounts: listAccountRecords(this.db, this.env).map(accountView) };
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
    // Another add for this host may have finished during the check; the re-check and the insert
    // are synchronous, so nothing slips between them.
    this.assertHostFree(host);
    return accountView(insertAccount(this.db, { provider, serverUrl, apiUrl, username, token }));
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

  /** GET <api>/user; 401/403 → "The forge refused this token." (400); never quotes the forge's body. */
  private async currentUser(
    provider: ForgeProvider,
    apiUrl: string,
    token: string,
    host: string,
  ): Promise<string> {
    let res: Response;
    try {
      res = await forgeFetch(this.fetch, `${apiUrl}/user`, { headers: authHeaders(provider, token) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(
        502,
        'forge_error',
        `Couldn't check the token with ${host}: ${message.split(token).join('[redacted]')}`,
      );
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'token_refused', TOKEN_REFUSED);
    if (!res.ok)
      throw new HttpError(
        502,
        'forge_error',
        `Couldn't check the token with ${host}: the forge answered ${res.status}.`,
      );
    const data = await readJson<{ login?: unknown; username?: unknown }>(res);
    const name =
      typeof data.login === 'string' ? data.login : typeof data.username === 'string' ? data.username : null;
    if (!name)
      throw new HttpError(
        502,
        'forge_error',
        `Couldn't check the token with ${host}: the forge did not name the user.`,
      );
    return name;
  }
}
