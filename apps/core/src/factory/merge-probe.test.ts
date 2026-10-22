import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitExec from '../git-exec.js';
import {
  findSuperseding,
  mainMoversFor,
  type MergeProbe,
  parseMergeTree,
  probeMerge,
  supersedingFor,
  ticketKeyFromSubject,
} from './merge-probe.js';

vi.mock('../git-exec.js', async (orig) => {
  const actual = await orig<typeof gitExec>();
  return { ...actual, execGitFile: vi.fn(actual.execGitFile) };
});

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const write = (name: string, body: string) => writeFileSync(path.join(dir, name), body);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
  git(dir, 'init', '-q', '-b', 'main');
  write('f', 'a\nb\nc\n');
  write('d', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(gitExec.execGitFile).mockClear();
});

/** Branch `name` from main adding `files` (and optionally more edits) in one feat commit. */
function branchAdding(name: string, key: string, files: string[]): void {
  git(dir, 'checkout', '-q', '-b', name, 'main');
  for (const f of files) write(f, `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `feat(${key}): factory run output`);
  git(dir, 'checkout', '-q', 'main');
}
const mergeInto = (branch: string, key: string) =>
  git(dir, 'merge', '--no-ff', '--no-edit', '-q', '-m', `Merge ${key} (${branch})`, branch);

describe('parseMergeTree', () => {
  it('reads content, add/add and modify/delete conflicts (captured git output)', () => {
    const out = [
      '05852ee282a1f05fc1a4f6aa7edb1a636c8a0e4c',
      'd',
      'f',
      'n',
      '',
      'CONFLICT (modify/delete): d deleted in br and modified in main.  Version main of d left in tree.',
      'Auto-merging f',
      'CONFLICT (content): Merge conflict in f',
      'Auto-merging n',
      'CONFLICT (add/add): Merge conflict in n',
      '',
    ].join('\n');
    expect(parseMergeTree(out)).toEqual([
      { path: 'd', kind: 'modify/delete' },
      { path: 'f', kind: 'content' },
      { path: 'n', kind: 'add/add' },
    ]);
  });
  it('gives a kind to a path a message names inside its text, and `unknown` to one no message names', () => {
    const out = [
      'tree',
      'd~main',
      'g',
      'sub/h.ts',
      '',
      'CONFLICT (file/directory): directory in the way of d~main from main; moving it to d~main instead.',
      'CONFLICT (rename/rename): sub/h.ts renamed to x in br and to y in main.',
      '',
    ].join('\n');
    expect(parseMergeTree(out)).toEqual([
      { path: 'd~main', kind: 'file/directory' },
      { path: 'g', kind: 'unknown' },
      { path: 'sub/h.ts', kind: 'rename/rename' },
    ]);
  });
  it('does not take a longer path for a shorter one', () => {
    const out = ['tree', 'a', 'a.ts', '', 'CONFLICT (file/directory): directory in the way of a.ts from main.', ''].join('\n');
    expect(parseMergeTree(out)).toEqual([
      { path: 'a', kind: 'unknown' },
      { path: 'a.ts', kind: 'file/directory' },
    ]);
  });
  it('returns nothing for a clean merge', () => {
    expect(parseMergeTree('05852ee282a1f05fc1a4f6aa7edb1a636c8a0e4c\n')).toEqual([]);
  });
});

describe('ticketKeyFromSubject', () => {
  it('reads both subject forms', () => {
    expect(ticketKeyFromSubject('feat(EL-10): factory run output')).toBe('EL-10');
    expect(ticketKeyFromSubject('Merge EL-10 (emberline/el-10-x)')).toBe('EL-10');
    expect(ticketKeyFromSubject('chore: x')).toBeNull();
  });
});

describe('probeMerge', () => {
  it('reports no conflicts for a clean merge', async () => {
    branchAdding('b', 'EL-2', ['new.txt']);
    const res = await probeMerge(dir, 'main', 'b');
    expect(res).toMatchObject({ ok: true, conflicts: [] });
  });

  it('lists real conflicts with their kinds', async () => {
    branchAdding('b', 'EL-2', ['n']);
    git(dir, 'checkout', '-q', 'b');
    write('f', 'a\nB1\nc\n');
    git(dir, 'commit', '-q', '-am', 'edit');
    git(dir, 'checkout', '-q', 'main');
    write('f', 'a\nB2\nc\n');
    write('n', 'main\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'main edit');
    const res = await probeMerge(dir, 'main', 'b');
    expect(res.ok && res.conflicts).toEqual([
      { path: 'f', kind: 'content' },
      { path: 'n', kind: 'add/add' },
    ]);
  });

  it('reports non-ASCII paths verbatim, not octal-quoted', async () => {
    branchAdding('b', 'EL-2', ['çiçek.ts']);
    write('çiçek.ts', 'main\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'main adds it too');
    const res = await probeMerge(dir, 'main', 'b');
    expect(res.ok && res.conflicts).toEqual([{ path: 'çiçek.ts', kind: 'add/add' }]);
  });

  it('a branch that replaces a file with a directory main edited: no conflict reads as content', async () => {
    git(dir, 'checkout', '-q', '-b', 'b');
    git(dir, 'rm', '-q', 'd');
    mkdirSync(path.join(dir, 'd'));
    write('d/inner', 'n\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'dir');
    git(dir, 'checkout', '-q', 'main');
    write('d', 'y\n');
    git(dir, 'commit', '-q', '-am', 'main edits d');
    const res = await probeMerge(dir, 'main', 'b');
    const conflicts = res.ok ? res.conflicts : [];
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.every((c) => c.kind !== 'content')).toBe(true);
    expect(conflicts.find((c) => c.path.startsWith('d'))?.kind).toMatch(/directory|delete|unknown/);
  });

  it('a cached probe cannot be changed by a caller', async () => {
    branchAdding('b', 'EL-2', ['new.txt']);
    const a = await probeMerge(dir, 'main', 'b');
    expect(() => (a as unknown as { conflicts: unknown[] }).conflicts.push({ path: 'x', kind: 'content' })).toThrow();
    expect(((await probeMerge(dir, 'main', 'b')) as MergeProbe).conflicts.map((c) => c.path)).not.toContain('x');
  });

  it('fails softly when the branch is missing', async () => {
    const res = await probeMerge(dir, 'main', 'nope');
    expect(res.ok).toBe(false);
  });

  it('serves a repeated probe from the cache without running merge-tree again', async () => {
    branchAdding('b', 'EL-2', ['new.txt']);
    await probeMerge(dir, 'main', 'b');
    const spy = vi.mocked(gitExec.execGitFile);
    spy.mockClear();
    await probeMerge(dir, 'main', 'b');
    expect(spy.mock.calls.some((c) => c[0].includes('merge-tree'))).toBe(false);
  });
});

describe('findSuperseding', () => {
  const files = ['a.ts', 'b.ts', 'c.ts'];
  const conflicts = files.map((p) => ({ path: p, kind: 'add/add' }));

  it('names the ticket that already added the same files', async () => {
    branchAdding('el-10', 'EL-10', files);
    mergeInto('el-10', 'EL-10');
    expect(await findSuperseding(dir, 'main', conflicts, 'EL-11')).toEqual({ key: 'EL-10', files: 3 });
  });

  it('returns the most frequent adder when they are mixed', async () => {
    branchAdding('el-10', 'EL-10', ['a.ts', 'b.ts']);
    mergeInto('el-10', 'EL-10');
    branchAdding('el-12', 'EL-12', ['c.ts']);
    mergeInto('el-12', 'EL-12');
    expect(await findSuperseding(dir, 'main', conflicts, 'EL-11')).toEqual({ key: 'EL-10', files: 2 });
  });

  it('ignores its own key and non add/add conflicts', async () => {
    branchAdding('el-11', 'EL-11', files);
    mergeInto('el-11', 'EL-11');
    expect(await findSuperseding(dir, 'main', conflicts, 'EL-11')).toBeNull();
    expect(await findSuperseding(dir, 'main', [{ path: 'a.ts', kind: 'content' }], null)).toBeNull();
  });

  it('credits the merge commit when the agent committed without a ticket key', async () => {
    git(dir, 'checkout', '-q', '-b', 'el-10', 'main');
    for (const f of files) write(f, 'el-10\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Add the game board');
    git(dir, 'checkout', '-q', 'main');
    mergeInto('el-10', 'EL-10');
    expect(await findSuperseding(dir, 'main', conflicts, 'EL-11')).toEqual({ key: 'EL-10', files: 3 });
  });

  it('still reads feat(KEY) commits made directly on main', async () => {
    for (const f of files) write(f, 'direct\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat(EL-10): factory run output');
    expect(await findSuperseding(dir, 'main', conflicts, 'EL-11')).toEqual({ key: 'EL-10', files: 3 });
  });

  it('finds the adder of a non-ASCII path', async () => {
    branchAdding('el-10', 'EL-10', ['çiçek.ts']);
    mergeInto('el-10', 'EL-10');
    const res = await findSuperseding(dir, 'main', [{ path: 'çiçek.ts', kind: 'add/add' }], 'EL-11');
    expect(res).toEqual({ key: 'EL-10', files: 1 });
  });
});

describe('supersedingFor', () => {
  const files = ['a.ts', 'b.ts'];

  it('does not cache a result read while a git log failed', async () => {
    branchAdding('el-10', 'EL-10', files);
    mergeInto('el-10', 'EL-10');
    const mainHead = git(dir, 'rev-parse', 'main');
    const probe = {
      ok: true as const,
      mainHead,
      branchHead: mainHead,
      conflicts: files.map((p) => ({ path: p, kind: 'add/add' })),
    };
    const spy = vi.mocked(gitExec.execGitFile);
    spy.mockRejectedValueOnce(new Error('runner busy')).mockRejectedValueOnce(new Error('runner busy'));
    expect(await supersedingFor(dir, probe, 'EL-11')).toBeNull();
    expect(await supersedingFor(dir, probe, 'EL-11')).toEqual({ key: 'EL-10', files: 2 });
  });
});

describe('mainMoversFor', () => {
  it('names the tickets whose commits on main touched the conflicted paths, newest first, without the own key', async () => {
    branchAdding('b', 'EL-9', ['f']);
    for (const [key, body] of [['EL-12', '1'], ['EL-14', '2'], ['EL-9', '3'], ['EL-12', '4']] as const) {
      write('f', `${body}\n`);
      git(dir, 'commit', '-q', '-am', `feat(${key}): change`);
    }
    write('other', 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat(EL-99): elsewhere');
    const probe = (await probeMerge(dir, 'main', 'b')) as MergeProbe;
    expect(probe.conflicts.map((c) => c.path)).toEqual(['f']);
    expect(await mainMoversFor(dir, probe, 'EL-9')).toEqual(['EL-12', 'EL-14']);
    expect(await mainMoversFor(dir, probe, null)).toEqual(['EL-12', 'EL-9', 'EL-14']);
  });

  it('is empty without conflicts', async () => {
    branchAdding('b', 'EL-2', ['new.txt']);
    expect(await mainMoversFor(dir, (await probeMerge(dir, 'main', 'b')) as MergeProbe, 'EL-2')).toEqual([]);
  });
});
