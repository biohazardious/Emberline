import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from './db/schema.js';
import { sshFingerprint } from './ssh-keys/known-hosts.js';
import { ed25519KeyPair } from './ssh-keys/store.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
const bodies: string[] = [];

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, headers: authHeaders(cookie), payload: payload as never });
  bodies.push(res.body);
  return res;
};

/** A fresh ed25519 host key as the blob and its fingerprint. */
const hostKey = () => {
  // ed25519KeyPair, not ssh2's generator: that drops a leading zero byte (1 key in 256 is malformed).
  const key = ed25519KeyPair('host').publicKey.split(' ')[1]!;
  return { keyType: 'ssh-ed25519', key, fingerprint: sshFingerprint(key) };
};

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  t.db
    .insert(projects)
    .values({ id: 'p1', name: 'p1', slug: 'p1', path: '/workspaces/p1', createdAt: new Date() })
    .run();
});
afterEach(async () => {
  expect(bodies.join('\n')).not.toContain('PRIVATE KEY');
  bodies.length = 0;
  await t.close();
});

describe('SSH key API', () => {
  it('requires a session and the CSRF header', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/ssh-key' })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/ssh-key', headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/ssh-host-keys' })).statusCode).toBe(401);
  });

  it('generates, shows, replaces and deletes the shared key', async () => {
    expect((await call('GET', '/api/ssh-key')).json()).toEqual({ key: null });
    const first = (await call('POST', '/api/ssh-key')).json().key;
    expect(first.publicKey).toMatch(/^ssh-ed25519 /);
    expect((await call('GET', '/api/ssh-key')).json().key.fingerprint).toBe(first.fingerprint);
    const second = (await call('POST', '/api/ssh-key')).json().key;
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect((await call('DELETE', '/api/ssh-key')).statusCode).toBe(204);
    expect((await call('GET', '/api/ssh-key')).json()).toEqual({ key: null });
  });

  it('manages a project key and its choice', async () => {
    const shared = (await call('POST', '/api/ssh-key')).json().key;
    const start = (await call('GET', '/api/projects/p1/ssh-key')).json();
    expect(start).toMatchObject({ choice: 'shared', key: null });
    expect(start.shared.fingerprint).toBe(shared.fingerprint);

    const own = (await call('PUT', '/api/projects/p1/ssh-key-choice', { choice: 'own' })).json();
    expect(own.choice).toBe('own');
    expect(own.key.publicKey).toMatch(/emberline-p1$/);

    const replaced = (await call('POST', '/api/projects/p1/ssh-key')).json();
    expect(replaced.key.fingerprint).not.toBe(own.key.fingerprint);

    expect((await call('PUT', '/api/projects/p1/ssh-key-choice', { choice: 'shared' })).json().choice).toBe(
      'shared',
    );
    expect((await call('DELETE', '/api/projects/p1/ssh-key')).statusCode).toBe(204);
    expect((await call('GET', '/api/projects/p1/ssh-key')).json().key).toBeNull();
  });

  it('answers 404 for an unknown project and 400 for a bad choice', async () => {
    expect((await call('GET', '/api/projects/nope/ssh-key')).statusCode).toBe(404);
    expect((await call('POST', '/api/projects/nope/ssh-key')).statusCode).toBe(404);
    expect((await call('PUT', '/api/projects/p1/ssh-key-choice', { choice: 'x' })).statusCode).toBe(400);
  });

  it('trusts, lists and removes a host key', async () => {
    const k = hostKey();
    const body = { host: 'Git.Example.com', port: 22, ...k };
    expect((await call('POST', '/api/ssh-host-keys', body)).statusCode).toBe(201);
    const list = (await call('GET', '/api/ssh-host-keys')).json().hosts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ host: 'git.example.com', fingerprint: k.fingerprint });
    const gone = await call('DELETE', '/api/ssh-host-keys', {
      host: 'git.example.com',
      port: 22,
      keyType: k.keyType,
    });
    expect(gone.statusCode).toBe(204);
    expect((await call('GET', '/api/ssh-host-keys')).json().hosts).toEqual([]);
  });

  it('refuses a fingerprint that does not match the key', async () => {
    const k = hostKey();
    const res = await call('POST', '/api/ssh-host-keys', {
      host: 'git.example.com',
      port: 22,
      ...k,
      fingerprint: hostKey().fingerprint,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses another key for a host that has one (409), pinned or trusted', async () => {
    const a = hostKey();
    await call('POST', '/api/ssh-host-keys', { host: 'git.example.com', port: 22, ...a });
    const other = await call('POST', '/api/ssh-host-keys', {
      host: 'git.example.com',
      port: 22,
      ...hostKey(),
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('host_key_changed');
    const pinned = await call('POST', '/api/ssh-host-keys', { host: 'github.com', port: 22, ...hostKey() });
    expect(pinned.statusCode).toBe(409);
  });
});
