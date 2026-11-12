import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitExec from '../git-exec.js';
import { mergeRunBranch } from '../runs/worktree.js';
import { rmTemp } from '../test-rm.js';
import { type HealGate, healConflicts, resolveAdditiveHunks } from './conflict-heal.js';

vi.mock('../git-exec.js', async (orig) => {
  const actual = await orig<typeof gitExec>();
  return { ...actual, execGitFile: vi.fn(actual.execGitFile) };
});

let dir: string;
let main: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const MAKEFILE = '.PHONY: build\n\nbuild:\n\tpnpm build\n';
const CI = 'name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
const PROJECT = '# Project\n\n## Vision\n\nShip it.\n';

function addWorktree(name: string): string {
  const wt = path.join(dir, name);
  git(main, 'worktree', 'add', '-q', '-b', `emberline/${name}`, wt, 'HEAD');
  return wt;
}

const append = (wt: string, file: string, text: string) =>
  writeFileSync(path.join(wt, file), readFileSync(path.join(wt, file), 'utf8') + text);

function commitAll(wt: string, message: string): void {
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', message);
}

/** Two runs that both append to Makefile, ci.yml and PROJECT.md; `a` is merged into main already. */
function parallelAppends(): { a: string; b: string } {
  const a = addWorktree('a');
  const b = addWorktree('b');
  append(a, 'Makefile', '\nlint:\n\tpnpm lint\n');
  append(a, '.github/workflows/ci.yml', '  lint:\n    runs-on: ubuntu-latest\n');
  append(a, 'PROJECT.md', '\n## Lint\n\nLint everything.\n');
  commitAll(a, 'feat(T-1): lint');
  append(b, 'Makefile', '\ntest:\n\tpnpm test\n');
  append(b, '.github/workflows/ci.yml', '  test:\n    runs-on: ubuntu-latest\n');
  append(b, 'PROJECT.md', '\n## Tests\n\nTest everything.\n');
  commitAll(b, 'feat(T-2): tests');
  git(main, 'merge', '--no-ff', '-q', '-m', 'Merge T-1', 'emberline/a');
  return { a, b };
}

/** Everything the heal must leave as it was: branch tip, index entries, tracked state, git dir files. */
function snapshot(wt: string) {
  const gitDir = git(wt, 'rev-parse', '--absolute-git-dir');
  return {
    head: git(wt, 'rev-parse', 'HEAD'),
    branch: git(wt, 'symbolic-ref', 'HEAD'),
    index: git(wt, 'ls-files', '-s'),
    status: git(wt, 'status', '--porcelain', '--untracked-files=all'),
    mergeHead: existsSync(path.join(gitDir, 'MERGE_HEAD')),
    files: ['Makefile', 'PROJECT.md', '.github/workflows/ci.yml'].map((f) =>
      existsSync(path.join(wt, f)) ? readFileSync(path.join(wt, f), 'utf8') : null,
    ),
  };
}

const PASSING: () => Promise<HealGate> = async () => ({ ok: true });

const heal = (wt: string, extra: Partial<Parameters<typeof healConflicts>[0]> = {}) =>
  healConflicts({
    worktreePath: wt,
    mainWorkspacePath: main,
    mainBranch: 'main',
    label: 'T-2',
    stale: () => false,
    verify: PASSING,
    ...extra,
  });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heal-'));
  main = path.join(dir, 'main');
  mkdirSync(path.join(main, '.github', 'workflows'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(main, 'Makefile'), MAKEFILE);
  writeFileSync(path.join(main, '.github', 'workflows', 'ci.yml'), CI);
  writeFileSync(path.join(main, 'PROJECT.md'), PROJECT);
  writeFileSync(path.join(main, 'app.js'), 'const a = 1;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmTemp(dir);
  vi.mocked(gitExec.execGitFile).mockClear();
});

describe('resolveAdditiveHunks', () => {
  const hunk = (ours: string, base: string, theirs: string) =>
    `<<<<<<< ours\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> theirs\n`;

  it('resolves an empty-base hunk as ours then theirs and keeps the rest', () => {
    const text = `head\n${hunk('a1\na2\n', '', 'b1\n')}tail\n`;
    expect(resolveAdditiveHunks(text)).toEqual({ resolved: 'head\na1\na2\nb1\ntail\n' });
  });

  it('keeps one copy when both sides added the same lines', () => {
    expect(resolveAdditiveHunks(hunk('same\n', '', 'same\n'))).toEqual({ resolved: 'same\n' });
  });

  it('resolves every hunk of a file', () => {
    const text = `${hunk('a\n', '', 'b\n')}mid\n${hunk('', '', 'c\n')}`;
    expect(resolveAdditiveHunks(text)).toEqual({ resolved: 'a\nb\nmid\nc\n' });
  });

  it('leaves a file with any hunk that has a base unresolved', () => {
    const text = `${hunk('a\n', '', 'b\n')}${hunk('x2\n', 'x\n', 'x3\n')}`;
    expect(resolveAdditiveHunks(text)).toEqual({ unresolved: true });
  });

  it('refuses two-way markers, malformed markers and text without a hunk', () => {
    expect(resolveAdditiveHunks('<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n')).toEqual({
      unresolved: true,
    });
    expect(resolveAdditiveHunks('<<<<<<< ours\na\n||||||| base\n')).toEqual({ unresolved: true });
    expect(resolveAdditiveHunks('a\n>>>>>>> theirs\n')).toEqual({ unresolved: true });
    expect(resolveAdditiveHunks('plain text\n')).toEqual({ unresolved: true });
  });

  it('reads markers of the given size only', () => {
    const big = (c: string) => c.repeat(12);
    const text = `<<<<<<< not a marker\n${big('<')} ours\nx\n${big('|')} base\n${big('=')}\ny\n${big('>')} theirs\n`;
    expect(resolveAdditiveHunks(text, 12)).toEqual({ resolved: '<<<<<<< not a marker\nx\ny\n' });
  });
});

describe('healConflicts (real git repos)', () => {
  it('AC-5.1: merges main into the branch keeping both appended targets, jobs and sections', async () => {
    const { b } = parallelAppends();
    const before = git(b, 'rev-parse', 'HEAD');
    const mainTip = git(main, 'rev-parse', 'HEAD');
    const res = await heal(b);
    expect(res).toMatchObject({
      healed: true,
      files: ['.github/workflows/ci.yml', 'Makefile', 'PROJECT.md'],
    });
    expect(git(b, 'log', '-1', '--format=%s')).toBe(
      'Merge main into emberline/b (auto-resolved: .github/workflows/ci.yml, Makefile, PROJECT.md)',
    );
    expect(git(b, 'log', '-1', '--format=%P')).toBe(`${before} ${mainTip}`);
    expect(git(b, 'log', '-1', '--format=%an')).toBe('Emberline AI Factory');
    const makefile = readFileSync(path.join(b, 'Makefile'), 'utf8');
    // Ours (the run's branch) first, then theirs (main).
    expect(makefile).toBe(`${MAKEFILE}\ntest:\n\tpnpm test\n\nlint:\n\tpnpm lint\n`);
    const ci = readFileSync(path.join(b, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toBe(`${CI}  test:\n    runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n`);
    expect(readFileSync(path.join(b, 'PROJECT.md'), 'utf8')).toMatch(/## Tests[\s\S]*## Lint/);
    expect(git(b, 'status', '--porcelain')).toBe('');
    // Merging the branch into main now is a clean merge.
    git(main, 'merge', '--no-ff', '-q', '-m', 'Merge T-2', 'emberline/b');
    expect(readFileSync(path.join(main, 'Makefile'), 'utf8')).toBe(makefile);
  });

  it('AC-5.2: an edit/edit conflict leaves worktree, branch tip and index exactly as before', async () => {
    const a = addWorktree('a');
    const b = addWorktree('b');
    writeFileSync(path.join(a, 'app.js'), 'const a = 2;\n');
    append(a, 'Makefile', '\nlint:\n\tpnpm lint\n');
    commitAll(a, 'a');
    writeFileSync(path.join(b, 'app.js'), 'const a = 3;\n');
    append(b, 'Makefile', '\ntest:\n\tpnpm test\n');
    commitAll(b, 'b');
    git(main, 'merge', '--no-ff', '-q', '-m', 'Merge a', 'emberline/a');
    const before = snapshot(b);
    const verify = vi.fn(PASSING);
    const res = await heal(b, { verify });
    expect(res).toMatchObject({
      healed: false,
      reason: 'unresolved',
      conflicts: ['Makefile', 'app.js'],
      unresolved: ['app.js'],
    });
    expect(verify).not.toHaveBeenCalled();
    expect(snapshot(b)).toEqual(before);
    expect(readFileSync(path.join(b, 'app.js'), 'utf8')).toBe('const a = 3;\n');
  });

  it('AC-5.3: a failing gate undoes the heal and reports the gate output', async () => {
    const { b } = parallelAppends();
    const before = snapshot(b);
    const res = await heal(b, { verify: async () => ({ ok: false, output: 'make: *** [test] Error 1' }) });
    expect(res).toMatchObject({
      healed: false,
      reason: 'gate_failed',
      gateFailure: 'make: *** [test] Error 1',
    });
    expect(snapshot(b)).toEqual(before);
  });

  it('leaves lockfile and modify/delete conflicts for the agent', async () => {
    writeFileSync(path.join(main, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(path.join(main, 'gone.txt'), 'x\n');
    commitAll(main, 'lock');
    const a = addWorktree('a');
    const b = addWorktree('b');
    append(a, 'pnpm-lock.yaml', 'a: 1\n');
    rmSync(path.join(a, 'gone.txt'));
    commitAll(a, 'a');
    append(b, 'pnpm-lock.yaml', 'b: 1\n');
    append(b, 'gone.txt', 'y\n');
    commitAll(b, 'b');
    git(main, 'merge', '--no-ff', '-q', '-m', 'Merge a', 'emberline/a');
    const before = snapshot(b);
    const res = await heal(b);
    expect(res).toMatchObject({
      healed: false,
      reason: 'unresolved',
      unresolved: ['gone.txt', 'pnpm-lock.yaml'],
    });
    expect(snapshot(b)).toEqual(before);
  });

  it('never union-merges a lockfile, whichever package manager wrote it and at any depth', async () => {
    const locks = ['uv.lock', 'apps/web/bun.lock', 'Gemfile.lock', 'flake.lock', 'npm-shrinkwrap.json'];
    for (const lock of locks) {
      mkdirSync(path.dirname(path.join(main, lock)), { recursive: true });
      writeFileSync(path.join(main, lock), 'version = 1\n');
    }
    commitAll(main, 'locks');
    const a = addWorktree('a');
    const b = addWorktree('b');
    for (const lock of locks) append(a, lock, 'a = 1\n');
    commitAll(a, 'a');
    for (const lock of locks) append(b, lock, 'b = 1\n');
    commitAll(b, 'b');
    git(main, 'merge', '--no-ff', '-q', '-m', 'Merge a', 'emberline/a');
    const before = snapshot(b);
    const res = await heal(b);
    expect(res).toMatchObject({ healed: false, reason: 'unresolved', unresolved: [...locks].sort() });
    expect(snapshot(b)).toEqual(before);
  });

  it('undoes an additive heal that no check could verify', async () => {
    const { b } = parallelAppends();
    const before = snapshot(b);
    const res = await heal(b, {
      verify: async () => ({ ok: 'unverified', reason: 'the build gate is off' }),
    });
    expect(res).toMatchObject({ healed: false, reason: 'unverified' });
    expect(res.healed === false && res.message).toContain('the build gate is off');
    expect(snapshot(b)).toEqual(before);
  });

  it('changes nothing when the agent worked again', async () => {
    const { b } = parallelAppends();
    const before = snapshot(b);
    expect(await heal(b, { stale: () => true })).toMatchObject({ healed: false, reason: 'turn_moved' });
    expect(snapshot(b)).toEqual(before);
    let calls = 0;
    const res = await heal(b, { stale: () => ++calls > 1 });
    expect(res).toMatchObject({ healed: false, reason: 'turn_moved' });
    expect(snapshot(b)).toEqual(before);
  });

  it('does not start on a worktree with uncommitted changes', async () => {
    const { b } = parallelAppends();
    append(b, 'app.js', '// wip\n');
    const before = snapshot(b);
    expect(await heal(b)).toMatchObject({ healed: false, reason: 'worktree_busy' });
    expect(snapshot(b)).toEqual(before);
  });

  it('AC-5.7: runs git with hooks off and diff3, and refuses a link planted in the git dir', async () => {
    const { b } = parallelAppends();
    const hooks = path.join(main, '.git', 'hooks');
    const marker = path.join(dir, 'hook-ran');
    for (const hook of ['pre-merge-commit', 'post-merge', 'post-checkout', 'reference-transaction']) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(path.join(hooks, hook), 0o755);
    }
    const res = await heal(b);
    expect(res.healed).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const mergeCall = vi
      .mocked(gitExec.execGitFile)
      .mock.calls.map(([args]) => args)
      .find((args) => args.includes('merge') && args.includes('--no-commit'));
    expect(mergeCall).toEqual(
      expect.arrayContaining(['core.hooksPath=/dev/null', 'merge.conflictStyle=diff3']),
    );

    // A second run's worktree whose git dir holds a link where a git state file goes.
    const c = addWorktree('c');
    append(c, 'Makefile', '\nfmt:\n\tpnpm fmt\n');
    commitAll(c, 'c');
    git(main, 'merge', '--no-ff', '-q', '-m', 'Merge b', 'emberline/b');
    const secret = path.join(dir, 'secret');
    writeFileSync(secret, `${'f'.repeat(40)}\n`);
    symlinkSync(secret, path.join(git(c, 'rev-parse', '--absolute-git-dir'), 'CHERRY_PICK_HEAD'));
    const before = snapshot(c);
    const refused = await heal(c, { label: 'T-3' });
    expect(refused).toMatchObject({ healed: false, reason: 'git_error' });
    expect(refused.healed === false && refused.message).toMatch(/not a regular file/);
    expect(snapshot(c)).toEqual(before);
  });
});

describe('mergeRunBranch with the heal', () => {
  const run = (wt: string, name: string) => ({
    id: `run-${name}-0000`,
    worktreePath: wt,
    branch: `emberline/${name}`,
  });

  it('lands both runs in main with no person involved and notes what it resolved', async () => {
    const { b } = parallelAppends();
    const notes: Array<[string, Record<string, unknown>]> = [];
    const res = await mergeRunBranch({
      run: run(b, 'b'),
      mainWorkspacePath: main,
      ticketKey: 'T-2',
      stale: () => false,
      heal: { verify: PASSING, note: (type, payload) => notes.push([type, payload]) },
    });
    expect(res).toMatchObject({
      ok: true,
      resolution: 'auto_resolved',
      autoResolved: ['.github/workflows/ci.yml', 'Makefile', 'PROJECT.md'],
    });
    expect(notes).toEqual([
      ['conflict_auto_resolved', { files: res?.autoResolved, commitSha: expect.any(String) }],
    ]);
    const makefile = readFileSync(path.join(main, 'Makefile'), 'utf8');
    expect(makefile).toContain('lint:');
    expect(makefile).toContain('test:');
    expect(git(main, 'log', '-1', '--format=%s')).toBe('Merge T-2 (emberline/b)');
  });

  it('keeps main unchanged and reports the failed heal when the gate fails', async () => {
    const { b } = parallelAppends();
    const mainBefore = git(main, 'rev-parse', 'HEAD');
    const notes: string[] = [];
    const res = await mergeRunBranch({
      run: run(b, 'b'),
      mainWorkspacePath: main,
      ticketKey: 'T-2',
      stale: () => false,
      heal: { verify: async () => ({ ok: false, output: 'boom' }), note: (type) => notes.push(type) },
    });
    expect(res).toMatchObject({ ok: false, resolution: null, healFailure: { reason: 'gate_failed' } });
    expect(res?.conflicts).toEqual(['.github/workflows/ci.yml', 'Makefile', 'PROJECT.md']);
    expect(notes).toEqual(['conflict_heal_failed']);
    expect(git(main, 'rev-parse', 'HEAD')).toBe(mainBefore);
    expect(git(main, 'status', '--porcelain')).toBe('');
  });
});
