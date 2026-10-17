import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createExclusiveFile,
  openFileUnder,
  SafeRoot,
  streamOpenedFile,
  UnsafePathError,
} from './safe-fs.js';

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'safe-fs-'));
  outside = mkdtempSync(path.join(tmpdir(), 'safe-fs-outside-'));
  writeFileSync(path.join(outside, 'secret.db'), 'core secrets');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const put = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};

describe('openFileUnder', () => {
  it('opens a regular file and streams exactly its size', async () => {
    put('build/app.apk', 'apk bytes');
    const opened = await openFileUnder(dir, 'build/app.apk');
    expect(opened.size).toBe(9);
    const chunks: Buffer[] = [];
    for await (const chunk of streamOpenedFile(opened)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('apk bytes');
  });

  it('refuses a symlinked file, a symlinked directory and a FIFO without blocking', async () => {
    mkdirSync(path.join(dir, 'build'));
    symlinkSync(path.join(outside, 'secret.db'), path.join(dir, 'build/app.apk'));
    await expect(openFileUnder(dir, 'build/app.apk')).rejects.toBeInstanceOf(UnsafePathError);

    symlinkSync(outside, path.join(dir, 'pkg'));
    await expect(openFileUnder(dir, 'pkg/secret.db')).rejects.toBeInstanceOf(UnsafePathError);

    execFileSync('mkfifo', [path.join(dir, 'build/pipe.apk')]);
    await expect(openFileUnder(dir, 'build/pipe.apk')).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe('createExclusiveFile', () => {
  it('never opens an existing entry or a planted link', async () => {
    symlinkSync(path.join(outside, 'secret.db'), path.join(dir, '.x.part'));
    await expect(createExclusiveFile(dir, '.x.part')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(path.join(outside, 'secret.db'), 'utf8')).toBe('core secrets');
    const handle = await createExclusiveFile(dir, '.y.part');
    await handle.close();
    expect(existsSync(path.join(dir, '.y.part'))).toBe(true);
  });
});

describe('SafeRoot', () => {
  it('refuses paths that leave the root', () => {
    const root = new SafeRoot(dir, 'archive');
    for (const bad of ['../x', '/etc/passwd', '', 'a/../../x', 'a\0b']) {
      expect(() => root.resolve(bad)).toThrow(UnsafePathError);
    }
    expect(root.resolve('p/r/app.apk')).toBe(path.join(dir, 'archive/p/r/app.apk'));
  });

  it('unlinks a planted link itself, and nothing through a linked directory', async () => {
    const root = new SafeRoot(dir, 'archive');
    mkdirSync(path.join(dir, 'archive/p/r'), { recursive: true });
    symlinkSync(path.join(outside, 'secret.db'), path.join(dir, 'archive/p/r/app.apk'));
    expect(await root.unlinkFile('p/r/app.apk')).toBe(true);
    expect(existsSync(path.join(outside, 'secret.db'))).toBe(true);

    symlinkSync(outside, path.join(dir, 'archive/p/linked'));
    await expect(root.unlinkFile('p/linked/secret.db')).rejects.toBeInstanceOf(UnsafePathError);
    expect(existsSync(path.join(outside, 'secret.db'))).toBe(true);
  });

  it('removes a tree without following links in it, and nothing under a linked root', async () => {
    mkdirSync(path.join(dir, 'archive/p'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'archive/p/linked'));
    await new SafeRoot(dir, 'archive').removeTree('p');
    expect(existsSync(path.join(dir, 'archive/p'))).toBe(false);
    expect(existsSync(path.join(outside, 'secret.db'))).toBe(true);

    rmSync(path.join(dir, 'archive'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'archive'));
    const linkedRoot = new SafeRoot(dir, 'archive');
    await linkedRoot.removeTree('secret.db');
    expect(existsSync(path.join(outside, 'secret.db'))).toBe(true);
    await expect(linkedRoot.realDir('p', { create: true })).rejects.toBeInstanceOf(UnsafePathError);
    expect(lstatSync(path.join(dir, 'archive')).isSymbolicLink()).toBe(true);
  });
});
