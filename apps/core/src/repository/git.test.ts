import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import {
  fetchBranchObjects,
  pushBranch,
  remoteBranchHead,
  remoteUrlForDisplay,
  shortGitError,
  validateRepositoryUrl,
} from './git.js';

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

describe('shortGitError', () => {
  it('drops user info from http(s) URLs git quotes (a token typed into origin), keeping ssh users', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr:
        "fatal: unable to access 'https://alice:tok3n@git.example.com/o/r.git/': and ssh://git@host/o/r.git, http://tok3n@h/x",
    });
    const text = shortGitError(error);
    expect(text).not.toContain('tok3n');
    expect(text).toContain("'https://git.example.com/o/r.git/'");
    expect(text).toContain('ssh://git@host/o/r.git');
    expect(text).toContain('http://h/x');
  });
});

describe('remoteUrlForDisplay', () => {
  it('drops user info, query and fragment from http(s) URLs and says it did', () => {
    expect(remoteUrlForDisplay('https://x-access-token:ghp_secret@github.com/o/r.git')).toEqual({
      url: 'https://github.com/o/r.git',
      hadCredentials: true,
    });
    expect(remoteUrlForDisplay('https://tok@git.example.com:8443/o/r.git?private_token=s#f')).toEqual({
      url: 'https://git.example.com:8443/o/r.git',
      hadCredentials: true,
    });
  });

  it('keeps an ssh user (it picks the key, it is no secret) but drops an ssh password', () => {
    expect(remoteUrlForDisplay('ssh://git:pw@host:2222/o/r.git')).toEqual({
      url: 'ssh://git@host:2222/o/r.git',
      hadCredentials: true,
    });
    expect(remoteUrlForDisplay('ssh://git@host/o/r.git')).toEqual({
      url: 'ssh://git@host/o/r.git',
      hadCredentials: false,
    });
    expect(remoteUrlForDisplay('git:pw@host:o/r.git')).toEqual({
      url: 'git@host:o/r.git',
      hadCredentials: true,
    });
    expect(remoteUrlForDisplay('git@host:o/r.git')).toEqual({
      url: 'git@host:o/r.git',
      hadCredentials: false,
    });
  });

  it('strips a scp-like password only before a host: an `@` in the path is no user info', () => {
    const shown = (url: string) => remoteUrlForDisplay(url).url;
    // `host:repo@x` is the path `repo@x` on `host`, never the user `host` on the server `x`.
    expect(remoteUrlForDisplay('host:repo@x')).toEqual({ url: 'host:repo@x', hadCredentials: false });
    expect(shown('host:a@x')).not.toBe(shown('host:b@x'));
    expect(shown('gitea:team/app@v2.git')).toBe('gitea:team/app@v2.git');
    expect(shown('git@host:o/r@v2.git')).toBe('git@host:o/r@v2.git');
    // A password before a host goes, whatever the host or path looks like.
    expect(remoteUrlForDisplay('Alice:S3cret@GitHub.COM:o/r.git')).toEqual({
      url: 'Alice@GitHub.COM:o/r.git',
      hadCredentials: true,
    });
    expect(shown('alice:pw@host:o/r@v2')).toBe('alice@host:o/r@v2');
    expect(shown('alice:pw@host:a@b:c')).toBe('alice@host:a@b:c');
    expect(shown('alice:p@ss@host:o/r.git')).toBe('alice@host:o/r.git');
    expect(shown('alice:p:w@host:o/r.git')).toBe('alice@host:o/r.git');
    expect(shown('alice:pw@[2001:db8::1]:o/r.git')).toBe('alice@[2001:db8::1]:o/r.git');
    // An IPv6 host is never read as a user name.
    expect(remoteUrlForDisplay('[2001:db8::1]:o/r@x')).toEqual({
      url: '[2001:db8::1]:o/r@x',
      hadCredentials: false,
    });
    expect(shown('[2001:db8::1]:a@b:c')).toBe('[2001:db8::1]:a@b:c');
    // URL forms: user info goes, an `@` in the path stays.
    expect(shown('https://github.com/o/r@v2.git')).toBe('https://github.com/o/r@v2.git');
    expect(shown('https://u:p@GitHub.com/o/r@v2.git')).toBe('https://github.com/o/r@v2.git');
    expect(shown('https://u:p@ss@host/o/r.git')).toBe('https://host/o/r.git');
    expect(shown('ssh://git:pw@[2001:db8::1]:2222/o/r@v2.git')).toBe(
      'ssh://git@[2001:db8::1]:2222/o/r@v2.git',
    );
  });

  it('leaves a clean URL exactly as it is', () => {
    expect(remoteUrlForDisplay('https://GitHub.com/o/r.git')).toEqual({
      url: 'https://GitHub.com/o/r.git',
      hadCredentials: false,
    });
  });
});

describe('reading origin without an account (the runner git straight to the URL)', () => {
  const setup = () => {
    const bare = path.join(dir, 'remote.git');
    const pusher = path.join(dir, 'pusher');
    const main = path.join(dir, 'main');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', pusher]);
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    git(pusher, 'commit', '-q', '--allow-empty', '-m', 'one');
    git(pusher, 'push', '-q', bare, 'main');
    return { bare, pusher, main, access: { url: bare, account: null } };
  };
  /** No ref and no FETCH_HEAD: the caller sets the tracking ref under the main-workspace lock. */
  const wroteNothing = (main: string) => {
    expect(existsSync(path.join(main, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(git(main, 'for-each-ref')).toBe('');
  };

  it('remoteBranchHead names the commit; fetchBranchObjects brings it without a ref or FETCH_HEAD', async () => {
    const { pusher, main, access } = setup();
    const oid = await remoteBranchHead(main, access, 'main');
    expect(oid).toBe(git(pusher, 'rev-parse', 'HEAD'));
    expect(await remoteBranchHead(main, access, 'nope')).toBeNull();
    await fetchBranchObjects(main, access, 'main', oid!);
    expect(git(main, 'cat-file', '-t', oid!)).toBe('commit');
    wroteNothing(main);
  });

  it('a remote that moves between ls-remote and the fetch is a 409 remote_moved, and nothing is written', async () => {
    const { bare, pusher, main, access } = setup();
    const oid = (await remoteBranchHead(main, access, 'main'))!;
    // Main is rewritten on the remote: the commit ls-remote named is not in what the fetch gets.
    git(pusher, 'checkout', '-q', '--orphan', 'other');
    git(pusher, 'commit', '-q', '--allow-empty', '-m', 'rewritten');
    git(pusher, 'push', '-q', '--force', bare, 'other:main');
    const error = await fetchBranchObjects(main, access, 'main', oid).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ statusCode: 409, code: 'remote_moved' });
    wroteNothing(main);
  });
});
