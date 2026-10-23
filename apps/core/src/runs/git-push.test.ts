/**
 * A run branch pushed without a forge account: what git and the server (`remote:` lines) print comes
 * back to the run's page, so it is redacted and bounded like the account push's.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecResult, localCommandExecutor, setCommandExecutor } from '../command-exec.js';
import { pushWorktreeBranch } from './git.js';

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
  rmSync(dir, { recursive: true, force: true });
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
    expect(message).toMatch(
      /^git push failed: Permission denied for https:\/\/git\.example\.com\/o\/r\.git or ssh:\/\/git@git\.example\.com\/o\/r\.git/,
    );
    expect(message).not.toMatch(/tok3n|p@ss|ss@/);
    expect(message).toContain('/api/internal/git/[capability]');
    expect(message).not.toContain('xxxxxxxxxx'.repeat(31));
  });

  it('the output of a push that worked has no user info or capability, and is bounded', async () => {
    pushAnswers({
      stdout:
        'To https://alice:tok3n@git.example.com/o/r.git\n*\trefs/heads/emberline/run-1:refs/heads/emberline/run-1\t[new branch]\nDone\n',
      stderr: [
        'remote: Create a pull request: https://bob:p4t@git.example.com/o/r/pulls/new',
        'remote: mirror: https://carol:p@ss:w@git.example.com/o/r.git and ssh://git:s3cr3t@git.example.com:2222/o/r.git',
        `remote: mirrored to ${CAPABILITY}`,
        `remote: ${'y'.repeat(100_000)}`,
      ].join('\n'),
    });
    const res = await pushWorktreeBranch(dir, 'emberline/run-1', 'main');
    expect(res.output).toContain('To https://git.example.com/o/r.git');
    expect(res.output).toContain('https://git.example.com/o/r/pulls/new');
    expect(res.output).toContain(
      'mirror: https://git.example.com/o/r.git and ssh://git@git.example.com:2222/o/r.git',
    );
    expect(res.output).not.toMatch(/tok3n|p4t|p@ss|ss:w|s3cr3t/);
    expect(res.output).toContain('/api/internal/git/[capability]');
    expect(res.output.length).toBeLessThanOrEqual(4096);
  });
});
