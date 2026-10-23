import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRETS_KEY_FORGET_SENTENCE, SECRETS_KEY_SENTENCE, SecretsKeyError } from './box.js';
import { createKeyFile, type KeyFileOps, loadSecretsKey, NODE_KEY_FILE_OPS } from './key.js';
import { rmTemp } from '../test-rm.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secrets-key-'));
});
afterEach(() => {
  rmTemp(dir);
});
const keyFile = () => path.join(dir, 'secrets.key');
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('loadSecretsKey', () => {
  it('uses the env key and creates no file', () => {
    const key = randomBytes(32);
    const loaded = loadSecretsKey({
      env: { EMBERLINE_SECRETS_KEY: key.toString('base64') },
      dataDir: dir,
      allowCreate: true,
    });
    expect(loaded.source).toBe('env');
    expect(loaded.key.equals(key)).toBe(true);
    expect(existsSync(keyFile())).toBe(false);
  });

  it('refuses an env key that is not 32 bytes, without echoing it', () => {
    const bad = randomBytes(16).toString('base64');
    const error = thrown(() =>
      loadSecretsKey({ env: { EMBERLINE_SECRETS_KEY: bad }, dataDir: dir, allowCreate: true }),
    );
    expect(error).toBeInstanceOf(SecretsKeyError);
    expect(String((error as SecretsKeyError).detail)).toContain('EMBERLINE_SECRETS_KEY');
    expect(`${(error as Error).message} ${(error as SecretsKeyError).detail}`).not.toContain(bad);
    expect(existsSync(keyFile())).toBe(false);
  });

  it('treats an empty env value as unset', () => {
    const loaded = loadSecretsKey({ env: { EMBERLINE_SECRETS_KEY: '' }, dataDir: dir, allowCreate: true });
    expect(loaded.source).toBe('created');
  });

  it('creates secrets.key (0600, 32 bytes) once and reuses it', () => {
    const created = loadSecretsKey({ env: {}, dataDir: dir, allowCreate: true });
    expect(created.source).toBe('created');
    expect(created.file).toBe(keyFile());
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(created.key).toHaveLength(32);
    const again = loadSecretsKey({ env: {}, dataDir: dir, allowCreate: true });
    expect(again.source).toBe('file');
    expect(again.key.equals(created.key)).toBe(true);
  });

  it('tightens a key file other users can read', () => {
    writeFileSync(keyFile(), `${randomBytes(32).toString('base64')}\n`, { mode: 0o644 });
    loadSecretsKey({ env: {}, dataDir: dir, allowCreate: false });
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  it('refuses a key file that does not hold 32 bytes and names the file', () => {
    const bad = randomBytes(16).toString('base64');
    writeFileSync(keyFile(), `${bad}\n`, { mode: 0o600 });
    const error = thrown(() => loadSecretsKey({ env: {}, dataDir: dir, allowCreate: true }));
    expect(error).toBeInstanceOf(SecretsKeyError);
    // A broken key file is not a lost key: EMBERLINE_FORGET_SECRETS would not help, so it is not named.
    expect((error as Error).message).toBe(
      "Emberline can't read its stored secrets: the secrets key changed or is missing.",
    );
    expect((error as SecretsKeyError).detail).toContain(keyFile());
    expect((error as SecretsKeyError).detail).not.toContain(bad);
  });

  it('never creates a key when it may not', () => {
    expect(() => loadSecretsKey({ env: {}, dataDir: dir, allowCreate: false })).toThrow(SecretsKeyError);
    expect(existsSync(keyFile())).toBe(false);
  });

  it('names EMBERLINE_FORGET_SECRETS only when the key is missing, not when it is malformed or cannot be made', () => {
    const missing = thrown(() => loadSecretsKey({ env: {}, dataDir: dir, allowCreate: false }));
    expect((missing as Error).message).toBe(`${SECRETS_KEY_SENTENCE} ${SECRETS_KEY_FORGET_SENTENCE}`);
    const malformed = thrown(() =>
      loadSecretsKey({ env: { EMBERLINE_SECRETS_KEY: 'not-a-key' }, dataDir: dir, allowCreate: true }),
    );
    expect(malformed).toBeInstanceOf(SecretsKeyError);
    expect((malformed as Error).message).toBe(SECRETS_KEY_SENTENCE);
    const notADir = path.join(dir, 'data');
    writeFileSync(notADir, '');
    const uncreatable = thrown(() => loadSecretsKey({ env: {}, dataDir: notADir, allowCreate: true }));
    expect(uncreatable).toBeInstanceOf(SecretsKeyError);
    expect((uncreatable as SecretsKeyError).detail).toMatch(/could not be created/);
    expect((uncreatable as Error).message).toBe(SECRETS_KEY_SENTENCE);
  });
  it('publishes a new key through a synced temp file and leaves nothing else behind', () => {
    const created = loadSecretsKey({ env: {}, dataDir: dir, allowCreate: true });
    expect(readdirSync(dir)).toEqual(['secrets.key']);
    expect(Buffer.from(readFileSync(keyFile(), 'utf8').trim(), 'base64').equals(created.key)).toBe(true);
  });

  it('ignores and removes a partial temp file from a crash, never reading it as the key', () => {
    writeFileSync(path.join(dir, 'secrets.key.tmp'), 'part');
    expect(() => loadSecretsKey({ env: {}, dataDir: dir, allowCreate: false })).toThrow(SecretsKeyError);
    const created = loadSecretsKey({ env: {}, dataDir: dir, allowCreate: true });
    expect(created.source).toBe('created');
    expect(created.key).toHaveLength(32);
    expect(readdirSync(dir)).toEqual(['secrets.key']);
  });

  it('never replaces an existing key file', () => {
    const existing = `${randomBytes(32).toString('base64')}\n`;
    writeFileSync(keyFile(), existing, { mode: 0o600 });
    expect(() => createKeyFile(keyFile(), randomBytes(32))).toThrow();
    expect(readFileSync(keyFile(), 'utf8')).toBe(existing);
    expect(readdirSync(dir)).toEqual(['secrets.key']);
  });

  it('a key path it cannot read (a directory a bind mount left) is the clear error naming the file', () => {
    mkdirSync(keyFile());
    const error = thrown(() => loadSecretsKey({ env: {}, dataDir: dir, allowCreate: true }));
    expect(error).toBeInstanceOf(SecretsKeyError);
    expect((error as SecretsKeyError).detail).toContain(keyFile());
  });
});

const errno = (code: string) => Object.assign(new Error(code), { code });
/** A volume without hard links (SMB/CIFS, some FUSE mounts): `link` fails with EPERM; calls are recorded. */
const noLinks = (over: Partial<KeyFileOps> = {}) => {
  const calls: string[] = [];
  const ops: KeyFileOps = {
    link: () => {
      calls.push('link');
      throw errno('EPERM');
    },
    exists: (file) => {
      calls.push('exists');
      return NODE_KEY_FILE_OPS.exists(file);
    },
    rename: (from, to) => {
      calls.push('rename');
      NODE_KEY_FILE_OPS.rename(from, to);
    },
    fsyncDir: (d) => NODE_KEY_FILE_OPS.fsyncDir(d),
    ...over,
  };
  return { ops, calls };
};

describe('createKeyFile on a volume without hard links', () => {
  it('renames the synced temp file into place (0600) after checking that no key exists', () => {
    const key = randomBytes(32);
    const { ops, calls } = noLinks();
    createKeyFile(keyFile(), key, ops);
    expect(calls).toEqual(['link', 'exists', 'rename']);
    expect(readFileSync(keyFile(), 'utf8')).toBe(`${key.toString('base64')}\n`);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['secrets.key']);
  });

  it('takes a refused directory sync as best effort there (the key file itself is synced)', () => {
    const key = randomBytes(32);
    const { ops, calls } = noLinks({
      fsyncDir: () => {
        throw errno('EINVAL');
      },
    });
    createKeyFile(keyFile(), key, ops);
    expect(calls).toContain('rename');
    expect(readFileSync(keyFile(), 'utf8').trim()).toBe(key.toString('base64'));
  });

  it('never replaces a key file that exists when the fallback checks', () => {
    const existing = `${randomBytes(32).toString('base64')}\n`;
    writeFileSync(keyFile(), existing, { mode: 0o600 });
    const { ops, calls } = noLinks();
    expect(() => createKeyFile(keyFile(), randomBytes(32), ops)).toThrow(/already exists/);
    expect(calls).toEqual(['link', 'exists']);
    expect(readFileSync(keyFile(), 'utf8')).toBe(existing);
    expect(readdirSync(dir)).toEqual(['secrets.key']);
  });

  it('refuses when another start renamed its own key over this one', () => {
    const theirs = `${randomBytes(32).toString('base64')}\n`;
    const { ops } = noLinks({
      rename: (from, to) => {
        NODE_KEY_FILE_OPS.rename(from, to);
        writeFileSync(to, theirs); // the other start's rename lands right after ours
      },
    });
    expect(() => createKeyFile(keyFile(), randomBytes(32), ops)).toThrow(/another start/);
    expect(readFileSync(keyFile(), 'utf8')).toBe(theirs);
  });

  it('a link error that is not about hard links, and a refused directory sync after a real link, still fail', () => {
    const { ops } = noLinks({
      link: () => {
        throw errno('EACCES');
      },
    });
    expect(() => createKeyFile(keyFile(), randomBytes(32), ops)).toThrow('EACCES');
    expect(readdirSync(dir)).toEqual([]);
    expect(() =>
      createKeyFile(keyFile(), randomBytes(32), {
        ...NODE_KEY_FILE_OPS,
        fsyncDir: () => {
          throw errno('EINVAL');
        },
      }),
    ).toThrow('EINVAL');
  });
});
