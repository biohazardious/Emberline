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
  renameSync,
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

/** `link` errors that mean the volume has no hard links (SMB/CIFS, some FUSE mounts). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);
/** Directory fsync errors from such volumes; the key file itself is synced already. */
const NO_DIRECTORY_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR']);

/** The filesystem calls {@link createKeyFile} publishes a key with; tests replace them. */
export interface KeyFileOps {
  link(from: string, to: string): void;
  rename(from: string, to: string): void;
  exists(file: string): boolean;
  fsyncDir(dir: string): void;
}

export const NODE_KEY_FILE_OPS: KeyFileOps = {
  link: linkSync,
  rename: renameSync,
  exists: existsSync,
  fsyncDir: (dir) => fsyncPath(dir, 'r'),
};

/**
 * Writes a new key durably before anything is sealed with it: a 0600 temp file in the same
 * directory, synced, then hard-linked into place (fails when `file` exists, so a key is never
 * replaced), then the directory synced. A temp file left by a crash is never read as the key.
 * On a volume without hard links (SMB/CIFS, some FUSE mounts) the synced temp file is renamed into
 * place once no key exists, then read back; the directory sync is best effort there.
 */
export function createKeyFile(file: string, key: Buffer, ops: KeyFileOps = NODE_KEY_FILE_OPS): void {
  const tmp = `${file}.tmp`;
  const text = `${key.toString('base64')}\n`;
  let linked = true;
  rmSync(tmp, { force: true });
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // the mode above is filtered by the umask
    try {
      ops.link(tmp, file);
    } catch (error) {
      if (!NO_HARD_LINKS.has(errorCode(error))) throw error;
      // Known window, accepted: rename replaces its target. A key another start creates after the
      // check below is replaced, and if that start already read its own key back it goes on sealing
      // with a key that is no longer on disk. The read-back only catches a rename that lands after
      // ours. Two cores on one /data volume are not supported, so only that setup can hit this.
      if (ops.exists(file)) throw Object.assign(new Error(`${file} already exists`), { code: 'EEXIST' });
      ops.rename(tmp, file);
      linked = false;
      if (readFileSync(file, 'utf8') !== text) {
        throw Object.assign(new Error(`${file} was replaced by another start`), { code: 'EEXIST' });
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    ops.fsyncDir(path.dirname(file));
  } catch (error) {
    if (linked || !NO_DIRECTORY_FSYNC.has(errorCode(error))) throw error;
  }
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
      { keyLost: true },
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
