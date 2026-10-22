/**
 * The container preview of a project's main workspace (`/api/projects/:id/preview`) and the
 * runner-facing preview URLs (`/api/projects/:id/browser-url`), with `docker` and `curl` faked in the
 * command executor (a small in-memory engine). Covers the plan's Review Focus 2, 3 and 5 for Task 2.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BrowserUrlResponse,
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  DOCKER_ENGINE_OFF_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  DockerOverview,
  MainPreviewStatus,
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
} from './command-exec.js';
import type { CoreConfig } from './config.js';
import { readProjectSettings, writeProjectSettings } from './db/project-settings.js';
import { COMPOSE_OVERRIDE_ENV, composeUpArgs } from './docker/compose.js';
import { DockerEngine, mainComposeProjectName, mainPreviewComposeProjectName } from './docker/engine.js';
import { DemoTokens } from './demo-token.js';
import { agentDemoUrl, demoWorkspacePath } from './factory/demo-target.js';
import { RunService } from './runs/service.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false });
const failed = (stderr: string, exitCode = 1): ExecResult => ({
  exitCode,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false,
  truncated: false,
});

const COMPOSE_V2 = ['version: 2', 'services:', '  - name: site', '    compose: { service: web, port: 80 }', '    preview: true', ''].join('\n');
const COMMAND_V1 = ['version: 1', 'services:', '  - name: web', '    command: "sleep 30"', '    preview: true', ''].join('\n');
const PROJECT_COMPOSE = ['services:', '  web:', '    image: nginx:1.29.3-alpine', '    ports: ["8080:80"]', ''].join('\n');

interface DockerCall {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

/** An engine in memory: compose projects with their services' states, published ports, the listings. */
class FakeEngine {
  available = true;
  calls: DockerCall[] = [];
  curls: string[] = [];
  /** URLs of the framing probes (`curl -D -`), kept apart from the readiness `curls`. */
  probes: string[] = [];
  /** published port → what the probe's curl prints (default: a plain 200). */
  frameHeaders = new Map<number, string>();
  /** project → service → state */
  projects = new Map<string, Map<string, string>>();
  /** published host port → project */
  published = new Map<number, string>();
  /** When set, `up` fails with this output. */
  upFails: string | null = null;
  /** While set, `up` waits for it (or for a cancel). */
  upGate: Promise<void> | null = null;
  pendingUps = new Map<string, (result: ExecResult) => void>();
  cancels: string[] = [];
  /** A cancel that does not reach the command (it keeps running). */
  ignoreCancels = false;

  add(project: string, services: Record<string, string> = { web: 'running' }): void {
    this.projects.set(project, new Map(Object.entries(services)));
  }

  readonly cancel = async (execId: string): Promise<boolean> => {
    this.cancels.push(execId);
    const pending = this.pendingUps.get(execId);
    if (!pending || this.ignoreCancels) return false;
    pending({ ...failed('', 137), exitCode: null, cancelled: true });
    return true;
  };

  readonly exec = async (request: ExecRequest): Promise<ExecResult> => {
    if (request.file === 'curl' && request.args.includes('-D')) {
      const url = request.args.at(-1) ?? '';
      this.probes.push(url);
      return ok(this.frameHeaders.get(Number(new URL(url).port)) ?? 'HTTP/1.1 200 OK\r\n\r\n');
    }
    if (request.file === 'curl') {
      const url = request.args.at(-1) ?? '';
      this.curls.push(url);
      return ok(this.published.has(Number(new URL(url).port)) ? '200' : '000');
    }
    let args: string[];
    let stdin: string | undefined;
    if (request.file === 'docker') {
      args = request.args;
    } else if (request.file === 'sh' && request.args[1]?.includes('exec docker')) {
      args = request.args.slice(3);
      stdin = request.env?.[COMPOSE_OVERRIDE_ENV];
    } else {
      return localCommandExecutor(request);
    }
    if (args[0] === 'version') return this.available ? ok('"29.8.2"\n') : failed('Cannot connect to the Docker daemon');
    this.calls.push({ args, cwd: request.cwd, env: request.env ?? {}, ...(stdin !== undefined ? { stdin } : {}) });
    if (args[0] === 'ps') {
      const lines = [...this.projects].flatMap(([project, services]) =>
        [...services].map(([service, state]) =>
          JSON.stringify({
            ID: `${project}-${service}`,
            Names: `${project}-${service}-1`,
            Image: `${service}:latest`,
            State: state,
            Status: 'Up 5 minutes',
            Ports: '',
            Labels: `com.docker.compose.project=${project},com.docker.compose.service=${service}`,
            CreatedAt: '2026-10-18 08:00:00 +0000 UTC',
            RunningFor: '5 minutes ago',
          }),
        ),
      );
      return ok(lines.join('\n'));
    }
    if (args[0] === 'system' && args[1] === 'df') return ok('');
    if ((args[0] === 'image' || args[0] === 'builder') && args[1] === 'prune') return ok('Total reclaimed space: 0B\n');
    if (args[0] !== 'compose') return failed(`unexpected docker ${args.join(' ')}`);
    if (args[1] === 'ls') {
      return ok(JSON.stringify([...this.projects].map(([Name, s]) => ({ Name, Status: `running(${s.size})`, ConfigFiles: '/x/compose.yaml' }))));
    }
    const project = args[2] ?? '';
    const verb = args.find((a) => ['config', 'up', 'ps', 'logs', 'down'].includes(a));
    if (verb === 'config') return ok('web\n');
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
      if (this.upFails !== null) return failed(this.upFails);
      this.add(project);
      const port = Number(/"(\d+):\d+"/.exec(stdin ?? '')?.[1]);
      if (port) this.published.set(port, project);
      return ok(' Container web-1 Started\n');
    }
    if (verb === 'ps') {
      const states = this.projects.get(project) ?? new Map();
      return ok([...states].map(([Service, State]) => JSON.stringify({ Service, State, Health: '', ExitCode: 0 })).join('\n'));
    }
    if (verb === 'logs') return ok('web-1  | \u001b[31mnginx: [emerg] bad config\u001b[0m\n');
    if (verb === 'down') {
      this.projects.delete(project);
      for (const [port, owner] of this.published) if (owner === project) this.published.delete(port);
      return ok();
    }
    return failed(`unexpected docker ${args.join(' ')}`);
  };

  composeCalls(verb: string, project?: string): DockerCall[] {
    return this.calls.filter((c) => c.args[0] === 'compose' && c.args.includes(verb) && (!project || c.args[2] === project));
  }
  downs(): string[][] {
    return this.composeCalls('down').map((c) => c.args);
  }
}

const downArgs = (project: string, cleanup: boolean) => [
  'compose',
  '-p',
  project,
  'down',
  ...(cleanup ? ['-v', '--rmi', 'local'] : []),
  '--remove-orphans',
];

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;
let engine: FakeEngine;

afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  setCommandCanceller(localCommandCanceller);
  await ptydServer.close();
  await t.close();
});

async function start(dockerHost: string | null = 'tcp://docker:2376', overrides: Partial<CoreConfig> = {}) {
  t = await createTestApp({ ...(dockerHost ? { dockerHost } : {}), ...overrides });
  t.runs.composePreviewTiming = { upTimeoutMs: 5_000, readyTimeoutMs: 1_000, pollMs: 20, stopSettleMs: 300, cancelRetryMs: 50 };
  engine = new FakeEngine();
  setCommandExecutor(engine.exec);
  setCommandCanceller(engine.cancel);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
}

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, ...(method === 'POST' ? { payload: payload ?? {} } : {}), headers: authHeaders(cookie) });

/** A git project; `yml` is approved; `composeFile` commits the project's compose.yaml into main. */
async function createProject(
  name = 'Shop',
  { yml = COMPOSE_V2 as string | null, composeFile = true } = {},
): Promise<{ id: string; path: string }> {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  if (yml) {
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, '.emberline/worktree.yml'), yml);
  }
  if (composeFile) writeFileSync(path.join(project.path, 'compose.yaml'), PROJECT_COMPOSE);
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (yml) {
    const { head } = (await api('GET', `/api/projects/${project.id}/worktree-config`)).json();
    expect((await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: head.sha256 })).statusCode).toBe(200);
  }
  return project;
}

const mainPreview = async (projectId: string) => {
  const res = await api('GET', `/api/projects/${projectId}/preview`);
  expect(res.statusCode).toBe(200);
  return MainPreviewStatus.parse(res.json());
};
const startMain = (projectId: string) => api('POST', `/api/projects/${projectId}/preview/start`);
const stopMain = (projectId: string) => api('POST', `/api/projects/${projectId}/preview/stop`);
async function waitMain(projectId: string, status: MainPreviewStatus['status']): Promise<MainPreviewStatus> {
  await expect.poll(async () => (await mainPreview(projectId)).status, { timeout: 5_000 }).toBe(status);
  return mainPreview(projectId);
}
async function runningMain(projectId: string): Promise<MainPreviewStatus> {
  expect((await startMain(projectId)).statusCode).toBe(200);
  return waitMain(projectId, 'running');
}
const runPreview = async (run: Run) => (await api('GET', `/api/runs/${run.id}/preview`)).json() as RunPreviewStatus;
async function runningRunPreview(run: Run): Promise<RunPreviewStatus> {
  const res = await api('POST', `/api/runs/${run.id}/preview/start`);
  expect(res.statusCode).toBe(200);
  await expect.poll(async () => (await runPreview(run)).status, { timeout: 5_000 }).toBe('running');
  return runPreview(run);
}
const stored = (projectId: string) => readProjectSettings(t.db, projectId).mainPreview as Record<string, unknown> | undefined;
const browserUrl = async (projectId: string, target: string) => {
  const res = await api('GET', `/api/projects/${projectId}/browser-url?target=${encodeURIComponent(target)}`);
  expect(res.statusCode).toBe(200);
  return BrowserUrlResponse.parse(res.json());
};

describe('without a container preview for main (Review Focus 5)', () => {
  it('engine off: the status says why, start is 409 with the hint, and no docker command runs', async () => {
    await start(null, { dockerEngineSwitchedOff: true });
    const p = await createProject();
    const status = await mainPreview(p.id);
    expect(status).toMatchObject({ runId: null, targetId: 'main', status: 'stopped', kind: 'compose', port: null, url: null });
    expect(status.unavailable).toContain(DOCKER_ENGINE_OFF_TEXT);
    const res = await startMain(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(DOCKER_ENGINE_OFF_TEXT);
    expect(res.json().message).not.toContain('COMPOSE_PROFILES');
    expect(engine.calls).toEqual([]);
    expect(stored(p.id)).toBeUndefined();
  });

  it('no engine configured (an old compose file): the status and the 409 say so, not "turned off"', async () => {
    await start(null);
    const p = await createProject();
    expect((await mainPreview(p.id)).unavailable).toContain(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    const res = await startMain(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    expect(res.json().message).not.toContain(DOCKER_ENGINE_OFF_TEXT);
  });

  it('an unreachable engine is the same 409', async () => {
    await start();
    engine.available = false;
    const p = await createProject();
    const res = await startMain(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(DOCKER_ENGINE_UNREACHABLE_HINT);
    expect(engine.calls).toEqual([]);
  });

  it('no approved compose preview service (a command preview, or no worktree.yml): 409, no docker command', async () => {
    await start();
    for (const [name, yml] of [
      ['Cmd', COMMAND_V1],
      ['Bare', null],
    ] as const) {
      const p = await createProject(name, { yml });
      const status = await mainPreview(p.id);
      expect(status).toMatchObject({ status: 'stopped', detectedCommand: null });
      expect(status.unavailable).toContain('no compose preview service');
      const res = await startMain(p.id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'no_compose_preview' });
      expect(res.json().message).toContain('no compose preview service');
      expect(res.json().hint).toContain('worktree.yml');
    }
    expect(engine.composeCalls('up')).toEqual([]);
  });

  it('compose.yaml not in main yet: a clear 409 and no command service fallback', async () => {
    await start();
    const p = await createProject('Wizard', { composeFile: false });
    expect((await mainPreview(p.id)).unavailable).toBe('compose.yaml is not in main yet: merge the work that adds it, then start the preview');
    const res = await startMain(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'compose_file_missing', message: 'compose.yaml is not in main yet: merge the work that adds it, then start the preview' });
    expect(engine.composeCalls('up')).toEqual([]);
    expect(stored(p.id)).toBeUndefined();
  });

  it('an unknown project is 404; actions need a session and CSRF', async () => {
    await start();
    const p = await createProject();
    expect((await api('GET', '/api/projects/nope/preview')).statusCode).toBe(404);
    expect((await api('POST', '/api/projects/nope/preview/start')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}/preview` })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/preview/start`, payload: {}, headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(engine.composeCalls('up')).toEqual([]);
  });
});

describe('start, status and stop', () => {
  it("starts the service in main's own preview project with the override on stdin; the state is in project settings", async () => {
    await start();
    const p = await createProject();
    let open!: () => void;
    engine.upGate = new Promise((resolve) => (open = resolve));
    const res = await startMain(p.id);
    expect(res.statusCode).toBe(200);
    const started = MainPreviewStatus.parse(res.json());
    expect(started).toMatchObject({ runId: null, targetId: 'main', status: 'starting', kind: 'compose', terminalId: null });
    const port = started.port!;
    expect(port).toBeGreaterThanOrEqual(4325);
    expect(port).toBeLessThanOrEqual(4349);
    expect(stored(p.id)).toMatchObject({ status: 'starting', port, startedAt: expect.any(String) });
    expect((await mainPreview(p.id)).status).toBe('starting');
    open();

    const running = await waitMain(p.id, 'running');
    expect(running).toMatchObject({
      port,
      url: `http://localhost:${port}`,
      command: 'docker compose up web (compose.yaml, port 80)',
      error: null,
    });
    expect(stored(p.id)).toMatchObject({ status: 'running', port });

    const project = mainPreviewComposeProjectName(p.id);
    expect(project).toBe(`emberline-main-${p.id.slice(0, 8)}-preview`);
    const [up] = engine.composeCalls('up');
    expect(up!.args).toEqual(composeUpArgs(project, 'compose.yaml', 'web'));
    expect(up!.cwd).toBe(p.path);
    expect(up!.env).toMatchObject({ DOCKER_HOST: 'tcp://docker:2376', DOCKER_TLS_VERIFY: '1' });
    expect(up!.stdin).toContain(`ports: !override ["${port}:80"]`);
    // Every compose command used main's preview project, never Build & Verify's.
    for (const call of engine.calls.filter((c) => c.args[0] === 'compose')) expect(call.args.slice(0, 3)).toEqual(['compose', '-p', project]);
    expect(engine.calls.some((c) => c.args.includes(mainComposeProjectName(p.id)))).toBe(false);
    expect(engine.curls.at(-1)).toBe(`http://docker:${port}/`);
  });

  it('stop takes the project down (volumes kept), frees the port and says stopped', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    const res = await stopMain(p.id);
    expect(res.statusCode).toBe(200);
    expect(MainPreviewStatus.parse(res.json())).toMatchObject({ status: 'stopped', port: null, url: null, error: null });
    expect(engine.downs()).toEqual([downArgs(mainPreviewComposeProjectName(p.id), false)]);
    expect(engine.published.size).toBe(0);
    expect(stored(p.id)).toMatchObject({ status: 'stopped', port: null });
    // A second stop has nothing to take down.
    expect((await stopMain(p.id)).statusCode).toBe(200);
    expect(engine.downs()).toHaveLength(1);
  });

  it('a start while one is starting cancels the first; the second one runs', async () => {
    await start();
    const p = await createProject();
    let open!: () => void;
    engine.upGate = new Promise((resolve) => (open = resolve));
    expect((await startMain(p.id)).statusCode).toBe(200);
    await expect.poll(() => engine.pendingUps.size).toBe(1);
    const [firstExec] = [...engine.pendingUps.keys()];
    expect((await startMain(p.id)).statusCode).toBe(200);
    expect(engine.cancels).toContain(firstExec);
    open();
    const running = await waitMain(p.id, 'running');
    expect(running.error).toBeNull();
    expect(engine.projects.has(mainPreviewComposeProjectName(p.id))).toBe(true);
  });

  it('a failed start says failed with the logs tail, takes the project down and frees the port', async () => {
    await start();
    const p = await createProject();
    engine.upFails = 'failed to solve: process "/bin/sh -c npm ci" did not complete\n';
    expect((await startMain(p.id)).statusCode).toBe(200);
    const status = await waitMain(p.id, 'failed');
    expect(status.error).toBe('docker compose up failed (exit 1)');
    expect(status.logs).toContain('npm ci');
    expect(engine.downs()).toEqual([downArgs(mainPreviewComposeProjectName(p.id), false)]);
    expect(stored(p.id)).toMatchObject({ status: 'failed' });
  });
});

describe('ports: main and run previews never collide (Review Focus 2)', () => {
  const twoPorts = { previewPorts: { runner: { first: 4300, last: 4324 }, docker: { first: 4325, last: 4326 } } };

  it('main first: a run takes the other port, a third preview finds none until main stops', async () => {
    await start('tcp://docker:2376', twoPorts);
    const p = await createProject();
    const mainPort = (await runningMain(p.id)).port!;
    const a = await t.runs.enqueue({ projectId: p.id, prompt: 'a' });
    const b = await t.runs.enqueue({ projectId: p.id, prompt: 'b' });
    const aPort = (await runningRunPreview(a)).port!;
    expect(aPort).not.toBe(mainPort);
    const refused = await api('POST', `/api/runs/${b.id}/preview/start`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('no free preview port');
    await stopMain(p.id);
    expect((await runningRunPreview(b)).port).toBe(mainPort);
  });

  it('runs first: main takes a free port, and none when the range is full', async () => {
    await start('tcp://docker:2376', twoPorts);
    const p = await createProject();
    const a = await t.runs.enqueue({ projectId: p.id, prompt: 'a' });
    const aPort = (await runningRunPreview(a)).port!;
    const mainPort = (await runningMain(p.id)).port!;
    expect(mainPort).not.toBe(aPort);
    const q = await createProject('Other');
    const refused = await startMain(q.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('no free preview port');
  });
});

describe('after a core restart the engine is the truth (Review Focus 2)', () => {
  const restartedStatus = async (projectId: string) => {
    const restarted = new RunService(t.db, t.config, t.ptyd);
    return restarted.mainPreviews.status(projectId);
  };

  it('a running preview reads running while its container runs, exited once it is gone; its port stays reserved until stopped', async () => {
    await start('tcp://docker:2376', { previewPorts: { runner: { first: 4300, last: 4324 }, docker: { first: 4325, last: 4326 } } });
    const p = await createProject();
    const port = (await runningMain(p.id)).port!;
    expect(await restartedStatus(p.id)).toMatchObject({ status: 'running', port });
    engine.projects.delete(mainPreviewComposeProjectName(p.id));
    expect(await restartedStatus(p.id)).toMatchObject({ status: 'exited', port, error: 'the "web" container is not running' });
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    expect((await runningRunPreview(run)).port).not.toBe(port);
  });

  const fastTiming = { upTimeoutMs: 5_000, readyTimeoutMs: 1_000, pollMs: 20, stopSettleMs: 300, cancelRetryMs: 50 };
  const restartedService = () => {
    const restarted = new RunService(t.db, t.config, t.ptyd);
    restarted.composePreviewTiming = fastTiming;
    return restarted;
  };

  it('a start that never came up is reconciled at boot: taken down, failed with a hint, and its port is free again', async () => {
    await start('tcp://docker:2376', { previewPorts: { runner: { first: 4300, last: 4324 }, docker: { first: 4325, last: 4325 } } });
    const p = await createProject();
    engine.upGate = new Promise(() => undefined);
    expect((await startMain(p.id)).statusCode).toBe(200);
    expect(stored(p.id)).toMatchObject({ status: 'starting', port: 4325 });
    engine.upGate = null;

    const restarted = restartedService();
    await restarted.mainPreviews.reconcileInterrupted();
    expect(stored(p.id)).toMatchObject({ status: 'failed', error: 'Emberline restarted before the preview was ready; start it again' });
    expect(engine.downs()).toEqual([downArgs(mainPreviewComposeProjectName(p.id), false)]);
    expect(await restarted.mainPreviews.status(p.id)).toMatchObject({ status: 'failed' });
    // The only port of the range is free for the next preview.
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    expect((await restarted.startPreview(run.id, {})).port).toBe(4325);
  });

  it('a start that came up meanwhile (the engine says running or starting) reads running, is recorded so, and a merge refreshes it', async () => {
    await start();
    const p = await createProject();
    engine.upGate = new Promise(() => undefined);
    expect((await startMain(p.id)).statusCode).toBe(200);
    const port = (stored(p.id)?.port as number) ?? 0;
    engine.upGate = null;
    // A restarting container is compose's `starting`.
    engine.add(mainPreviewComposeProjectName(p.id), { web: 'restarting' });

    const restarted = restartedService();
    // Lazily, on the first status read.
    expect(await restarted.mainPreviews.status(p.id)).toMatchObject({ status: 'running', port });
    expect(stored(p.id)).toMatchObject({ status: 'running', port });
    expect(engine.downs()).toEqual([]);
    await restarted.mainPreviews.refresh(p.id);
    const ups = engine.composeCalls('up', mainPreviewComposeProjectName(p.id));
    expect(ups).toHaveLength(2);
    expect(ups[1]!.stdin).toContain(`ports: !override ["${port}:80"]`);
    expect(await restarted.mainPreviews.status(p.id)).toMatchObject({ status: 'running', port, error: null });
  });

  it('a reconcile is idempotent: a second pass changes nothing and takes nothing down again', async () => {
    await start();
    const p = await createProject();
    engine.upGate = new Promise(() => undefined);
    expect((await startMain(p.id)).statusCode).toBe(200);
    engine.upGate = null;
    const restarted = restartedService();
    await Promise.all([restarted.mainPreviews.reconcileInterrupted(), restarted.mainPreviews.status(p.id)]);
    await restarted.mainPreviews.reconcileInterrupted();
    expect(engine.downs()).toHaveLength(1);
    expect(stored(p.id)).toMatchObject({ status: 'failed' });
  });

  it('a boot pass the engine was down for runs once the engine answers again', async () => {
    await start();
    const p = await createProject();
    engine.upGate = new Promise(() => undefined);
    expect((await startMain(p.id)).statusCode).toBe(200);
    engine.upGate = null;
    engine.available = false;
    const docker = new DockerEngine(t.config.dockerHost, { cwd: t.config.workspacesDir });
    const restarted = new RunService(t.db, t.config, t.ptyd, docker);
    restarted.composePreviewTiming = fastTiming;
    try {
      restarted.startReconciler();
      await docker.probe();
      // Settle the boot pass: the engine does not answer, so it leaves the start alone.
      await restarted.mainPreviews.reconcileInterrupted();
      expect(stored(p.id)).toMatchObject({ status: 'starting' });
      expect(engine.downs()).toEqual([]);
      engine.available = true;
      await docker.probe();
      await expect.poll(() => stored(p.id)?.status, { timeout: 5_000 }).toBe('failed');
      expect(stored(p.id)).toMatchObject({ error: 'Emberline restarted before the preview was ready; start it again' });
      expect(engine.downs()).toEqual([downArgs(mainPreviewComposeProjectName(p.id), false)]);
    } finally {
      restarted.dispose();
    }
  });

  it("a stored preview whose service is not known any more says so without printing 'undefined'", async () => {
    await start();
    const p = await createProject('Bare', { yml: null });
    writeProjectSettings(t.db, p.id, { mainPreview: { status: 'running', port: 4330, startedAt: new Date().toISOString() } });
    const status = await mainPreview(p.id);
    expect(status).toMatchObject({ status: 'exited', error: 'the preview container is not running' });
    expect(status.error).not.toContain('undefined');
  });
});

describe('refresh after a merge into main', () => {
  it('a running preview is rebuilt (`up -d --build`) on the same port with a fresh override', async () => {
    await start();
    const p = await createProject();
    const port = (await runningMain(p.id)).port!;
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    t.runs.note(run.id, 'merged_by_person', {});
    await t.postMerge.idle();
    const ups = engine.composeCalls('up', mainPreviewComposeProjectName(p.id));
    expect(ups).toHaveLength(2);
    expect(ups[1]!.args).toEqual(composeUpArgs(mainPreviewComposeProjectName(p.id), 'compose.yaml', 'web'));
    expect(ups[1]!.cwd).toBe(p.path);
    expect(ups[1]!.stdin).toContain(`ports: !override ["${port}:80"]`);
    expect(await mainPreview(p.id)).toMatchObject({ status: 'running', port, error: null });
  });

  it('a failed refresh says failed with the logs tail and takes the project down', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    engine.upFails = 'failed to solve: npm ci exited 1\n';
    t.runs.note(run.id, 'merged_to_main', {});
    await t.postMerge.idle();
    const status = await mainPreview(p.id);
    expect(status.status).toBe('failed');
    expect(status.error).toContain('docker compose up failed (exit 1)');
    expect(status.error).toContain('refresh after a merge');
    expect(status.logs).toContain('npm ci exited 1');
    expect(engine.projects.has(mainPreviewComposeProjectName(p.id))).toBe(false);
  });

  it('nothing happens when the preview is not running', async () => {
    await start();
    const p = await createProject();
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    t.runs.note(run.id, 'merged_by_person', {});
    await t.postMerge.idle();
    expect(engine.composeCalls('up')).toEqual([]);
    expect(stored(p.id)).toBeUndefined();
  });
});

describe('cleanup', () => {
  it('deleting the project takes the main preview down with its volumes and images', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    expect((await api('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(200);
    expect(engine.downs()).toContainEqual(downArgs(mainPreviewComposeProjectName(p.id), true));
    expect(engine.projects.has(mainPreviewComposeProjectName(p.id))).toBe(false);
  });

  it('deleting the project while the preview starts cancels the start first', async () => {
    await start();
    const p = await createProject();
    engine.upGate = new Promise(() => undefined);
    expect((await startMain(p.id)).statusCode).toBe(200);
    await expect.poll(() => engine.pendingUps.size).toBe(1);
    expect((await api('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(200);
    expect(engine.cancels.length).toBeGreaterThan(0);
    expect(engine.downs()).toContainEqual(downArgs(mainPreviewComposeProjectName(p.id), true));
  });

  it('a start the delete gave up waiting for is taken down with its volumes once it settles', async () => {
    await start();
    const p = await createProject();
    let open!: () => void;
    engine.upGate = new Promise((resolve) => (open = resolve));
    engine.ignoreCancels = true;
    expect((await startMain(p.id)).statusCode).toBe(200);
    await expect.poll(() => engine.pendingUps.size).toBe(1);
    const name = mainPreviewComposeProjectName(p.id);
    await t.runs.mainPreviews.removeForProject(p.id);
    expect(engine.downs()).toEqual([downArgs(name, true)]);
    // The project row is still there (the route deletes it last); the abandoned `up` now brings containers up.
    open();
    await expect.poll(() => engine.downs().length, { timeout: 5_000 }).toBe(2);
    expect(engine.downs()[1]).toEqual(downArgs(name, true));
    expect(engine.projects.has(name)).toBe(false);
  });

  it('a project delete that fails after the preview went does not leave the project marked as deleted', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    vi.spyOn(t.runs, 'removeTree').mockRejectedValueOnce(new Error('EBUSY: resource busy'));
    expect((await api('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(500);
    const name = mainPreviewComposeProjectName(p.id);
    expect(engine.downs()).toContainEqual(downArgs(name, true));
    // The project stays. A start its Stop gives up on is taken down like any project's (volumes kept).
    const before = engine.downs().length;
    let open!: () => void;
    engine.upGate = new Promise((resolve) => (open = resolve));
    engine.ignoreCancels = true;
    expect((await startMain(p.id)).statusCode).toBe(200);
    await expect.poll(() => engine.pendingUps.size).toBe(1);
    expect((await stopMain(p.id)).statusCode).toBe(200);
    expect(engine.downs().slice(before)).toEqual([downArgs(name, false)]);
    open();
    await expect.poll(() => engine.downs().length - before, { timeout: 5_000 }).toBe(2);
    expect(engine.downs().slice(before)).toEqual([downArgs(name, false), downArgs(name, false)]);
  });

  it("the sweep keeps a project's main preview, and removes a deleted project's", async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    engine.add('emberline-main-99999999-preview');
    const swept = await t.runs.sweepDockerProjects();
    expect(swept.removed).toEqual(['emberline-main-99999999-preview']);
    expect(engine.projects.has(mainPreviewComposeProjectName(p.id))).toBe(true);
  });
});

describe('the Docker page lists main previews and acts on them through the main preview stop', () => {
  it('lists it as a preview of main', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    const res = await api('GET', '/api/docker');
    const listed = DockerOverview.parse(res.json()).projects.find((x) => x.name === mainPreviewComposeProjectName(p.id));
    expect(listed).toMatchObject({ owner: { kind: 'main', projectId: p.id, projectName: 'Shop', preview: true }, stale: false });
  });

  it('Stop: the state says stopped (the port is free) and one down, volumes kept', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    const name = mainPreviewComposeProjectName(p.id);
    const res = await api('POST', `/api/docker/projects/${name}/stop`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owner: { kind: 'main', preview: true }, warning: null });
    expect(await mainPreview(p.id)).toMatchObject({ status: 'stopped', port: null });
    expect(stored(p.id)).toMatchObject({ status: 'stopped', port: null });
    expect(engine.downs()).toEqual([downArgs(name, false)]);
  });

  it('Remove: one CLEANUP_DOWN through the main preview stop', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    const name = mainPreviewComposeProjectName(p.id);
    expect((await api('POST', `/api/docker/projects/${name}/remove`)).statusCode).toBe(200);
    expect(engine.downs()).toEqual([downArgs(name, true)]);
    expect((await mainPreview(p.id)).status).toBe('stopped');
  });

  it('a main preview that is not started: one down, the state untouched', async () => {
    await start();
    const p = await createProject();
    const name = mainPreviewComposeProjectName(p.id);
    engine.add(name);
    expect((await api('POST', `/api/docker/projects/${name}/stop`)).statusCode).toBe(200);
    expect(engine.downs()).toEqual([downArgs(name, false)]);
    expect(stored(p.id)).toBeUndefined();
  });
});

describe('framing: whether the container preview allows being framed (Task 6)', () => {
  const DENY = 'HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\n\r\n';
  const ALLOW = 'HTTP/1.1 200 OK\r\n\r\n';

  it("reads the app's headers once per start, and a recheck probes again", async () => {
    await start();
    const p = await createProject();
    const running = await runningMain(p.id);
    expect(running.framing).toEqual({ state: 'allowed', reason: null });
    const port = running.port!;
    // The probe of the first status call is cached: new headers show only after a recheck.
    engine.frameHeaders.set(port, DENY);
    expect((await mainPreview(p.id)).framing).toEqual({ state: 'allowed', reason: null });
    expect(engine.probes).toEqual([`http://docker:${port}/`]);
    const again = await api('POST', `/api/projects/${p.id}/preview/framing`);
    expect(again.statusCode).toBe(200);
    expect(MainPreviewStatus.parse(again.json()).framing).toEqual({ state: 'refused', reason: 'X-Frame-Options: DENY' });
    expect(engine.probes).toHaveLength(2);
    expect((await mainPreview(p.id)).framing?.state).toBe('refused');
    expect(engine.probes).toHaveLength(2);
    engine.frameHeaders.set(port, ALLOW);
    expect((await api('POST', `/api/projects/${p.id}/preview/framing`)).json().framing.state).toBe('allowed');
  });

  it('a stopped preview has no framing, and a restart probes again', async () => {
    await start();
    const p = await createProject();
    await runningMain(p.id);
    expect(engine.probes).toHaveLength(1);
    expect((await stopMain(p.id)).statusCode).toBe(200);
    const stopped = await mainPreview(p.id);
    expect(stopped.status).toBe('stopped');
    expect(stopped.framing).toBeUndefined();
    const restarted = await runningMain(p.id);
    expect(restarted.framing).toEqual({ state: 'allowed', reason: null });
    expect(engine.probes).toHaveLength(2);
  });

  it('an unknown project is 404', async () => {
    await start();
    expect((await api('POST', '/api/projects/nope/preview/framing')).statusCode).toBe(404);
  });
});

describe('browser-url: the preview as the runner sees it (Review Focus 3)', () => {
  it("main's running container preview: the engine host and the published port", async () => {
    await start();
    const p = await createProject();
    const port = (await runningMain(p.id)).port!;
    expect(await browserUrl(p.id, 'main')).toEqual({ url: `http://docker:${port}/`, kind: 'compose' });
  });

  it("a run's running compose preview: the engine host too", async () => {
    await start();
    const p = await createProject();
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    const port = (await runningRunPreview(run)).port!;
    expect(await browserUrl(p.id, run.id)).toEqual({ url: `http://docker:${port}/`, kind: 'compose' });
  });

  it("a run's running command preview runs in the runner: localhost there", async () => {
    await start(null);
    const p = await createProject('Cmd', { yml: COMMAND_V1 });
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    const port = (await runningRunPreview(run)).port!;
    expect(await browserUrl(p.id, run.id)).toEqual({ url: `http://localhost:${port}/`, kind: 'command' });
    await api('POST', `/api/runs/${run.id}/preview/stop`);
  });

  it('otherwise the token demo URL on core (hookUrl), or null without a demo entry', async () => {
    await start(null, { hookUrl: 'http://core:7420' });
    const p = await createProject();
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    const none = await browserUrl(p.id, 'main');
    expect(none).toMatchObject({ url: null, kind: 'static' });
    expect(none.note).toBeTruthy();
    mkdirSync(path.join(p.path, 'dist'), { recursive: true });
    writeFileSync(path.join(p.path, 'dist/index.html'), '<!doctype html><title>main</title>');
    const main = await browserUrl(p.id, 'main');
    expect(main.kind).toBe('static');
    expect(main.url).toMatch(/^http:\/\/core:7420\/api\/demo\/[^/]+\/$/);
    const served = await t.app.inject({ method: 'GET', url: main.url!.slice('http://core:7420'.length) });
    expect(served.statusCode).toBe(200);
    expect(served.body).toContain('<title>main</title>');
    expect(await browserUrl(p.id, run.id)).toMatchObject({ url: null, kind: 'static' });
  });

  it('a stopped or starting container preview falls back to the static demo', async () => {
    await start(null, { hookUrl: 'http://core:7420' });
    const p = await createProject();
    mkdirSync(path.join(p.path, 'dist'), { recursive: true });
    writeFileSync(path.join(p.path, 'dist/index.html'), '<!doctype html>');
    writeProjectSettings(t.db, p.id, { mainPreview: { status: 'starting', port: 4330, startedAt: new Date().toISOString() } });
    const res = await browserUrl(p.id, 'main');
    expect(res.kind).toBe('static');
    expect(res.url).toMatch(/^http:\/\/core:7420\/api\/demo\//);
  });

  it('validates the target: missing is 400; an unknown run or one of another project is 404; never localhost:7420', async () => {
    await start();
    const p = await createProject();
    const q = await createProject('Other');
    const other = await t.runs.enqueue({ projectId: q.id, prompt: 'x' });
    expect((await api('GET', `/api/projects/${p.id}/browser-url`)).statusCode).toBe(400);
    expect((await api('GET', `/api/projects/${p.id}/browser-url?target=nope`)).statusCode).toBe(404);
    expect((await api('GET', `/api/projects/${p.id}/browser-url?target=${other.id}`)).statusCode).toBe(404);
    expect((await api('GET', `/api/projects/missing/browser-url?target=main`)).statusCode).toBe(404);
    expect(JSON.stringify(await browserUrl(p.id, 'main'))).not.toContain('localhost:7420');
  });
});

describe('the demo target helpers shared by the demo routes and browser-url', () => {
  it("resolve main and the project's own runs only, and mint agent URLs on hookUrl that the demo route serves", async () => {
    await start(null, { hookUrl: 'http://core:7420' });
    const p = await createProject();
    const q = await createProject('Other');
    const own = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    const other = await t.runs.enqueue({ projectId: q.id, prompt: 'x' });
    expect(demoWorkspacePath(t.db, p.id, 'main')).toBe(p.path);
    expect(demoWorkspacePath(t.db, p.id, own.id)).toBe(own.worktreePath);
    expect(demoWorkspacePath(t.db, p.id, other.id)).toBeNull();
    expect(demoWorkspacePath(t.db, p.id, 'nope')).toBeNull();
    expect(demoWorkspacePath(t.db, 'missing', 'main')).toBeNull();
    const url = agentDemoUrl({ hookUrl: t.config.hookUrl }, new DemoTokens(t.db), p.id, 'main');
    expect(url).toMatch(/^http:\/\/core:7420\/api\/demo\/[^/]+\/$/);
    mkdirSync(path.join(p.path, 'dist'), { recursive: true });
    writeFileSync(path.join(p.path, 'dist/index.html'), '<!doctype html><title>shared</title>');
    const served = await t.app.inject({ method: 'GET', url: url.slice('http://core:7420'.length) });
    expect(served.body).toContain('<title>shared</title>');
  });
});
