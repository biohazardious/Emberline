import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtydClient, PtydClientError } from './client.js';
import { PtydServer, type PtydServerOptions, readPtraceScope } from './server.js';

let dir: string;
let socketPath: string;
let server: PtydServer;
const clients: PtydClient[] = [];

async function connect(): Promise<PtydClient> {
  const client = await PtydClient.connect(socketPath);
  clients.push(client);
  return client;
}

/** Collects output for one session and lets tests wait for a substring. */
function collect(client: PtydClient, sessionId: () => string) {
  let text = '';
  client.on('output', (id, data) => {
    if (id === sessionId()) text += data;
  });
  return {
    get text() {
      return text;
    },
    waitFor(needle: string, timeoutMs = 5_000): Promise<void> {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (text.includes(needle)) return resolve();
          if (Date.now() - started > timeoutMs) {
            return reject(
              new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(text)}`),
            );
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    },
  };
}

const spawnShell = (client: PtydClient) =>
  client.spawn({ file: '/bin/sh', args: [], cwd: dir, env: { PS1: '$ ' }, cols: 80, rows: 24 });

// `$((40+2))` makes the expected text differ from the echoed input.
const MARK_CMD = 'echo ember-$((40+2))\r';
const MARK = 'ember-42';

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ptyd-'));
  socketPath = path.join(dir, 'ptyd.sock');
  server = new PtydServer({ socketPath, logDir: path.join(dir, 'logs') });
  await server.listen();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server.close();
  // A session that is still exiting may add a file during removal (ENOTEMPTY): retry.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ownUid = process.getuid?.() ?? 0;

/** A passwd file with these users, so a test decides which uid `dropTo` names whoever runs it. */
function passwd(users: Record<string, number>): string {
  const file = path.join(dir, `passwd-${Object.keys(users).join('-')}`);
  const lines = Object.entries(users).map(([name, uid]) => `${name}:x:${uid}:${uid}::/home/${name}:/bin/sh`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Starts another ptyd on its own socket, hands a client to `use`, and closes both. */
async function withPtyd(
  options: Omit<PtydServerOptions, 'socketPath'> & { socketDir?: string },
  use: (client: PtydClient, other: PtydServer) => Promise<void>,
): Promise<void> {
  const { socketDir = dir, ...rest } = options;
  const other = new PtydServer({ socketPath: path.join(socketDir, `other-${randomUUID()}.sock`), ...rest });
  await other.listen();
  const client = await PtydClient.connect(other.socketPath);
  try {
    await use(client, other);
  } finally {
    client.close();
    await other.close();
  }
}

/** ptyd's own entrypoint, run with this process's node and the given environment. */
function startMain(env: Record<string, string>) {
  return spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@emberline/source', path.join(import.meta.dirname, 'main.ts')],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

async function waitForSocket(socket: string, timeoutMs = 20_000): Promise<PtydClient> {
  const started = Date.now();
  for (;;) {
    try {
      return await PtydClient.connect(socket);
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('modes and isolation', () => {
  it('hello reports mode and secured', async () => {
    await withPtyd({ mode: 'ops' }, async (client) => {
      expect(await client.hello()).toMatchObject({
        protocolVersion: PTYD_PROTOCOL_VERSION,
        mode: 'ops',
        secured: true,
      });
    });
    // The dev stack: a runner ptyd with no user to start sessions as.
    await withPtyd({ mode: 'runner' }, async (client) => {
      expect(await client.hello()).toMatchObject({ mode: 'runner', secured: false });
    });
    // Runner is the default mode.
    expect(await (await connect()).hello()).toMatchObject({ mode: 'runner', secured: false });
    expect(PTYD_PROTOCOL_VERSION).toBe(5);
  });

  it('a runner ptyd is secured only when it drops to another user, from a directory only it can write', async () => {
    const passwdFile = passwd({ node: ownUid + 1, self: ownUid });
    const secured = async (options: Omit<PtydServerOptions, 'socketPath'> & { socketDir?: string }) => {
      let result: boolean | undefined;
      await withPtyd({ mode: 'runner', passwdFile, ...options }, async (client) => {
        result = (await client.hello()).secured;
      });
      return result;
    };
    expect(await secured({ dropTo: 'node' })).toBe(true);
    // Sessions would run as ptyd's own user: agents could take it over.
    expect(await secured({ dropTo: 'self' })).toBe(false);
    expect(await secured({ dropTo: 'nobody-here' })).toBe(false);
    // Another user could put its own listener in the socket's place.
    const shared = path.join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o770);
    expect(await secured({ dropTo: 'node', socketDir: shared })).toBe(false);
    chmodSync(shared, 0o705);
    expect(await secured({ dropTo: 'node', socketDir: shared })).toBe(true);
    // The drop itself must work.
    const probed: string[] = [];
    const probeDrop = (user: string) => {
      probed.push(user);
      return false;
    };
    expect(await secured({ dropTo: 'node', probeDrop })).toBe(false);
    expect(probed).toContain('node');
  });

  it('runAs is refused in ops mode and for users not in SERVICE_USERS', async () => {
    const asBrowser = { cwd: dir, runAs: 'browser' as const };
    await withPtyd({ mode: 'ops', serviceUsers: ['browser'] }, async (client) => {
      await expect(client.spawn({ file: '/bin/sh', ...asBrowser })).rejects.toMatchObject({
        code: 'bad_request',
      });
      await expect(client.exec({ file: 'true', ...asBrowser })).rejects.toMatchObject({
        code: 'bad_request',
      });
    });
    await withPtyd({ mode: 'runner', serviceUsers: [] }, async (client) => {
      await expect(client.spawn({ file: '/bin/sh', ...asBrowser })).rejects.toMatchObject({
        code: 'bad_request',
      });
      await expect(client.exec({ file: 'true', ...asBrowser })).rejects.toMatchObject({
        code: 'bad_request',
      });
    });
    await withPtyd({ mode: 'runner', serviceUsers: ['browser'] }, async (client) => {
      // Only service users exist as `runAs` at all.
      await expect(
        client.exec({ file: 'true', cwd: dir, runAs: 'root' as unknown as 'browser' }),
      ).rejects.toMatchObject({ code: 'bad_request' });
      // A listed service user is accepted (it runs to a result, whatever the drop makes of it).
      await expect(client.exec({ file: 'true', ...asBrowser })).resolves.toMatchObject({ timedOut: false });
    });
  });

  it('a runner ptyd that is not isolated refuses spawn and exec when requireIsolation is set', async () => {
    await withPtyd({ mode: 'runner', requireIsolation: true }, async (client) => {
      await expect(client.spawn({ file: '/bin/sh', cwd: dir })).rejects.toMatchObject({
        code: 'not_isolated',
      });
      await expect(client.exec({ file: 'true', cwd: dir })).rejects.toMatchObject({ code: 'not_isolated' });
      // Everything else still answers: core reads what runs and says why nothing starts.
      expect(await client.hello()).toMatchObject({ mode: 'runner', secured: false });
      expect((await client.list()).sessions).toEqual([]);
    });
    // Isolated, it starts what it is asked to.
    const passwdFile = passwd({ node: ownUid + 1 });
    await withPtyd({ mode: 'runner', requireIsolation: true, dropTo: 'node', passwdFile }, async (client) => {
      expect(await client.exec({ file: 'true', cwd: dir })).toMatchObject({ exitCode: 0 });
    });
    // Without requireIsolation (the dev stack) an unisolated runner still starts things.
    await withPtyd({ mode: 'runner' }, async (client) => {
      expect(await client.exec({ file: 'true', cwd: dir })).toMatchObject({ exitCode: 0 });
    });
  });

  it('reads its mode, service users and isolation requirement from the environment', async () => {
    const socket = path.join(dir, 'main.sock');
    const child = startMain({
      EMBERLINE_PTYD_SOCKET: socket,
      EMBERLINE_PTYD_MODE: 'runner',
      EMBERLINE_PTYD_SERVICE_USERS: 'browser',
      EMBERLINE_PTYD_REQUIRE_ISOLATION: '1',
    });
    try {
      const client = await waitForSocket(socket);
      expect(await client.hello()).toMatchObject({ mode: 'runner', secured: false });
      await expect(client.spawn({ file: '/bin/sh', cwd: dir })).rejects.toMatchObject({
        code: 'not_isolated',
      });
      client.close();
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    const ops = startMain({ EMBERLINE_PTYD_SOCKET: path.join(dir, 'ops.sock'), EMBERLINE_PTYD_MODE: 'ops' });
    try {
      const client = await waitForSocket(path.join(dir, 'ops.sock'));
      expect(await client.hello()).toMatchObject({ mode: 'ops', secured: true });
      client.close();
    } finally {
      ops.kill('SIGTERM');
      await new Promise((resolve) => ops.once('exit', resolve));
    }
    // An unknown mode is refused rather than guessed.
    const bogus = startMain({
      EMBERLINE_PTYD_SOCKET: path.join(dir, 'bogus.sock'),
      EMBERLINE_PTYD_MODE: 'agent',
    });
    expect(await new Promise((resolve) => bogus.once('exit', resolve))).toBe(1);
    expect(existsSync(path.join(dir, 'bogus.sock'))).toBe(false);
  }, 60_000);
});

describe("the host's Yama ptrace setting", () => {
  it('hello reports it as the kernel has it, and null without Yama', async () => {
    const yama = path.join(dir, 'ptrace_scope');
    for (const [content, scope] of [
      ['0\n', 0],
      ['1\n', 1],
      ['3\n', 3],
    ] as const) {
      writeFileSync(yama, content);
      const other = new PtydServer({
        socketPath: path.join(dir, `yama-${scope}.sock`),
        ptraceScopeFile: yama,
      });
      await other.listen();
      const client = await PtydClient.connect(path.join(dir, `yama-${scope}.sock`));
      expect(await client.hello()).toEqual({
        protocolVersion: PTYD_PROTOCOL_VERSION,
        ptraceScope: scope,
        mode: 'runner',
        secured: false,
      });
      client.close();
      await other.close();
    }
    expect(readPtraceScope(path.join(dir, 'no-yama'))).toBeNull();
    writeFileSync(yama, 'garbage');
    expect(readPtraceScope(yama)).toBeNull();
  });
});

describe('ptyd', () => {
  it('streams output of one session to multiple attached clients', async () => {
    const a = await connect();
    const b = await connect();
    const session = await spawnShell(a);
    const outA = collect(a, () => session.id);
    const outB = collect(b, () => session.id);

    await a.attach(session.id);
    await b.attach(session.id);
    await a.write(session.id, MARK_CMD);

    await outA.waitFor(MARK);
    await outB.waitFor(MARK);
  });

  it('keeps no on-disk log for a session marked noLog, but still streams it', async () => {
    const a = await connect();
    const normal = await spawnShell(a);
    const quiet = await a.spawn({
      file: '/bin/sh',
      args: [],
      cwd: dir,
      env: { PS1: '$ ' },
      cols: 80,
      rows: 24,
      meta: { noLog: '1' },
    });
    const out = collect(a, () => quiet.id);
    await a.attach(quiet.id);
    await a.write(quiet.id, MARK_CMD);
    await out.waitFor(MARK); // the live stream still works
    await a.write(normal.id, MARK_CMD);
    await expect
      .poll(() => readdirSync(path.join(dir, 'logs')), { timeout: 5_000 })
      .toContain(`${normal.id}.log`);
    // The marked session is never written to the log directory.
    expect(existsSync(path.join(dir, 'logs', `${quiet.id}.log`))).toBe(false);
  });

  it('restores the screen from a snapshot after a client reconnects', async () => {
    const a = await connect();
    const session = await spawnShell(a);
    const out = collect(a, () => session.id);
    await a.attach(session.id);
    await a.write(session.id, MARK_CMD);
    await out.waitFor(MARK);
    a.close();

    const b = await connect();
    const { session: info, snapshot } = await b.attach(session.id);
    expect(info.status).toBe('running');
    expect(snapshot.data).toContain(MARK);
    expect(snapshot.cols).toBe(80);
  });

  it('keeps sessions alive while no client is connected', async () => {
    const a = await connect();
    const session = await spawnShell(a);
    await a.write(session.id, MARK_CMD);
    a.close();

    const b = await connect();
    const { sessions } = await b.list();
    expect(sessions.map((s) => s.id)).toContain(session.id);
    await expect.poll(async () => (await b.snapshot(session.id)).data, { timeout: 5_000 }).toContain(MARK);
  });

  it('emits an exit event when a session is killed', async () => {
    const a = await connect();
    const session = await spawnShell(a);
    await a.attach(session.id);
    const exited = new Promise<string>((resolve) => a.on('exit', (id) => resolve(id)));
    await a.kill(session.id, 'SIGKILL');
    expect(await exited).toBe(session.id);

    const { sessions } = await a.list();
    expect(sessions.find((s) => s.id === session.id)?.status).toBe('exited');
    await a.remove(session.id);
    expect((await a.list()).sessions).toHaveLength(0);
  });

  it('settles a pending snapshot when the session is disposed (B21 guard)', async () => {
    const { PtySession } = await import('./session.js');
    const session = new PtySession(
      'b21',
      { file: 'sh', args: [], cwd: dir, env: {}, inheritEnv: true, cols: 80, rows: 24, meta: {} },
      {},
    );
    // The flush callback is asynchronous; disposing in the same tick used to drop it for good.
    const pending = session.snapshot().then(
      () => 'answered',
      () => 'rejected',
    );
    session.dispose();
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    expect(outcome).not.toBe('hung');
  });

  it('times out a request ptyd never answers', async () => {
    const a = await connect();
    const blackhole = net.createServer(() => {});
    const path2 = `${socketPath}.silent`;
    await new Promise<void>((resolve) => blackhole.listen(path2, resolve));
    try {
      const silent = await PtydClient.connect(path2);
      await expect(silent.request('list', {}, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'timeout' });
      silent.close();
    } finally {
      blackhole.close();
    }
    expect((await a.list()).sessions).toBeDefined();
  });

  it('streams output once when a client attaches twice at the same time (B22)', async () => {
    const a = await connect();
    const session = await spawnShell(a);
    let marks = 0;
    a.on('output', (id, data) => {
      if (id === session.id) marks += data.split(MARK).length - 1;
    });
    await Promise.all([a.attach(session.id), a.attach(session.id)]);
    await a.write(session.id, MARK_CMD);
    await expect.poll(() => marks, { timeout: 5_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // MARK only appears in the command's output (the echoed command line has $((40+2))): once per listener.
    expect(marks).toBe(1);
  });

  it('resizes the session', async () => {
    const a = await connect();
    const session = await spawnShell(a);
    await a.resize(session.id, 100, 30);
    const snapshot = await a.snapshot(session.id);
    expect([snapshot.cols, snapshot.rows]).toEqual([100, 30]);
  });

  it('returns typed errors for bad requests', async () => {
    const a = await connect();
    await expect(a.write('missing', 'x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.spawn({ file: '/bin/sh', cwd: path.join(dir, 'nope') })).rejects.toBeInstanceOf(
      PtydClientError,
    );
    const session = await spawnShell(a);
    await expect(spawnShellWithId(a, session.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('runs commands to completion without a terminal (exec)', async () => {
    const client = await connect();
    const ok = await client.exec({
      file: 'sh',
      args: ['-c', 'printf "%s|%s" "$PWD" "$EXTRA"; echo oops >&2; exit 4'],
      cwd: dir,
      env: { EXTRA: 'set' },
    });
    expect(ok).toMatchObject({
      exitCode: 4,
      stdout: `${dir}|set`,
      stderr: 'oops\n',
      timedOut: false,
      truncated: false,
    });

    const binary = await client.exec({
      file: 'printf',
      args: ['\\377\\000\\001'],
      cwd: dir,
      encoding: 'base64',
    });
    expect([...Buffer.from(binary.stdout, 'base64')]).toEqual([255, 0, 1]);

    const capped = await client.exec({
      file: 'sh',
      args: ['-c', 'yes | head -c 5000'],
      cwd: dir,
      maxOutputBytes: 100,
    });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.stdout).toHaveLength(100);

    const pidFile = path.join(dir, 'bg.pid');
    const slow = await client.exec({
      file: 'sh',
      args: ['-c', `sleep 30 & echo $! > "${pidFile}"; sleep 30`],
      cwd: dir,
      timeoutMs: 300,
    });
    expect(slow.timedOut).toBe(true);
    // The timeout kills the whole process group, not just the shell: the background child is gone too.
    let bgPid = 0;
    for (let i = 0; i < 40 && !bgPid; i++) {
      try {
        bgPid = Number(readFileSync(pidFile, 'utf8').trim());
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(bgPid).toBeGreaterThan(1);
    const gone = async () => {
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(bgPid, 0);
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    expect(await gone()).toBe(true);

    const missing = await client.exec({ file: 'definitely-not-a-binary', cwd: dir });
    expect(missing.exitCode).toBe(127);
    await expect(client.exec({ file: 'true', cwd: path.join(dir, 'nope') })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await client.hello()).toEqual({
      protocolVersion: PTYD_PROTOCOL_VERSION,
      ptraceScope: readPtraceScope(),
      mode: 'runner',
      secured: false,
    });
    // exec never creates a session.
    expect((await client.list()).sessions).toHaveLength(0);
  });

  it('cancels a running exec by its id, with the whole process group (execCancel)', async () => {
    const client = await connect();
    const pidFile = path.join(dir, 'cancel.pid');
    // Never ends on its own: a result at all is the cancel's.
    const running = client.exec({
      file: 'sh',
      args: ['-c', `sleep 3600 & echo $! > "${pidFile}"; wait`],
      cwd: dir,
      timeoutMs: 60_000,
      execId: 'setup-1',
    });
    let bgPid = 0;
    for (let i = 0; i < 40 && !bgPid; i++) {
      try {
        bgPid = Number(readFileSync(pidFile, 'utf8').trim());
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(bgPid).toBeGreaterThan(1);
    expect(await client.execCancel('setup-1')).toEqual({ cancelled: true });
    const result = await running;
    expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: null });
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      try {
        process.kill(bgPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch (error) {
        gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    expect(gone).toBe(true);
    // Unknown or finished ids: nothing to cancel.
    expect(await client.execCancel('setup-1')).toEqual({ cancelled: false });
    // An id in use is refused rather than shadowed.
    const first = client.exec({ file: 'sleep', args: ['5'], cwd: dir, execId: 'dup' });
    await new Promise((r) => setTimeout(r, 100));
    await expect(client.exec({ file: 'true', cwd: dir, execId: 'dup' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await client.execCancel('dup');
    await first;
  });

  it('gives a process with inheritEnv false only the variables sent, none of its own (exec and spawn)', async () => {
    const client = await connect();
    const planted = { PATH: `${dir}/planted:/usr/bin:/bin`, HOME: dir, LANG: 'xx_XX', TMPDIR: dir };
    const saved = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    try {
      const inherited = await client.exec({ file: '/usr/bin/env', cwd: dir, env: { ONLY: '1' } });
      expect(inherited.stdout).toContain(`HOME=${dir}`);
      const clean = await client.exec({
        file: '/usr/bin/env',
        cwd: dir,
        env: { ONLY: '1' },
        inheritEnv: false,
      });
      expect(clean.stdout.trim().split('\n').sort()).toEqual(['ONLY=1']);

      const session = await client.spawn({
        file: '/usr/bin/env',
        cwd: dir,
        env: { ONLY: '1' },
        inheritEnv: false,
        cols: 80,
        rows: 24,
      });
      await expect.poll(async () => (await client.list()).sessions[0]?.status).toBe('exited');
      const screen = (await client.snapshot(session.id)).data;
      // node-pty itself sets PWD (the cwd); nothing else comes from ptyd.
      expect([...screen.matchAll(/([A-Z_]+)=/g)].map((m) => m[1]).sort()).toEqual([
        'COLORTERM',
        'ONLY',
        'PWD',
        'TERM',
      ]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('refuses to start a second server on a live socket', async () => {
    const second = new PtydServer({ socketPath });
    await expect(second.listen()).rejects.toThrow(/already listening/);
  });

  it('replaces a stale socket path', async () => {
    const stalePath = path.join(dir, 'stale.sock');
    writeFileSync(stalePath, '');
    const other = new PtydServer({ socketPath: stalePath });
    await other.listen();
    await other.close();
  });
});

function spawnShellWithId(client: PtydClient, id: string) {
  return client.spawn({ id, file: '/bin/sh', cwd: dir });
}
