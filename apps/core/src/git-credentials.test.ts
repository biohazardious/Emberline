import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCredentialForRemote } from './forge/account-store.js';
import {
  basicAuthValue,
  type GitHttpCredential,
  redactCredential,
  urlUnderServer,
} from './git-credentials.js';
import { authorizationFor, redirectTarget } from './git-gateway/upstream.js';
import { createTestApp, seedForgeAccount, type TestApp } from './test-utils.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('which URLs get an account credential (prefix confusion)', () => {
  it.each([
    ['https://github.com', 'https://github.com/a/b.git', true],
    ['https://github.com', 'https://GitHub.COM/a/b.git', true], // the same host in other case
    ['https://github.com', 'https://github.com:443/a/b.git', true], // the default port is the same origin
    ['https://github.com', 'https://github.com.evil.com/a/b.git', false],
    ['https://github.com', 'https://evilgithub.com/a/b.git', false],
    ['https://github.com', 'https://github.com:8443/a/b.git', false],
    ['https://github.com', 'http://github.com/a/b.git', false],
    ['https://github.com', 'https://evil.com@github.com/a/b.git', false], // user info: never
    ['https://github.com', 'https://x-access-token:t@github.com/a/b.git', false],
    ['https://github.com', 'https://github.com@evil.com/a/b.git', false],
    ['https://example.com/gitea', 'https://example.com/gitea/al/b.git', true],
    ['https://example.com/gitea', 'https://example.com/gitea', true],
    ['https://example.com/gitea', 'https://example.com/gitea-evil/al/b.git', false],
    ['https://example.com/gitea', 'https://example.com/gitea/../other/b.git', false],
    ['https://example.com/gitea', 'https://example.com/Gitea/al/b.git', false],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000/al/b.git', true],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3001/al/b.git', false],
  ] as const)('server %s, URL %s → %s', (server, url, expected) => {
    expect(urlUnderServer(url, server)).toBe(expected);
    expect(authorizationFor(new URL(url), { serverUrl: server, username: 'u', token: 'T' }) !== null).toBe(
      expected,
    );
  });
});

describe('redirectTarget', () => {
  const c: GitHttpCredential = { serverUrl: 'https://git.example.com/gitea', username: 'u', token: 'T' };
  const from = new URL('https://git.example.com/gitea/al/b.git/info/refs?service=git-upload-pack');
  it.each([
    [
      '/gitea/al/renamed.git/info/refs?service=git-upload-pack',
      'https://git.example.com/gitea/al/renamed.git/info/refs?service=git-upload-pack',
    ],
    ['http://git.example.com/gitea/al/b.git/info/refs', null], // https → http
    ['https://git.example.com:8443/gitea/al/b.git/info/refs', null],
    ['https://other.example.com/gitea/al/b.git/info/refs', null],
    ['https://u:p@git.example.com/gitea/al/b.git/info/refs', null],
    ['//evil.example.com/gitea/x', null],
    ['/elsewhere/al/b.git/info/refs', null], // outside the account's server path
  ])('%s → %s', (location, expected) => {
    expect(redirectTarget(from, location, c)?.href ?? null).toBe(expected);
  });
});

describe('redaction', () => {
  it('replaces the token and its Basic value', () => {
    const c: GitHttpCredential = {
      serverUrl: 'https://github.com',
      username: 'x-access-token',
      token: 'ghp_X',
    };
    expect(redactCredential(`x ghp_X y ${basicAuthValue(c)} z`, c)).toBe('x [redacted] y [redacted] z');
  });
});

describe('gitCredentialForRemote', () => {
  it('only http(s) remotes under the account server, with the provider user, never with user info', () => {
    seedForgeAccount(t.db, { provider: 'github', serverUrl: 'https://github.com', token: 'gh' });
    seedForgeAccount(t.db, { provider: 'gitlab', serverUrl: 'https://gitlab.example.com', token: 'gl' });
    seedForgeAccount(t.db, {
      provider: 'gitea',
      serverUrl: 'https://example.com/gitea',
      token: 'gt',
      username: 'al',
    });
    expect(gitCredentialForRemote(t.db, 'https://github.com/a/b.git', {})).toEqual({
      serverUrl: 'https://github.com',
      username: 'x-access-token',
      token: 'gh',
    });
    expect(gitCredentialForRemote(t.db, 'https://gitlab.example.com/g/b.git', {})?.username).toBe('oauth2');
    expect(gitCredentialForRemote(t.db, 'https://example.com/gitea/al/b.git', {})).toMatchObject({
      username: 'al',
      token: 'gt',
    });
    for (const url of [
      'https://example.com/other/al/b.git',
      'https://example.com/gitea-evil/al/b.git',
      'http://github.com/a/b.git',
      'https://github.com:8443/a/b.git',
      'git@github.com:a/b.git',
      'ssh://git@github.com/a/b.git',
      'https://github.com.evil.org/a/b.git',
      'https://me:mytoken@github.com/a/b.git',
    ]) {
      expect(gitCredentialForRemote(t.db, url, {}), url).toBeNull();
    }
  });
  it('a Gitea account without a username must be checked first', () => {
    seedForgeAccount(t.db, { provider: 'gitea', serverUrl: 'https://gitea.example.com', token: 'gt' });
    expect(() => gitCredentialForRemote(t.db, 'https://gitea.example.com/a/b.git', {})).toThrow(
      'Check the account for gitea.example.com in Settings → Forge accounts first.',
    );
  });
});
