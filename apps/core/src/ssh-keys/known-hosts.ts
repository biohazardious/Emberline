/**
 * SSH host keys for core's ssh remotes: the pinned keys of GitHub, GitLab and Bitbucket
 * (@emberline/protocol, the same list as the runner image's /etc/ssh/ssh_known_hosts) and the keys a
 * person trusted (`ssh_host_keys`). A changed key is never replaced by trusting the new one: the
 * stored key is removed explicitly first (Settings), and a pinned key cannot be replaced here.
 */
import { createHash } from 'node:crypto';
import { PINNED_SSH_HOST_KEYS } from '@emberline/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { utils } from 'ssh2';
import type { Db } from '../db/index.js';
import { sshHostKeys } from '../db/schema.js';
import { badRequest, conflict } from '../errors.js';

export type HostKeyStatus = 'pinned' | 'trusted' | 'unknown' | 'changed';

export interface HostKeyEntry {
  host: string;
  port: number;
  /** The key's own type (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`), not a signature algorithm. */
  keyType: string;
  /** The public key blob, base64. */
  key: string;
}

export interface TrustedHostKey extends HostKeyEntry {
  fingerprint: string;
  trustedAt: Date;
}

/** `SHA256:<base64 without padding>` of a key blob, as `ssh-keygen -l` prints it. */
export function sshFingerprint(keyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

let pinned: readonly HostKeyEntry[] | null = null;

/** The pinned list parsed: `host` or `[host]:port` → host (lower case) and port (22 without one). */
export function pinnedHostKeys(): readonly HostKeyEntry[] {
  pinned ??= PINNED_SSH_HOST_KEYS.map((line) => {
    const [pattern, keyType, key] = line.split(' ') as [string, string, string];
    const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(pattern);
    return {
      host: (bracketed ? bracketed[1]! : pattern).toLowerCase(),
      port: bracketed ? Number(bracketed[2]) : 22,
      keyType,
      key,
    };
  });
  return pinned;
}

const sameKey = (a: string, b: string): boolean => Buffer.from(a, 'base64').equals(Buffer.from(b, 'base64'));

const pinnedFor = (host: string, port: number, keyType: string) =>
  pinnedHostKeys().filter((k) => k.host === host && k.port === port && k.keyType === keyType);

const trustedRow = (db: Db, host: string, port: number, keyType: string) =>
  db
    .select()
    .from(sshHostKeys)
    .where(and(eq(sshHostKeys.host, host), eq(sshHostKeys.port, port), eq(sshHostKeys.keyType, keyType)))
    .get();

/**
 * What a server's host key is to core: one of the pinned keys, one a person trusted, a host:port
 * and key type nothing is known for, or `changed` when another key of that type is pinned or
 * trusted for that host:port. Another port is another server.
 */
export function hostKeyStatus(
  db: Db,
  host: string,
  port: number,
  keyType: string,
  keyBase64: string,
): HostKeyStatus {
  const h = host.toLowerCase();
  const pins = pinnedFor(h, port, keyType);
  if (pins.length > 0) return pins.some((k) => sameKey(k.key, keyBase64)) ? 'pinned' : 'changed';
  const row = trustedRow(db, h, port, keyType);
  if (!row) return 'unknown';
  return sameKey(row.key, keyBase64) ? 'trusted' : 'changed';
}

const HOST_RE = /^[a-z0-9._:-]{1,253}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The entry checked and normalised (host lower case, canonical base64); 400 for anything malformed. */
function checkedEntry(entry: HostKeyEntry): HostKeyEntry {
  const host = entry.host.trim().toLowerCase();
  if (!HOST_RE.test(host)) throw badRequest('the host name is not valid');
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
    throw badRequest('the port must be a number from 1 to 65535');
  }
  if (!BASE64_RE.test(entry.key)) throw badRequest('the host key is not valid');
  const key = Buffer.from(entry.key, 'base64').toString('base64');
  const parsed = utils.parseKey(`${entry.keyType} ${key}`);
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== entry.keyType) {
    throw badRequest(`the host key is not a valid ${entry.keyType} key`);
  }
  return { host, port: entry.port, keyType: entry.keyType, key };
}

/**
 * Stores a host key a person chose to trust. The same key again changes nothing; another key for
 * a host:port and type that already has one (stored or pinned) is refused (`host_key_changed`).
 */
export function trustHostKey(db: Db, entry: HostKeyEntry): TrustedHostKey {
  const e = checkedEntry(entry);
  const where = `${e.host}:${e.port}`;
  const pins = pinnedFor(e.host, e.port, e.keyType);
  if (pins.length > 0) {
    if (pins.some((k) => sameKey(k.key, e.key))) {
      throw conflict(`${where} uses the ${e.keyType} host key Emberline ships; there is nothing to trust`);
    }
    throw conflict(
      `${where} has a pinned ${e.keyType} host key and this is not it; it cannot be replaced`,
      'host_key_changed',
    );
  }
  const existing = trustedRow(db, e.host, e.port, e.keyType);
  if (existing) {
    if (sameKey(existing.key, e.key)) return existing;
    throw conflict(
      `another ${e.keyType} host key is trusted for ${where}; remove it in Settings first`,
      'host_key_changed',
    );
  }
  const row: TrustedHostKey = { ...e, fingerprint: sshFingerprint(e.key), trustedAt: new Date() };
  db.insert(sshHostKeys).values(row).run();
  return row;
}

/** Removes a trusted host key; false when none was stored (pinned keys are never stored). */
export function removeHostKey(db: Db, host: string, port: number, keyType: string): boolean {
  const result = db
    .delete(sshHostKeys)
    .where(
      and(
        eq(sshHostKeys.host, host.toLowerCase()),
        eq(sshHostKeys.port, port),
        eq(sshHostKeys.keyType, keyType),
      ),
    )
    .run();
  return result.changes > 0;
}

export function listTrustedHostKeys(db: Db): TrustedHostKey[] {
  return db
    .select()
    .from(sshHostKeys)
    .orderBy(asc(sshHostKeys.host), asc(sshHostKeys.port), asc(sshHostKeys.keyType))
    .all();
}
