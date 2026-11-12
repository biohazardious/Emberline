/**
 * ssh remotes through the git gateway with Emberline's keys (spec Part 2): Connect, Refresh, Push
 * main, Keep main pushed and a run's push against a real sshd, with the shared key, the project's
 * own key, no key (`ssh_key_missing`, nothing reaches the server), and an unknown or changed host key.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryStatus, SystemStatus } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projects, runs } from './db/schema.js';
import { readRepositorySettings } from './db/project-settings.js';
import { HttpError } from './errors.js';
import { trustHostKey } from './ssh-keys/known-hosts.js';
import { deleteKey, ed25519KeyPair, generateKey } from './ssh-keys/store.js';
import { SSHD, type SshForge, startSshForge } from './test-ssh-forge.js';
import { authHeaders, createTestApp, setupAndLogin, startGitGateway, type TestApp } from './test-utils.js';

const MISSING = "Create a key in Settings → SSH key, or in this project's settings.";
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const commit = (dir: string, file: string) => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', file);
};

describe.skipIf(!SSHD)('ssh remotes through the gateway', () => {
  let forge: SshForge;
  let t: TestApp;
  let cookie: string;
  let projectId: string;
  let projectPath: string;
  let url: string;
  /** Each test's own bare repository on the forge. */
  let name: string;
  let count = 0;
  const send = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: path,
      headers: authHeaders(cookie),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const repo = (suffix: string) => `/api/projects/${projectId}/repository/${suffix}`;
  const trustForge = () =>
    trustHostKey(t.db, {
      host: '127.0.0.1',
      port: forge.port,
      keyType: forge.hostKey.keyType,
      key: forge.hostKey.key,
    });
  const sharedKey = () => {
    const key = generateKey(t.db, 'shared');
    forge.authorize(key.publicKey);
    return key;
  };
  /** An origin connected before 0.7.0 (it worked through the runner's ~/.ssh then). */
  const connectedEarlier = () => {
    git(projectPath, 'remote', 'add', 'origin', url);
    t.db.update(projects).set({ repoUrl: url }).where(eq(projects.id, projectId)).run();
  };
  const tip = () => git(projectPath, 'rev-parse', 'HEAD');
  /** A run with its own branch and one commit on it. */
  const addRun = () => {
    const wt = path.join(t.dir, '.worktrees', 'run-1');
    git(projectPath, 'worktree', 'add', '-q', '-b', 'emberline/run-1', wt);
    commit(wt, 'run.txt');
    const now = new Date();
    t.db
      .insert(runs)
      .values({
        id: 'r1',
        projectId,
        agent: 'claude',
        state: 'done',
        worktreePath: wt,
        branch: 'emberline/run-1',
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
        title: 'T',
      })
      .run();
    return wt;
  };
  const rejection = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  };
  const system = async () => (await send('GET', '/api/system')).json() as SystemStatus;

  beforeAll(async () => {
    forge = await startSshForge();
  });
  afterAll(() => forge?.close());
  beforeEach(async () => {
    t = await createTestApp();
    await startGitGateway(t);
    cookie = await setupAndLogin(t.app);
    const made = (await send('POST', '/api/projects', { name: 'Ssh App', initGit: true })).json();
    projectId = made.project.id;
    projectPath = made.project.path;
    name = `app${++count}`;
    url = forge.address(name);
    forge.bare(name);
    forge.authorize();
  });
  afterEach(async () => {
    await t.close();
  });
  const bareMain = () => git(forge.bare(name), 'rev-parse', '--verify', '--quiet', 'refs/heads/main');

  it('without a key every remote operation fails with what to do, and nothing reaches the server', async () => {
    trustForge();
    const before = forge.sessions().length;
    const connect = await send('POST', repo('connect'), { url });
    expect(connect.statusCode, connect.body).toBe(409);
    expect(connect.json()).toMatchObject({ error: 'ssh_key_missing', message: MISSING });
    expect(git(projectPath, 'remote')).toBe('');

    connectedEarlier();
    for (const action of ['refresh', 'push-main']) {
      const res = await send('POST', repo(action));
      expect(res.statusCode, action).toBe(409);
      expect(res.json(), action).toMatchObject({ error: 'ssh_key_missing', message: MISSING });
    }
    // Keep main pushed records why; a run's push is refused the same way.
    expect(await t.repository.pushMainQuietly(projectId, tip())).toEqual({ ok: false, reason: MISSING });
    expect(readRepositorySettings(t.db, projectId).lastMainPushError).toBe(MISSING);
    addRun();
    expect(await rejection(t.runs.push('r1'))).toMatchObject({ code: 'ssh_key_missing', message: MISSING });
    expect(forge.sessions().length).toBe(before);
    // The banner names the project until a key exists.
    expect((await system()).sshKeyMissing).toEqual([{ projectId, name: 'Ssh App' }]);
    generateKey(t.db, 'shared');
    expect((await system()).sshKeyMissing).toEqual([]);
  });

  it('an unknown host key fails with the key to trust; trusted, Connect, Refresh, Push main, Keep main pushed and a run push work with the shared key', async () => {
    sharedKey();
    const before = forge.sessions().length;
    const unknown = await send('POST', repo('connect'), { url });
    expect(unknown.statusCode, unknown.body).toBe(409);
    expect(unknown.json()).toMatchObject({
      error: 'host_key_unknown',
      hostKey: { host: '127.0.0.1', port: forge.port, ...forge.hostKey },
    });
    expect(unknown.json().message).toContain(forge.hostKey.fingerprint);
    expect(forge.sessions().length).toBe(before);
    // What the UI sends after the person compared the fingerprint.
    const trusted = await send('POST', '/api/ssh-host-keys', unknown.json().hostKey);
    expect(trusted.statusCode, trusted.body).toBe(201);

    const connected = await send('POST', repo('connect'), { url });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({ connected: true, transport: 'ssh', mainState: 'unpublished' });
    expect(git(projectPath, 'remote', 'get-url', 'origin')).toBe(url);

    const pushed = await send('POST', repo('push-main'));
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(bareMain()).toBe(tip());
    expect(((await send('POST', repo('refresh'))).json() as RepositoryStatus).mainState).toBe('up_to_date');

    commit(projectPath, 'next.txt');
    await t.repository.update(projectId, { pushTarget: 'default_branch' });
    expect(await t.repository.pushMainQuietly(projectId, tip())).toEqual({ ok: true });
    expect(bareMain()).toBe(tip());

    const wt = addRun();
    await t.runs.push('r1');
    expect(git(forge.bare(name), 'rev-parse', 'refs/heads/emberline/run-1')).toBe(
      git(wt, 'rev-parse', 'HEAD'),
    );
    // Every session was git's own, and nothing of the gateway went into the repository's config.
    expect(forge.sessions().length).toBeGreaterThan(before);
    expect(git(projectPath, 'config', '--get-regexp', '^remote\\.')).not.toMatch(/api\/internal\/git/);
    expect((await system()).sshKeyMissing).toEqual([]);
  });

  it("the project's own key is used once chosen; the server not knowing it fails with where to add it", async () => {
    trustForge();
    sharedKey();
    connectedEarlier();
    const own = await send('PUT', `/api/projects/${projectId}/ssh-key-choice`, { choice: 'own' });
    expect(own.statusCode, own.body).toBe(200);
    const refused = await send('POST', repo('push-main'));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe(
      "Push failed: The server refused Emberline's SSH key: add the public key shown in this project's settings to the repository or account.",
    );
    forge.authorize(own.json().key.publicKey);
    expect((await send('POST', repo('push-main'))).statusCode).toBe(200);
    expect(bareMain()).toBe(tip());
    // Ruling 19: its key deleted, the choice stays own: no fall-back to the shared key.
    deleteKey(t.db, { projectId });
    const missing = await send('POST', repo('refresh'));
    expect(missing.json()).toMatchObject({ error: 'ssh_key_missing', message: MISSING });
    expect((await system()).sshKeyMissing).toEqual([{ projectId, name: 'Ssh App' }]);
  });

  it('a changed host key fails every operation with the key offered, and Keep main pushed records why', async () => {
    sharedKey();
    connectedEarlier();
    // Another ed25519 key is the one trusted for this host:port.
    const other = ed25519KeyPair('other').publicKey.split(' ')[1]!;
    trustHostKey(t.db, { host: '127.0.0.1', port: forge.port, keyType: 'ssh-ed25519', key: other });
    const before = forge.sessions().length;
    for (const action of ['refresh', 'push-main']) {
      const res = await send('POST', repo(action));
      expect(res.statusCode, action).toBe(409);
      expect(res.json(), action).toMatchObject({
        error: 'host_key_changed',
        hostKey: { host: '127.0.0.1', port: forge.port, fingerprint: forge.hostKey.fingerprint },
      });
    }
    const quiet = await t.repository.pushMainQuietly(projectId, tip());
    expect(quiet).toMatchObject({ ok: false });
    expect(quiet.ok === false && quiet.reason).toMatch(/is not the one Emberline knows/);
    addRun();
    expect(await rejection(t.runs.push('r1'))).toMatchObject({ code: 'host_key_changed' });
    expect(forge.sessions().length).toBe(before);
  });
});
