/**
 * SSH host keys for core's ssh remotes: the pinned keys of GitHub, GitLab and Bitbucket
 * (@emberline/protocol, the same list as the runner image's /etc/ssh/ssh_known_hosts) and the keys a
 * person trusted (`ssh_host_keys`). A host:port with known keys accepts only those: any other key is
 * `changed`, never replaced by trusting it; a stored key is removed explicitly first (Settings), and
 * a pinned host's keys cannot be changed here.
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

/**
 * A host name as core compares and stores it (Ruling 18): trimmed, lower case, one trailing dot
 * dropped (`github.com.` is github.com to DNS, so it must be to the pins too). Null for an empty
 * host or one with a colon or whitespace inside (a port, an IPv6 literal: never a host here).
 */
export function normaliseSshHost(host: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h && !/[\s:]/.test(h) && !h.endsWith('.') ? h : null;
}

const sameKey = (a: string, b: string): boolean => Buffer.from(a, 'base64').equals(Buffer.from(b, 'base64'));

/**
 * The keys known for a host:port: its pinned keys when it has any (then nothing stored counts),
 * otherwise the keys a person trusted for it. Another port is another server.
 */
function knownKeys(
  db: Db,
  host: string,
  port: number,
): { source: 'pinned'; keys: readonly HostKeyEntry[] } | { source: 'trusted'; keys: TrustedHostKey[] } {
  const pins = pinnedHostKeys().filter((k) => k.host === host && k.port === port);
  if (pins.length > 0) return { source: 'pinned', keys: pins };
  const keys = db
    .select()
    .from(sshHostKeys)
    .where(and(eq(sshHostKeys.host, host), eq(sshHostKeys.port, port)))
    .all();
  return { source: 'trusted', keys };
}

const matching = <T extends HostKeyEntry>(keys: readonly T[], keyType: string, keyBase64: string) =>
  keys.find((k) => k.keyType === keyType && sameKey(k.key, keyBase64));

/**
 * What a server's host key is to core (Ruling 16): `pinned` or `trusted` when it is exactly one of
 * the keys known for that host:port, `changed` for any other key while some are known (whatever its
 * type, so a server offering a type nothing is known for cannot be trusted past the known ones),
 * `unknown` only for a host:port with no pinned and no trusted key.
 */
export function hostKeyStatus(
  db: Db,
  host: string,
  port: number,
  keyType: string,
  keyBase64: string,
): HostKeyStatus {
  const name = normaliseSshHost(host);
  // The gateway reads the remote's host with the same normaliser first; nothing else asks.
  if (name === null) throw new Error('hostKeyStatus needs a host name');
  const known = knownKeys(db, name, port);
  if (known.keys.length === 0) return 'unknown';
  return matching(known.keys, keyType, keyBase64) ? known.source : 'changed';
}

/**
 * The key types known for a host:port (pinned, else trusted), in the order stored; empty for a
 * host:port nothing is known for. The gateway offers only these to the server (Ruling 16), so a
 * server with several keys shows the one core knows. `host` as the normaliser reads it.
 */
export function knownHostKeyTypes(db: Db, host: string, port: number): string[] {
  return [...new Set(knownKeys(db, host, port).keys.map((k) => k.keyType))];
}

const HOST_RE = /^[a-z0-9._-]{1,253}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The entry checked and normalised (host lower case, canonical base64); 400 for anything malformed. */
function checkedEntry(entry: HostKeyEntry): HostKeyEntry {
  const host = normaliseSshHost(entry.host);
  if (host === null || !HOST_RE.test(host)) throw badRequest('the host name is not valid');
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
 * Stores a host key a person chose to trust, for a host:port nothing is known for. The same key
 * again changes nothing; any other key for a host:port that has pinned or trusted keys is refused
 * (`host_key_changed`): a stored key is removed in Settings first, a pinned one never.
 */
export function trustHostKey(db: Db, entry: HostKeyEntry): TrustedHostKey {
  const e = checkedEntry(entry);
  const where = `${e.host}:${e.port}`;
  const known = knownKeys(db, e.host, e.port);
  if (known.source === 'pinned') {
    if (matching(known.keys, e.keyType, e.key))
      throw conflict(`${where} uses the ${e.keyType} host key Emberline ships; there is nothing to trust`);
    throw conflict(
      `${where} has pinned host keys and this is not one of them; it cannot be trusted`,
      'host_key_changed',
    );
  }
  const same = matching(known.keys, e.keyType, e.key);
  if (same) return same;
  if (known.keys.length > 0) {
    throw conflict(
      `another host key is trusted for ${where}; remove it in Settings first`,
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
        eq(sshHostKeys.host, normaliseSshHost(host) ?? ''),
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
