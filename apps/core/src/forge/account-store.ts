import { randomUUID } from 'node:crypto';
import type { ForgeProvider } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { forgeAccounts } from '../db/schema.js';
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
const envUsernames = new Map<string, string>();
export function setEnvironmentUsername(id: string, username: string): void {
  envUsernames.set(id, username);
}

/**
 * EMBERLINE_FORGE_TOKEN as read-only accounts: its server comes from EMBERLINE_FORGE_API_URL
 * (github.com without one); each EMBERLINE_FORGE_ALLOWED_HOSTS entry adds the same token for that
 * server host (`api.github.com` is covered by github.com and skipped).
 */
export function environmentAccounts(env: NodeJS.ProcessEnv = process.env): ForgeAccountRecord[] {
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
      username: envUsernames.get(id) ?? null,
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
  return [...stored, ...environmentAccounts(env).filter((a) => !hosts.has(serverHost(a.serverUrl)))];
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
