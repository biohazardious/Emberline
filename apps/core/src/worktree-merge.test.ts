import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncWorktreeToMainWorkspace } from './factory/service.js';

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
