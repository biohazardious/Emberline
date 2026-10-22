/** Where the secrets key comes from: EMBERLINE_SECRETS_KEY, else <data>/secrets.key (created 0600 when allowed). */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { SecretsKeyError } from './box.js';

export const SECRETS_KEY_ENV = 'EMBERLINE_SECRETS_KEY';
export const SECRETS_KEY_FILE = 'secrets.key';

/** 32 bytes in standard base64 (`openssl rand -base64 32`), or null. */
function decodeKey(text: string): Buffer | null {
  return /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, 'base64') : null;
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? 'an error';

function fsyncPath(target: string, flags: string): void {
  const fd = openSync(target, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a new key durably before anything is sealed with it: a 0600 temp file in the same
 * directory, synced, then hard-linked into place (fails when `file` exists, so a key is never
 * replaced), then the directory synced. A temp file left by a crash is never read as the key.
 */
export function createKeyFile(file: string, key: Buffer): void {
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${key.toString('base64')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // the mode above is filtered by the umask
    linkSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  fsyncPath(path.dirname(file), 'r');
}

export function loadSecretsKey(o: { env: NodeJS.ProcessEnv; dataDir: string; allowCreate: boolean }): {
  key: Buffer;
  source: 'env' | 'file' | 'created';
  file: string;
} {
  const file = path.join(o.dataDir, SECRETS_KEY_FILE);
  const fromEnv = o.env[SECRETS_KEY_ENV]?.trim();
  if (fromEnv) {
    const key = decodeKey(fromEnv);
    if (!key)
      throw new SecretsKeyError(`${SECRETS_KEY_ENV} is not 32 bytes of base64 (openssl rand -base64 32)`);
    return { key, source: 'env', file };
  }
  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new SecretsKeyError(`${file} could not be read (${errorCode(error)})`);
    }
    const key = decodeKey(text.trim());
    if (!key) throw new SecretsKeyError(`${file} does not hold 32 bytes of base64`);
    try {
      if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
    } catch (error) {
      throw new SecretsKeyError(`${file} could not be limited to mode 0600 (${errorCode(error)})`);
    }
    return { key, source: 'file', file };
  }
  if (!o.allowCreate) {
    throw new SecretsKeyError(
      `no ${SECRETS_KEY_ENV} and no ${file}, but the database holds encrypted secrets`,
    );
  }
  const key = randomBytes(32);
  try {
    mkdirSync(o.dataDir, { recursive: true });
    createKeyFile(file, key);
  } catch (error) {
    throw new SecretsKeyError(`${file} could not be created (${errorCode(error)})`);
  }
  return { key, source: 'created', file };
}
