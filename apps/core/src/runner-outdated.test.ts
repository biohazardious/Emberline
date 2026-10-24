/**
 * Fail closed on a runner older than this core (ptyd protocol below PTYD_MIN_PROTOCOL_VERSION): core
 * reads `hello` and what already runs, but starts no agent, terminal or command, and types into
 * nothing, until the runner image is updated. A current runner works as before.
 */
import { PTYD_MIN_PROTOCOL_VERSION, PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelCommand,
  ptydCommandCanceller,
  ptydCommandExecutor,
  setCommandCanceller,
} from './command-exec.js';
import { runs } from './db/schema.js';
import { RUNNER_SECURITY_UPDATE } from './errors.js';
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
