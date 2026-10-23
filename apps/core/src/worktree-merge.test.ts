import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { unavailable } from './errors.js';
import { runProducedChanges, withMainWorkspaceLock } from './factory/merge.js';
import { syncWorktreeToMainWorkspace } from './factory/service.js';
import { commitWorktree } from './runs/git.js';
import { rmTemp } from './test-rm.js';

let dir: string;
let main: string;

// stderr is kept from the test output (git's conflict hints); a failure still carries it.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function addWorktree(name: string): string {
  const wt = path.join(dir, name);
  git(main, 'worktree', 'add', '-q', '-b', `emberline/${name}`, wt, 'HEAD');
  return wt;
}

const sync = (worktreePath: string, ticketKey: string) =>
  syncWorktreeToMainWorkspace({
    worktreePath,
    mainWorkspacePath: main,
    ticketKey,
    runId: `run-${ticketKey}`,
  });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'merge-'));
  main = path.join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(main, '.gitignore'), '.venv/\n');
  writeFileSync(path.join(main, 'app.js'), 'line1\nline2\nline3\n');
  writeFileSync(path.join(main, 'old.txt'), 'remove me\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmTemp(dir);
});

describe('syncWorktreeToMainWorkspace (git merge)', () => {
  it('merges two parallel runs without losing either side or untracked files', async () => {
    // Untracked/ignored files that only exist in the main workspace.
    writeFileSync(path.join(main, '.env'), 'SECRET=1\n');
    mkdirSync(path.join(main, '.venv'));
    writeFileSync(path.join(main, '.venv', 'pyvenv.cfg'), 'home=/usr\n');

    const a = addWorktree('a');
    const b = addWorktree('b');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    rmSync(path.join(a, 'old.txt'));
    writeFileSync(path.join(b, 'feature-b.js'), 'b\n');
    writeFileSync(path.join(b, 'app.js'), 'line1\nline2\nline3\nline4\n');

    const [resA, resB] = await Promise.all([sync(a, 'T-1'), sync(b, 'T-2')]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    expect(readFileSync(path.join(main, 'feature-a.js'), 'utf8')).toBe('a\n');
    expect(readFileSync(path.join(main, 'feature-b.js'), 'utf8')).toBe('b\n');
    expect(readFileSync(path.join(main, 'app.js'), 'utf8')).toContain('line4');
    expect(existsSync(path.join(main, 'old.txt'))).toBe(false);
    expect(readFileSync(path.join(main, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(existsSync(path.join(main, '.venv', 'pyvenv.cfg'))).toBe(true);
    // The secret stayed untracked.
    expect(git(main, 'ls-files', '.env')).toBe('');
    expect(git(main, 'log', '--format=%s')).toMatch(/Merge T-2[\s\S]*Merge T-1|Merge T-1[\s\S]*Merge T-2/);
  });

  it('refuses a conflicting merge and leaves the main workspace unchanged', async () => {
    const a = addWorktree('a');
    const b = addWorktree('b');
    writeFileSync(path.join(a, 'app.js'), 'line1\nfrom-a\nline3\n');
    writeFileSync(path.join(b, 'app.js'), 'line1\nfrom-b\nline3\n');

    expect((await sync(a, 'T-1')).ok).toBe(true);
    const head = git(main, 'rev-parse', 'HEAD');
    const res = await sync(b, 'T-2');
    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(['app.js']);
    expect(git(main, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(main, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(main, 'app.js'), 'utf8')).toContain('from-a');
  });

  it("reports main's head as the merge saw it, not after a queued change", async () => {
    const a = addWorktree('a');
    const b = addWorktree('b');
    writeFileSync(path.join(a, 'app.js'), 'line1\nfrom-a\nline3\n');
    writeFileSync(path.join(b, 'app.js'), 'line1\nfrom-b\nline3\n');
    expect((await sync(a, 'T-1')).ok).toBe(true);
    const head = git(main, 'rev-parse', 'HEAD');
    const pending = sync(b, 'T-2');
    // Queued behind the merge's lock: it moves main right after the merge gives up.
    const queued = withMainWorkspaceLock(main, async () => {
      writeFileSync(path.join(main, 'z.txt'), 'z\n');
      git(main, 'add', '-A');
      git(main, 'commit', '-q', '-m', 'later');
    });
    const res = await pending;
    await queued;
    expect(res.ok).toBe(false);
    expect(res.mainHead).toBe(head);
    expect(git(main, 'rev-parse', 'HEAD')).not.toBe(head);
  });

  it('keeps edits made directly in the main workspace', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeFileSync(path.join(main, 'app.js'), 'line1\nedited in main\nline3\n');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(main, 'app.js'), 'utf8')).toContain('edited in main');
    expect(existsSync(path.join(main, 'feature-a.js'))).toBe(true);
  });

  it('refuses instead of overwriting an untracked main file the run also created', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'notes.md'), 'from the agent\n');
    writeFileSync(path.join(main, 'notes.md'), 'mine, untracked\n');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(false);
    expect(readFileSync(path.join(main, 'notes.md'), 'utf8')).toBe('mine, untracked\n');
  });

  it('is idempotent once the run is merged', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    expect((await sync(a, 'T-1')).filesSynced).toBe(1);
    const head = git(main, 'rev-parse', 'HEAD');
    const again = await sync(a, 'T-1');
    expect(again.ok).toBe(true);
    expect(git(main, 'rev-parse', 'HEAD')).toBe(head);
  });
});

describe('a merge refused before it starts', () => {
  const refusing = (worktreePath: string, beforeMerge: () => void) =>
    syncWorktreeToMainWorkspace({
      worktreePath,
      mainWorkspacePath: main,
      ticketKey: 'T-1',
      runId: 'run-T-1',
      beforeMerge,
    });
  /** The branch, the index (with what the agent staged) and the files, as git shows them. */
  const stateOf = (wt: string) => ({
    head: git(wt, 'rev-parse', 'HEAD'),
    status: git(wt, 'status', '--porcelain', '--untracked-files=all'),
    staged: git(wt, 'diff', '--cached', '--name-status'),
    unstaged: git(wt, 'diff', '--name-status'),
  });

  it("leaves the run's branch, its index and its files as they were", async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 edited\nline3\n');
    writeFileSync(path.join(a, 'staged.js'), 'staged\n');
    git(a, 'add', 'staged.js');
    const before = stateOf(a);
    const mainBefore = git(main, 'rev-parse', 'HEAD');

    await expect(
      refusing(a, () => {
        throw new Error('the agent works again');
      }),
    ).rejects.toThrow('the agent works again');
    expect(stateOf(a)).toEqual(before);
    expect(git(a, 'log', '--format=%s')).toBe('init');
    expect(git(main, 'rev-parse', 'HEAD')).toBe(mainBefore);
  });

  it('once allowed, the output is committed as before, with what the agent staged by hand', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    mkdirSync(path.join(a, '.venv'));
    writeFileSync(path.join(a, '.venv', 'kept.cfg'), 'kept\n');
    git(a, 'add', '-f', '.venv/kept.cfg');
    let calls = 0;
    const res = await refusing(a, () => {
      calls += 1;
      // Asked with the output commit built and nothing moved yet.
      expect(git(a, 'log', '--format=%s')).toBe('init');
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(1);
    expect(git(a, 'log', '--format=%s')).toBe('feat(T-1): factory run output\ninit');
    expect(git(a, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      '.venv/kept.cfg',
      'feature-a.js',
    ]);
    expect(git(a, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(readFileSync(path.join(main, 'feature-a.js'), 'utf8')).toBe('a\n');
  });

  it('the index copy is made and removed in the runner; one an interrupted merge left behind is replaced', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    const scratch = `${git(a, 'rev-parse', '--path-format=absolute', '--git-path', 'index')}.emberline-output`;
    // Left behind: not an index, and read-only.
    writeFileSync(scratch, 'not an index');
    chmodSync(scratch, 0o444);
    const requests: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      requests.push(request);
      return localCommandExecutor(request);
    });
    try {
      const res = await refusing(a, () => undefined);
      expect(res.ok).toBe(true);
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    expect(git(a, 'show', '--name-only', '--format=', 'HEAD')).toBe('feature-a.js');
    expect(existsSync(scratch)).toBe(false);
    const onScratch = requests
      .filter((r) => r.file !== 'git' && r.args.includes(scratch))
      .map((r) => [r.file, ...r.args.filter((x) => x !== scratch)].join(' '));
    expect(onScratch).toEqual([
      'rm -f --',
      `cp -- ${scratch.slice(0, -'.emberline-output'.length)}`,
      'rm -f --',
    ]);
    // The runner's own git commands do not read it.
    expect(git(a, 'status', '--porcelain')).toBe('');
  });

  it("an agent's resolved but unconcluded `git merge main` is concluded as `git commit` would: a merge commit, no MERGE_HEAD", async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 run\nline3\n');
    git(a, 'commit', '-q', '-am', 'run edit');
    writeFileSync(path.join(main, 'app.js'), 'line1\nline2 main\nline3\n');
    git(main, 'commit', '-q', '-am', 'main edit');
    const mainTip = git(main, 'rev-parse', 'HEAD');
    expect(() => git(a, 'merge', '-q', 'main')).toThrow();
    // Resolved on disk, not added, not committed.
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 main and run\nline3\n');
    const res = await refusing(a, () => undefined);
    expect(res.ok, res.summary).toBe(true);
    expect(git(a, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([
      git(a, 'rev-parse', 'HEAD^1'),
      mainTip,
    ]);
    expect(() => git(a, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(a, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(main, 'app.js'), 'utf8')).toBe('line1\nline2 main and run\nline3\n');
  });

  it("an agent's resolved but unconcluded cherry-pick keeps the picked commit's author, and its state ends", async () => {
    const a = addWorktree('a');
    git(main, 'checkout', '-q', '-b', 'other');
    writeFileSync(path.join(main, 'picked.js'), 'picked\n');
    writeFileSync(path.join(main, 'app.js'), 'line1\nline2 other\nline3\n');
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Picked Author',
        '-c',
        'user.email=picked@example.com',
        'commit',
        '-q',
        '-am',
        'pick me',
      ],
      { cwd: main },
    );
    git(main, 'add', 'picked.js');
    git(main, 'commit', '-q', '--amend', '--no-edit');
    const picked = git(main, 'rev-parse', 'HEAD');
    git(main, 'checkout', '-q', 'main');
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 run\nline3\n');
    git(a, 'commit', '-q', '-am', 'run edit');
    expect(() => git(a, 'cherry-pick', picked)).toThrow();
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 both\nline3\n');
    const res = await refusing(a, () => undefined);
    expect(res.ok, res.summary).toBe(true);
    expect(git(a, 'log', '-1', '--format=%an <%ae>')).toBe('Picked Author <picked@example.com>');
    expect(() => git(a, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow();
    expect(git(a, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'app.js',
      'picked.js',
    ]);
  });

  it("an unfinished `git merge --autostash` is refused with a note, and its stash stays the merge's (never the shared list)", async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 run\nline3\n');
    git(a, 'commit', '-q', '-am', 'run edit');
    writeFileSync(path.join(main, 'app.js'), 'line1\nline2 main\nline3\n');
    git(main, 'commit', '-q', '-am', 'main edit');
    // Uncommitted work the autostash takes, then a conflict that stops the merge.
    writeFileSync(path.join(a, 'old.txt'), 'edited, not committed\n');
    expect(() => git(a, 'merge', '--autostash', '-q', 'main')).toThrow();
    const before = { head: git(a, 'rev-parse', 'HEAD'), status: git(a, 'status', '--porcelain') };
    // A pass whose turn is over is asked first: it records nothing.
    await expect(
      refusing(a, () => {
        throw new Error('turn moved');
      }),
    ).rejects.toThrow('turn moved');
    const res = await refusing(a, () => undefined);
    expect(res).toMatchObject({ ok: false });
    expect(res.summary).toBe(
      'Could not merge T-1: a git merge --autostash in its worktree is not finished. Finish it with git commit (or end it with git merge --abort), then merge again.',
    );
    expect({ head: git(a, 'rev-parse', 'HEAD'), status: git(a, 'status', '--porcelain') }).toEqual(before);
    expect(git(a, 'stash', 'list')).toBe('');
    expect(git(a, 'rev-parse', '-q', '--verify', 'MERGE_AUTOSTASH')).not.toBe('');
  });

  it('a MERGE_HEAD that names no commit fails the merge, after asking whether the pass is still current', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeFileSync(
      path.join(git(a, 'rev-parse', '--path-format=absolute', '--git-dir'), 'MERGE_HEAD'),
      'not a commit\n',
    );
    await expect(
      refusing(a, () => {
        throw new Error('turn moved');
      }),
    ).rejects.toThrow('turn moved');
    await expect(refusing(a, () => undefined)).rejects.toThrow(/MERGE_HEAD names no commit/);
    expect(git(a, 'log', '--format=%s')).toBe('init');
  });

  it('a --no-ff merge whose end failed after the branch moved is ended by the next merge too', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(main, 'main-only.js'), 'm\n');
    git(main, 'add', 'main-only.js');
    git(main, 'commit', '-q', '-m', 'main only');
    git(a, 'merge', '--no-ff', '--no-commit', '-q', 'main');
    const gitDir = git(a, 'rev-parse', '--path-format=absolute', '--git-dir');
    expect(readFileSync(path.join(gitDir, 'MERGE_MODE'), 'utf8')).toBe('no-ff');
    setCommandExecutor(async (request) => {
      if (request.file === 'git' && request.args.includes('--quit'))
        throw new Error('index.lock: File exists');
      return localCommandExecutor(request);
    });
    try {
      await expect(refusing(a, () => undefined)).rejects.toThrow('index.lock');
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    const recorded = git(a, 'rev-parse', 'HEAD');
    expect(git(a, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    const res = await refusing(a, () => undefined);
    expect(res.ok, res.summary).toBe(true);
    expect(git(a, 'rev-parse', 'HEAD')).toBe(recorded);
    expect(() => git(a, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(existsSync(path.join(gitDir, 'MERGE_MODE'))).toBe(false);
  });

  it('a merge whose end failed after the branch moved is ended by the next merge, which records nothing twice', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 run\nline3\n');
    git(a, 'commit', '-q', '-am', 'run edit');
    writeFileSync(path.join(main, 'app.js'), 'line1\nline2 main\nline3\n');
    git(main, 'commit', '-q', '-am', 'main edit');
    const mainTip = git(main, 'rev-parse', 'HEAD');
    expect(() => git(a, 'merge', '-q', 'main')).toThrow();
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 both\nline3\n');
    setCommandExecutor(async (request) => {
      if (request.file === 'git' && request.args.includes('--quit'))
        throw new Error('index.lock: File exists');
      return localCommandExecutor(request);
    });
    try {
      await expect(refusing(a, () => undefined)).rejects.toThrow('index.lock');
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    const recorded = git(a, 'rev-parse', 'HEAD');
    expect(git(a, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    // MERGE_HEAD is now in HEAD: the next merge ends it and merges, with no second output commit.
    const res = await refusing(a, () => undefined);
    expect(res.ok, res.summary).toBe(true);
    expect(git(a, 'rev-parse', 'HEAD')).toBe(recorded);
    expect(() => git(a, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(main, 'merge-base', '--is-ancestor', mainTip, 'HEAD')).toBe('');
    expect(readFileSync(path.join(main, 'app.js'), 'utf8')).toBe('line1\nline2 both\nline3\n');
  });

  it('parents are reduced as `git commit` reduces them: a MERGE_HEAD already in HEAD adds none, unless --no-ff', async () => {
    const a = addWorktree('a');
    const base = git(a, 'rev-parse', 'HEAD');
    writeFileSync(path.join(a, 'step.js'), 'step\n');
    git(a, 'add', 'step.js');
    git(a, 'commit', '-q', '-m', 'step');
    const gitDir = git(a, 'rev-parse', '--path-format=absolute', '--git-dir');
    writeFileSync(path.join(gitDir, 'MERGE_HEAD'), `${base}\n`);
    writeFileSync(path.join(a, 'one.js'), '1\n');
    expect((await refusing(a, () => undefined)).ok).toBe(true);
    expect(git(a, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(2);
    expect(() => git(a, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();

    writeFileSync(path.join(gitDir, 'MERGE_HEAD'), `${base}\n`);
    writeFileSync(path.join(gitDir, 'MERGE_MODE'), 'no-ff');
    writeFileSync(path.join(a, 'two.js'), '2\n');
    expect((await refusing(a, () => undefined)).ok).toBe(true);
    expect(git(a, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([
      git(a, 'rev-parse', 'HEAD^1'),
      base,
    ]);
  });

  it('a cherry-pick sequence: its last pick ends the sequence, an earlier one leaves it for --continue', async () => {
    const pickInto = (wt: string) => {
      git(main, 'checkout', '-q', '-b', `picks-${path.basename(wt)}`);
      writeFileSync(path.join(main, 'app.js'), 'line1\nline2 A\nline3\n');
      git(main, 'commit', '-q', '-am', 'A');
      writeFileSync(path.join(main, 'b.txt'), 'B\n');
      git(main, 'add', 'b.txt');
      git(main, 'commit', '-q', '-m', 'B');
      const [first, second] = [git(main, 'rev-parse', 'HEAD~1'), git(main, 'rev-parse', 'HEAD')];
      git(main, 'checkout', '-q', 'main');
      writeFileSync(path.join(wt, 'app.js'), 'line1\nline2 run\nline3\n');
      git(wt, 'commit', '-q', '-am', 'run edit');
      return [first, second] as const;
    };
    const sequencer = (wt: string) =>
      existsSync(path.join(git(wt, 'rev-parse', '--path-format=absolute', '--git-dir'), 'sequencer'));

    // A conflicts first, B is still to come: the sequence stays.
    const a = addWorktree('a');
    const [first, second] = pickInto(a);
    expect(() => git(a, 'cherry-pick', first, second)).toThrow();
    expect(sequencer(a)).toBe(true);
    writeFileSync(path.join(a, 'app.js'), 'line1\nline2 both\nline3\n');
    expect((await refusing(a, () => undefined)).ok).toBe(true);
    expect(() => git(a, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow();
    expect(sequencer(a)).toBe(true);

    // B applies, then A, the last pick, conflicts: concluding it ends the sequence.
    const b = addWorktree('b');
    const [lastA, firstB] = pickInto(b);
    expect(() => git(b, 'cherry-pick', firstB, lastA)).toThrow();
    expect(sequencer(b)).toBe(true);
    writeFileSync(path.join(b, 'app.js'), 'line1\nline2 both\nline3\n');
    expect((await refusing(b, () => undefined)).ok).toBe(true);
    expect(() => git(b, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow();
    expect(sequencer(b)).toBe(false);
    expect(git(b, 'log', '--format=%s', '-3').split('\n')).toEqual([
      'feat(T-1): factory run output',
      'B',
      'run edit',
    ]);
  });

  it('an update of the branch that fails without the branch moving is reported as its own error', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    const before = git(a, 'rev-parse', 'HEAD');
    let asked = 0;
    setCommandExecutor(async (request) => {
      if (request.file === 'git' && request.args.includes('update-ref') && !request.args.includes('-d'))
        throw unavailable('ptyd_unavailable', 'the runner (ptyd) is not reachable');
      return localCommandExecutor(request);
    });
    try {
      await expect(refusing(a, () => void asked++)).rejects.toMatchObject({ code: 'ptyd_unavailable' });
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    expect(asked).toBe(1);
    expect(git(a, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('a restage that fails leaves the branch where it was and the index never behind it', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    const before = git(a, 'rev-parse', 'HEAD');
    const mainBefore = git(main, 'rev-parse', 'HEAD');
    setCommandExecutor(async (request) => {
      if (request.file === 'git' && request.args.includes('add') && !request.env?.GIT_INDEX_FILE)
        throw new Error('index.lock: File exists');
      return localCommandExecutor(request);
    });
    try {
      await expect(refusing(a, () => undefined)).rejects.toThrow('index.lock');
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    expect(git(a, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(main, 'rev-parse', 'HEAD')).toBe(mainBefore);
    // Nothing committed shows as deleted from the index.
    expect(git(a, 'diff', '--cached', '--diff-filter=D', '--name-only', 'HEAD')).toBe('');
  });

  it('a copy of the index that fails fails the merge, instead of leaving out what the agent staged', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    const before = git(a, 'rev-parse', 'HEAD');
    setCommandExecutor(async (request) => {
      if (request.file === 'cp') throw new Error('No space left on device');
      return localCommandExecutor(request);
    });
    try {
      await expect(refusing(a, () => undefined)).rejects.toThrow('No space left');
    } finally {
      setCommandExecutor(localCommandExecutor);
    }
    expect(git(a, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('an agent that commits while the merge is asked for keeps its commit; nothing is merged', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    const mainBefore = git(main, 'rev-parse', 'HEAD');
    let calls = 0;
    const res = await refusing(a, () => {
      calls += 1;
      if (calls === 1) {
        git(a, 'add', '-A');
        git(a, 'commit', '-q', '-m', 'agent commit');
      }
    });
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/branch moved/);
    expect(calls).toBe(2);
    expect(git(a, 'log', '--format=%s')).toBe('agent commit\ninit');
    expect(git(main, 'rev-parse', 'HEAD')).toBe(mainBefore);
  });
});

describe('Emberline commits never carry scratch files', () => {
  const TICKETS = '.emberline/new-tickets.json';
  const writeTickets = (cwd: string, title = 'Again') => {
    mkdirSync(path.join(cwd, '.emberline'), { recursive: true });
    writeFileSync(path.join(cwd, TICKETS), JSON.stringify({ tickets: [{ title }] }));
  };
  const filesIn = (cwd: string, rev: string) =>
    git(cwd, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean);

  it('leaves out a tickets file the agent staged itself (git add -A, no commit)', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeTickets(a);
    mkdirSync(path.join(a, 'docs', '.emberline'), { recursive: true });
    writeFileSync(path.join(a, 'docs', '.emberline', 'tickets.json'), '[]');
    mkdirSync(path.join(a, '.emberline', 'attachments'), { recursive: true });
    writeFileSync(path.join(a, '.emberline', 'attachments', 'shot.png'), 'png');
    git(a, 'add', '-A');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    expect(filesIn(a, 'HEAD')).toEqual(['feature-a.js']);
    expect(git(main, 'ls-files', '.emberline', 'docs')).toBe('');
    expect(existsSync(path.join(main, TICKETS))).toBe(false);
    // The agent's file stays on disk in its worktree for core to read.
    expect(existsSync(path.join(a, TICKETS))).toBe(true);
  });

  it("removes a scratch file main already tracks with the next run's merge", async () => {
    writeTickets(main);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'factory run output (old bug)');
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    expect(git(main, 'ls-files', TICKETS)).toBe('');
    expect(existsSync(path.join(main, TICKETS))).toBe(false);
    expect(git(main, 'status', '--porcelain')).toBe('');
  });

  it('leaves out scratch files staged in the main workspace from the snapshot commit', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeFileSync(path.join(main, 'app.js'), 'line1\nedited in main\nline3\n');
    writeTickets(main);
    git(main, 'add', '-A');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    const snapshot = git(main, 'log', '--format=%H', '--grep', 'snapshot workspace edits');
    expect(snapshot).not.toBe('');
    expect(filesIn(main, snapshot)).toEqual(['app.js']);
    expect(git(main, 'ls-files', '.emberline')).toBe('');
  });

  it('commitWorktree (stage all, or files staged by hand) never commits scratch files', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeTickets(a);
    await commitWorktree(a, 'emberline/a', { message: 'stage all', stageAll: true });
    expect(filesIn(a, 'HEAD')).toEqual(['feature-a.js']);

    writeFileSync(path.join(a, 'feature-b.js'), 'b\n');
    git(a, 'add', '-A');
    await commitWorktree(a, 'emberline/a', { message: 'staged by hand' });
    expect(filesIn(a, 'HEAD')).toEqual(['feature-b.js']);
    expect(git(a, 'ls-files', '.emberline')).toBe('');
  });

  it("main's only change is a staged scratch file: the merge goes ahead without an empty snapshot", async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeTickets(main);
    git(main, 'add', '-A');
    const head = git(main, 'rev-parse', 'HEAD');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    expect(git(main, 'log', '--format=%s', `${head}..HEAD`).split('\n')).toEqual([
      'Merge T-1 (emberline/a)',
      'feat(T-1): factory run output',
    ]);
    expect(git(main, 'ls-files', '.emberline')).toBe('');
    // Still on disk, no longer staged.
    expect(existsSync(path.join(main, TICKETS))).toBe(true);
  });

  it('a scratch file staged in main and then deleted from disk does not block the merge', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeTickets(main);
    git(main, 'add', '-A');
    rmSync(path.join(main, TICKETS));

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(main, 'feature-a.js'))).toBe(true);
    expect(git(main, 'ls-files', '.emberline')).toBe('');
    expect(git(main, 'status', '--porcelain')).toBe('');
  });

  it('a scratch file main tracks leaves main with the merge even when main has its own edits', async () => {
    writeTickets(main);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'factory run output (old bug)');
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    writeFileSync(path.join(main, 'app.js'), 'line1\nedited in main\nline3\n');

    const res = await sync(a, 'T-1');
    expect(res.ok).toBe(true);
    const snapshot = git(main, 'log', '--format=%H', '--grep', 'snapshot workspace edits');
    expect(filesIn(main, snapshot)).toEqual(['app.js']);
    expect(git(main, 'ls-files', '.emberline')).toBe('');
    // Deleted by the merge, not left behind untracked for the pipeline to import from main again.
    expect(existsSync(path.join(main, TICKETS))).toBe(false);
  });

  it('commitWorktree answers 409 when the scratch files cannot be unstaged', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    git(a, 'add', '-A');
    const lock = path.resolve(a, git(a, 'rev-parse', '--git-path', 'index.lock'));
    writeFileSync(lock, '');
    try {
      await expect(
        commitWorktree(a, 'emberline/a', { message: 'locked', stageAll: false }),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      rmSync(lock, { force: true });
    }
  });
});

describe('runProducedChanges', () => {
  const produced = (wt: string) => runProducedChanges(wt, main);

  it('a fresh branch with nothing written: no changes', async () => {
    expect(await produced(addWorktree('a'))).toBe(false);
  });

  it('a fresh branch after main moved on (another run merged): still no changes', async () => {
    const a = addWorktree('a');
    const b = addWorktree('b');
    writeFileSync(path.join(b, 'feature-b.js'), 'b\n');
    expect((await sync(b, 'T-2')).ok).toBe(true);
    expect(await produced(a)).toBe(false);
  });

  it('an uncommitted new or edited file: changes', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    expect(await produced(a)).toBe(true);
    const b = addWorktree('b');
    writeFileSync(path.join(b, 'app.js'), 'line1\n');
    expect(await produced(b)).toBe(true);
  });

  it("only Emberline's scratch files: no changes", async () => {
    const a = addWorktree('a');
    mkdirSync(path.join(a, '.emberline'), { recursive: true });
    writeFileSync(path.join(a, '.emberline', 'new-tickets.json'), '{"tickets":[]}');
    writeFileSync(path.join(a, '.emberline', 'cross-critic-1.json'), '{}');
    expect(await produced(a)).toBe(false);
  });

  it('a commit of its own: changes', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-q', '-m', 'feat: a');
    expect(await produced(a)).toBe(true);
  });

  it('its own commit already merged into main (--no-ff): still changes', async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    expect((await sync(a, 'T-1')).ok).toBe(true);
    expect(git(main, 'merge-base', '--is-ancestor', git(a, 'rev-parse', 'HEAD'), 'HEAD')).toBe('');
    expect(await produced(a)).toBe(true);
  });

  it("its own commit fast-forwarded into main by hand looks unchanged here (the pipeline's merge-note guard decides)", async () => {
    const a = addWorktree('a');
    writeFileSync(path.join(a, 'feature-a.js'), 'a\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-q', '-m', 'feat: a');
    git(main, 'merge', '-q', '--ff-only', 'emberline/a');
    expect(await produced(a)).toBe(false);
  });

  it('a worktree that is gone is not checked', async () => {
    expect(await runProducedChanges(path.join(dir, 'missing'), main)).toBe(true);
  });
});
