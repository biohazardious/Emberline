/**
 * Compose previews (worktree.yml v2) end to end through the API, with `docker` and `curl` faked in
 * the command executor (a tiny in-memory engine). Covers the plan's Review Focus 1, 2, 4 and 5.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DOCKER_ENGINE_NOT_ANSWERED_TEXT,
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  DOCKER_ENGINE_OFF_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  type Run,
  type RunPreviewStatus,
} from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecRequest,
  type ExecResult,
  localCommandCanceller,
  localCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
  RUNNER_BIN,
  SYSTEM_PATH,
} from './command-exec.js';
import type { CoreConfig } from './config.js';
import { COMPOSE_OVERRIDE_ENV, composeUpArgs } from './docker/compose.js';
import { composeProjectName, previewComposeProjectName } from './docker/engine.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import { rmTemp } from './test-rm.js';

const ok = (stdout = ''): ExecResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
});
const failed = (stdout: string, exitCode = 1): ExecResult => ({
  exitCode,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
});

const COMPOSE_V2 = [
  'version: 2',
  'services:',
  '  - name: dev',
  '    command: npm run dev',
  '  - name: site',
  '    compose: { service: web, port: 80 }',
  '    preview: true',
  '',
].join('\n');

/** The project's own compose file: fixed host ports and a project name of its own, both to be ignored. */
const PROJECT_COMPOSE = [
  'name: chosen-by-agent',
  'services:',
  '  web:',
  '    image: nginx:1.29.3-alpine',
  '    ports: ["8080:80"]',
  '    depends_on: [db]',
  '  db:',
  '    image: postgres:18',
  '    ports: ["5432:5432"]',
  '',
].join('\n');

interface DockerCall {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** What the command got on stdin (the override), when it was run through the `sh` wrapper. */
  stdin?: string;
  file: string;
  inheritEnv?: boolean;
}

/** An engine in memory: `compose up/ps/logs/down/config` per project, plus `curl` against published ports. */
class FakeEngine {
  calls: DockerCall[] = [];
  curls: string[] = [];
  /** URLs of the framing probes (`curl -D -`), kept apart from the readiness `curls`. */
  probes: string[] = [];
  /** published port → what the probe's curl prints (default: a plain 200). */
  frameHeaders = new Map<number, string>();
  available = true;
  services = ['web', 'db'];
  /** project → service → state */
  projects = new Map<string, Map<string, string>>();
  /** published host port → project */
  published = new Map<number, string>();
  upResult: ExecResult = ok(' Container web-1 Started\n');
  stateAfterUp = 'running';
  answersHttp = true;
  /** Host ports something else in the engine already holds (`up` fails with compose's message). */
  busyPorts = new Set<number>();
  /** While set, `up` waits for it (or for a cancel that the canceller honours). */
  upGate: Promise<void> | null = null;
  /** Pending `up` calls by execId: resolving one with `cancelled` is what a working cancel does. */
  pendingUps = new Map<string, (result: ExecResult) => void>();
  /** Each `cancelCommand` execId, in order; `honourCancels` says how many to honour (Infinity = all). */
  cancels: string[] = [];
  ignoreCancels = 0;
  curlArgs: string[][] = [];
  /** While set, `down` waits for it; `heldDowns` counts the ones waiting. */
  downGate: Promise<void> | null = null;
  heldDowns = 0;
  /** With a gate set: hold only the `down` of this compose project (null = every project). */
  downGateFor: string | null = null;

  readonly cancel = async (execId: string): Promise<boolean> => {
    this.cancels.push(execId);
    if (this.ignoreCancels > 0) {
      this.ignoreCancels -= 1;
      return false;
    }
    const pending = this.pendingUps.get(execId);
    if (!pending) return false;
    pending({ ...failed('', 137), exitCode: null, cancelled: true });
    return true;
  };

  readonly exec = async (request: ExecRequest): Promise<ExecResult> => {
    if (request.file === RUNNER_BIN.curl && request.args.includes('-D')) {
      const url = request.args.at(-1) ?? '';
      this.probes.push(url);
      return ok(this.frameHeaders.get(Number(new URL(url).port)) ?? 'HTTP/1.1 200 OK\r\n\r\n');
    }
    if (request.file === RUNNER_BIN.curl) {
      const url = request.args.at(-1) ?? '';
      this.curls.push(url);
      this.curlArgs.push(request.args);
      const port = Number(new URL(url).port);
      return ok(this.answersHttp && this.published.has(port) ? '200' : '000');
    }
    let args: string[];
    let stdin: string | undefined;
    if (request.file === RUNNER_BIN.docker) {
      args = request.args;
    } else if (request.file === RUNNER_BIN.sh && request.args[1]?.includes(RUNNER_BIN.docker)) {
      args = request.args.slice(3);
      stdin = request.env?.[COMPOSE_OVERRIDE_ENV];
    } else {
      return localCommandExecutor(request);
    }
    if (args[0] === 'version')
      return this.available ? ok('"29.8.2"\n') : failed('Cannot connect to the Docker daemon');
    this.calls.push({
      args,
      cwd: request.cwd,
      env: request.env ?? {},
      ...(stdin !== undefined ? { stdin } : {}),
      file: request.file,
      inheritEnv: request.inheritEnv,
    });
    const project = args[2] ?? '';
    const verb = args.find((a) => ['config', 'up', 'ps', 'logs', 'down'].includes(a));
    if (verb === 'config') return ok(`${this.services.join('\n')}\n`);
    if (verb === 'up') {
      if (this.upGate) {
        const gate = this.upGate;
        const cancelled = await new Promise<ExecResult | null>((resolve) => {
          if (request.execId) this.pendingUps.set(request.execId, resolve);
          void gate.then(() => resolve(null));
        });
        if (request.execId) this.pendingUps.delete(request.execId);
        if (cancelled) return cancelled;
      }
      if (this.upResult.exitCode !== 0) return this.upResult;
      const service = args.at(-1)!;
      const port = Number(/"(\d+):\d+"/.exec(stdin ?? '')?.[1]);
      if (this.busyPorts.has(port)) {
        return failed(
          `Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:${port} failed: port is already allocated\n`,
        );
      }
      const states = this.projects.get(project) ?? new Map<string, string>();
      states.set(service, this.stateAfterUp);
      this.projects.set(project, states);
      if (port) this.published.set(port, project);
      return this.upResult;
    }
    if (verb === 'ps') {
      const states = this.projects.get(project) ?? new Map();
      return ok(
        [...states]
          .map(([service, state]) =>
            JSON.stringify({ Service: service, State: state, Health: '', ExitCode: 0 }),
          )
          .join('\n'),
      );
    }
    if (verb === 'logs') return ok('web-1  | \u001b[31mnginx: [emerg] bind failed\u001b[0m\n');
    if (verb === 'down') {
      if (this.downGate && (this.downGateFor === null || this.downGateFor === project)) {
        this.heldDowns += 1;
        await this.downGate;
      }
      this.projects.delete(project);
      for (const [port, owner] of this.published) if (owner === project) this.published.delete(port);
      return ok();
    }
    return failed(`unexpected docker ${args.join(' ')}`);
  };

  composeCalls(verb: string): DockerCall[] {
    return this.calls.filter((c) => c.args.includes(verb));
  }
}

describe('compose previews (worktree.yml v2)', () => {
  let t: TestApp;
  let ptydServer: PtydServer;
  let cookie: string;
  let engine: FakeEngine;

  afterEach(async () => {
    delete process.env.EMBERLINE_PREVIEW_HOST;
    setCommandExecutor(localCommandExecutor);
    setCommandCanceller(localCommandCanceller);
    await ptydServer.close();
    await t.close();
  });

  async function start(dockerHost: string | undefined, overrides: Partial<CoreConfig> = {}) {
    t = await createTestApp({ ...(dockerHost ? { dockerHost } : {}), ...overrides });
    t.runs.composePreviewTiming = {
      upTimeoutMs: 5_000,
      readyTimeoutMs: 1_000,
      pollMs: 20,
      stopSettleMs: 300,
      cancelRetryMs: 50,
    };
    engine = new FakeEngine();
    setCommandExecutor(engine.exec);
    setCommandCanceller(engine.cancel);
    ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
    cookie = await setupAndLogin(t.app);
  }

  const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, host?: string) =>
    t.app.inject({ method, url, payload, headers: { ...authHeaders(cookie), ...(host ? { host } : {}) } });

  /** A git project with `compose.yaml`, a `.env` naming a compose project, and an approved worktree.yml. */
  async function project(worktreeYml = COMPOSE_V2): Promise<{ id: string; path: string }> {
    const { project } = (await api('POST', '/api/projects', { name: 'Shop', initGit: false })).json();
    const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
    git('init', '-q', '-b', 'main');
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, '.emberline/worktree.yml'), worktreeYml);
    writeFileSync(path.join(project.path, 'compose.yaml'), PROJECT_COMPOSE);
    writeFileSync(path.join(project.path, '.env'), 'COMPOSE_PROJECT_NAME=chosen-by-agent\n');
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const { head } = (await api('GET', `/api/projects/${project.id}/worktree-config`)).json();
    expect(
      (await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: head.sha256 }))
        .statusCode,
    ).toBe(200);
    return project;
  }

  const preview = async (run: Run, host?: string) =>
    (await api('GET', `/api/runs/${run.id}/preview`, undefined, host)).json() as RunPreviewStatus;
  const startPreview = (run: Run, body: object = {}, host?: string) =>
    api('POST', `/api/runs/${run.id}/preview/start`, body, host);
  async function waitStatus(
    run: Run,
    status: RunPreviewStatus['status'],
    host?: string,
  ): Promise<RunPreviewStatus> {
    await expect.poll(async () => (await preview(run, host)).status, { timeout: 5_000 }).toBe(status);
    return preview(run, host);
  }
  const listTree = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => !path.join(e.parentPath, e.name).includes(`${path.sep}.git`))
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
      .sort();

  describe('engine off (Review Focus 2)', () => {
    it('a compose preview answers 409 with the hint and runs no docker command', async () => {
      await start(undefined, { dockerEngineSwitchedOff: true });
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      expect(await preview(run)).toMatchObject({
        status: 'stopped',
        kind: 'compose',
        detectedCommand: 'docker compose up web (compose.yaml, port 80)',
      });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain(DOCKER_ENGINE_OFF_TEXT);
      expect(engine.calls).toEqual([]);
      expect((await preview(run)).status).toBe('stopped');
    });

    it('no engine configured: the 409 points at the current compose file, not at a line in .env', async () => {
      await start(undefined);
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
      expect(res.json().message).not.toContain(DOCKER_ENGINE_OFF_TEXT);
    });

    it('an enabled engine that has not answered yet: the 409 says so, never "turned off"', async () => {
      await start('tcp://docker:2376');
      t.runs.docker.ready = async () => undefined;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain(DOCKER_ENGINE_NOT_ANSWERED_TEXT);
      expect(res.json().message).not.toContain('turned off');
      expect(engine.calls).toEqual([]);
    });

    it('an unreachable engine is the same 409', async () => {
      await start('tcp://docker:2376');
      engine.available = false;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain(DOCKER_ENGINE_UNREACHABLE_HINT);
      expect(engine.calls).toEqual([]);
    });

    it('a v1 command preview is unchanged: the runner range, no docker, no Docker variables', async () => {
      await start(undefined);
      const out = path.join(t.dir, 'preview-env');
      const cmd = `echo "$PORT|\${DOCKER_HOST-unset}" > ${out}; sleep 30`;
      const p = await project(
        `version: 1\nservices:\n  - name: web\n    command: ${JSON.stringify(cmd)}\n    preview: true\n`,
      );
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(200);
      const status = res.json() as RunPreviewStatus;
      expect(status).toMatchObject({
        status: 'running',
        kind: 'command',
        command: cmd,
        error: null,
        logs: null,
      });
      expect(status.port).toBeGreaterThanOrEqual(4300);
      expect(status.port).toBeLessThanOrEqual(4324);
      await expect.poll(() => readdirSync(t.dir).includes('preview-env'), { timeout: 8_000 }).toBe(true);
      expect(engine.calls).toEqual([]);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
    });
  });

  describe('framing', () => {
    it('a running compose preview reports what its headers say, probed on the engine host', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(200);
      const port = (await waitStatus(run, 'running')).port!;
      expect((await preview(run)).framing).toEqual({ state: 'allowed', reason: null });
      engine.frameHeaders.set(
        port,
        "HTTP/1.1 200 OK\r\nContent-Security-Policy: frame-ancestors 'none'\r\n\r\n",
      );
      expect((await preview(run)).framing?.state).toBe('allowed');
      const again = await api('POST', `/api/runs/${run.id}/preview/framing`);
      expect(again.statusCode).toBe(200);
      expect((again.json() as RunPreviewStatus).framing).toEqual({
        state: 'refused',
        reason: "Content-Security-Policy: frame-ancestors 'none'",
      });
      expect(engine.probes).toEqual([`http://docker:${port}/`, `http://docker:${port}/`]);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      expect((await preview(run)).framing).toBeUndefined();
    });
  });

  describe('engine on', () => {
    it("starts the service under the run's project with the override on stdin, then reports it running (Focus 1, 4)", async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const before = listTree(run.worktreePath);
      const res = await startPreview(run, { command: 'docker compose -p chosen-by-agent up' });
      expect(res.statusCode).toBe(200);
      const started = res.json() as RunPreviewStatus;
      expect(started).toMatchObject({ status: 'starting', kind: 'compose', terminalId: null });
      const port = started.port!;
      expect(port).toBeGreaterThanOrEqual(4325);
      expect(port).toBeLessThanOrEqual(4349);

      const running = await waitStatus(run, 'running');
      expect(running).toMatchObject({ kind: 'compose', port, url: `http://localhost:${port}`, error: null });

      const composeProject = previewComposeProjectName(run.id);
      const [up] = engine.composeCalls('up');
      expect(up!.args).toEqual(composeUpArgs(composeProject, 'compose.yaml', 'web'));
      expect(up!.cwd).toBe(run.worktreePath);
      expect(up!.env).toMatchObject({ DOCKER_HOST: 'tcp://docker:2376', DOCKER_TLS_VERIFY: '1' });
      // The override drops the file's fixed ports: the preview service gets only its own, the rest none.
      expect(up!.stdin).toBe(
        'services:\n  "web":\n    ports: !override ["' +
          port +
          ':80"]\n    container_name: !reset null\n' +
          '  "db":\n    ports: !reset []\n    container_name: !reset null\n',
      );
      // Every compose command Emberline ran used the run's project, never the file's or `.env`'s.
      for (const call of engine.calls)
        expect(call.args.slice(0, 3)).toEqual(['compose', '-p', composeProject]);
      expect(engine.calls.some((c) => c.args.includes('chosen-by-agent'))).toBe(false);
      // Nothing was written into the worktree; no argument points at an override file.
      expect(listTree(run.worktreePath)).toEqual(before);
      for (const call of engine.calls) {
        const files = call.args.flatMap((a, i) => (call.args[i - 1] === '-f' ? [a] : []));
        expect(files.every((f) => f === 'compose.yaml' || f === '-')).toBe(true);
      }
      // The readiness probe went to the engine's name on the compose network, on the published port.
      expect(engine.curls.at(-1)).toBe(`http://docker:${port}/`);
      // A proxy in the runner's environment must not catch the probe.
      expect(engine.curlArgs.at(-1)).toEqual(expect.arrayContaining(['--noproxy', '*']));
      // Its own project, apart from the one the agent uses for its own containers.
      expect(composeProject).not.toBe(composeProjectName(run.id, run.worktreePath));
      expect(composeProject).toBe(`emberline-${run.id.slice(0, 8)}-preview`);
    });

    it("two runs' previews coexist on distinct ports (Focus 1)", async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const a = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const b = await t.runs.enqueue({ projectId: p.id, prompt: 'y' });
      const pa = ((await startPreview(a)).json() as RunPreviewStatus).port;
      const pb = ((await startPreview(b)).json() as RunPreviewStatus).port;
      expect(pa).not.toBe(pb);
      await waitStatus(a, 'running');
      await waitStatus(b, 'running');
      const ups = engine.composeCalls('up');
      expect(ups.map((c) => c.args[2])).toEqual([
        previewComposeProjectName(a.id),
        previewComposeProjectName(b.id),
      ]);
      expect(ups[0]!.stdin).toContain(`"${pa}:80"`);
      expect(ups[1]!.stdin).toContain(`"${pb}:80"`);
    });

    it('stop takes the project down (volumes kept) and the status says stopped', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await waitStatus(run, 'running');
      const res = await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      expect(res.json()).toMatchObject({ status: 'stopped', port: null, url: null });
      expect(engine.composeCalls('down').map((c) => c.args)).toEqual([
        ['compose', '-p', previewComposeProjectName(run.id), 'down', '--remove-orphans'],
      ]);
      expect(engine.projects.size).toBe(0);
    });

    it("every docker command is the image's CLI with no config, plugin or variable of the runner's", async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await waitStatus(run, 'running');
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      const verbs = engine.calls.map((c) => c.args.find((a) => ['config', 'up', 'ps', 'down'].includes(a)));
      expect(new Set(verbs)).toEqual(new Set(['config', 'up', 'ps', 'down']));
      for (const call of engine.calls) {
        expect([RUNNER_BIN.docker, RUNNER_BIN.sh]).toContain(call.file);
        // ~/.docker (agents can write it: cli-plugins, config.json) is never read, nor anything inherited.
        expect(call.inheritEnv, call.args.join(' ')).toBe(false);
        expect(call.env).toMatchObject({
          PATH: SYSTEM_PATH,
          HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent',
          BUILDX_CONFIG: '/nonexistent/buildx',
          DOCKER_HOST: 'tcp://docker:2376',
        });
      }
    });

    it('a port something else holds in the engine is retried on the next free one, re-recorded', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      // Find out which port this run gets first, then make it busy for the real start.
      const first = ((await startPreview(run)).json() as RunPreviewStatus).port!;
      await waitStatus(run, 'running');
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      engine.calls = [];
      engine.busyPorts.add(first);
      expect(((await startPreview(run)).json() as RunPreviewStatus).port).toBe(first);
      const running = await waitStatus(run, 'running');
      expect(running.port).not.toBe(first);
      expect(running.port).toBeGreaterThanOrEqual(4325);
      const ups = engine.composeCalls('up');
      expect(ups).toHaveLength(2);
      expect(ups[0]!.stdin).toContain(`"${first}:80"`);
      expect(ups[1]!.stdin).toContain(`"${running.port}:80"`);
      const started = t.runs
        .get(run.id)
        .events.filter((e) => e.type === 'preview_started')
        .map((e) => (e.payload as { port: number }).port);
      expect(started.slice(-2).sort()).toEqual([first, running.port].sort());
    });

    it('gives up after 3 attempts when every port is taken', async () => {
      await start('tcp://docker:2376');
      for (let port = 4325; port <= 4349; port++) engine.busyPorts.add(port);
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      const status = await waitStatus(run, 'failed');
      expect(engine.composeCalls('up')).toHaveLength(3);
      expect(status.logs).toContain('port is already allocated');
    });

    it('a stop while it starts cancels the start, waits for it, then takes the project down', async () => {
      await start('tcp://docker:2376');
      let open!: () => void;
      engine.upGate = new Promise((resolve) => (open = resolve));
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      const res = await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      expect(res.json()).toMatchObject({ status: 'stopped' });
      expect(engine.cancels).toHaveLength(1);
      expect(engine.pendingUps.size).toBe(0);
      expect(engine.composeCalls('down').map((c) => c.args[2])).toContain(previewComposeProjectName(run.id));
      open();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        t.runs.get(run.id).events.some((e) => e.type === 'preview_ready' || e.type === 'preview_failed'),
      ).toBe(false);
      expect((await preview(run)).status).toBe('stopped');
    });

    it('a cancel that misses the command is retried once', async () => {
      await start('tcp://docker:2376');
      engine.upGate = new Promise(() => undefined);
      engine.ignoreCancels = 1;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      expect(engine.cancels).toHaveLength(2);
      expect(engine.pendingUps.size).toBe(0);
    });

    it('a start that could not be cancelled and finishes after the stop is taken down when it settles', async () => {
      await start('tcp://docker:2376');
      let open!: () => void;
      engine.upGate = new Promise((resolve) => (open = resolve));
      engine.ignoreCancels = 10;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      const downsAtStop = engine.composeCalls('down').length;
      // The late `up` creates the containers after the stop's `down`...
      open();
      await expect.poll(() => engine.composeCalls('down').length).toBe(downsAtStop + 1);
      // ...and the settle-time `down` removes them again.
      expect(engine.projects.has(previewComposeProjectName(run.id))).toBe(false);
      expect((await preview(run)).status).toBe('stopped');
    });

    it('a second start while one is starting cancels the first; only the second reports', async () => {
      await start('tcp://docker:2376');
      let open!: () => void;
      engine.upGate = new Promise((resolve) => (open = resolve));
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const [r1, r2] = await Promise.all([
        startPreview(run),
        (async () => {
          await expect.poll(() => engine.pendingUps.size).toBe(1);
          engine.upGate = null;
          return startPreview(run);
        })(),
      ]);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      open();
      await waitStatus(run, 'running');
      expect(engine.cancels).toHaveLength(1);
      expect(t.runs.get(run.id).events.filter((e) => e.type === 'preview_ready')).toHaveLength(1);
      expect(engine.projects.has(previewComposeProjectName(run.id))).toBe(true);
    });

    it('a failed preview is taken down and frees its port for another run', async () => {
      await start('tcp://docker:2376', {
        previewPorts: { runner: { first: 4300, last: 4324 }, docker: { first: 4325, last: 4325 } },
      });
      const p = await project();
      const a = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const b = await t.runs.enqueue({ projectId: p.id, prompt: 'y' });
      await startPreview(a);
      await waitStatus(a, 'running');
      // The only port is held by a's running preview.
      expect((await startPreview(b)).statusCode).toBe(409);
      await api('POST', `/api/runs/${a.id}/preview/stop`, {});
      engine.stateAfterUp = 'exited';
      await startPreview(a);
      await waitStatus(a, 'failed');
      expect(engine.composeCalls('down').at(-1)?.args[2]).toBe(previewComposeProjectName(a.id));
      engine.stateAfterUp = 'running';
      const res = await startPreview(b);
      expect(res.statusCode).toBe(200);
      expect((res.json() as RunPreviewStatus).port).toBe(4325);
      await waitStatus(b, 'running');
    });

    it('a failed build reports failed with the output tail, sanitised', async () => {
      await start('tcp://docker:2376');
      engine.upResult = failed(
        'failed to solve: \u001b[31mprocess "/bin/sh -c npm ci" did not complete\u001b[0m\n',
        17,
      );
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      const status = await waitStatus(run, 'failed');
      expect(status.error).toContain('docker compose up failed (exit 17)');
      expect(status.logs).toBe('failed to solve: process "/bin/sh -c npm ci" did not complete');
    });

    it('a container that exits reports failed with its logs', async () => {
      await start('tcp://docker:2376');
      engine.stateAfterUp = 'exited';
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      const status = await waitStatus(run, 'failed');
      expect(status.error).toContain('stopped');
      expect(status.logs).toBe('web-1  | nginx: [emerg] bind failed');
    });

    it('a service that never answers HTTP fails after the readiness window', async () => {
      await start('tcp://docker:2376');
      engine.answersHttp = false;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      const status = await waitStatus(run, 'failed');
      expect(status.error).toMatch(/did not answer HTTP on port \d+ within 1 s/);
      expect(status.logs).toContain('bind failed');
    });

    it('a service missing from the compose file fails without starting anything', async () => {
      await start('tcp://docker:2376');
      engine.services = ['api'];
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      const status = await waitStatus(run, 'failed');
      expect(status.error).toContain('"web" is not a service in compose.yaml');
      expect(engine.composeCalls('up')).toEqual([]);
    });

    it('a preview that stopped running later shows exited', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await waitStatus(run, 'running');
      engine.projects.get(previewComposeProjectName(run.id))!.set('web', 'exited');
      expect((await preview(run)).status).toBe('exited');
    });

    it('deleting the run takes its preview down', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await waitStatus(run, 'running');
      await t.runs.stop(run.id).catch(() => undefined);
      expect((await api('DELETE', `/api/runs/${run.id}`)).statusCode).toBeLessThan(300);
      // The preview project, then (the worktree is kept, no other run in it) the run's own project.
      expect(engine.composeCalls('down').map((c) => c.args)).toEqual([
        [
          'compose',
          '-p',
          previewComposeProjectName(run.id),
          'down',
          '-v',
          '--rmi',
          'local',
          '--remove-orphans',
        ],
        [
          'compose',
          '-p',
          composeProjectName(run.id, run.worktreePath),
          'down',
          '-v',
          '--rmi',
          'local',
          '--remove-orphans',
        ],
      ]);
      // Nothing per run is left behind in the service.
      expect(
        (t.runs as unknown as { previewGenerations: Map<string, number> }).previewGenerations.has(run.id),
      ).toBe(false);
    });

    const singlePort = {
      previewPorts: { runner: { first: 4300, last: 4324 }, docker: { first: 4325, last: 4325 } },
    };

    it('a prune takes a running preview down, records it stopped, and its port is free again', async () => {
      await start('tcp://docker:2376', singlePort);
      const p = await project();
      const a = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const b = await t.runs.enqueue({ projectId: p.id, prompt: 'y' });
      await startPreview(a);
      await waitStatus(a, 'running');
      await t.runs.stop(a.id);
      const res = await api('POST', `/api/runs/${a.id}/worktree/prune`, {});
      expect(res.json()).toMatchObject({ removed: true });
      expect(t.runs.get(a.id).events.filter((e) => e.type === 'preview_stopped')).toHaveLength(1);
      const status = await preview(a);
      expect(status.status).toBe('stopped');
      expect(status.error ?? '').not.toContain('restarted');
      // The only docker port is free for another run.
      const started = await startPreview(b);
      expect(started.statusCode).toBe(200);
      expect((started.json() as RunPreviewStatus).port).toBe(4325);
    });

    it('a run whose worktree is gone no longer holds its preview port', async () => {
      await start('tcp://docker:2376', singlePort);
      const p = await project();
      const a = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const b = await t.runs.enqueue({ projectId: p.id, prompt: 'y' });
      await startPreview(a);
      await waitStatus(a, 'running');
      rmTemp(a.worktreePath);
      const started = await startPreview(b);
      expect(started.statusCode).toBe(200);
      expect((started.json() as RunPreviewStatus).port).toBe(4325);
    });

    it('a start abandoned by a stop, whose run is then deleted, is taken down with its volumes and images', async () => {
      await start('tcp://docker:2376');
      let open!: () => void;
      engine.upGate = new Promise((resolve) => (open = resolve));
      engine.ignoreCancels = 10;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      await t.runs.stop(run.id).catch(() => undefined);
      expect((await api('DELETE', `/api/runs/${run.id}`)).statusCode).toBeLessThan(300);
      const downsBefore = engine.composeCalls('down').length;
      open();
      await expect.poll(() => engine.composeCalls('down').length).toBe(downsBefore + 1);
      expect(engine.composeCalls('down').at(-1)!.args).toEqual([
        'compose',
        '-p',
        previewComposeProjectName(run.id),
        'down',
        '-v',
        '--rmi',
        'local',
        '--remove-orphans',
      ]);
    });

    it('a start abandoned by a stop that settles while its run is being removed is taken down with its volumes', async () => {
      await start('tcp://docker:2376');
      let open!: () => void;
      engine.upGate = new Promise((resolve) => (open = resolve));
      engine.ignoreCancels = 10;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      await t.runs.stop(run.id).catch(() => undefined);
      let release!: () => void;
      engine.downGate = new Promise((resolve) => (release = resolve));
      engine.downGateFor = composeProjectName(run.id, run.worktreePath);
      const deleting = api('DELETE', `/api/runs/${run.id}`);
      await expect.poll(() => engine.heldDowns).toBe(1);
      const downsBefore = engine.composeCalls('down').length;
      open();
      await expect.poll(() => engine.composeCalls('down').length).toBe(downsBefore + 1);
      expect(engine.composeCalls('down').at(-1)!.args).toEqual([
        'compose',
        '-p',
        previewComposeProjectName(run.id),
        'down',
        '-v',
        '--rmi',
        'local',
        '--remove-orphans',
      ]);
      release();
      await deleting;
    });

    it('deleting a run forgets its framing probe', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const forget = vi.spyOn(t.runs.framing, 'forget');
      await api('DELETE', `/api/runs/${run.id}`);
      expect(forget).toHaveBeenCalledWith(`run:${run.id}`);
    });

    it('a preview start is refused while the worktree is being torn down', async () => {
      await start('tcp://docker:2376');
      let release!: () => void;
      engine.downGate = new Promise((resolve) => (release = resolve));
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await t.runs.stop(run.id);
      (t.runs as unknown as { teardownBudgets: { request: number } }).teardownBudgets.request = 50;
      expect((await api('POST', `/api/runs/${run.id}/worktree/prune`, {})).json()).toMatchObject({
        pending: true,
      });
      const res = await startPreview(run);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain('being removed');
      engine.downGate = null;
      release();
    });

    describe('compose file not there yet', () => {
      const FALLBACK_V2 = [
        'version: 2',
        'services:',
        '  - name: dev',
        '    command: sleep 30',
        '  - name: container',
        '    compose: { service: web, port: 80 }',
        '    preview: true',
        '',
      ].join('\n');

      it('previews the first command service instead and says why', async () => {
        await start('tcp://docker:2376');
        const p = await project(FALLBACK_V2);
        const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
        rmSync(path.join(run.worktreePath, 'compose.yaml'));
        const res = await startPreview(run);
        expect(res.statusCode).toBe(200);
        const status = res.json() as RunPreviewStatus;
        expect(status).toMatchObject({ kind: 'command', command: 'sleep 30', status: 'running' });
        expect(status.note).toBe('compose.yaml not found yet — previewing dev');
        expect((await preview(run)).note).toBe('compose.yaml not found yet — previewing dev');
        expect(engine.composeCalls('up')).toEqual([]);
        await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      });

      it('without a command service, a package.json dev script is previewed instead', async () => {
        await start('tcp://docker:2376');
        const p = await project(
          'version: 2\nservices:\n  - name: container\n    compose: { service: web, port: 80 }\n    preview: true\n',
        );
        const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
        rmSync(path.join(run.worktreePath, 'compose.yaml'));
        writeFileSync(path.join(run.worktreePath, 'package.json'), '{"scripts":{"dev":"sleep 30"}}');
        const res = await startPreview(run);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ kind: 'command', status: 'running' });
        expect((res.json() as RunPreviewStatus).note).toBe(
          'compose.yaml not found yet — previewing the detected dev command',
        );
        expect(engine.composeCalls('up')).toEqual([]);
        await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      });

      it('without a command service it fails clearly', async () => {
        await start('tcp://docker:2376');
        const p = await project();
        const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
        writeFileSync(
          path.join(p.path, '.emberline/worktree.yml'),
          'version: 2\nservices:\n  - name: container\n    compose: { service: web, port: 80 }\n    preview: true\n',
        );
        execFileSync('git', [
          '-C',
          p.path,
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          'commit',
          '-qam',
          'only compose',
        ]);
        const { head } = (await api('GET', `/api/projects/${p.id}/worktree-config`)).json();
        await api('POST', `/api/projects/${p.id}/worktree-config/approve`, { sha256: head.sha256 });
        rmSync(path.join(run.worktreePath, 'compose.yaml'));
        const res = await startPreview(run);
        expect(res.statusCode).toBe(409);
        expect(res.json().message).toContain('compose.yaml not found');
        expect(engine.composeCalls('up')).toEqual([]);
      });
    });

    it('while a stop waits for the start to settle, the status still reads starting', async () => {
      await start('tcp://docker:2376');
      engine.upGate = new Promise(() => undefined);
      engine.ignoreCancels = 10;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      const stopping = api('POST', `/api/runs/${run.id}/preview/stop`, {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await preview(run)).toMatchObject({ status: 'starting', error: null });
      expect((await stopping).json()).toMatchObject({ status: 'stopped' });
    });

    it('the late down of a start the stop gave up on holds the run lock: a newer start waits for it', async () => {
      await start('tcp://docker:2376');
      let openUp!: () => void;
      engine.upGate = new Promise((resolve) => (openUp = resolve));
      engine.ignoreCancels = 10;
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      await startPreview(run);
      await expect.poll(() => engine.pendingUps.size).toBe(1);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
      let openDown!: () => void;
      engine.downGate = new Promise((resolve) => (openDown = resolve));
      engine.upGate = null;
      // The given-up `up` finishes late; its settle-time `down` is still going...
      openUp();
      await expect.poll(() => engine.heldDowns).toBe(1);
      // ...when a new start comes in. It must not start its containers before that down ended.
      const second = startPreview(run);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(engine.composeCalls('config')).toHaveLength(1);
      engine.downGate = null;
      openDown();
      expect((await second).statusCode).toBe(200);
      await waitStatus(run, 'running');
      expect(engine.projects.has(previewComposeProjectName(run.id))).toBe(true);
    });
  });

  describe('preview URL host (Review Focus 5)', () => {
    it('uses the host the browser used for the API, keeping the preview port', async () => {
      await start('tcp://docker:2376');
      const p = await project();
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const res = await startPreview(run, {}, '192.168.1.16:7420');
      const port = (res.json() as RunPreviewStatus).port;
      expect((res.json() as RunPreviewStatus).url).toBe(`http://192.168.1.16:${port}`);
      expect((await waitStatus(run, 'running', '192.168.1.16:7420')).url).toBe(`http://192.168.1.16:${port}`);
      // Another device asking later gets its own host.
      expect((await preview(run, '10.0.0.7:7420')).url).toBe(`http://10.0.0.7:${port}`);
      expect((await preview(run, '[::1]:7420')).url).toBe(`http://[::1]:${port}`);
    });

    it('EMBERLINE_PREVIEW_HOST still wins', async () => {
      process.env.EMBERLINE_PREVIEW_HOST = 'https://preview.example.test/';
      await start(undefined);
      const p = await project(
        'version: 1\nservices:\n  - name: web\n    command: sleep 30\n    preview: true\n',
      );
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      const status = (await startPreview(run, {}, '192.168.1.16:7420')).json() as RunPreviewStatus;
      expect(status.url).toBe(`https://preview.example.test:${status.port}`);
      await api('POST', `/api/runs/${run.id}/preview/stop`, {});
    });

    it('a host that is not allowed never reaches the preview (421 from the allow-list)', async () => {
      await start(undefined);
      const p = await project(
        'version: 1\nservices:\n  - name: web\n    command: sleep 30\n    preview: true\n',
      );
      const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
      expect(
        (await api('GET', `/api/runs/${run.id}/preview`, undefined, 'evil.example:7420')).statusCode,
      ).toBe(421);
    });
  });
});
