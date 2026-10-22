import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiffFile } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnsafePathError } from '../outputs/safe-fs.js';
import { assignHashes, blobHashNoFollow, inspectDiff, readReviewSide } from './git.js';

let dir: string;
let outside: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@e.com', '-c', 'user.name=t', ...args]);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hash-'));
  outside = mkdtempSync(path.join(tmpdir(), 'hash-out-'));
  git('init', '-q', '-b', 'main');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const file = (
  p: string,
  status: DiffFile['status'] = 'modified',
  additions = 1,
  deletions = 0,
): DiffFile => ({
  path: p,
  oldPath: null,
  status,
  additions,
  deletions,
  hash: '',
  staged: false,
  unstaged: true,
});
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const body = Array.from({ length: 30 }, (_, i) => `content line ${i}`).join('\n') + '\n';

describe('assignHashes', () => {
  it('hashes symlinks by their link text without following them (FIFO, outside files)', async () => {
    const fifo = path.join(outside, 'pipe');
    execFileSync('mkfifo', [fifo]);
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(fifo, path.join(dir, 'fifo-link'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'out-link'));
    symlinkSync('/dev/zero', path.join(dir, 'zero-link'));
    const files = [file('fifo-link'), file('out-link'), file('zero-link')];
    const started = Date.now();
    await assignHashes(dir, files, '');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(files.map((f) => f.hash)).toEqual([
      `link:${sha1(fifo)}`,
      `link:${sha1(path.join(outside, 'secret.txt'))}`,
      `link:${sha1('/dev/zero')}`,
    ]);
  });

  it('does not follow a symlinked directory out of the worktree', async () => {
    writeFileSync(path.join(outside, 'x.txt'), 'x\n');
    symlinkSync(outside, path.join(dir, 'dirlink'));
    const f = file('dirlink/x.txt', 'modified', 2, 3);
    await assignHashes(dir, [f], '');
    expect(f.hash).toBe('unhashed:modified:2:3');
  });

  it('gives unhashable entries a varying fallback instead of an empty hash', async () => {
    mkdirSync(path.join(dir, 'sub'));
    const a = file('sub', 'modified', 1, 2);
    const b = file('sub', 'modified', 4, 2);
    const missing = file('nope.txt', 'added', 5, 0);
    await assignHashes(dir, [a, b, missing], '');
    expect(a.hash).toBe('unhashed:modified:1:2');
    expect(b.hash).toBe('unhashed:modified:4:2');
    expect(missing.hash).toBe('unhashed:added:5:0');
  });

  it('hashes regular files normally', async () => {
    writeFileSync(path.join(dir, 'r.txt'), 'hi\n');
    const f = file('r.txt');
    await assignHashes(dir, [f], '');
    expect(f.hash).toBe(execFileSync('git', ['-C', dir, 'hash-object', 'r.txt']).toString().trim());
  });
});

describe('blobHashNoFollow', () => {
  it('computes the git blob id in Node, equal to git hash-object', async () => {
    const content = Buffer.concat([Buffer.from('binary\0bytes\n'), Buffer.alloc(3000, 7)]);
    writeFileSync(path.join(dir, 'b.bin'), content);
    writeFileSync(path.join(dir, 'empty.txt'), '');
    for (const name of ['b.bin', 'empty.txt']) {
      expect(await blobHashNoFollow(dir, name)).toBe(
        execFileSync('git', ['-C', dir, 'hash-object', '--no-filters', name]).toString().trim(),
      );
    }
  });

  it('never follows a symlink swapped in for the file (O_NOFOLLOW) or a symlinked parent', async () => {
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'swapped.txt'));
    await expect(blobHashNoFollow(dir, 'swapped.txt')).rejects.toBeInstanceOf(UnsafePathError);
    symlinkSync(outside, path.join(dir, 'dirlink'));
    await expect(blobHashNoFollow(dir, 'dirlink/secret.txt')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('refuses a FIFO without blocking', async () => {
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    await expect(blobHashNoFollow(dir, 'pipe')).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe('inspectDiff untracked files', () => {
  it('counts lines of an untracked file but never through a symlink', async () => {
    writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    writeFileSync(path.join(dir, 'new.txt'), 'a\nb\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'one\ntwo\nthree\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'));
    const summary = await inspectDiff(dir, 'main', 'branch', 'r', 'main');
    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
    expect(byPath['new.txt']).toMatchObject({ status: 'untracked', additions: 2 });
    expect(byPath['leak.txt']).toMatchObject({ status: 'untracked', additions: 0 });
  });
});

describe('inspectDiff renames', () => {
  it('resolves plain and brace renames to the new path and hashes them', async () => {
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'top-old.txt'), body);
    writeFileSync(path.join(dir, 'src', 'a.ts'), body);
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('mv', 'top-old.txt', 'top-new.txt');
    git('mv', 'src/a.ts', 'src/b.ts');
    const summary = await inspectDiff(dir, 'main', 'branch', 'r', 'main');
    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['src/b.ts', 'top-new.txt']);
    expect(byPath['top-new.txt']).toMatchObject({ status: 'renamed', oldPath: 'top-old.txt' });
    expect(byPath['src/b.ts']).toMatchObject({ status: 'renamed', oldPath: 'src/a.ts' });
    for (const f of summary.files) expect(f.hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('readReviewSide', () => {
  it('refuses a symlink on the modified side', async () => {
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'l.txt'));
    await expect(readReviewSide(dir, 'main', 'l.txt', 'modified')).rejects.toThrow();
  });

  it('reads the original side of a renamed file from its old path', async () => {
    writeFileSync(path.join(dir, 'old.txt'), body);
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('mv', 'old.txt', 'new.txt');
    expect(await readReviewSide(dir, 'main', 'new.txt', 'original')).toBe(body);
  });
});
