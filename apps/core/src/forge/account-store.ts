import { randomUUID } from 'node:crypto';
import type { ForgeProvider } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { forgeAccounts, projects } from '../db/schema.js';
import { conflict } from '../errors.js';
import { type GitHttpCredential, urlUnderServer } from '../git-credentials.js';
import { hostOf, sameForgeServer } from './hosts.js';

export interface ForgeAccountRecord {
  id: string;
  provider: ForgeProvider;
  serverUrl: string;
  apiUrl: string;
  username: string | null;
  token: string;
  source: 'settings' | 'environment';
}

export const ENV_ACCOUNT_ID = 'env';

/** `https://Git.Example.com:443/sub/` → `https://git.example.com/sub`; null for anything but http(s) without user info. */
export function normalizeServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    !url.hostname
  )
    return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function deriveApiUrl(provider: ForgeProvider, serverUrl: string): string {
  if (provider === 'github')
    return new URL(serverUrl).host === 'github.com' ? 'https://api.github.com' : `${serverUrl}/api/v3`;
  return `${serverUrl}${provider === 'gitlab' ? '/api/v4' : '/api/v1'}`;
}

/** Same rule as `parseForgeRemote`'s auto detection. */
export function detectProviderByHost(host: string): ForgeProvider {
  const h = host.toLowerCase();
  if (h.includes('gitlab')) return 'gitlab';
  if (h.includes('gitea') || h.includes('forgejo') || h.includes('codeberg')) return 'gitea';
  return 'github';
}

const API_SUFFIX_PROVIDER: Record<string, ForgeProvider> = { '1': 'gitea', '3': 'github', '4': 'gitlab' };

/** The web server behind a configured API URL (`/api/v1|v3|v4` stripped; api.github.com → github.com). */
export function serverFromApiUrl(
  apiUrl: string,
  provider: ForgeProvider | null,
): { provider: ForgeProvider; serverUrl: string } | null {
  let url: URL;
  try {
    url = new URL(apiUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.host === 'api.github.com')
    return { provider: provider ?? 'github', serverUrl: 'https://github.com' };
  const m = /^(.*?)\/api\/v(1|3|4)\/?$/.exec(url.pathname);
  const serverUrl = `${url.origin}${(m ? m[1]! : url.pathname).replace(/\/+$/, '')}`;
  return {
    provider: provider ?? (m ? API_SUFFIX_PROVIDER[m[2]!]! : detectProviderByHost(url.hostname)),
    serverUrl,
  };
}

/** `host[:port]` of a server URL, lower case. */
export function serverHost(serverUrl: string): string {
  return new URL(serverUrl).host;
}

const fixedProvider = (raw: string | undefined): ForgeProvider | null =>
  raw === 'github' || raw === 'gitlab' || raw === 'gitea' ? raw : null;

/** Usernames of environment accounts learned by a check (they have no row to store it in). */
const envUsernames = new WeakMap<Db, Map<string, string>>();
const usernamesOf = (db: Db): Map<string, string> => {
  let m = envUsernames.get(db);
  if (!m) envUsernames.set(db, (m = new Map()));
  return m;
};
export function setEnvironmentUsername(db: Db, id: string, username: string): void {
  usernamesOf(db).set(id, username);
}

/**
 * EMBERLINE_FORGE_TOKEN as read-only accounts: its server comes from EMBERLINE_FORGE_API_URL
 * (github.com without one); each EMBERLINE_FORGE_ALLOWED_HOSTS entry adds the same token for that
 * server host (`api.github.com` is covered by github.com and skipped).
 */
export function environmentAccounts(
  env: NodeJS.ProcessEnv = process.env,
  usernames: ReadonlyMap<string, string> = new Map(),
): ForgeAccountRecord[] {
  const token = env.EMBERLINE_FORGE_TOKEN?.trim();
  if (!token) return [];
  const fixed = fixedProvider(env.EMBERLINE_FORGE_PROVIDER?.trim());
  const apiUrl = env.EMBERLINE_FORGE_API_URL?.trim().replace(/\/+$/, '') || null;
  const primary = apiUrl
    ? serverFromApiUrl(apiUrl, fixed)
    : { provider: fixed ?? 'github', serverUrl: 'https://github.com' };
  const out: ForgeAccountRecord[] = [];
  const add = (id: string, provider: ForgeProvider, serverUrl: string, api: string) => {
    if (out.some((a) => serverHost(a.serverUrl) === serverHost(serverUrl))) return;
    out.push({
      id,
      provider,
      serverUrl,
      apiUrl: api,
      username: usernames.get(id) ?? null,
      token,
      source: 'environment',
    });
  };
  if (primary)
    add(
      ENV_ACCOUNT_ID,
      primary.provider,
      primary.serverUrl,
      apiUrl ?? deriveApiUrl(primary.provider, primary.serverUrl),
    );
  for (const entry of (env.EMBERLINE_FORGE_ALLOWED_HOSTS ?? '').split(',')) {
    const host = entry.trim().toLowerCase();
    // A bare host (`git.example.com[:port]`); a URL written here is skipped, not misread.
    if (!host || host.includes('/') || host === 'api.github.com') continue;
    const serverUrl = normalizeServerUrl(`https://${host}`);
    if (!serverUrl) continue;
    const provider = fixed ?? detectProviderByHost(host);
    add(`env:${host}`, provider, serverUrl, deriveApiUrl(provider, serverUrl));
  }
  return out;
}

function storedRecords(db: Db): ForgeAccountRecord[] {
  return db
    .select()
    .from(forgeAccounts)
    .all()
    .map((r) => ({
      id: r.id,
      provider: r.provider,
      serverUrl: r.serverUrl,
      apiUrl: r.apiUrl,
      username: r.username,
      token: r.token,
      source: 'settings' as const,
    }));
}

/** Stored accounts first; an environment account whose host has a stored one is hidden. */
export function listAccountRecords(db: Db, env: NodeJS.ProcessEnv = process.env): ForgeAccountRecord[] {
  const stored = storedRecords(db);
  const hosts = new Set(stored.map((a) => serverHost(a.serverUrl)));
  return [...stored, ...environmentAccounts(env, usernamesOf(db)).filter((a) => !hosts.has(serverHost(a.serverUrl)))];
}

export function findAccountRecord(
  db: Db,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ForgeAccountRecord | null {
  return listAccountRecords(db, env).find((a) => a.id === id) ?? null;
}

/**
 * The account for REST calls about a remote: same server host (the port counts only between
 * http(s) URLs, as in `sameForgeServer`). Null when no account has that host.
 */
export function accountForRemote(
  db: Db,
  remoteUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ForgeAccountRecord | null {
  if (!hostOf(remoteUrl)) return null;
  return listAccountRecords(db, env).find((a) => sameForgeServer(a.serverUrl, remoteUrl)) ?? null;
}

const BASIC_USER: Record<ForgeProvider, string | null> = {
  github: 'x-access-token',
  gitlab: 'oauth2',
  gitea: null,
};

/** The account git uses for an http(s) remote: its server covers the URL, which has no user info. */
export function accountForGitRemote(
  db: Db,
  remoteUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ForgeAccountRecord | null {
  let url: URL;
  try {
    url = new URL(remoteUrl.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return listAccountRecords(db, env).find((a) => urlUnderServer(url, a.serverUrl)) ?? null;
}

/** Credentials for one git call to an http(s) remote under an account's server; null otherwise (ssh, other host). */
export function gitCredentialForRemote(
  db: Db,
  remoteUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): GitHttpCredential | null {
  const account = accountForGitRemote(db, remoteUrl, env);
  if (!account) return null;
  const username = BASIC_USER[account.provider] ?? account.username;
  if (!username) {
    throw conflict(
      `Check the account for ${serverHost(account.serverUrl)} in Settings → Forge accounts first.`,
      'forge_account_unchecked',
    );
  }
  return { serverUrl: account.serverUrl, username, token: account.token };
}

export function insertAccount(
  db: Db,
  input: Omit<ForgeAccountRecord, 'id' | 'source'>,
  now = new Date(),
): ForgeAccountRecord {
  const id = randomUUID();
  db.insert(forgeAccounts)
    .values({ id, ...input, createdAt: now, updatedAt: now })
    .run();
  return { id, ...input, source: 'settings' };
}

/**
 * The insert to use outside tests: one account per server host, counting environment accounts
 * (the unique index is on `server_url`, which a sub-path would slip past). Null when the host is
 * taken. The check and the insert are synchronous, so no other insert can come between them.
 */
export function insertAccountIfHostFree(
  db: Db,
  input: Omit<ForgeAccountRecord, 'id' | 'source'>,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): ForgeAccountRecord | null {
  const host = serverHost(input.serverUrl);
  if (listAccountRecords(db, env).some((a) => serverHost(a.serverUrl) === host)) return null;
  return insertAccount(db, input, now);
}

export function updateAccount(
  db: Db,
  id: string,
  patch: { token?: string; username?: string | null },
  now = new Date(),
): void {
  db.update(forgeAccounts)
    .set({ ...patch, updatedAt: now })
    .where(eq(forgeAccounts.id, id))
    .run();
}

export function deleteAccount(db: Db, id: string): void {
  db.delete(forgeAccounts).where(eq(forgeAccounts.id, id)).run();
}

export const LEGACY_FORGE_SETTINGS_KEY = 'forge.config';

interface LegacyForgeConfig {
  provider?: unknown;
  apiUrl?: unknown;
  token?: unknown;
  /** Set once the token could not be matched to one server. */
  unmatched?: unknown;
}

/** The old global config, its token opened in memory (sealed at rest). */
const readLegacy = (db: Db): LegacyForgeConfig | null => {
  const value = getSetting<unknown>(db, LEGACY_FORGE_SETTINGS_KEY);
  return typeof value === 'object' && value !== null ? (value as LegacyForgeConfig) : null;
};
const legacyToken = (cfg: LegacyForgeConfig | null) => (typeof cfg?.token === 'string' ? cfg.token.trim() : '');

/**
 * The servers projects were set up with (https only: the old token never went over plain http to
 * them). `unusable` is set when a project's address gives no server name; the token is then not
 * guessed.
 */
function projectServers(db: Db): { servers: Set<string>; plainHttp: boolean; unusable: boolean } {
  const servers = new Set<string>();
  let plainHttp = false;
  let unusable = false;
  for (const { repoUrl } of db.select({ repoUrl: projects.repoUrl }).from(projects).all()) {
    if (!repoUrl?.trim()) continue;
    const url = repoUrl.trim();
    if (/^http:\/\//i.test(url)) {
      plainHttp = true;
      continue;
    }
    const host = /^https:\/\//i.test(url) ? hostOf(url) : hostOf(url)?.replace(/:\d+$/, '');
    const server = host ? normalizeServerUrl(`https://${host}`) : null;
    if (server) servers.add(server);
    else unusable = true;
  }
  return { servers, plainHttp, unusable };
}

/** Where the old token belongs, or null when that cannot be told from the stored settings. */
function legacyTarget(
  db: Db,
  cfg: LegacyForgeConfig,
  apiUrl: string | null,
): { provider: ForgeProvider; serverUrl: string } | null {
  const fixed = fixedProvider(typeof cfg.provider === 'string' ? cfg.provider : undefined);
  if (apiUrl) {
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      return null;
    }
    if (url.username || url.password) return null;
    // As before the upgrade: a fixed provider, else the host name (not the API path) says which.
    return serverFromApiUrl(apiUrl, fixed ?? detectProviderByHost(url.hostname));
  }
  const { servers, plainHttp, unusable } = projectServers(db);
  if (plainHttp || unusable) return null;
  if (servers.size === 1) {
    const serverUrl = [...servers][0]!;
    return { provider: fixed ?? detectProviderByHost(new URL(serverUrl).hostname), serverUrl };
  }
  if (servers.size === 0 && fixed !== 'gitea') {
    return fixed === 'gitlab'
      ? { provider: 'gitlab', serverUrl: 'https://gitlab.com' }
      : { provider: 'github', serverUrl: 'https://github.com' };
  }
  return null;
}

/**
 * Once per start: the old global token becomes an account for its host, then is cleared (so a
 * removed account does not come back). An account stored for the host is kept. Environment accounts
 * are ignored: a stored account for the same host wins over them. A token that could not be matched
 * is marked so; later starts never guess again (projects may have changed) until it is forgotten.
 */
export function migrateLegacyForgeToken(db: Db): 'none' | 'migrated' | 'unmatched' {
  const cfg = readLegacy(db);
  const token = legacyToken(cfg);
  if (!cfg || !token) return 'none';
  if (cfg.unmatched === true) return 'unmatched';
  const apiUrl =
    typeof cfg.apiUrl === 'string' && cfg.apiUrl.trim() ? cfg.apiUrl.trim().replace(/\/+$/, '') : null;
  const target = legacyTarget(db, cfg, apiUrl);
  if (!target) {
    setSetting(db, LEGACY_FORGE_SETTINGS_KEY, { ...cfg, unmatched: true });
    return 'unmatched';
  }
  insertAccountIfHostFree(
    db,
    {
      provider: target.provider,
      serverUrl: target.serverUrl,
      apiUrl: apiUrl ?? deriveApiUrl(target.provider, target.serverUrl),
      username: null,
      token,
    },
    {},
  );
  forgetLegacyToken(db);
  return 'migrated';
}

/** True while forge.config still holds a token (the migration could not match it to one server). */
export function legacyTokenUnmatched(db: Db): boolean {
  return Boolean(legacyToken(readLegacy(db)));
}

export function forgetLegacyToken(db: Db): void {
  const cfg = readLegacy(db);
  if (!cfg) return;
  setSetting(db, LEGACY_FORGE_SETTINGS_KEY, { ...cfg, token: null, unmatched: false });
}
