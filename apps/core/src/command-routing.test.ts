/**
 * Where core's commands run (0.7.0): its own commands (git, the merge's file steps, the Docker CLI,
 * curl to the network) in the `ops` container, the ones that must run beside the agents (localhost
 * previews, agent CLIs, the runner home, workspace code) in the runner. Without the ops service a
 * production core starts nothing anywhere; a ptyd that answers in the other mode counts as missing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentModelId } from '@emberline/protocol';
import { PtydClient } from '@emberline/ptyd/client';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandTarget,
  dockerCommand,
  type ExecRequest,
  type ExecResult,
  localCommandExecutor,
  ptydCommandExecutor,
  RUNNER_BIN,
  runnerSystemCommand,
  SYSTEM_PATH,
  setCommandExecutor,
  systemCommand,
} from './command-exec.js';
import { ComposeConfigReader } from './docker/compose-config.js';
import { dockerQuery, runComposePreview } from './docker/compose-preview.js';
import { DockerEngine } from './docker/engine.js';
import { OPS_MISSING } from './errors.js';
import { captureBrowserViewportSnapshot } from './factory/demo.js';
import { collectReviewDiff, runRivalReview } from './factory/rival-critic.js';
import { syncWorktreeToMainWorkspace } from './factory/service.js';
import { assertSafeGitConfig, execGitFile } from './git-exec.js';
import { NOT_ANSWERING_AFTER_MS, PtydBridge } from './ptyd-bridge.js';
import { terminalBridge } from './routes/terminals.js';
import { probePreviewFraming } from './runs/preview-framing.js';
import { runSuggestion } from './runs/suggest.js';
import { rmTemp } from './test-rm.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { UpdateService } from './updates/service.js';
import { runWorktreeCommand } from './worktree-config/lifecycle.js';
import { openDb } from './db/index.js';
import { getFactorySettings, updateFactorySettings } from './factory/settings.js';

const OK: ExecResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
};

/** A bridge that only records which side was asked to run a command. */
function fakeBridge(side: CommandTarget, calls: string[]): PtydBridge {
  return {
    assertCanStart() {},
    get: () => ({
      exec: async () => {
        calls.push(side);
        return OK;
      },
    }),
  } as unknown as PtydBridge;
}

describe('command routing', () => {
  it('system commands go to ops', async () => {
    const calls: string[] = [];
    const exec = ptydCommandExecutor({ runner: fakeBridge('runner', calls), ops: fakeBridge('ops', calls) });
    await exec(systemCommand({ file: RUNNER_BIN.git, args: ['--version'], cwd: '/' }));
    await exec(dockerCommand({ file: RUNNER_BIN.docker, args: ['version'], cwd: '/' }));
    expect(calls).toEqual(['ops', 'ops']);
  });

  it('runnerSystemCommand and workspace commands go to the runner', async () => {
    const calls: string[] = [];
    const exec = ptydCommandExecutor({ runner: fakeBridge('runner', calls), ops: fakeBridge('ops', calls) });
    const beside = runnerSystemCommand({ file: RUNNER_BIN.curl, args: ['-q'], cwd: '/', env: { A: '1' } });
    // The same hardening as a system command: absolute path, system PATH, nothing of the runner's env.
    expect(beside).toMatchObject({ target: 'runner', env: { A: '1', PATH: SYSTEM_PATH }, inheritEnv: false });
    expect(() => runnerSystemCommand({ file: 'curl', args: [], cwd: '/' })).toThrow(/absolute path/);
    await exec(beside);
    await exec({ target: 'runner', file: 'sh', args: ['-c', 'npm test'], cwd: '/' });
    expect(calls).toEqual(['runner', 'runner']);
  });

  it("without an ops service (the dev stack) core's own commands run in the runner", async () => {
    const calls: string[] = [];
    const exec = ptydCommandExecutor({ runner: fakeBridge('runner', calls), ops: null });
    await exec(systemCommand({ file: RUNNER_BIN.git, args: [], cwd: '/' }));
    expect(calls).toEqual(['runner']);
  });
});

describe('the ops bridge', () => {
  let dir: string;
  const servers: PtydServer[] = [];
  const bridges: PtydBridge[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'routing-'));
  });
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.stop();
    for (const server of servers.splice(0)) await server.close();
    rmTemp(dir);
  });
  const listen = async (socketPath: string, mode: 'runner' | 'ops') => {
    const server = new PtydServer({ socketPath, mode });
    servers.push(server);
    await server.listen();
    return server;
  };
  const bridge = (...args: ConstructorParameters<typeof PtydBridge>) => {
    const b = new PtydBridge(...args);
    bridges.push(b);
    b.start();
    return b;
  };

  it('without an ops bridge in production every command is refused with ops_missing and nothing reaches the runner', async () => {
    const runnerSock = path.join(dir, 'runner.sock');
    const opsSock = path.join(dir, 'ops.sock');
    await listen(runnerSock, 'runner');
    const ops = bridge(opsSock, { mode: 'ops', requireSecured: true });
    const runner = bridge(runnerSock, { mode: 'runner', ops });
    await runner.waitUntilConnected();
    const exec = ptydCommandExecutor({ runner, ops });
    const marker = path.join(dir, 'ran');
    const touch = { file: '/usr/bin/touch', args: [marker], cwd: '/' };
    const missing = { statusCode: 503, code: 'ops_missing', message: OPS_MISSING };
    for (const request of [
      systemCommand(touch),
      runnerSystemCommand(touch),
      { ...touch, target: 'runner' as const },
    ])
      await expect(exec(request)).rejects.toMatchObject(missing);
    await expect(
      runner.get().spawn({ file: '/usr/bin/touch', args: [marker], cwd: dir }),
    ).rejects.toMatchObject(missing);
    expect(() => runner.assertCanStart()).toThrow(OPS_MISSING);
    expect(OPS_MISSING).toContain('Update the compose file: the `ops` service is missing');
    // Reading what runs still works.
    expect((await runner.get().list()).sessions).toEqual([]);
    expect(existsSync(marker)).toBe(false);

    // The compose file gets its ops service: everything works, without a restart of core.
    await listen(opsSock, 'ops');
    await ops.waitUntilConnected(10_000);
    expect(ops.available).toBe(true);
    expect(() => runner.assertCanStart()).not.toThrow();
    expect(await exec(systemCommand(touch))).toMatchObject({ exitCode: 0 });
    expect(existsSync(marker)).toBe(true);
  }, 20_000);

  it('a bridge whose hello reports the wrong mode counts as missing', async () => {
    // The two sockets swapped: each answers as the other side.
    const runnerSock = path.join(dir, 'runner.sock');
    const opsSock = path.join(dir, 'ops.sock');
    await listen(runnerSock, 'ops');
    await listen(opsSock, 'runner');
    const ops = bridge(opsSock, { mode: 'ops' });
    const runner = bridge(runnerSock, { mode: 'runner', ops });
    await vi.waitFor(() => {
      expect(runner.foundMode).toBe('ops');
      expect(ops.foundMode).toBe('runner');
    });
    expect(runner.status).not.toBe('connected');
    expect(ops.status).not.toBe('connected');
    expect(ops.available).toBe(false);
    expect(() => runner.get()).toThrow(expect.objectContaining({ code: 'ptyd_unavailable' }));
    const exec = ptydCommandExecutor({ runner, ops });
    await expect(exec(systemCommand({ file: '/usr/bin/true', args: [], cwd: '/' }))).rejects.toMatchObject({
      code: 'ops_missing',
    });
    // Without an ops service (dev), a runner socket that answers in ops mode is still not the runner.
    const alone = bridge(runnerSock, { mode: 'runner' });
    await vi.waitFor(() => expect(alone.foundMode).toBe('ops'));
    await expect(
      ptydCommandExecutor({ runner: alone, ops: null })({
        target: 'runner',
        file: '/usr/bin/true',
        args: [],
        cwd: '/',
      }),
    ).rejects.toMatchObject({ code: 'ptyd_unavailable' });
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** Each call site with what it runs; `canned`: the answer instead of running it (undefined: run it). */
interface CallSite {
  name: string;
  /** The target every command of this call site must get (or per file, for a site with both). */
  expect: CommandTarget | ((request: ExecRequest) => CommandTarget);
  run: (dir: string) => Promise<unknown>;
  canned?: (request: ExecRequest) => ExecResult | undefined;
  /** Files that must be among the commands seen (the call site really ran). */
  files?: string[];
}

function repo(dir: string): string {
  const main = path.join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(main, 'app.js'), 'a\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  return main;
}

const composeEngine = (request: ExecRequest): ExecResult => {
  const args = request.args.join(' ');
  if (request.file === RUNNER_BIN.curl) return { ...OK, stdout: '200' };
  if (args.includes('--services')) return { ...OK, stdout: 'web\n' };
  if (args.includes(' ps ')) return { ...OK, stdout: '{"Service":"web","State":"running","Health":""}\n' };
  return OK;
};

const CALL_SITES: CallSite[] = [
  { name: 'git-exec: assertSafeGitConfig', expect: 'ops', run: (d) => assertSafeGitConfig(repo(d)) },
  {
    name: 'git-exec: execGitFile',
    expect: 'ops',
    run: (d) => execGitFile(['rev-parse', 'HEAD'], { cwd: repo(d) }),
    files: [RUNNER_BIN.git],
  },
  {
    name: "factory/merge: the merge's file steps (sh, rm, cp)",
    expect: 'ops',
    run: async (d) => {
      const main = repo(d);
      const wt = path.join(d, 'wt');
      git(main, 'worktree', 'add', '-q', '-b', 'emberline/a', wt, 'HEAD');
      writeFileSync(path.join(wt, 'b.js'), 'b\n');
      const res = await syncWorktreeToMainWorkspace({
        worktreePath: wt,
        mainWorkspacePath: main,
        ticketKey: 'T-1',
        runId: 'run-T-1',
      });
      expect(res.ok).toBe(true);
    },
    files: [RUNNER_BIN.git, RUNNER_BIN.sh, RUNNER_BIN.rm],
  },
  {
    name: 'factory/rival-critic: the diff (git in ops, untracked files read beside the agents)',
    expect: (r) => (r.file === RUNNER_BIN.head ? 'runner' : 'ops'),
    run: (d) => {
      const main = repo(d);
      writeFileSync(path.join(main, 'new.js'), 'n\n');
      return collectReviewDiff(main);
    },
    files: [RUNNER_BIN.git, RUNNER_BIN.head],
  },
  {
    name: "factory/rival-critic: the reviewer's CLI",
    expect: 'runner',
    run: (d) =>
      runRivalReview({ reviewer: 'claude', model: 'haiku' as AgentModelId, workspacePath: d, prompt: 'p' }),
    canned: () => OK,
  },
  {
    name: "factory/demo: the build gate's workspace commands",
    expect: 'runner',
    run: async (d) => {
      const { runApprovedSetup } = await import('./factory/demo.js');
      await runApprovedSetup(d, ['true'], []);
    },
  },
  {
    name: 'factory/demo: the headless browser screenshot of a preview',
    expect: 'runner',
    run: () => captureBrowserViewportSnapshot({ targetUrl: 'http://127.0.0.1:4300/' }),
    canned: () => OK,
    files: [RUNNER_BIN.sh],
  },
  {
    name: 'runs/preview-framing: curl to a preview (localhost in the runner)',
    expect: 'runner',
    run: () => probePreviewFraming('http://127.0.0.1:4300/'),
    canned: () => OK,
    files: [RUNNER_BIN.curl],
  },
  {
    name: 'runs/suggest: the answer suggestion (agent CLI)',
    expect: 'runner',
    run: (d) =>
      runSuggestion({ command: 'claude', model: 'haiku', cwd: d, prompt: 'p' }).catch(() => undefined),
    canned: () => ({ ...OK, stdout: '{}' }),
  },
  {
    name: 'worktree-config/lifecycle: worktree.yml commands',
    expect: 'runner',
    run: (d) => runWorktreeCommand('true', d, 5_000),
  },
  {
    name: 'updates/service: clearing the npx cache in the runner home',
    expect: 'runner',
    run: async (d) => {
      const home = path.join(d, 'home');
      const pkg = path.join(home, '.npm/_npx/aaaa/node_modules/@upstash/context7-mcp');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      const opened = openDb(':memory:');
      try {
        const current = getFactorySettings(opened.db).mcpServers;
        updateFactorySettings(opened.db, {
          mcpServers: current.map((s) => (s.id === 'context7' ? { ...s, enabled: true } : s)),
        });
        const updates = new UpdateService(opened.db, {
          version: '0.7.0',
          runnerHome: home,
          toolsDir: path.join(d, 'tools'),
          fetch: async () => new Response('[]', { status: 200 }),
        });
        await updates.refreshMcp('context7');
      } finally {
        opened.close();
      }
    },
    canned: () => OK,
    files: [RUNNER_BIN.rm],
  },
  {
    name: 'docker/engine: the engine probe (Docker CLI)',
    expect: 'ops',
    run: () => new DockerEngine('tcp://docker:2376').probe(),
    canned: () => ({ ...OK, stdout: '"29.0.0"' }),
    files: [RUNNER_BIN.docker],
  },
  {
    name: 'docker/compose-config: compose config of the main workspace (Docker CLI through sh)',
    expect: 'ops',
    run: async (d) => {
      const main = repo(d);
      writeFileSync(path.join(main, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
      git(main, 'add', '-A');
      git(main, 'commit', '-q', '-m', 'compose');
      const oid = git(main, 'rev-parse', 'HEAD:compose.yaml');
      const commit = git(main, 'rev-parse', 'HEAD');
      await new ComposeConfigReader().read('p1', main, {
        file: 'compose.yaml',
        commit,
        oid,
        mode: '100644',
        type: 'blob',
        size: 40,
      });
    },
    // git reads HEAD for real; the Docker CLI is not there.
    canned: (r) => (r.file === RUNNER_BIN.git ? undefined : OK),
    files: [RUNNER_BIN.sh],
  },
  {
    name: 'docker/compose-preview: compose up and ps (Docker CLI) and the readiness curl to the engine',
    expect: 'ops',
    run: async (d) => {
      const outcome = await runComposePreview(
        {
          worktreePath: d,
          project: 'emberline-aaaa-preview',
          file: 'compose.yaml',
          service: 'web',
          containerPort: 80,
          hostPort: 4400,
          engineHost: 'docker',
          env: {},
        },
        { upTimeoutMs: 5_000, readyTimeoutMs: 5_000, pollMs: 10, stopSettleMs: 0, cancelRetryMs: 0 },
        { execId: 'x', cancelled: () => false, reallocate: async () => 4401 },
      );
      expect(outcome).toMatchObject({ ok: true });
      await dockerQuery(['ps'], {});
    },
    canned: composeEngine,
    files: [RUNNER_BIN.sh, RUNNER_BIN.docker, RUNNER_BIN.curl],
  },
];

describe('every call site sends its commands to the right side', () => {
  let dir: string;
  let seen: ExecRequest[];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sites-'));
    seen = [];
  });
  afterEach(() => {
    setCommandExecutor(localCommandExecutor);
    rmTemp(dir);
  });

  for (const site of CALL_SITES)
    it(site.name, async () => {
      setCommandExecutor(async (request) => {
        seen.push(request);
        return site.canned?.(request) ?? localCommandExecutor(request);
      });
      await site.run(dir);
      expect(seen.length).toBeGreaterThan(0);
      for (const request of seen) {
        const want = typeof site.expect === 'function' ? site.expect(request) : site.expect;
        expect({ file: request.file, target: request.target }).toEqual({ file: request.file, target: want });
      }
      for (const file of site.files ?? []) expect(seen.map((r) => r.file)).toContain(file);
    });
});

describe('the import clone and its terminal use the ops bridge; other terminals the runner', () => {
  let t: TestApp;
  let runnerServer: PtydServer;
  let opsServer: PtydServer;
  let cookie: string;
  beforeEach(async () => {
    const opsDir = mkdtempSync(path.join(tmpdir(), 'ops-'));
    t = await createTestApp({ opsSocket: path.join(opsDir, 'ops.sock') });
    runnerServer = new PtydServer({ socketPath: t.config.ptydSocket, mode: 'runner' });
    opsServer = new PtydServer({ socketPath: t.config.opsSocket!, mode: 'ops' });
    await runnerServer.listen();
    await opsServer.listen();
    t.ops!.start();
    t.ptyd.start();
    await t.ops!.waitUntilConnected();
    await t.ptyd.waitUntilConnected();
    cookie = await setupAndLogin(t.app);
    return () => rmTemp(opsDir);
  });
  afterEach(async () => {
    await t.close();
    await runnerServer.close();
    await opsServer.close();
  });
  const sessionsOf = async (socketPath: string) => {
    const client = await PtydClient.connect(socketPath);
    try {
      return (await client.list()).sessions;
    } finally {
      client.close();
    }
  };

  it('spawns the clone in ops, lists and removes it there, and attaches a viewer to it there', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Cloned', source: 'import_url', repoUrl: 'https://example.invalid/x.git' },
      headers: authHeaders(cookie),
    });
    expect(res.statusCode, res.body).toBe(201);
    const { terminalId, project } = res.json() as { terminalId: string; project: { id: string } };
    expect((await sessionsOf(t.config.opsSocket!)).map((s) => s.id)).toEqual([terminalId]);
    expect(await sessionsOf(t.config.ptydSocket)).toEqual([]);
    expect(await terminalBridge(terminalId, t.ptyd, t.ops!)).toBe(t.ops);

    const status = await t.app.inject({
      url: `/api/projects/${project.id}/import-status`,
      headers: authHeaders(cookie),
    });
    expect(status.json()).toMatchObject({ terminalId });

    // A shell terminal starts in the runner, and both are listed.
    const shell = await t.app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { kind: 'shell' },
      headers: authHeaders(cookie),
    });
    expect(shell.statusCode, shell.body).toBe(201);
    const shellId = (shell.json() as { id: string }).id;
    expect((await sessionsOf(t.config.ptydSocket)).map((s) => s.id)).toEqual([shellId]);
    expect(await terminalBridge(shellId, t.ptyd, t.ops!)).toBe(t.ptyd);
    const listed = await t.app.inject({ url: '/api/terminals', headers: authHeaders(cookie) });
    expect((listed.json() as { id: string }[]).map((x) => x.id).sort()).toEqual([terminalId, shellId].sort());

    const removed = await t.app.inject({
      method: 'DELETE',
      url: `/api/terminals/${terminalId}`,
      headers: authHeaders(cookie),
    });
    expect(removed.statusCode).toBe(200);
    expect(await sessionsOf(t.config.opsSocket!)).toEqual([]);
    expect((await sessionsOf(t.config.ptydSocket)).map((s) => s.id)).toEqual([shellId]);
  });
});

describe('an old compose file with the new images (no ops service)', () => {
  let t: TestApp;
  let runnerServer: PtydServer;
  let opsServer: PtydServer | undefined;
  let opsDir: string;
  beforeEach(async () => {
    opsDir = mkdtempSync(path.join(tmpdir(), 'ops-'));
    t = await createTestApp({ opsSocket: path.join(opsDir, 'ops.sock') });
    runnerServer = new PtydServer({ socketPath: t.config.ptydSocket, mode: 'runner' });
    await runnerServer.listen();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
    await runnerServer.close();
    await opsServer?.close();
    opsServer = undefined;
    rmTemp(opsDir);
  });

  it('every page says so, nothing starts, nothing crashes; adding the service fixes it without a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    t.ops!.start();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
    const cookie = await setupAndLogin(t.app);
    const system = async () =>
      (await t.app.inject({ url: '/api/system', headers: authHeaders(cookie) })).json();
    // A restart's few seconds: no banner yet, but nothing starts either.
    expect(await system()).toMatchObject({ opsMissing: false });
    vi.setSystemTime(Date.now() + NOT_ANSWERING_AFTER_MS + 100);
    expect(await system()).toMatchObject({ opsMissing: true, ptyd: 'connected' });
    const terminal = await t.app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { kind: 'shell' },
      headers: authHeaders(cookie),
    });
    expect(terminal.statusCode).toBe(503);
    expect(terminal.json()).toMatchObject({ error: 'ops_missing', message: OPS_MISSING });
    const deep = await t.app.inject({ url: '/api/health/deep' });
    expect(deep.statusCode).toBe(503);
    expect(deep.json()).toMatchObject({
      ops: { connected: false, protocol: null, secured: false },
      checks: { ops: { ok: false } },
    });
    expect(deep.json().checks.ops.detail).toContain(OPS_MISSING);

    opsServer = new PtydServer({ socketPath: t.config.opsSocket!, mode: 'ops' });
    await opsServer.listen();
    await t.ops!.waitUntilConnected(10_000);
    expect(await system()).toMatchObject({ opsMissing: false });
    const after = await t.app.inject({
      method: 'POST',
      url: '/api/terminals',
      payload: { kind: 'shell' },
      headers: authHeaders(cookie),
    });
    expect(after.statusCode, after.body).toBe(201);
  }, 20_000);
});

describe('deep health reports ops', () => {
  it('connected, its protocol and secured; null in the dev stack (no ops service)', async () => {
    const opsDir = mkdtempSync(path.join(tmpdir(), 'ops-'));
    const t = await createTestApp({ opsSocket: path.join(opsDir, 'ops.sock') });
    const server = new PtydServer({ socketPath: t.config.opsSocket!, mode: 'ops' });
    try {
      await server.listen();
      t.ops!.start();
      await t.ops!.waitUntilConnected();
      const deep = (await t.app.inject({ url: '/api/health/deep' })).json();
      expect(deep.ops).toEqual({ connected: true, protocol: 5, secured: true });
      expect(deep.checks.ops).toMatchObject({ ok: true });
    } finally {
      await t.close();
      await server.close();
      rmTemp(opsDir);
    }
    const dev = await createTestApp();
    try {
      const deep = (await dev.app.inject({ url: '/api/health/deep' })).json();
      expect(deep.ops).toBeNull();
      expect(deep.checks.ops).toMatchObject({ ok: true });
      expect(deep.checks.ops.detail).toContain('EMBERLINE_OPS_SOCKET');
    } finally {
      await dev.close();
    }
  });
});
