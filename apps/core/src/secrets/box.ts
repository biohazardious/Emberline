/**
 * Secrets at rest: AES-256-GCM with a random 96-bit nonce per value, stored as
 * `enc:v1:<base64url(nonce | ciphertext | tag)>`. The key lives outside the database
 * (EMBERLINE_SECRETS_KEY or <data>/secrets.key, see key.ts) and is installed once at start.
 * Nothing here imports the database, so the schema can use it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SEALED_PREFIX = 'enc:v1:';
export const SECRETS_KEY_SENTENCE =
  "Emberline can't read its stored secrets: the secrets key changed or is missing.";
export const SECRETS_KEY_FORGET_SENTENCE =
  'If the key is lost, start once with EMBERLINE_FORGET_SECRETS=1 to clear the secrets it cannot read.';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The spec sentences as the message; `detail` says which key or place, never a value. */
export class SecretsKeyError extends Error {
  constructor(readonly detail: string) {
    super(`${SECRETS_KEY_SENTENCE} ${SECRETS_KEY_FORGET_SENTENCE}`);
    this.name = 'SecretsKeyError';
  }
}

let installed: Buffer | null = null;

export function installSecretsKey(key: Buffer): void {
  if (key.length !== 32) throw new SecretsKeyError('the key is not 32 bytes');
  installed = key;
}

export function installedSecretsKey(): Buffer {
  if (!installed) throw new Error('secrets key not installed');
  return installed;
}

export const isSealed = (v: string): boolean => v.startsWith(SEALED_PREFIX);

/**
 * No associated data: the threat is a read of the volume or a backup. Someone who can write the
 * database could move a sealed value to another field, but could equally redirect plaintext URLs;
 * a v2 format would bind each value to its place (`settings:<key>:<path>`, `forge_accounts:<id>`).
 */
export function sealWith(key: Buffer, plain: string): string {
  const iv = randomBytes(NONCE_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}

/** Throws on another key, a changed byte or a truncated value; never returns the stored text. */
export function openWith(key: Buffer, stored: string): string {
  const raw = Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64url');
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new SecretsKeyError('a stored secret is damaged');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
  d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return Buffer.concat([d.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), d.final()]).toString(
    'utf8',
  );
}

/**
 * Idempotent: a value this key sealed is returned unchanged. Anything else is sealed, also text
 * that merely starts with the prefix (a pasted token), which would otherwise fail every read.
 */
export function sealSecret(v: string): string {
  const key = installedSecretsKey();
  if (isSealed(v)) {
    try {
      openWith(key, v);
      return v;
    } catch {
      // not ours: seal it like any other text
    }
  }
  return sealWith(key, v);
}

/** A plaintext value (before the start-up pass, or in a test fixture) passes through. */
export const openSecret = (v: string): string => (isSealed(v) ? openWith(installedSecretsKey(), v) : v);
