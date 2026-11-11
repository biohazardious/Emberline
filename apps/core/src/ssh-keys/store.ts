/**
 * The SSH keys core authenticates with to ssh remotes: Emberline's shared key and a project's own
 * key, both ed25519 and generated here. The private key is sealed with the secrets key
 * (secrets/box.ts) before it is stored and only opened in memory for the git gateway; it is never
 * written to a file, a log, a command line or an environment.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { utils } from 'ssh2';
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
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  const publicKey = pair.public.trim();
  const row: typeof sshKeys.$inferSelect = {
    id: randomUUID(),
    scope: scopeValue(scope),
    projectId: scope === 'shared' ? null : scope.projectId,
    algorithm: 'ed25519',
    publicKey,
    fingerprint: sshFingerprint(publicKey.split(' ')[1]!),
    privateKeyEnc: sealWith(installedSecretsKey(), pair.private),
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
