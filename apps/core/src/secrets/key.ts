/** Where the secrets key comes from: EMBERLINE_SECRETS_KEY, else <data>/secrets.key (created 0600 when allowed). */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SecretsKeyError } from './box.js';

export const SECRETS_KEY_ENV = 'EMBERLINE_SECRETS_KEY';
export const SECRETS_KEY_FILE = 'secrets.key';

/** 32 bytes in standard base64 (`openssl rand -base64 32`), or null. */
function decodeKey(text: string): Buffer | null {
  return /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, 'base64') : null;
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
    const key = decodeKey(readFileSync(file, 'utf8').trim());
    if (!key) throw new SecretsKeyError(`${file} does not hold 32 bytes of base64`);
    if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
    return { key, source: 'file', file };
  }
  if (!o.allowCreate) {
    throw new SecretsKeyError(
      `no ${SECRETS_KEY_ENV} and no ${file}, but the database holds encrypted secrets`,
    );
  }
  mkdirSync(o.dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600); // the mode above is filtered by the umask
  return { key, source: 'created', file };
}
