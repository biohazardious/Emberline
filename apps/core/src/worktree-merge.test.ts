import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProducedChanges } from './factory/merge.js';
import { syncWorktreeToMainWorkspace } from './factory/service.js';
import { commitWorktree } from './runs/git.js';

let dir: string;
let main: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function addWorktree(name: string): string {
  const wt = path.join(dir, name);
  git(main, 'worktree', 'add', '-q', '-b', `emberline/${name}`, wt, 'HEAD');
  return wt;
}

const sync = (worktreePath: string, ticketKey: string) =>
  syncWorktreeToMainWorkspace({ worktreePath, mainWorkspacePath: main, ticketKey, runId: `run-${ticketKey}` });

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
  rmSync(dir, { recursive: true, force: true });
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

describe('Emberline commits never carry scratch files', () => {
  const TICKETS = '.emberline/new-tickets.json';
  const writeTickets = (cwd: string, title = 'Again') => {
    mkdirSync(path.join(cwd, '.emberline'), { recursive: true });
    writeFileSync(path.join(cwd, TICKETS), JSON.stringify({ tickets: [{ title }] }));
  };
  const filesIn = (cwd: string, rev: string) => git(cwd, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean);

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
    expect(git(main, 'log', '--format=%s', `${head}..HEAD`).split('\n')).toEqual(['Merge T-1 (emberline/a)', 'feat(T-1): factory run output']);
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
      await expect(commitWorktree(a, 'emberline/a', { message: 'locked', stageAll: false })).rejects.toMatchObject({ statusCode: 409 });
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

  it('a worktree that is gone is not checked', async () => {
    expect(await runProducedChanges(path.join(dir, 'missing'), main)).toBe(true);
  });
});
