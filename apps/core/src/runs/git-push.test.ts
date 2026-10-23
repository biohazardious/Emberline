/**
 * A run branch pushed without a forge account: what git and the server (`remote:` lines) print comes
 * back to the run's page, so it is redacted and bounded like the account push's.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecResult, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { pushWorktreeBranch } from './git.js';
import { rmTemp } from '../test-rm.js';

let dir: string;
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const CAPABILITY = 'http://core:7420/api/internal/git/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-/o/r.git';

/** The runner answers `git push` with `result`; every other git command runs for real. */
const pushAnswers = (result: Partial<ExecResult>) =>
  setCommandExecutor(async (request) =>
    request.args.includes('push')
      ? { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, ...result }
      : localCommandExecutor(request),
  );

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'run-push-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'a');
  git('checkout', '-q', '-b', 'emberline/run-1');
  git('remote', 'add', 'origin', 'https://alice:tok3n@git.example.com/o/r.git');
});

afterEach(() => {
  setCommandExecutor(localCommandExecutor);
  rmTemp(dir);
});

describe('pushing a run branch without an account', () => {
  it('a failure says what went wrong in one line, without a token, a capability or the whole server output', async () => {
    pushAnswers({
      exitCode: 1,
      stderr: [
        'remote: Permission denied for https://alice:p@ss@git.example.com/o/r.git or ssh://git:tok3n@git.example.com/o/r.git, see ' +
          CAPABILITY,
        `remote: ${'x'.repeat(10_000)}`,
        "error: failed to push some refs to 'https://alice:tok3n@git.example.com/o/r.git'",
      ].join('\n'),
    });
    const error = await pushWorktreeBranch(dir, 'emberline/run-1', 'main').catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 409 });
    const message = (error as Error).message;
    // After git's `remote: ` prefix, up to the line's last `@` that a host follows.
    expect(message).toMatch(/^git push failed: \*\*\*@git\.example\.com\/o\/r\.git, see /);
    expect(message).not.toMatch(/tok3n|p@ss|ss@/);
    expect(message).toContain('/api/internal/git/[capability]');
    expect(message).not.toContain('xxxxxxxxxx'.repeat(31));
  });

  it("origin's password (its push URL's too) never shows, wherever git or the server quotes it", async () => {
    git('remote', 'set-url', '--push', 'origin', 'https://alice:pu5hS3CRET@git.example.com/o/r.git');
    pushAnswers({
      exitCode: 1,
      stderr: 'remote: token tok3n expired\nremote: and pu5hS3CRET too',
    });
    const error = await pushWorktreeBranch(dir, 'emberline/run-1', 'main').catch((e: unknown) => e);
    expect((error as Error).message).toBe('git push failed: token *** expired');
    pushAnswers({ stdout: 'tok3n', stderr: 'remote: pu5hS3CRET, alice:tok3n' });
    const res = await pushWorktreeBranch(dir, 'emberline/run-1', 'main');
    expect(res.output).toBe('***\nremote: ***, alice:***');
  });

  it('every address origin pushes to is known: all its URLs and push URLs, also one an agent sets during the push', async () => {
    git('remote', 'set-url', '--add', 'origin', 'https://bob:s3cond-URL@git.example.com/o/r.git');
    git('remote', 'set-url', '--add', '--push', 'origin', 'https://carol:f1rst-PUSH@git.example.com/o/r.git');
    git('remote', 'set-url', '--add', '--push', 'origin', 'https://dave:s3cond-PUSH@git.example.com/o/r.git');
    let args: string[] = [];
    setCommandExecutor(async (request) => {
      if (!request.args.includes('push')) return localCommandExecutor(request);
      args = request.args;
      // An agent points origin elsewhere while git pushes.
      git(
        'remote',
        'set-url',
        '--add',
        '--push',
        'origin',
        'https://erin:dur1ng-PUSH@git.example.com/o/r.git',
      );
      return {
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'remote: bad tokens: s3cond-URL f1rst-PUSH s3cond-PUSH dur1ng-PUSH tok3n',
        timedOut: false,
        truncated: false,
      };
    });
    const error = await pushWorktreeBranch(dir, 'emberline/run-1', 'main').catch((e: unknown) => e);
    expect((error as Error).message).toBe('git push failed: bad tokens: *** *** *** *** ***');
    // Never into a submodule, whatever the repository's config says.
    expect(args).toContain('--no-recurse-submodules');
    expect(args.join(' ')).toContain('-c submodule.recurse=false -c push.recurseSubmodules=no');
  });

  it('the output of a push that worked has no user info or capability, and is bounded', async () => {
    pushAnswers({
      stdout:
        'To https://alice:tok3n@git.example.com/o/r.git\n*\trefs/heads/emberline/run-1:refs/heads/emberline/run-1\t[new branch]\nDone\n',
      stderr: [
        'remote: Create a pull request: https://bob:p4t@git.example.com/o/r/pulls/new',
        'remote: mirror: https://carol:p@ss:w@git.example.com/o/r.git and ssh://git:s3cr3t@git.example.com:2222/o/r.git',
        "remote: also 'https://dave:q'u0te@git.example.com/o/r.git' and ssh://me@corp.com:c0rp@git.example.com/o/r.git",
        'remote: and ssh+git://erin:sl/ash@git.example.com/o/r.git',
        "remote: scp frank:fr4nk@git.example.com:o/r.git, quoted 'gr4ce@git.example.com:o/r.git'",
        'remote: glued _https://heidi:h3idi@git.example.com/o/r.git',
        `remote: mirrored to ${CAPABILITY}`,
        `remote: ${'y'.repeat(100_000)}`,
        // Long runs that a backtracking pattern would take quadratic time over (the scan's steps are
        // counted in git-gateway/redaction.test.ts).
        `remote: ${'a1'.repeat(100_000)} ${'x:'.repeat(50_000)} ${'@h'.repeat(50_000)}`,
      ].join('\n'),
    });
    const res = await pushWorktreeBranch(dir, 'emberline/run-1', 'main');
    // A `remote: ` line keeps its prefix and one space; the rest up to its last `@` before a host goes.
    expect(res.output).toContain('To https://***@git.example.com/o/r.git');
    expect(res.output).toContain('remote: ***@git.example.com/o/r/pulls/new');
    expect(res.output).toContain('remote: ***@git.example.com:2222/o/r.git');
    expect(res.output).toContain("remote: ***@git.example.com:o/r.git'");
    expect(res.output).not.toMatch(/tok3n|p4t|p@ss|ss:w|s3cr3t|u0te|c0rp|corp\.com|ash@|fr4nk|gr4ce|h3idi/);
    expect(res.output).toContain('/api/internal/git/[capability]');
    expect(res.output.length).toBeLessThanOrEqual(4096);
  });
});

describe('pushing a run branch with submodules', () => {
  it("never runs a command a submodule's own config sets, even with submodule.recurse in the repository", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'run-push-sub-'));
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', cwd, ...args], { encoding: 'utf8' });
    const commitIn = (cwd: string, file: string) => {
      writeFileSync(path.join(cwd, file), `${file}\n`);
      run(cwd, 'add', file);
      run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
    };
    try {
      const sub = path.join(root, 'sub');
      const origin = path.join(root, 'origin.git');
      const subOrigin = path.join(root, 'sub-origin.git');
      execFileSync('git', ['init', '-q', '--bare', origin]);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', subOrigin]);
      execFileSync('git', ['init', '-q', '-b', 'main', sub]);
      commitIn(sub, 's.txt');
      run(sub, 'push', '-q', subOrigin, 'main');
      run(dir, 'submodule', 'add', '-q', subOrigin, 'sub');
      run(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'sub');
      // A new commit on the submodule's own run branch that its remote does not have: a recursing
      // push pushes it there, with the submodule's own receivepack.
      run(path.join(dir, 'sub'), 'checkout', '-q', '-b', 'emberline/run-1');
      commitIn(path.join(dir, 'sub'), 'more.txt');
      run(dir, 'add', 'sub');
      run(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'sub moved');
      git('remote', 'set-url', 'origin', origin);
      git('config', 'submodule.recurse', 'true');
      git('config', 'push.recurseSubmodules', 'on-demand');
      git('config', 'protocol.file.allow', 'always');
      const marker = path.join(root, 'ran');
      const moduleDir = path.join(dir, '.git', 'modules', 'sub');
      execFileSync('git', [
        '-C',
        moduleDir,
        'config',
        'remote.origin.receivepack',
        `touch ${marker}; git-receive-pack`,
      ]);
      await pushWorktreeBranch(dir, 'emberline/run-1', 'main').catch(() => undefined);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmTemp(root);
    }
  });
});
