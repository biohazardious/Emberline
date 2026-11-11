/**
 * The SSH keys core authenticates with to ssh remotes: Emberline's shared key and a project's own
 * key, both ed25519 and generated here. The private key is sealed with the secrets key
 * (secrets/box.ts) before it is stored and only opened in memory for the git gateway; it is never
 * written to a file, a log, a command line or an environment.
 */
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sshKeys } from '../db/schema.js';
import { installedSecretsKey, isSealed, openWith, SecretsKeyError, sealWith } from '../secrets/box.js';
import { sshFingerprint } from './known-hosts.js';

/** Emberline's shared key, or a project's own key. */
export type SshKeyScope = 'shared' | { projectId: string };

export interface SshKeyPublic {
  /** The OpenSSH public line, `ssh-ed25519 AAAA… emberline` (`emberline-<project slug>` for a project). */
  publicKey: string;
  /** `SHA256:…` as `ssh-keygen -l` prints it. */
  fingerprint: string;
  createdAt: Date;
  algorithm: 'ed25519';
}

/** An SSH wire string: uint32 length, then the bytes. */
const sshString = (data: Buffer | string): Buffer => {
  const bytes = Buffer.from(data);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** PKCS#8 DER of an ed25519 private key, before its 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * A new ed25519 key pair in OpenSSH's formats (`openssh-key-v1`, unencrypted: the row seals it):
 * the private key and the public line with `comment`. Written here from Node's key, because ssh2's
 * generator drops a public key's leading zero bytes (one key in 256 came out malformed). `seed`: tests.
 */
export function ed25519KeyPair(comment: string, seed?: Buffer): { publicKey: string; privateKey: string } {
  const key = seed
    ? createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
    : generateKeyPairSync('ed25519').privateKey;
  const jwk = key.export({ format: 'jwk' });
  const secret = Buffer.from(jwk.d!, 'base64url');
  const pub = Buffer.from(jwk.x!, 'base64url');
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = randomBytes(4);
  const section = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([secret, pub])),
    sshString(comment),
  ]);
  // Padded 1, 2, 3, … to the cipher's block size (8 for none).
  const padding = Buffer.from(Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, i) => i + 1));
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    count,
    sshString(publicBlob),
    sshString(Buffer.concat([section, padding])),
  ]);
  const lines = body
    .toString('base64')
    .match(/.{1,70}/g)!
    .join('\n');
  return {
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}

const scopeValue = (scope: SshKeyScope): string => (scope === 'shared' ? 'shared' : scope.projectId);

const toPublic = (row: typeof sshKeys.$inferSelect): SshKeyPublic => ({
  publicKey: row.publicKey,
  fingerprint: row.fingerprint,
  createdAt: row.createdAt,
  algorithm: row.algorithm,
});

const rowFor = (db: Db, scope: SshKeyScope) =>
  db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.scope, scopeValue(scope)))
    .get();

/**
 * A new key for `scope`, replacing the one it had at once (a new id too, so whatever was bound to
 * the old key finds nothing rather than another key). A project key needs the project to exist.
 */
export function generateKey(db: Db, scope: 'shared' | { projectId: string; slug: string }): SshKeyPublic {
  const comment =
    scope === 'shared' ? 'emberline' : `emberline-${scope.slug.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const pair = ed25519KeyPair(comment);
  const publicKey = pair.publicKey;
  const row: typeof sshKeys.$inferSelect = {
    id: randomUUID(),
    scope: scopeValue(scope),
    projectId: scope === 'shared' ? null : scope.projectId,
    algorithm: 'ed25519',
    publicKey,
    fingerprint: sshFingerprint(publicKey.split(' ')[1]!),
    privateKeyEnc: sealWith(installedSecretsKey(), pair.privateKey),
    createdAt: new Date(),
  };
  db.transaction((tx) => {
    tx.delete(sshKeys).where(eq(sshKeys.scope, row.scope)).run();
    tx.insert(sshKeys).values(row).run();
  });
  return toPublic(row);
}

export function getPublicKey(db: Db, scope: SshKeyScope): SshKeyPublic | null {
  const row = rowFor(db, scope);
  return row ? toPublic(row) : null;
}

export function deleteKey(db: Db, scope: SshKeyScope): boolean {
  return (
    db
      .delete(sshKeys)
      .where(eq(sshKeys.scope, scopeValue(scope)))
      .run().changes > 0
  );
}

function openPrivateKey(sealed: string): string {
  if (!isSealed(sealed)) throw new SecretsKeyError('an SSH key is stored without encryption');
  try {
    return openWith(installedSecretsKey(), sealed);
  } catch {
    throw new SecretsKeyError('ssh_keys could not be decrypted with this key', { keyLost: true });
  }
}

/** The OpenSSH private key, opened in memory: for the git gateway only. Null without a key. */
export function privateKeyFor(db: Db, scope: SshKeyScope): string | null {
  const row = rowFor(db, scope);
  if (!row) return null;
  return openPrivateKey(row.privateKeyEnc);
}

/**
 * The private key with the given id and its scope, opened in memory: for a gateway capability
 * bound to that key id. Null once that key was replaced or deleted (the scope's key has another id
 * or none), so a bound operation never uses a key it was not given.
 */
export function privateKeyById(db: Db, keyId: string): { scope: SshKeyScope; privateKey: string } | null {
  const row = db.select().from(sshKeys).where(eq(sshKeys.id, keyId)).get();
  if (!row) return null;
  const scope: SshKeyScope = row.projectId === null ? 'shared' : { projectId: row.projectId };
  return { scope, privateKey: openPrivateKey(row.privateKeyEnc) };
}

/**
 * The key a project's ssh remotes use: its chosen one (`own` → the project's key, `shared` → the
 * shared key), or null when the chosen key does not exist. The other key never stands in.
 */
export function keyForProject(
  db: Db,
  project: { id: string; sshKeyChoice: 'shared' | 'own' },
): { scope: SshKeyScope; keyId: string } | null {
  const scope: SshKeyScope = project.sshKeyChoice === 'own' ? { projectId: project.id } : 'shared';
  const row = rowFor(db, scope);
  return row ? { scope, keyId: row.id } : null;
}
