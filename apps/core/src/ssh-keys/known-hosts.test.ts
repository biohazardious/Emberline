import { execFileSync } from 'node:child_process';
import { PINNED_SSH_HOST_KEYS } from '@emberline/protocol';
import { utils } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { HttpError } from '../errors.js';
import {
  hostKeyStatus,
  listTrustedHostKeys,
  pinnedHostKeys,
  removeHostKey,
  sshFingerprint,
  trustHostKey,
} from './known-hosts.js';

let opened: ReturnType<typeof openDb>;
let db: Db;
beforeEach(() => {
  opened = openDb(':memory:');
  db = opened.db;
});
afterEach(() => opened.close());

/** A fresh host key as a server would offer it: type and base64 blob. */
const hostKey = (type: 'ed25519' | 'ecdsa' = 'ed25519') => {
  const pub = (
    type === 'ecdsa'
      ? utils.generateKeyPairSync('ecdsa', { bits: 256 })
      : utils.generateKeyPairSync('ed25519')
  ).public;
  const [keyType, key] = pub.split(' ') as [string, string];
  return { keyType, key };
};

const GITHUB_ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

describe('pinned host keys (packages/protocol, also the runner image /etc/ssh/ssh_known_hosts)', () => {
  it('are the keys GitHub, GitLab and Bitbucket publish, as the runner image had them', () => {
    // The fingerprints each forge publishes (GitHub docs "GitHub's SSH key fingerprints",
    // docs.gitlab.com "SSH host keys fingerprints", bitbucket.org/site/ssh).
    const published = [
      'github.com ssh-ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
      'github.com ecdsa-sha2-nistp256 SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
      'github.com ssh-rsa SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
      '[ssh.github.com]:443 ssh-ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
      '[ssh.github.com]:443 ecdsa-sha2-nistp256 SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
      '[ssh.github.com]:443 ssh-rsa SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
      'gitlab.com ssh-ed25519 SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8',
      'gitlab.com ecdsa-sha2-nistp256 SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw',
      'gitlab.com ssh-rsa SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ',
      'bitbucket.org ssh-ed25519 SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM',
      'bitbucket.org ecdsa-sha2-nistp256 SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0',
      'bitbucket.org ssh-rsa SHA256:46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E',
    ];
    expect(PINNED_SSH_HOST_KEYS).toHaveLength(12);
    expect(
      PINNED_SSH_HOST_KEYS.map((line) => {
        const [host, type, key] = line.split(' ') as [string, string, string];
        return `${host} ${type} ${sshFingerprint(key)}`;
      }),
    ).toEqual(published);
    // The same lines OpenSSH reads (the runner's file is written from this list at build).
    const listed = execFileSync('ssh-keygen', ['-l', '-f', '-'], {
      input: `${PINNED_SSH_HOST_KEYS.join('\n')}\n`,
      encoding: 'utf8',
    });
    expect(
      listed
        .trim()
        .split('\n')
        .map((l) => l.split(' ').slice(1, 3).join(' ')),
    ).toEqual(
      published.map((p) => {
        const [host, , fp] = p.split(' ');
        return `${fp} ${host}`;
      }),
    );
  });

  it('parse into host, port and key type ([host]:port as written)', () => {
    const parsed = pinnedHostKeys();
    expect(parsed).toHaveLength(12);
    expect(parsed[0]).toEqual({ host: 'github.com', port: 22, keyType: 'ssh-ed25519', key: GITHUB_ED25519 });
    expect(parsed.filter((k) => k.host === 'ssh.github.com').map((k) => k.port)).toEqual([443, 443, 443]);
  });
});

describe('sshFingerprint', () => {
  it('prints what ssh-keygen -l prints (SHA256, base64 without padding)', () => {
    const { keyType, key } = hostKey('ecdsa');
    const fp = execFileSync('ssh-keygen', ['-l', '-f', '-'], {
      input: `${keyType} ${key}\n`,
      encoding: 'utf8',
    });
    expect(fp.split(' ')[1]).toBe(sshFingerprint(key));
    expect(sshFingerprint(key)).not.toContain('=');
  });
});

describe('hostKeyStatus', () => {
  it('a pinned key is pinned, on github.com:22 and on [ssh.github.com]:443', () => {
    expect(hostKeyStatus(db, 'github.com', 22, 'ssh-ed25519', GITHUB_ED25519)).toBe('pinned');
    expect(hostKeyStatus(db, 'GitHub.com', 22, 'ssh-ed25519', GITHUB_ED25519)).toBe('pinned');
    expect(hostKeyStatus(db, 'ssh.github.com', 443, 'ssh-ed25519', GITHUB_ED25519)).toBe('pinned');
  });

  it('another key of a pinned type for GitHub is changed (also on 443)', () => {
    const { key } = hostKey();
    expect(hostKeyStatus(db, 'github.com', 22, 'ssh-ed25519', key)).toBe('changed');
    expect(hostKeyStatus(db, 'ssh.github.com', 443, 'ssh-ed25519', key)).toBe('changed');
  });

  it('a pinned key is only pinned on the host:port it is listed for', () => {
    // GitHub's key on another port or host is not GitHub.
    expect(hostKeyStatus(db, 'github.com', 2222, 'ssh-ed25519', GITHUB_ED25519)).toBe('unknown');
    expect(hostKeyStatus(db, 'ssh.github.com', 22, 'ssh-ed25519', GITHUB_ED25519)).toBe('unknown');
    expect(hostKeyStatus(db, 'git.example.com', 22, 'ssh-ed25519', GITHUB_ED25519)).toBe('unknown');
  });

  it('unknown until trusted, then trusted; another key of that type is changed', () => {
    const k = hostKey();
    expect(hostKeyStatus(db, 'git.example.com', 22, k.keyType, k.key)).toBe('unknown');
    trustHostKey(db, { host: 'git.example.com', port: 22, ...k });
    expect(hostKeyStatus(db, 'git.example.com', 22, k.keyType, k.key)).toBe('trusted');
    expect(hostKeyStatus(db, 'Git.Example.com', 22, k.keyType, k.key)).toBe('trusted');
    expect(hostKeyStatus(db, 'git.example.com', 22, k.keyType, hostKey().key)).toBe('changed');
    // Another port is another server; another key type is not a change.
    expect(hostKeyStatus(db, 'git.example.com', 2222, k.keyType, k.key)).toBe('unknown');
    const ecdsa = hostKey('ecdsa');
    expect(hostKeyStatus(db, 'git.example.com', 22, ecdsa.keyType, ecdsa.key)).toBe('unknown');
  });

  it('a changed key stays changed until the stored one is removed', () => {
    const old = hostKey();
    const now = hostKey();
    trustHostKey(db, { host: 'git.example.com', port: 22, ...old });
    expect(() => trustHostKey(db, { host: 'git.example.com', port: 22, ...now })).toThrow(
      expect.objectContaining({ code: 'host_key_changed' }),
    );
    expect(hostKeyStatus(db, 'git.example.com', 22, now.keyType, now.key)).toBe('changed');
    expect(removeHostKey(db, 'git.example.com', 22, old.keyType)).toBe(true);
    expect(removeHostKey(db, 'git.example.com', 22, old.keyType)).toBe(false);
    expect(hostKeyStatus(db, 'git.example.com', 22, now.keyType, now.key)).toBe('unknown');
    trustHostKey(db, { host: 'git.example.com', port: 22, ...now });
    expect(hostKeyStatus(db, 'git.example.com', 22, now.keyType, now.key)).toBe('trusted');
  });
});

describe('trusted host keys', () => {
  it('lists what was trusted with its fingerprint and time; trusting the same key again changes nothing', () => {
    const k = hostKey();
    const e = hostKey('ecdsa');
    const first = trustHostKey(db, { host: 'Git.Example.com', port: 22, ...k });
    expect(first).toMatchObject({
      host: 'git.example.com',
      port: 22,
      ...k,
      fingerprint: sshFingerprint(k.key),
    });
    expect(first.trustedAt).toBeInstanceOf(Date);
    expect(trustHostKey(db, { host: 'git.example.com', port: 22, ...k })).toEqual(first);
    trustHostKey(db, { host: 'a.example.com', port: 2222, ...e });
    expect(listTrustedHostKeys(db)).toEqual([
      expect.objectContaining({ host: 'a.example.com', port: 2222, keyType: e.keyType }),
      first,
    ]);
  });

  it('a pinned host keeps its pinned keys: trusting another key for it is refused', () => {
    const k = hostKey();
    for (const [host, port] of [
      ['github.com', 22],
      ['ssh.github.com', 443],
    ] as const) {
      expect(() => trustHostKey(db, { host, port, ...k })).toThrow(
        expect.objectContaining({ code: 'host_key_changed' }),
      );
    }
    // Trusting a pinned key itself adds nothing.
    expect(() =>
      trustHostKey(db, { host: 'github.com', port: 22, keyType: 'ssh-ed25519', key: GITHUB_ED25519 }),
    ).toThrow(HttpError);
    expect(listTrustedHostKeys(db)).toEqual([]);
  });

  it('refuses a key whose blob is not of the type named, a bad port or host', () => {
    const k = hostKey();
    const bad = [
      { host: 'git.example.com', port: 22, keyType: 'ecdsa-sha2-nistp256', key: k.key },
      { host: 'git.example.com', port: 22, keyType: k.keyType, key: 'not base64!' },
      { host: 'git.example.com', port: 0, ...k },
      { host: 'git.example.com', port: 65536, ...k },
      { host: '', port: 22, ...k },
      { host: 'git example.com', port: 22, ...k },
    ];
    for (const entry of bad) expect(() => trustHostKey(db, entry)).toThrow(HttpError);
    expect(listTrustedHostKeys(db)).toEqual([]);
  });
});
