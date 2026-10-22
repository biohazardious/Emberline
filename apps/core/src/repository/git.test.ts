import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { pushBranch, validateRepositoryUrl } from './git.js';

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'repo-git-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pushBranch without an account (the runner git straight to the URL)', () => {
  it('pushes exactly the given commit to the branch, and never tags', async () => {
    const work = path.join(dir, 'work');
    const bare = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git(work, 'add', 'a.txt');
    git(work, 'commit', '-q', '-m', 'a');
    const first = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', '-a', '-m', 'v1', 'v1');
    git(work, 'config', 'push.followTags', 'true');
    writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', 'b.txt');
    git(work, 'commit', '-q', '-m', 'b'); // main moved on: only `first` is pushed
    expect(await pushBranch(work, { url: bare, account: null }, 'main', first)).toBe('pushed');
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(first);
    expect(git(bare, 'tag', '--list')).toBe('');
  });
});

describe('validateRepositoryUrl', () => {
  it('refuses a password in ssh URLs and a query or fragment in http(s) URLs', () => {
    for (const url of [
      'ssh://alice:hunter2@host/a/b.git',
      'https://host/a/b.git?private_token=x',
      'https://host/a/b.git#x',
    ]) {
      expect(() => validateRepositoryUrl(url)).toThrow(HttpError);
    }
    expect(validateRepositoryUrl('ssh://git@host:2222/a/b.git')).toMatchObject({
      transport: 'ssh',
      host: 'host',
    });
  });

  it('a capitalised scheme is stored lower-case, and IPv6 hosts are accepted', () => {
    expect(validateRepositoryUrl('HTTPS://Host.example/a/b.git')).toEqual({
      url: 'https://Host.example/a/b.git',
      host: 'host.example',
      transport: 'https',
    });
    expect(validateRepositoryUrl('https://[::1]:8443/a/b.git')).toMatchObject({
      transport: 'https',
      host: '[::1]:8443',
    });
    expect(() => validateRepositoryUrl('ext::sh -c x')).toThrow(HttpError);
    expect(() => validateRepositoryUrl('fd::17')).toThrow(HttpError);
  });
});

describe('pushBranch without an account: refusals', () => {
  it("the remote's own refusal is a failed push with its reason, not a diverged main", async () => {
    const work = path.join(dir, 'work');
    const remote = path.join(dir, 'remote');
    execFileSync('git', ['init', '-q', '-b', 'main', remote]); // not bare, main checked out: receive-pack refuses
    git(remote, 'commit', '-q', '--allow-empty', '-m', 'r');
    execFileSync('git', ['clone', '-q', remote, work]);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'w');
    const oid = git(work, 'rev-parse', 'HEAD');
    const error = await pushBranch(work, { url: remote, account: null }, 'main', oid).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('push_failed');
  });
});
