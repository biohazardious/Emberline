import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { utils } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { projects, sshKeys } from '../db/schema.js';
import { installedSecretsKey, installSecretsKey, SecretsKeyError } from '../secrets/box.js';
import {
  deleteKey,
  generateKey,
  getPublicKey,
  keyForProject,
  privateKeyById,
  privateKeyFor,
} from './store.js';

/** `ssh-keygen` reading the key from stdin (`-f -`): no key file is written. */
const keygen = (args: string[], input: string) =>
  execFileSync('ssh-keygen', args, { input, encoding: 'utf8' }).trim();

let opened: ReturnType<typeof openDb>;
let db: Db;
const testKey = installedSecretsKey();

const addProject = (id: string, slug = id) =>
  db
    .insert(projects)
    .values({ id, name: id, slug, path: `/workspaces/${slug}`, createdAt: new Date() })
    .run();
const project = (id: string) => db.select().from(projects).where(eq(projects.id, id)).get()!;
const choose = (id: string, choice: 'shared' | 'own') =>
  db.update(projects).set({ sshKeyChoice: choice }).where(eq(projects.id, id)).run();

beforeEach(() => {
  opened = openDb(':memory:');
  db = opened.db;
});
afterEach(() => {
  installSecretsKey(testKey);
  opened.close();
});

describe('SSH keys', () => {
  it('generates an ed25519 key ssh-keygen accepts, with its fingerprint and the emberline comment', () => {
    const key = generateKey(db, 'shared');
    expect(key.algorithm).toBe('ed25519');
    expect(key.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ emberline$/);
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(key.createdAt).toBeInstanceOf(Date);
    expect(keygen(['-l', '-f', '-'], `${key.publicKey}\n`)).toBe(
      `256 ${key.fingerprint} emberline (ED25519)`,
    );
    expect(Object.keys(key).sort()).toEqual(['algorithm', 'createdAt', 'fingerprint', 'publicKey']);
    expect(getPublicKey(db, 'shared')).toEqual(key);
  });

  it("a project's key carries the project's slug as its comment", () => {
    addProject('p1', 'my-app');
    const key = generateKey(db, { projectId: 'p1', slug: 'my-app' });
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ emberline-my-app$/);
    expect(keygen(['-l', '-f', '-'], `${key.publicKey}\n`)).toBe(
      `256 ${key.fingerprint} emberline-my-app (ED25519)`,
    );
    expect(getPublicKey(db, { projectId: 'p1' })).toEqual(key);
    expect(getPublicKey(db, 'shared')).toBeNull();
  });

  it('the private key opens only in memory: the row holds it sealed, and it matches the public key', () => {
    const key = generateKey(db, 'shared');
    const pem = privateKeyFor(db, 'shared')!;
    expect(pem).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n?$/,
    );
    // Round-trips through ssh2's parser (the gateway's) and through OpenSSH.
    const parsed = utils.parseKey(pem);
    expect(parsed).not.toBeInstanceOf(Error);
    const [type, blob] = key.publicKey.split(' ');
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe('ssh-ed25519');
    expect(parsed.getPublicSSH().toString('base64')).toBe(blob);
    // Through `cat`: node's stdin for a child is a socket, which ssh-keygen cannot open as /dev/stdin.
    const derived = execFileSync('sh', ['-c', 'cat | ssh-keygen -y -f /dev/stdin'], {
      input: pem,
      encoding: 'utf8',
    });
    expect(derived.split(' ').slice(0, 2)).toEqual([type, blob]);

    const rows = db.$client.prepare('select * from ssh_keys').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.private_key_enc)).toMatch(/^enc:v1:/);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('PRIVATE KEY');
    for (const line of pem.split('\n').filter((l) => l && !l.startsWith('-----'))) {
      expect(dump).not.toContain(line);
    }
  });

  it('another secrets key cannot open it (it is sealed with the installed key)', () => {
    generateKey(db, 'shared');
    installSecretsKey(randomBytes(32));
    expect(() => privateKeyFor(db, 'shared')).toThrow(SecretsKeyError);
  });

  it('a new key replaces the old one at once: new fingerprint, new id, one row', () => {
    const first = generateKey(db, 'shared');
    const firstId = keyForProject(db, { id: 'x', sshKeyChoice: 'shared' })!.keyId;
    const firstPem = privateKeyFor(db, 'shared');
    const second = generateKey(db, 'shared');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(privateKeyFor(db, 'shared')).not.toBe(firstPem);
    expect(getPublicKey(db, 'shared')).toEqual(second);
    expect(db.select().from(sshKeys).all()).toHaveLength(1);
    // A capability bound to the old key id finds nothing (it never silently uses the new key).
    expect(keyForProject(db, { id: 'x', sshKeyChoice: 'shared' })!.keyId).not.toBe(firstId);
  });

  it('delete removes the key; a second delete finds nothing', () => {
    generateKey(db, 'shared');
    expect(deleteKey(db, 'shared')).toBe(true);
    expect(getPublicKey(db, 'shared')).toBeNull();
    expect(privateKeyFor(db, 'shared')).toBeNull();
    expect(deleteKey(db, 'shared')).toBe(false);
  });

  it("the shared key and a project's key are separate", () => {
    addProject('p1');
    const shared = generateKey(db, 'shared');
    const own = generateKey(db, { projectId: 'p1', slug: 'p1' });
    expect(own.fingerprint).not.toBe(shared.fingerprint);
    expect(deleteKey(db, { projectId: 'p1' })).toBe(true);
    expect(getPublicKey(db, 'shared')).toEqual(shared);
  });

  it('deleting a project deletes its key, and only its key', () => {
    addProject('p1');
    addProject('p2');
    generateKey(db, 'shared');
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    const p2 = generateKey(db, { projectId: 'p2', slug: 'p2' });
    db.delete(projects).where(eq(projects.id, 'p1')).run();
    expect(getPublicKey(db, { projectId: 'p1' })).toBeNull();
    expect(privateKeyFor(db, { projectId: 'p1' })).toBeNull();
    expect(getPublicKey(db, { projectId: 'p2' })).toEqual(p2);
    expect(getPublicKey(db, 'shared')).not.toBeNull();
    expect(db.select().from(sshKeys).all()).toHaveLength(2);
  });

  it('a key for a project that does not exist is refused', () => {
    expect(() => generateKey(db, { projectId: 'nope', slug: 'nope' })).toThrow();
    expect(db.select().from(sshKeys).all()).toHaveLength(0);
  });
});

describe('keyForProject (the chosen key)', () => {
  it('a new project uses the shared key', () => {
    addProject('p1');
    expect(project('p1').sshKeyChoice).toBe('shared');
    expect(keyForProject(db, project('p1'))).toBeNull();
    generateKey(db, 'shared');
    const shared = db.select().from(sshKeys).where(eq(sshKeys.scope, 'shared')).get()!;
    expect(keyForProject(db, project('p1'))).toEqual({ scope: 'shared', keyId: shared.id });
  });

  it("`own` uses the project's key, never the shared one when it is missing", () => {
    addProject('p1');
    generateKey(db, 'shared');
    choose('p1', 'own');
    expect(keyForProject(db, project('p1'))).toBeNull();
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    const own = db.select().from(sshKeys).where(eq(sshKeys.scope, 'p1')).get()!;
    expect(keyForProject(db, project('p1'))).toEqual({ scope: { projectId: 'p1' }, keyId: own.id });
    expect(privateKeyFor(db, { projectId: 'p1' })).toMatch(/OPENSSH PRIVATE KEY/);
  });

  it("switching back to the shared key keeps the project's key for later", () => {
    addProject('p1');
    generateKey(db, 'shared');
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    choose('p1', 'own');
    const own = keyForProject(db, project('p1'))!;
    choose('p1', 'shared');
    expect(keyForProject(db, project('p1'))!.scope).toBe('shared');
    choose('p1', 'own');
    expect(keyForProject(db, project('p1'))).toEqual(own);
  });

  it('the chosen key deleted or replaced: the next lookup sees null or the new key', () => {
    addProject('p1');
    generateKey(db, 'shared');
    const before = keyForProject(db, project('p1'))!;
    generateKey(db, 'shared');
    const after = keyForProject(db, project('p1'))!;
    expect(after.keyId).not.toBe(before.keyId);
    deleteKey(db, 'shared');
    expect(keyForProject(db, project('p1'))).toBeNull();
    // A project key does not stand in for a deleted shared key.
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    expect(keyForProject(db, project('p1'))).toBeNull();
  });
});

describe('privateKeyById (a capability bound to a key id)', () => {
  it('opens the key with its scope while that id is the current key, null once replaced or deleted', () => {
    addProject('p1');
    generateKey(db, 'shared');
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    const sharedId = keyForProject(db, { id: 'p1', sshKeyChoice: 'shared' })!.keyId;
    const ownId = keyForProject(db, { id: 'p1', sshKeyChoice: 'own' })!.keyId;
    expect(privateKeyById(db, sharedId)).toEqual({
      scope: 'shared',
      privateKey: privateKeyFor(db, 'shared'),
    });
    expect(privateKeyById(db, ownId)).toEqual({
      scope: { projectId: 'p1' },
      privateKey: privateKeyFor(db, { projectId: 'p1' }),
    });
    generateKey(db, 'shared');
    expect(privateKeyById(db, sharedId)).toBeNull();
    deleteKey(db, { projectId: 'p1' });
    expect(privateKeyById(db, ownId)).toBeNull();
    expect(privateKeyById(db, 'no-such-id')).toBeNull();
  });
});
