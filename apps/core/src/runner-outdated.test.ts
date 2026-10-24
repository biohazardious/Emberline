/**
 * Fail closed on a runner older than this core (ptyd protocol below PTYD_MIN_PROTOCOL_VERSION): core
 * reads `hello` and what already runs, but starts no agent, terminal or command, and types into
 * nothing, until the runner image is updated. A current runner works as before.
 */
import { PTYD_MIN_PROTOCOL_VERSION, PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PtydClient } from '@emberline/ptyd/client';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelCommand,
  ptydCommandCanceller,
  ptydCommandExecutor,
  setCommandCanceller,
} from './command-exec.js';
import { runs } from './db/schema.js';
import {
  RUNNER_MUST_START_AS_ROOT,
  RUNNER_NOT_SECURED,
  RUNNER_SECURITY_UPDATE,
  RUNNER_STARTING,
} from './errors.js';
import { PtydBridge, runnerStartProblem, SECURE_GRACE_MS } from './ptyd-bridge.js';
import { rmTemp } from './test-rm.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let server: PtydServer;
let cookie: string;
let version: number;

beforeEach(async () => {
  t = await createTestApp();
  server = new PtydServer({ socketPath: t.config.ptydSocket });
  await server.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  version = PTYD_PROTOCOL_VERSION;
  Object.defineProperty(t.ptyd, 'protocolVersion', { get: () => version });
  cookie = await setupAndLogin(t.app);
});
afterEach(async () => {
  setCommandCanceller(async () => false);
  await server.close();
  await t.close();
});

const outdated = { statusCode: 503, code: 'runner_outdated', message: RUNNER_SECURITY_UPDATE };

describe('a runner older than core', () => {
  it('needs protocol 4: runners before it start ptyd through a PATH agents can write', () => {
    expect(PTYD_MIN_PROTOCOL_VERSION).toBe(4);
  });

  it('protocol 3: no command, terminal or agent starts, nothing is typed; reading and stopping what runs still work', async () => {
    // A session that was running before core met the old runner.
    const running = await t.ptyd.get().spawn({ file: 'sleep', args: ['60'], cwd: t.dir });
    version = 3;
    expect(t.ptyd.outdated).toBe(true);

    const exec = ptydCommandExecutor(t.ptyd);
    await expect(exec({ file: '/usr/bin/true', args: [], cwd: '/' })).rejects.toMatchObject(outdated);
    await expect(t.ptyd.get().exec({ file: '/usr/bin/true', cwd: '/' })).rejects.toMatchObject(outdated);
    await expect(t.ptyd.get().spawn({ file: 'true', cwd: t.dir })).rejects.toMatchObject(outdated);
    await expect(t.ptyd.get().write(running.id, 'echo typed\r')).rejects.toMatchObject(outdated);
    const viewer = await t.ptyd.openViewer();
    await expect(viewer.write(running.id, 'x')).rejects.toMatchObject(outdated);
    viewer.close();
    expect(() => t.ptyd.assertCanStart()).toThrow(RUNNER_SECURITY_UPDATE);

    // The API says why, with a stable code: a terminal, and a run (refused before any worktree exists).
    const terminal = await t.app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { kind: 'shell' },
      headers: authHeaders(cookie),
    });
    expect(terminal.statusCode).toBe(503);
    expect(terminal.json()).toMatchObject({ error: 'runner_outdated', message: RUNNER_SECURITY_UPDATE });
    const created = (
      await t.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Old', initGit: false },
        headers: authHeaders(cookie),
      })
    ).json() as { project: { id: string } };
    await expect(t.runs.enqueue({ projectId: created.project.id, prompt: 'x' })).rejects.toMatchObject(
      outdated,
    );
    expect(t.db.select().from(runs).all()).toEqual([]);

    const system = (await t.app.inject({ url: '/api/system', headers: authHeaders(cookie) })).json();
    expect(system.runnerOutdated).toBe(true);
    const deep = (await t.app.inject({ url: '/api/health/deep' })).json();
    expect(deep.checks.runnerProtocol.ok).toBe(false);
    expect(deep.checks.runnerProtocol.detail).toContain('Security update required: update the runner image');

    // Reading and stopping are allowed.
    expect((await t.ptyd.get().list()).sessions.map((s) => s.id)).toContain(running.id);
    expect((await t.ptyd.get().snapshot(running.id)).data).toBeTypeOf('string');
    setCommandCanceller(ptydCommandCanceller(t.ptyd));
    expect(await cancelCommand('nothing')).toBe(false);
    await t.ptyd.get().remove(running.id);
    expect((await t.ptyd.get().list()).sessions).toHaveLength(0);
  });

  it('protocol 4: commands, terminals and typing work', async () => {
    version = 4;
    expect(t.ptyd.outdated).toBe(false);
    expect(() => t.ptyd.assertCanStart()).not.toThrow();
    const result = await ptydCommandExecutor(t.ptyd)({ file: '/bin/echo', args: ['ok'], cwd: '/' });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok\n' });
    const terminal = await t.app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { kind: 'shell' },
      headers: authHeaders(cookie),
    });
    expect(terminal.statusCode).toBe(201);
    const id = (terminal.json() as { id: string }).id;
    await expect(t.ptyd.get().write(id, 'exit\r')).resolves.toBeDefined();
    await t.ptyd.get().remove(id);
    const system = (await t.app.inject({ url: '/api/system', headers: authHeaders(cookie) })).json();
    expect(system.runnerOutdated).toBe(false);
  });
});

/** An old runner's ptyd: answers `hello` with `version` and anything else with ok, and records every request. */
async function fakePtyd(socketPath: string, version: number) {
  const seen: { method: string; params: unknown }[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0);
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as {
          id: number;
          method: string;
          params: unknown;
        };
        buffer = buffer.subarray(4 + length);
        seen.push({ method: request.method, params: request.params });
        const result = request.method === 'hello' ? { protocolVersion: version } : {};
        const body = Buffer.from(JSON.stringify({ type: 'response', id: request.id, ok: true, result }));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        socket.write(Buffer.concat([header, body]));
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('a terminal viewer (M-A)', () => {
  it('is refused while the bridge is not connected, and never types into a runner that says it is old', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'old-ptyd-'));
    const socketPath = path.join(dir, 'ptyd.sock');
    const old = await fakePtyd(socketPath, 3);
    const bridge = new PtydBridge(socketPath);
    try {
      // Not connected yet (as while it reconnects): no viewer at all, though the old ptyd is reachable.
      await expect(bridge.openViewer()).rejects.toMatchObject({ statusCode: 503, code: 'ptyd_unavailable' });
      bridge.start();
      await bridge.waitUntilConnected();
      expect(bridge.outdated).toBe(true);
      const viewer = await bridge.openViewer();
      await expect(viewer.write('s1', 'secret typed\r')).rejects.toMatchObject(outdated);
      await expect(viewer.hello()).resolves.toEqual({ protocolVersion: 3 });
      viewer.close();
      expect(old.seen.map((r) => r.method)).not.toContain('write');
    } finally {
      bridge.stop();
      await old.close();
      rmTemp(dir);
    }
  });
});

describe('a current runner whose socket is not locked', () => {
  let u: TestApp;
  let ptydServer: PtydServer;
  let ucookie: string;
  beforeEach(async () => {
    // The test's own directory, like a runner started with a compose `user:` (node's, not root's).
    u = await createTestApp({ requireSecuredRunner: true });
    // It says so itself (`hello` lock `impossible`), so it is not secured at once, not "starting".
    ptydServer = new PtydServer({ socketPath: u.config.ptydSocket, cannotLock: true });
    await ptydServer.listen();
    u.ptyd.start();
    await u.ptyd.waitUntilConnected();
    ucookie = await setupAndLogin(u.app);
  });
  afterEach(async () => {
    await ptydServer.close();
    await u.close();
  });

  const notSecured = { statusCode: 503, code: 'runner_not_secured', message: RUNNER_NOT_SECURED };

  it('gets nothing started or typed until it is locked, says so, and works once it is', async () => {
    // A session that was running before (started on its own connection, as before the check).
    const own = await PtydClient.connect(u.config.ptydSocket);
    const running = (await own.spawn({ file: 'sleep', args: ['60'], cwd: u.dir })).id;
    own.close();
    expect(u.ptyd.protocolVersion).toBe(PTYD_PROTOCOL_VERSION);
    expect(u.ptyd.socketGuarded).toBe(false);
    expect(u.ptyd.unsecured).toBe(true);
    await expect(
      ptydCommandExecutor(u.ptyd)({ file: '/bin/echo', args: ['x'], cwd: '/' }),
    ).rejects.toMatchObject(notSecured);
    await expect(u.ptyd.get().spawn({ file: 'true', cwd: u.dir })).rejects.toMatchObject(notSecured);
    await expect(u.ptyd.get().write(running, 'x')).rejects.toMatchObject(notSecured);
    const viewer = await u.ptyd.openViewer();
    await expect(viewer.write(running, 'x')).rejects.toMatchObject(notSecured);
    viewer.close();
    expect(() => u.ptyd.assertCanStart()).toThrow(RUNNER_NOT_SECURED);
    const terminal = await u.app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { kind: 'shell' },
      headers: authHeaders(ucookie),
    });
    expect(terminal.statusCode).toBe(503);
    expect(terminal.json()).toMatchObject({ error: 'runner_not_secured', message: RUNNER_NOT_SECURED });
    const system = (await u.app.inject({ url: '/api/system', headers: authHeaders(ucookie) })).json();
    expect(system).toMatchObject({ runnerNotSecured: true, runnerOutdated: false });
    const deep = (await u.app.inject({ url: '/api/health/deep' })).json();
    expect(deep.checks.runnerSocket).toMatchObject({ ok: false, detail: RUNNER_NOT_SECURED });
    // Watching and stopping still work.
    expect((await u.ptyd.get().list()).sessions.map((s) => s.id)).toContain(running);
    await u.ptyd.get().remove(running);

    // The runner's entrypoint locks the directory: everything works.
    Object.defineProperty(u.ptyd, 'socketGuarded', { get: () => true });
    expect(u.ptyd.unsecured).toBe(false);
    expect(await ptydCommandExecutor(u.ptyd)({ file: '/bin/echo', args: ['ok'], cwd: '/' })).toMatchObject({
      exitCode: 0,
    });
    const after = (await u.app.inject({ url: '/api/system', headers: authHeaders(ucookie) })).json();
    expect(after.runnerNotSecured).toBe(false);
  });
});

describe('a runner started as another user on a socket folder an earlier start locked', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'not-root-'));
    mkdirSync(path.join(dir, 'browser'));
  });
  afterEach(() => rmTemp(dir));
  const socket = () => path.join(dir, 'ptyd.sock');
  const locked = () => true;

  it('is named from the file its entrypoint writes, only while core cannot reach it and the folder is locked', () => {
    expect(runnerStartProblem(socket(), false, locked)).toBeNull();
    writeFileSync(path.join(dir, 'browser', 'runner-not-root'), 'not-root 1000\n');
    expect(runnerStartProblem(socket(), false, locked)).toBe('must_start_as_root');
    // Connected: whatever the file says, the runner works (an agent could have written it).
    expect(runnerStartProblem(socket(), true, locked)).toBeNull();
    // A folder that is not locked is not the case the file explains.
    expect(runnerStartProblem(socket(), false, () => false)).toBeNull();
    // The real check: the test's own folder is not root's.
    expect(runnerStartProblem(socket(), false)).toBeNull();
  });

  it('is shown in /api/health, /api/system and the deep health check', async () => {
    Object.defineProperty(t.ptyd, 'startProblem', { get: () => 'must_start_as_root' });
    const health = (await t.app.inject({ url: '/api/health' })).json();
    expect(health).toMatchObject({ status: 'ok', runnerProblem: 'must_start_as_root' });
    const system = (await t.app.inject({ url: '/api/system', headers: authHeaders(cookie) })).json();
    expect(system.runnerProblem).toBe('must_start_as_root');
    const deep = (await t.app.inject({ url: '/api/health/deep' })).json();
    expect(deep.checks.runner.detail).toBe(RUNNER_MUST_START_AS_ROOT);
  });
});

describe('a runner that has just started and not locked its socket yet', () => {
  let u: TestApp;
  let ptydServer: PtydServer;
  let ucookie: string;
  async function startWith(options: { cannotLock?: boolean; requireLock?: boolean }) {
    u = await createTestApp({ requireSecuredRunner: true });
    ptydServer = new PtydServer({ socketPath: u.config.ptydSocket, ...options });
    await ptydServer.listen();
    u.ptyd.start();
    await u.ptyd.waitUntilConnected();
    ucookie = await setupAndLogin(u.app);
  }
  afterEach(async () => {
    vi.useRealTimers();
    await ptydServer.close();
    await u.close();
  });
  const system = async () =>
    (await u.app.inject({ url: '/api/system', headers: authHeaders(ucookie) })).json();

  it('is "starting" (nothing starts) for the grace period, then "not secured"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await startWith({ requireLock: true });
    expect(u.ptyd.lockState).toBe('starting');
    expect(await system()).toMatchObject({ runnerStarting: true, runnerNotSecured: false });
    await expect(
      ptydCommandExecutor(u.ptyd)({ file: '/bin/echo', args: ['x'], cwd: '/' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'runner_starting', message: RUNNER_STARTING });
    await expect(u.ptyd.get().spawn({ file: 'true', cwd: u.dir })).rejects.toMatchObject({
      code: 'runner_starting',
    });

    vi.setSystemTime(Date.now() + SECURE_GRACE_MS - 100);
    expect(u.ptyd.lockState).toBe('starting');
    vi.setSystemTime(Date.now() + 200);
    expect(u.ptyd.lockState).toBe('not_secured');
    expect(await system()).toMatchObject({ runnerStarting: false, runnerNotSecured: true });
    await expect(u.ptyd.get().spawn({ file: 'true', cwd: u.dir })).rejects.toMatchObject({
      code: 'runner_not_secured',
    });
  });

  it('is "not secured" at once when the runner says it cannot lock it (it runs as another user)', async () => {
    await startWith({ cannotLock: true });
    expect(u.ptyd.lockState).toBe('not_secured');
    expect(await system()).toMatchObject({ runnerStarting: false, runnerNotSecured: true });
  });

  it('is "secured" once the folder is locked, with nothing shown', async () => {
    await startWith({ requireLock: true });
    Object.defineProperty(u.ptyd, 'socketGuarded', { get: () => true });
    expect(u.ptyd.lockState).toBe('secured');
    expect(await system()).toMatchObject({
      runnerStarting: false,
      runnerNotSecured: false,
      runnerProblem: null,
    });
  });
});
