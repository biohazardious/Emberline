import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { addressSecrets, hostOf, remoteCompareKey, type ScanMeter } from '../forge/hosts.js';
import {
  fetchBranchObjects,
  passwordGitWouldShow,
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

  it('refuses a `\\` in an http(s) URL: as user info when an `@` follows it (git sends it there)', () => {
    const refusal = (url: string) => {
      try {
        validateRepositoryUrl(url);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refusal('https://u:2024\\S3CRET@github.com/o/r.git')).toMatch(/^Remove the user name and token/);
    expect(refusal('https://x-access-token:12\\ghp_T0K@github.com/o/r.git')).toMatch(/^Remove the user name/);
    expect(refusal('https://alice:a@b\\c@github.com/o/r.git')).toMatch(/^Remove the user name/);
    expect(refusal('https://github.com\\o\\r.git')).toMatch(/^Enter a repository URL/);
  });

  it('knows which passwords git would print while it clones', () => {
    for (const url of [
      'ssh://git:pw@host/o/r.git',
      'ssh://me@corp.com:pw@host/o/r.git',
      'git:pw@host:o/r.git',
      'https://u:2024\\S3CRET@github.com/o/r.git',
    ])
      expect(passwordGitWouldShow(url), url).toBe(true);
    for (const url of [
      'https://u:tok@github.com/o/r.git',
      'git@github.com:o/r.git',
      'ssh://git@h/o',
      'https://h/o',
    ])
      expect(passwordGitWouldShow(url), url).toBe(false);
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
    // Only user info git would send is refused: an `@` after a port or after the first `/` is a
    // path's as git reads it (the display masks the ones that may hide a password).
    for (const url of [
      'https://u:2024/S@h/o',
      'https://host:8443/g/n@v2/r.git',
      'git@host:o/r@v2/x.git',
      'https://u:2024/Secret@github.com/o/r.git',
      'https://host.example:8443/group/name@v2/repo.git',
      'https://host.example:8443/o/r@v2.git',
      'ssh://git:22/S3C@host:2222/o/r.git',
      'git@host.example:o/r@v2/x.git',
      'gitea:team/app@v2/x.git',
      'u:pa/ss@git.example.com/o/r.git',
    ])
      expect(refusal(url), url).toBeNull();
    expect(refusal('https://user@host.example:8443/o/r')).toBe(CREDENTIALS);
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
    // git's phrase stays; the quoted text is no single word, so all of it up to the line's last `@`
    // that a host follows goes.
    expect(shortGitError(error)).toBe("unable to access '***@h/x");
    // Known (origin as configured): its token goes wherever it shows.
    expect(
      shortGitError(Object.assign(new Error('git failed'), { stderr: 'remote: token tok3n expired' }), {
        addresses: ['https://alice:tok3n@git.example.com/o/r.git'],
      }),
    ).toBe('token *** expired');
  });
});

/** Each line masks from its first opener to its last `@` that a host follows; examples (generated cases: redaction.test.ts). */
describe('shortGitError: addresses with a password in what git and a server print', () => {
  const text = (stderr: string) => shortGitError(Object.assign(new Error('git failed'), { stderr }));
  it("after git's prefix and phrase, everything up to the line's last `@` before a host goes; the rest of the line stays", () => {
    for (const [stderr, shown] of [
      [
        "fatal: unable to access 'https://alice:p@ss@git.example.com/o/r.git/': Could not resolve host",
        "unable to access 'https://***@git.example.com/o/r.git/': Could not resolve host",
      ],
      [
        "fatal: unable to access 'https://alice:p@ss@git.example.com/o/r.git/'",
        "unable to access '***@git.example.com/o/r.git/'",
      ],
      [
        "fatal: 'pw@host:o/r' does not appear to be a git repository",
        "'***@host:o/r' does not appear to be a git repository",
      ],
      ['remote: https://u:p%40x@h/x', '***@h/x'],
      ['fatal: ssh://git:pa/ss@h/x refused', '***@h/x refused'],
      ['fatal: alice:pw@[2001:db8::1]:o/r refused', '***@[2001:db8::1]:o/r refused'],
      ['fatal: me@corp.com:SECRET@host:o/r refused', '***@host:o/r refused'],
      ['fatal: ssh://git:pw@host:22 mail me@x.y', '***@x.y'],
      // An address may start the line with such a user name: only it and one space can show.
      ['ssh: S3CRET@host: Permission denied (publickey).', 'ssh: ***@host: Permission denied (publickey).'],
    ] as const)
      expect(text(stderr), stderr).toBe(shown);
  });
  it('without a git prefix, from the first opener: a scheme keeps the address, with *** for its user info', () => {
    for (const [stderr, shown] of [
      ['https://u:p@ss@git.example.com/o/r.git refused', 'https://***@git.example.com/o/r.git refused'],
      ["Cloning into 'pw@host:o/r'...", "Cloning into '***@host:o/r'..."],
      ['To alice:pw@host:o/r', 'To alice:***@host:o/r'],
    ] as const)
      expect(text(stderr), stderr).toBe(shown);
  });
  it('leaves a line without an `@` that a host follows as it is', () => {
    expect(text('fatal: ssh://[::1]:22/x and https://h/o/r.git')).toBe(
      'ssh://[::1]:22/x and https://h/o/r.git',
    );
    expect(text('fatal: Could not read from remote repository.')).toBe(
      'Could not read from remote repository.',
    );
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

describe('addressSecrets', () => {
  it('returns each user name and what may be its password, never less than the password', () => {
    const pairs = (raw: string) => addressSecrets(raw).map((p) => `${p.user}|${p.password}`);
    for (const [raw, wanted] of [
      ['https://u:S3CRET@h/o/r.git', ['u|S3CRET']],
      ['https://u:p%40ss%20w@h/o', ['u|p%40ss%20w']],
      ['https://u:p@ss@h/o', ['u|p@ss']],
      ['ssh://me@corp.com:S3CRET@h/o', ['me@corp.com|S3CRET']],
      ['git:S3CRET@h:o/r.git', ['git|S3CRET']],
      ['me@corp.com:S3CRET@h:o/r', ['me@corp.com|S3CRET']],
      ['alice:pa/ss@h', ['alice|pa/ss']],
      ['https://u:ab@h/o', ['u|ab']],
      // A password holding an `@`, in an address with a path's `@`: as the parser and git read it.
      ['https://u:x@y@host/o/r@v2.git', ['u|x@y', 'u|x@y@host/o/r']],
      // The first and the last `@` a host follows: a path's `@` may end the password.
      ['https://u:S3CRET@GitHub.com/o/r@v2.git', ['u|S3CRET', 'u|S3CRET@GitHub.com/o/r']],
      ['https://u:2024/S3CRET@h/o', ['u|2024/S3CRET']],
      // A `\` (the parser ends the authority there; git sends it in the user info).
      ['https://u:2024\\S3CRET@github.com/o/r.git', ['u|2024\\S3CRET']],
      ['https://alice:a@b\\c@github.com/o/r.git', ['alice|a', 'alice|a@b\\c']],
      // An http(s) user name alone may be a token.
      ['https://ghp_T0KEN@github.com/o/r.git', ['ghp_T0KEN|null']],
      ['https://ghp_T0KEN@github.com:8443/o/r@v2.git', ['ghp_T0KEN|null']],
    ] as const)
      for (const pair of wanted) expect(pairs(raw), raw).toContain(pair);
    // Linear: each character read a fixed number of times, however many `@`s.
    const steps = (raw: string) => {
      const meter: ScanMeter = { steps: 0 };
      addressSecrets(raw, meter);
      return meter.steps;
    };
    for (const make of [
      (n: number) => `https://u:${'p@h'.repeat(n / 3)}/x`,
      (n: number) => `alice:${'@h/'.repeat(n / 3)}`,
      (n: number) => `https://${'a@'.repeat(n / 2)}h/o`,
    ]) {
      const small = steps(make(60_000));
      expect(small).toBeLessThanOrEqual(20 * 60_000);
      expect(steps(make(120_000)) / small).toBeLessThan(2.1);
    }
    // No password, no http user name: nothing.
    for (const raw of ['git@h:o/r.git', 'https://h/o/r@v2.git', 'ssh://git@h:2222/o', 'h:o/r'])
      expect(addressSecrets(raw), raw).toEqual([]);
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
    // An `@` after the first `/` that a host follows may end a password holding `/`: kept, masked.
    expect(read('alice:pw@host:o/r@v2')).toEqual({
      url: 'alice:pw@host:o/r@v2',
      display: 'alice:***@v2',
      hadCredentials: true,
    });
    expect(read('alice:p:w@host:o/r.git').url).toBe('alice@host:o/r.git');
    expect(read('alice:pw@[2001:db8::1]:o/r.git').url).toBe('alice@[2001:db8::1]:o/r.git');
    // Ambiguous: a password holding `@`, an `@x:` in the path, a schemeless `user:token@host/path`
    // (the same shape as the path `a@x/y` on `host`), a pathless `host:repo@x`. Kept as they are
    // (never two remotes made equal), shown with `***` (no part of a password), and flagged.
    for (const [raw, display] of [
      ['me@corp.com:SECRET@host:o/r', 'me@corp.com:***@host:o/r'],
      ['me@corp.com:p@ss@host:o/r', 'me@corp.com:***@host:o/r'],
      ['me@corp.com:SECRET@host/o/r', 'me@corp.com:***@host/o/r'],
      ['me@corp.com:SECRET@host', 'me@corp.com:***@host'],
      ['alice:p@ss@host:o/r.git', 'alice:***@host:o/r.git'],
      ['alice:p@ss:w@host:o', 'alice:***@host:o'],
      ['alice:pw@host:a@b:c', 'alice:***@b:c'],
      ['alice:token@github.com/o/r.git', 'alice:***@github.com/o/r.git'],
      ['host:a@x/y', 'host:***@x/y'],
      ['host:repo@x', 'host:***@x'],
      ['alice:p@ss:w@host', 'alice:***@host'],
      // A `/` in the password: its `@` comes after the first `/`.
      ['u:se/cret@h/p', 'u:***@h/p'],
      ['alice:pa/ss@host:o/r', 'alice:***@host:o/r'],
      ['me@corp.com:pa/ss@host/o/r', 'me@corp.com:***@host/o/r'],
      // With no path after the host.
      ['u:pa/ss@host', 'u:***@host'],
      ['me@corp.com:pa/ss@host', 'me@corp.com:***@host'],
      // A path's `@` reads the same: shown masked too (Connect accepts it).
      ['gitea:team/app@v2.git', 'gitea:***@v2.git'],
      ['git@host:o/r@v2.git', 'git@host:***@v2.git'],
    ] as const) {
      expect(read(raw), raw).toEqual({ url: raw, display, hadCredentials: true });
    }
    expect(read('host:a@x/y').url).not.toBe(read('host:b@x/y').url);
    expect(read('alice:pw@host:a@b:c').url).not.toBe(read('alice:pw@other:a@b:c').url);
    // No `user:` at all: nothing to hide.
    for (const raw of ['git@host:o/r.git', '[2001:db8::1]:o/r@x', '[2001:db8::1]:a@b:c'])
      expect(read(raw), raw).toEqual({ url: raw, display: raw, hadCredentials: false });
  });

  it('reads a long hand-set address in linear time: each character a fixed number of times', () => {
    const addresses = (n: number) => [
      `me@${'a@'.repeat(n / 2)}:x`,
      `me@corp.com:${'s@'.repeat(n / 2)}`,
      `${'a@'.repeat(n / 2)}:${'b@'.repeat(n / 2)}/x`,
      `u@x:${'@h'.repeat(n / 2)}:`,
      `${'@'.repeat(n)}`,
      // Many `@`s, each followed by a host that fails, after a user name holding an `@`.
      `me@x:${'@hostname['.repeat(n / 10)}/x`,
      `alice:${'@[v6'.repeat(n / 4)}`,
      // Not readable as a URL (a space in the host): the fallback reads it.
      `https://u:${'p@'.repeat(n / 2)}@h o/r?${'q'.repeat(n / 2)}`,
    ];
    const steps = (address: string) => {
      const meter: ScanMeter = { steps: 0 };
      remoteUrlForDisplay(address, meter);
      return meter.steps;
    };
    const large = addresses(120_000);
    addresses(60_000).forEach((address, i) => {
      const small = steps(address);
      expect(small, address.slice(0, 20)).toBeLessThanOrEqual(6 * address.length);
      expect(steps(large[i]!) / small, address.slice(0, 20)).toBeLessThan(2.1);
    });
  });

  it('URL forms: user info goes up to its last `@`; an `@` in the path stays unless a `:` may start a password, and a cut shows ***', () => {
    const shown = (url: string) => remoteUrlForDisplay(url).display;
    expect(shown('https://github.com/o/r@v2.git')).toBe('https://github.com/o/r@v2.git');
    expect(shown('https://u:p@ss@host/o/r.git')).toBe('https://host/o/r.git');
    // With a `:` in the user info, an `@` in the path may end a password holding `/`: shown cut,
    // with *** where it was cut (never as another, clean-looking address).
    expect(shown('https://u:p@GitHub.com/o/r@v2.git')).toBe('https://***@v2.git');
    expect(shown('ssh://git:pw@[2001:db8::1]:2222/o/r@v2.git')).toBe('ssh://***@v2.git');
    expect(remoteUrlForDisplay('https://u:p@GitHub.com/o/r@v2.git').url).toBe(
      'https://github.com/o/r@v2.git',
    );
    expect(shown('ssh://me@corp.com:pw@host/o/r')).not.toContain('pw');
    // Not parseable (a `/` in the password): everything up to the last `@` goes.
    expect(remoteUrlForDisplay('ssh://git:pa/ss@h/x')).toMatchObject({
      display: 'ssh://***@h/x',
      hadCredentials: true,
    });
    // A password starting with digits (or `/`, `?`, `#`) reads as a port and a path, as an `@` in the
    // path after a real port does: kept as it is (Connect may take it), shown up to the last `@`.
    for (const [raw, display] of [
      ['https://u:2024/Secret@h/o/r', 'https://***@h/o/r'],
      ['https://u:2024/S@h/o', 'https://***@h/o'],
      ['https://u:123?abc@h/o', 'https://***@h/o'],
      ['https://u:9#t@h/o', 'https://***@h/o'],
      ['https://u:#t@h/o', 'https://***@h/o'],
      ['ssh://git:22/S3C@host:2222/o/r', 'ssh://***@host:2222/o/r'],
      ['https://host:8443/g/n@v2/r.git', 'https://***@v2/r.git'],
      ['https://u:2024/S@[::1]:8443/o', 'https://***@[::1]:8443/o'],
      // A `\\` ends the parser's user info and host; git sends it as part of the user info.
      ['https://u:2024\\S3CRET@github.com/o/r.git', 'https://***@github.com/o/r.git'],
      ['https://x-access-token:12\\ghp_T0K@github.com/o/r.git', 'https://***@github.com/o/r.git'],
      ['https://alice:a@b\\c@github.com/o/r.git', 'https://***@github.com/o/r.git'],
      ['https://u@h\\x@github.com/o', 'https://***@github.com/o'],
    ] as const)
      expect(remoteUrlForDisplay(raw), raw).toMatchObject({ display, hadCredentials: true });
    // Kept as git reads it (Connect may take it).
    expect(remoteUrlForDisplay('https://host:8443/g/n@v2/r.git').url).toBe('https://host:8443/g/n@v2/r.git');
    // Without a `:` before the path, an `@` in the path stays.
    expect(remoteUrlForDisplay('https://host/o/r@v2.git')).toMatchObject({
      display: 'https://host/o/r@v2.git',
      hadCredentials: false,
    });
    // Not parseable (whitespace or a quote mark in the password, a space in the host): the same.
    for (const c of ['\t', '\u00a0', '\u2003', ' ', '’', '“', '”', '«', '»'])
      expect(remoteUrlForDisplay(`https://u:S3C${c}R3T@h o/r`), JSON.stringify(c)).toEqual({
        url: 'https://h o/r',
        display: 'https://***@h o/r',
        hadCredentials: true,
      });
    // Parseable: the URL parser takes them out with the rest of the user info.
    for (const c of ['\t', '\u00a0', '\u2003', ' ', '’', '“', '”', '«', '»'])
      expect(remoteUrlForDisplay(`https://u:S3C${c}R3T@h/o/r`).display, JSON.stringify(c)).toBe(
        'https://h/o/r',
      );
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

describe('a `\\` in an http password, as git sends it', () => {
  it('git sends it in the user info; core shows ***, masks it and its Basic value, and Connect refuses it', async () => {
    let authorization = '';
    const server = http.createServer((req, res) => {
      authorization ||= req.headers.authorization ?? '';
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const address = `http://u:2024\\S3CRET@127.0.0.1:${port}/o/r.git`;
    try {
      const failure = await promisify(execFile)('git', ['ls-remote', '--', address], {
        cwd: tmpdir(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).catch((e: { stderr: string }) => e);
      expect(Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString()).toBe('u:2024\\S3CRET');
      expect(remoteUrlForDisplay(address).display).toBe(`http://***@127.0.0.1:${port}/o/r.git`);
      expect(shortGitError(failure, { addresses: [address] })).not.toContain('S3CRET');
      expect(
        shortGitError(new Error(`remote: ${authorization} and 2024\\S3CRET`), { addresses: [address] }),
      ).toBe('Basic [redacted] and ***');
      expect(() => validateRepositoryUrl(address.replace('http:', 'https:'))).toThrow(/Remove the user name/);
    } finally {
      server.close();
    }
  });
});
