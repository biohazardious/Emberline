import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { hostOf, remoteCompareKey } from '../forge/hosts.js';
import {
  fetchBranchObjects,
  pushBranch,
  remoteBranchHead,
  remoteUrlForDisplay,
  shortGitError,
  validateRepositoryUrl,
} from './git.js';
import { rmTemp } from '../test-rm.js';

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'repo-git-'));
});
afterEach(() => {
  rmTemp(dir);
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

  it('refuses an address whose user info may hold a password, read as the display reads it', () => {
    const refusal = (url: string) => {
      try {
        validateRepositoryUrl(url);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    const CREDENTIALS = 'Remove the user name and token from the URL; Emberline uses the forge account.';
    // Whatever may hold a secret, as the display masks it, is refused.
    expect(refusal('alice:pw@git.example.com:o/r.git')).toBe(CREDENTIALS);
    expect(refusal('alice:p@ss:w@git.example.com:o/r.git')).toBe(CREDENTIALS);
    expect(refusal('alice:token@github.com/o/r.git')).toBe(CREDENTIALS);
    expect(refusal('me@corp.com:pw@git.example.com:o/r.git')).toBe(CREDENTIALS);
    expect(refusal('git.example.com:app@v2')).toBe(CREDENTIALS);
    expect(refusal('git@git.example.com:o/r@v2.git')).toBeNull();
    expect(refusal('git.example.com:team/app@v2.git')).not.toBe(CREDENTIALS);
    // ssh URLs: user info up to the last `@` before the path; one that does not parse is refused.
    expect(refusal('ssh://me@corp.com:pw@host/o/r.git')).toBe(CREDENTIALS);
    expect(refusal('ssh://git:pa/ss@host/o/r.git')).toBe(CREDENTIALS);
    expect(refusal('ssh://git@host:2222/o/r@v2.git')).toBeNull();
    expect(refusal('ssh://me@corp.com@host/o/r.git')).toBeNull();
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
  it('drops the credentials of URLs git quotes (a token typed into origin)', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr:
        "fatal: unable to access 'https://alice:tok3n@git.example.com/o/r.git/': and ssh://git:tok3n@host/o/r.git, http://tok3n@h/x",
    });
    const text = shortGitError(error);
    expect(text).not.toContain('tok3n');
    expect(text).toContain("'https://git.example.com/o/r.git/'");
    expect(text).toContain('ssh://host/o/r.git');
    expect(text).toContain('http://h/x');
  });
});

describe('shortGitError: hostile URLs in what git and a server print', () => {
  const text = (stderr: string) => shortGitError(Object.assign(new Error('git failed'), { stderr }));
  it('drops everything from `://` to the last `@` of the address, whatever the password holds', () => {
    expect(text("fatal: unable to access 'https://alice:p@ss@git.example.com/o/r.git/'")).toBe(
      "unable to access 'https://git.example.com/o/r.git/'",
    );
    expect(text('remote: see https://bob:p@ss:w@h.example/x')).toBe('see https://h.example/x');
    expect(text('remote: https://u:p%40x@h/x')).toBe('https://h/x');
    // A quote or a `/` in a password does not end the address.
    expect(text("remote: https://u:p'w@h/x")).toBe('https://h/x');
    expect(text('fatal: ssh://git:pa/ss@h/x refused')).toBe('ssh://h/x refused');
    // A user name holding `@`, and any scheme git takes.
    expect(text('fatal: ssh://me@corp.com:pw@host/o/r refused')).toBe('ssh://host/o/r refused');
    expect(text('fatal: ssh+git://u:p@h/x and git+ssh://u:p@h/y')).toBe('ssh+git://h/x and git+ssh://h/y');
    expect(text('fatal: SSH://git:p@ss@host:2222/o/r.git refused')).toBe('SSH://host:2222/o/r.git refused');
    // Glued to a word, a digit or `_`, a URL is still one.
    expect(text('remote: _https://u:SECRET@h/x and 2https://u:SECRET@h/y')).toBe(
      '_https://h/x and 2https://h/y',
    );
    expect(text('fatal: xssh://git:SECRET@h/x')).toBe('xssh://h/x');
    // The address ends at whitespace; one without user info is left alone.
    expect(text('fatal: ssh://git:pw@host:22 mail me@x.y')).toBe('ssh://host:22 mail me@x.y');
    expect(text('fatal: ssh://[::1]:22/x and https://h/o/r.git')).toBe(
      'ssh://[::1]:22/x and https://h/o/r.git',
    );
  });
});

describe('shortGitError: scp-like addresses with a password', () => {
  const text = (stderr: string) => shortGitError(Object.assign(new Error('git failed'), { stderr }));
  it('masks the secret of `user:secret@host:path`, up to its last `@` before a host', () => {
    expect(text('fatal: alice:pw@host:o/r refused')).toBe('alice:***@host:o/r refused');
    expect(text('fatal: alice:p@ss:w@host:o refused')).toBe('alice:***@host:o refused');
    expect(text('fatal: alice:pw@[2001:db8::1]:o/r refused')).toBe('alice:***@[2001:db8::1]:o/r refused');
  });
  it('masks the path git quotes after splitting such an address at its first `:`', () => {
    // git reads `alice:pw@host:o/r` as host `alice`, path `pw@host:o/r`; the server's answer quotes the path.
    expect(text("fatal: 'pw@host:o/r' does not appear to be a git repository")).toBe(
      "'***@host:o/r' does not appear to be a git repository",
    );
    expect(text("fatal: 'p@ss@host:o' does not appear to be a git repository")).toBe(
      "'***@host:o' does not appear to be a git repository",
    );
  });
  it('masks a user name holding an `@`, and a secret before a host and its `/` (hand-set origins)', () => {
    expect(text('fatal: me@corp.com:SECRET@host:o/r refused')).toBe('me@corp.com:***@host:o/r refused');
    expect(text('fatal: alice:ghp_SECRET@github.com/o/r refused')).toBe('alice:***@github.com/o/r refused');
    expect(text('fatal: alice:p@ss@github.com/o/r refused')).toBe('alice:***@github.com/o/r refused');
  });
  it('leaves addresses without a secret alone', () => {
    expect(text('fatal: git@github.com:o/r.git and gitea:team/app@v2.git')).toBe(
      'git@github.com:o/r.git and gitea:team/app@v2.git',
    );
    expect(text('fatal: git@github.com/o/r and mail me@x.y')).toBe('git@github.com/o/r and mail me@x.y');
  });
});

describe('hostOf and remoteCompareKey', () => {
  it('hostOf reads the host after the last `@` that a host and its `:` follow', () => {
    expect(hostOf('user:p@ss@Host.example:o/r.git')).toBe('host.example');
    expect(hostOf('git@host.example:o/r@v2.git')).toBe('host.example');
    expect(hostOf('host.example:a@x/y')).toBe('host.example');
    expect(hostOf('alice:pw@host.example:o/r.git')).toBe('host.example');
  });

  it('remoteCompareKey lower-cases the scheme and host only', () => {
    expect(remoteCompareKey('git@GitHub.com:Alice/App.git')).toBe('git@github.com:Alice/App.git');
    expect(remoteCompareKey('HTTPS://GitHub.COM/Alice/App.git')).toBe('https://github.com/Alice/App.git');
    expect(remoteCompareKey('ssh://Git@Host.Example:2222/o/R.git')).toBe(
      'ssh://Git@host.example:2222/o/R.git',
    );
    expect(remoteCompareKey('me@corp.com@Host:o/r')).toBe('me@corp.com@host:o/r');
  });
});

describe('remoteUrlForDisplay', () => {
  it('drops user info, query and fragment from http(s) URLs and says it did', () => {
    expect(remoteUrlForDisplay('https://x-access-token:ghp_secret@github.com/o/r.git')).toEqual({
      url: 'https://github.com/o/r.git',
      display: 'https://github.com/o/r.git',
      hadCredentials: true,
    });
    expect(remoteUrlForDisplay('https://tok@git.example.com:8443/o/r.git?private_token=s#f')).toMatchObject({
      url: 'https://git.example.com:8443/o/r.git',
      hadCredentials: true,
    });
  });

  it('keeps an ssh user (it picks the key, it is no secret) but drops an ssh password', () => {
    expect(remoteUrlForDisplay('ssh://git:pw@host:2222/o/r.git')).toMatchObject({
      url: 'ssh://git@host:2222/o/r.git',
      hadCredentials: true,
    });
    expect(remoteUrlForDisplay('ssh://git@host/o/r.git')).toMatchObject({
      url: 'ssh://git@host/o/r.git',
      hadCredentials: false,
    });
    expect(remoteUrlForDisplay('git:pw@host:o/r.git')).toEqual({
      url: 'git@host:o/r.git',
      display: 'git@host:o/r.git',
      hadCredentials: true,
    });
    expect(remoteUrlForDisplay('git@host:o/r.git')).toMatchObject({
      url: 'git@host:o/r.git',
      hadCredentials: false,
    });
  });

  it('rewrites only `user:secret@host:path`; an address that may hold a secret is kept, and shown masked', () => {
    const read = remoteUrlForDisplay;
    // The plain form: one `@` before the first `/`, a host and its `:` after it.
    expect(read('Alice:S3cret@GitHub.COM:o/r.git')).toEqual({
      url: 'Alice@GitHub.COM:o/r.git',
      display: 'Alice@GitHub.COM:o/r.git',
      hadCredentials: true,
    });
    expect(read('alice:pw@host:o/r@v2').url).toBe('alice@host:o/r@v2');
    expect(read('alice:p:w@host:o/r.git').url).toBe('alice@host:o/r.git');
    expect(read('alice:pw@[2001:db8::1]:o/r.git').url).toBe('alice@[2001:db8::1]:o/r.git');
    // Ambiguous: a password holding `@`, an `@x:` in the path, a schemeless `user:token@host/path`
    // (the same shape as the path `a@x/y` on `host`), a pathless `host:repo@x`. Kept as they are
    // (never two remotes made equal), shown with `***` (no part of a password), and flagged.
    for (const [raw, display] of [
      ['me@corp.com:SECRET@host:o/r', 'me@corp.com:***@host:o/r'],
      ['me@corp.com:p@ss@host:o/r', 'me@corp.com:***@host:o/r'],
      ['alice:p@ss@host:o/r.git', 'alice:***@host:o/r.git'],
      ['alice:p@ss:w@host:o', 'alice:***@host:o'],
      ['alice:pw@host:a@b:c', 'alice:***@b:c'],
      ['alice:token@github.com/o/r.git', 'alice:***@github.com/o/r.git'],
      ['host:a@x/y', 'host:***@x/y'],
      ['host:repo@x', 'host:***@x'],
      ['alice:p@ss:w@host', 'alice:***@host'],
    ] as const) {
      expect(read(raw), raw).toEqual({ url: raw, display, hadCredentials: true });
    }
    expect(read('host:a@x/y').url).not.toBe(read('host:b@x/y').url);
    expect(read('alice:pw@host:a@b:c').url).not.toBe(read('alice:pw@other:a@b:c').url);
    // No `user:` before an `@` ahead of the first `/`: nothing to hide.
    for (const raw of [
      'gitea:team/app@v2.git',
      'git@host:o/r@v2.git',
      '[2001:db8::1]:o/r@x',
      '[2001:db8::1]:a@b:c',
    ])
      expect(read(raw), raw).toEqual({ url: raw, display: raw, hadCredentials: false });
  });

  it('URL forms: user info goes up to its last `@`, an `@` in the path stays', () => {
    const shown = (url: string) => remoteUrlForDisplay(url).display;
    expect(shown('https://github.com/o/r@v2.git')).toBe('https://github.com/o/r@v2.git');
    expect(shown('https://u:p@GitHub.com/o/r@v2.git')).toBe('https://github.com/o/r@v2.git');
    expect(shown('https://u:p@ss@host/o/r.git')).toBe('https://host/o/r.git');
    expect(shown('ssh://git:pw@[2001:db8::1]:2222/o/r@v2.git')).toBe(
      'ssh://git@[2001:db8::1]:2222/o/r@v2.git',
    );
    expect(shown('ssh://me@corp.com:pw@host/o/r')).not.toContain('pw');
    // Not parseable (a `/` in the password): everything up to the last `@` goes.
    expect(remoteUrlForDisplay('ssh://git:pa/ss@h/x')).toMatchObject({
      display: 'ssh://h/x',
      hadCredentials: true,
    });
  });

  it('leaves a clean URL exactly as it is', () => {
    expect(remoteUrlForDisplay('https://GitHub.com/o/r.git')).toEqual({
      url: 'https://GitHub.com/o/r.git',
      display: 'https://GitHub.com/o/r.git',
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
