import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretsKeyError } from './box.js';
import { loadSecretsKey } from './key.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secrets-key-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
});
