import { describe, expect, it } from 'vitest';
import {
  bannerProjects,
  createdText,
  deployKeyHint,
  hostKeyOf,
  hostLabel,
  isSshAddress,
  keyInUse,
  repoPathOf,
  sshProblemFor,
} from './sshKeys';

const key = (fingerprint: string) => ({
  publicKey: `ssh-ed25519 AAAA ${fingerprint}`,
  fingerprint,
  createdAt: new Date('2026-11-10T12:00:00Z'),
  algorithm: 'ed25519' as const,
});

describe('isSshAddress', () => {
  it('is true for ssh:// and scp-like addresses', () => {
    expect(isSshAddress('git@github.com:o/r.git')).toBe(true);
    expect(isSshAddress('ssh://git@host:2222/o/r.git')).toBe(true);
    expect(isSshAddress('  host:o/r ')).toBe(true);
  });
  it('is false for http(s), other schemes and local paths', () => {
    expect(isSshAddress('https://github.com/o/r.git')).toBe(false);
    expect(isSshAddress('http://host/o/r')).toBe(false);
    expect(isSshAddress('file:///srv/r')).toBe(false);
    expect(isSshAddress('ext::sh -c x')).toBe(false);
    expect(isSshAddress('/srv/repo')).toBe(false);
    expect(isSshAddress('./a:b')).toBe(false);
    expect(isSshAddress('')).toBe(false);
  });
});

describe('repoPathOf and deployKeyHint', () => {
  it('reads owner/repo from both ssh forms', () => {
    expect(repoPathOf('git@github.com:alice/shop.git')).toBe('alice/shop');
    expect(repoPathOf('ssh://git@git.example.com:2222/team/app.git/')).toBe('team/app');
    expect(repoPathOf('https://github.com/alice/shop.git')).toBeNull();
    expect(repoPathOf('ssh://host')).toBeNull();
  });
  it('names the repository in the deploy-key hint, with write access', () => {
    expect(deployKeyHint('git@github.com:alice/shop.git')).toContain(
      'Add it to alice/shop → Settings → Deploy keys, tick "Allow write access"',
    );
    expect(deployKeyHint(null)).toContain('Add it to the repository →');
  });
});

describe('sshProblemFor', () => {
  it('offers an ssh fix only for an ssh address', () => {
    expect(sshProblemFor('git@h:o/r', 'auth_refused')).toBe('auth_refused');
    expect(sshProblemFor('git@h:o/r', 'host_key_unknown')).toBe('host_key_unknown');
    // An https account's refused token: today's plain message, no deploy-key help.
    expect(sshProblemFor('https://github.com/o/r.git', 'auth_refused')).toBeNull();
    expect(sshProblemFor('git@h:o/r', 'not_found')).toBeNull();
    expect(sshProblemFor('git@h:o/r', undefined)).toBeNull();
    expect(sshProblemFor(null, 'auth_refused')).toBeNull();
  });
});

describe('hostKeyOf', () => {
  it('takes a whole host key from an error body and refuses a partial one', () => {
    const hostKey = { host: 'h', port: 22, keyType: 'ssh-ed25519', key: 'AAAA', fingerprint: 'SHA256:x' };
    expect(hostKeyOf({ hostKey })).toEqual(hostKey);
    expect(hostKeyOf({ hostKey: { host: 'h' } })).toBeNull();
    expect(hostKeyOf({})).toBeNull();
    expect(hostKeyOf(undefined)).toBeNull();
  });
});

describe('small texts', () => {
  it('labels a host with its port only when it is not 22', () => {
    expect(hostLabel({ host: 'git.example.com', port: 22 })).toBe('git.example.com');
    expect(hostLabel({ host: 'git.example.com', port: 2222 })).toBe('git.example.com:2222');
  });
  it('picks the chosen key, never the other one', () => {
    expect(keyInUse({ choice: 'own', key: null, shared: key('S') })).toBeNull();
    expect(keyInUse({ choice: 'shared', key: key('P'), shared: key('S') })?.fingerprint).toBe('S');
  });
  it('formats the creation date from the API string', () => {
    expect(createdText('2026-11-10T12:00:00.000Z')).toBe('10 Nov 2026');
    expect(createdText('nope')).toBe('');
  });
  it('names a few projects, then counts the rest', () => {
    expect(bannerProjects(['A', 'B'])).toEqual({ shown: ['A', 'B'], more: 0 });
    expect(bannerProjects(['A', 'B', 'C', 'D', 'E'])).toEqual({ shown: ['A', 'B', 'C'], more: 2 });
  });
});
