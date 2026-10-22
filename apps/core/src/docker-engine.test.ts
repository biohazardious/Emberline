import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run, SystemStatus } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandExecutor,
  type ExecRequest,
  type ExecResult,
  localCommandExecutor,
  setCommandExecutor,
} from './command-exec.js';
import { loadConfig, parsePortRange, previewPortRangesOverlap } from './config.js';
import { buildWorkspaceDemo } from './factory/demo.js';
import {
  composeProjectName,
  DOCKER_PROBE_INTERVAL_MS,
  DOCKER_PROMPT_PARAGRAPH,
  DockerEngine,
  mainComposeProjectName,
  mainPreviewComposeProjectName,
  previewComposeProjectName,
} from './docker/engine.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const ok = (stdout: string): ExecResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false });
const failed = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, signal: null, stdout: '', stderr, timedOut: false, truncated: false });
const CERTS = '/run/emberline-docker-certs';
/** Shell that prints the Docker variables a command got, `unset` for a missing one. */
const PRINT_DOCKER_ENV =
  'printf "%s|%s|%s|%s" "${DOCKER_HOST-unset}" "${DOCKER_TLS_VERIFY-unset}" "${DOCKER_CERT_PATH-unset}" "${EMBERLINE_COMPOSE_PROJECT-unset}"';
const dockerEnvLine = (project: string) => `tcp://docker:2376|1|${CERTS}|${project}`;
const NO_DOCKER = 'unset|unset|unset|unset';
/** What a client of the engine needs: its address and Emberline's client certificate (mTLS). */
const CLIENT_ENV = { DOCKER_HOST: 'tcp://docker:2376', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: CERTS };

describe('config: Docker host and preview port ranges', () => {
  it('reads EMBERLINE_DOCKER_HOST; blank or unset is off', () => {
    expect(loadConfig({ EMBERLINE_DOCKER_HOST: 'tcp://docker:2376' }).dockerHost).toBe('tcp://docker:2376');
    expect(loadConfig({ EMBERLINE_DOCKER_HOST: '  ' }).dockerHost).toBeUndefined();
    expect(loadConfig({}).dockerHost).toBeUndefined();
  });

  it('EMBERLINE_DOCKER_ENGINE=0 (trimmed) turns the engine off even with a host; 1 without a host stays off', () => {
    const host = 'tcp://docker:2376';
    expect(loadConfig({ EMBERLINE_DOCKER_HOST: host }).dockerHost).toBe(host);
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '1', EMBERLINE_DOCKER_HOST: host }).dockerHost).toBe(host);
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '0', EMBERLINE_DOCKER_HOST: host }).dockerHost).toBeUndefined();
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: ' 0 ', EMBERLINE_DOCKER_HOST: host }).dockerHost).toBeUndefined();
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '1' }).dockerHost).toBeUndefined();
  });

  it('remembers that EMBERLINE_DOCKER_ENGINE=0 switched it off, apart from a missing host', () => {
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: ' 0 ' }).dockerEngineSwitchedOff).toBe(true);
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '0', EMBERLINE_DOCKER_HOST: 'tcp://docker:2376' }).dockerEngineSwitchedOff).toBe(true);
    expect(loadConfig({}).dockerEngineSwitchedOff).toBe(false);
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '1' }).dockerEngineSwitchedOff).toBe(false);
  });

  it('flags an EMBERLINE_DOCKER_ENGINE value that is not 0 or 1', () => {
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '2' }).dockerEngineSettingInvalid).toBe('2');
    for (const v of ['0', ' 1 ', '']) expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: v }).dockerEngineSettingInvalid).toBeUndefined();
    expect(loadConfig({}).dockerEngineSettingInvalid).toBeUndefined();
  });

  it('an engine of your own keeps working with the bundled one switched off', () => {
    const own = loadConfig({ EMBERLINE_DOCKER_ENGINE: '0', EMBERLINE_DOCKER_HOST: 'tcp://10.0.0.5:2376' });
    expect(own.dockerHost).toBe('tcp://10.0.0.5:2376');
    expect(own.dockerEngineSwitchedOff).toBe(false);
    expect(loadConfig({ EMBERLINE_DOCKER_ENGINE: '0', EMBERLINE_DOCKER_HOST: 'garbage' }).dockerEngineSwitchedOff).toBe(false);
    const bundled = loadConfig({ EMBERLINE_DOCKER_ENGINE: '0', EMBERLINE_DOCKER_HOST: 'tcp://docker:2376' });
    expect(bundled.dockerHost).toBeUndefined();
    expect(bundled.dockerEngineSwitchedOff).toBe(true);
  });

  it('reads the client certificate directory, by default the runner\'s read-only mount', () => {
    expect(loadConfig({}).dockerCertPath).toBe('/run/emberline-docker-certs');
    expect(loadConfig({ EMBERLINE_DOCKER_CERT_PATH: ' /certs/client ' }).dockerCertPath).toBe('/certs/client');
  });

  it('tells when the runner and docker preview ranges overlap', () => {
    expect(previewPortRangesOverlap(loadConfig({}).previewPorts)).toBe(false);
    expect(previewPortRangesOverlap({ runner: { first: 4300, last: 4330 }, docker: { first: 4325, last: 4349 } })).toBe(true);
    expect(previewPortRangesOverlap({ runner: { first: 5000, last: 5000 }, docker: { first: 4990, last: 5000 } })).toBe(true);
    expect(previewPortRangesOverlap({ runner: { first: 5001, last: 5009 }, docker: { first: 4990, last: 5000 } })).toBe(false);
  });

  it('defaults the preview ports to 4300-4324 (runner) and 4325-4349 (docker)', () => {
    expect(loadConfig({}).previewPorts).toEqual({ runner: { first: 4300, last: 4324 }, docker: { first: 4325, last: 4349 } });
  });

  it('reads both ranges, and falls back to the default for an invalid one', () => {
    const config = loadConfig({ EMBERLINE_PREVIEW_PORTS_RUNNER: ' 5000 - 5009 ', EMBERLINE_PREVIEW_PORTS_DOCKER: '6000-5000' });
    expect(config.previewPorts).toEqual({ runner: { first: 5000, last: 5009 }, docker: { first: 4325, last: 4349 } });
  });

  it('parses a range or a single port, and rejects anything else', () => {
    expect(parsePortRange('4300-4349')).toEqual({ first: 4300, last: 4349 });
    expect(parsePortRange('8080')).toEqual({ first: 8080, last: 8080 });
    for (const bad of ['', 'abc', '0-10', '4300-70000', '4350-4300', '4300-', '-4300', '4300:4349', '1e3-2e3']) {
      expect(parsePortRange(bad), bad).toBeNull();
    }
  });
});

describe('composeProjectName', () => {
  it('is emberline-<first 8 of the run id>', () => {
    expect(composeProjectName('AB12cd34-0000-4000-8000-000000000000')).toBe('emberline-ab12cd34');
  });

  it('follows the worktree, so a handoff successor shares its predecessor\'s project', () => {
    expect(composeProjectName('99999999-0000-4000-8000-000000000000', '/workspaces/.worktrees/shop/1a2b3c4d')).toBe('emberline-1a2b3c4d');
    // In place (no worktree of its own): the run's id.
    expect(composeProjectName('99999999-0000-4000-8000-000000000000', '/workspaces/shop')).toBe('emberline-99999999');
  });

  it('a preview has emberline-<first 8 of its own run id>-preview, also for a handoff successor in a shared worktree', () => {
    const successor = '99999999-0000-4000-8000-000000000000';
    expect(previewComposeProjectName(successor)).toBe('emberline-99999999-preview');
    expect(previewComposeProjectName('1A2B3C4D-0000-4000-8000-000000000000')).toBe('emberline-1a2b3c4d-preview');
    // The successor shares its predecessor's agent project, but not its preview project.
    expect(composeProjectName(successor, '/workspaces/.worktrees/shop/1a2b3c4d')).toBe('emberline-1a2b3c4d');
  });

  it('the main workspace (Build & Verify) has emberline-main-<first 8 of the project id>', () => {
    expect(mainComposeProjectName('C0FFEE12-0000-4000-8000-000000000000')).toBe('emberline-main-c0ffee12');
  });

  it("the main workspace's container preview has emberline-main-<first 8 of the project id>-preview, apart from Build & Verify's", () => {
    const id = 'C0FFEE12-0000-4000-8000-000000000000';
    expect(mainPreviewComposeProjectName(id)).toBe('emberline-main-c0ffee12-preview');
    expect(mainPreviewComposeProjectName(id)).not.toBe(mainComposeProjectName(id));
  });
});

describe('DockerEngine probe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off without a host and never runs the CLI', async () => {
    const exec = vi.fn<CommandExecutor>();
    const engine = new DockerEngine(undefined, { exec });
    expect(await engine.probe()).toEqual({ enabled: false, checked: false, available: false, version: null, reason: 'not_configured' });
    await engine.ready(); // nothing to wait for
    engine.start();
    engine.stop();
    expect(exec).not.toHaveBeenCalled();
    expect(engine.runEnv('emberline-ab12cd34')).toEqual({});
  });

  it('says why it is off: switched off, or no host configured; an enabled engine has no reason', () => {
    expect(new DockerEngine(undefined, { switchedOff: true }).status.reason).toBe('switched_off');
    expect(new DockerEngine(undefined).status.reason).toBe('not_configured');
    expect(new DockerEngine('tcp://docker:2376').status.reason).toBeUndefined();
  });

  it('runs `docker version` in the runner with the client certificate and caches the server version', async () => {
    const exec = vi.fn<CommandExecutor>(async () => ok('"29.8.2"\n'));
    const engine = new DockerEngine('tcp://docker:2376', { certPath: CERTS, exec, cwd: '/workspaces' });
    expect(engine.status).toEqual({ enabled: true, checked: false, available: false, version: null });
    expect(await engine.probe()).toEqual({ enabled: true, checked: true, available: true, version: '29.8.2' });
    expect(engine.status).toEqual({ enabled: true, checked: true, available: true, version: '29.8.2' });
    const request = exec.mock.calls[0]![0] as ExecRequest;
    expect(request).toMatchObject({
      file: 'docker',
      args: ['version', '--format', '{{json .Server.Version}}'],
      cwd: '/workspaces',
    });
    expect(request.env).toEqual(CLIENT_ENV);
    expect(engine.runEnv('emberline-ab12cd34')).toEqual({ ...CLIENT_ENV, EMBERLINE_COMPOSE_PROJECT: 'emberline-ab12cd34' });
  });

  it('an unreachable engine is unavailable with the CLI error, sanitised and short', async () => {
    const message = `Cannot connect to the Docker daemon at tcp://docker:2376. Is the docker daemon running?\u001b[31m\n${'x'.repeat(600)}`;
    const engine = new DockerEngine('tcp://docker:2376', { exec: async () => failed(message) });
    const status = await engine.probe();
    expect(status).toMatchObject({ enabled: true, available: false, version: null });
    expect(status.error).not.toContain('\u001b');
    expect(status.error!.length).toBeLessThanOrEqual(300);
    expect(engine.runEnv('emberline-ab12cd34')).toEqual({});
  });

  it('says so when the runner image has no Docker CLI', async () => {
    const engine = new DockerEngine('tcp://docker:2376', { exec: async () => failed('spawn docker ENOENT\n', 127) });
    expect((await engine.probe()).error).toBe('the runner image has no Docker CLI; rebuild it (make up)');
  });

  it('a runner that is not reachable is an error too, never a throw', async () => {
    const engine = new DockerEngine('tcp://docker:2376', { exec: async () => Promise.reject(new Error('ptyd is not connected')) });
    expect(await engine.probe()).toEqual({ enabled: true, checked: true, available: false, version: null, error: 'ptyd is not connected' });
  });

  it('an answer that is not a version string is an error', async () => {
    const engine = new DockerEngine('tcp://docker:2376', { exec: async () => ok('null\n') });
    expect(await engine.probe()).toMatchObject({ available: false, error: 'unexpected `docker version` output' });
  });

  it('probes at start and every 60 s; a change is reported once', async () => {
    vi.useFakeTimers();
    let answer: ExecResult = ok('"29.8.2"');
    const exec = vi.fn<CommandExecutor>(async () => answer);
    const changes: string[] = [];
    const engine = new DockerEngine('tcp://docker:2376', {
      exec,
      onChange: (s) => changes.push(s.available ? `on ${s.version}` : `off ${s.error}`),
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(engine.status.available).toBe(true);
    await vi.advanceTimersByTimeAsync(DOCKER_PROBE_INTERVAL_MS);
    expect(exec).toHaveBeenCalledTimes(2);
    answer = failed('connection refused');
    await vi.advanceTimersByTimeAsync(DOCKER_PROBE_INTERVAL_MS);
    expect(engine.status).toMatchObject({ available: false, error: 'connection refused' });
    expect(changes).toEqual(['on 29.8.2', 'off connection refused']);
    engine.stop();
    await vi.advanceTimersByTimeAsync(DOCKER_PROBE_INTERVAL_MS * 3);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('ready() waits for the first probe, at most the given time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new DockerEngine('tcp://docker:2376', {
      certPath: CERTS,
      exec: async () => {
        await gate;
        return ok('"29.8.2"');
      },
    });
    const started = Date.now();
    await engine.ready(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(engine.status.checked).toBe(false);
    const waiting = engine.ready(5_000);
    release();
    await waiting;
    expect(engine.status).toMatchObject({ checked: true, available: true });
  });

  it('shares one probe between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exec = vi.fn<CommandExecutor>(async () => {
      await gate;
      return ok('"29.8.2"');
    });
    const engine = new DockerEngine('tcp://docker:2376', { exec });
    const both = Promise.all([engine.probe(), engine.probe()]);
    release();
    await both;
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('Docker engine in core: /api/system, run env, first prompt, worktree.yml commands', () => {
  let t: TestApp;
  let ptydServer: PtydServer;
  let cookie: string;
  /** What the fake `docker version` answers. */
  let dockerAnswer: ExecResult;

  afterEach(async () => {
    setCommandExecutor(localCommandExecutor);
    await ptydServer.close();
    await t.close();
  });

  /**
   * Core with EMBERLINE_DOCKER_HOST set (or not), a ptyd and a fake Claude that leaks its prompt and
   * its Docker variables to files. `docker` itself is faked in the command executor.
   */
  async function start(dockerHost: string | undefined, dockerDelayMs = 0) {
    t = await createTestApp(dockerHost ? { dockerHost, dockerCertPath: CERTS } : {});
    const fake = path.join(t.dir, 'fake-claude.sh');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'last=""; for a in "$@"; do last="$a"; done',
        `printf %s "$last" > "${t.dir}/.prompt-$EMBERLINE_RUN_ID"`,
        `${PRINT_DOCKER_ENV} > "${t.dir}/.docker-$EMBERLINE_RUN_ID"`,
        `mv "${t.dir}/.docker-$EMBERLINE_RUN_ID" "${t.dir}/docker-$EMBERLINE_RUN_ID"`,
        `mv "${t.dir}/.prompt-$EMBERLINE_RUN_ID" "${t.dir}/prompt-$EMBERLINE_RUN_ID"`,
        'read line',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    t.config.claudeCommand = fake;
    dockerAnswer = ok('"29.8.2"\n');
    setCommandExecutor(async (request) => {
      if (request.file !== 'docker') return localCommandExecutor(request);
      if (dockerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, dockerDelayMs));
      return dockerAnswer;
    });
    ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
    cookie = await setupAndLogin(t.app);
  }

  const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

  async function waitFile(file: string): Promise<string> {
    await expect.poll(() => existsSync(file), { timeout: 8_000 }).toBe(true);
    return readFileSync(file, 'utf8');
  }

  async function gitProject(worktreeYml?: string): Promise<{ id: string; path: string }> {
    const { project } = (await api('POST', '/api/projects', { name: 'Shop', initGit: false })).json();
    const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
    git('init', '-q', '-b', 'main');
    if (worktreeYml) {
      execFileSync('mkdir', ['-p', path.join(project.path, '.emberline')]);
      writeFileSync(path.join(project.path, '.emberline/worktree.yml'), worktreeYml);
      git('add', '.emberline/worktree.yml');
    }
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    if (worktreeYml) {
      const { head } = (await api('GET', `/api/projects/${project.id}/worktree-config`)).json();
      expect((await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: head.sha256 })).statusCode).toBe(200);
    }
    return project;
  }

  async function startRun(projectId: string, prompt = 'build it'): Promise<{ run: Run; prompt: string; docker: string }> {
    const run: Run = (await api('POST', '/api/runs', { projectId, prompt })).json();
    const docker = await waitFile(path.join(t.dir, `docker-${run.id}`));
    return { run, prompt: await waitFile(path.join(t.dir, `prompt-${run.id}`)), docker };
  }

  it('off: /api/system says so, and runs get neither the variables nor the paragraph', async () => {
    await start(undefined);
    const system: SystemStatus = (await api('GET', '/api/system')).json();
    expect(system.docker).toEqual({ enabled: false, checked: false, available: false, version: null, reason: 'not_configured' });
    const project = await gitProject();
    const { prompt, docker } = await startRun(project.id);
    expect(docker).toBe(NO_DOCKER);
    expect(prompt).toBe('build it');
  });

  it('on: /api/system reports the version; a run gets DOCKER_HOST, its compose project and one paragraph', async () => {
    await start('tcp://docker:2376');
    await t.runs.docker.probe();
    const system: SystemStatus = (await api('GET', '/api/system')).json();
    expect(system.docker).toEqual({ enabled: true, checked: true, available: true, version: '29.8.2' });
    const project = await gitProject();
    const { run, prompt, docker } = await startRun(project.id);
    expect(docker).toBe(dockerEnvLine(`emberline-${run.id.slice(0, 8)}`));
    expect(prompt).toBe(`build it\n\n${DOCKER_PROMPT_PARAGRAPH}`);
    expect(DOCKER_PROMPT_PARAGRAPH).toContain('$EMBERLINE_COMPOSE_PROJECT');
    // Fixed names would collide between runs sharing the engine.
    expect(DOCKER_PROMPT_PARAGRAPH).toContain('container_name');
    expect(DOCKER_PROMPT_PARAGRAPH).toMatch(/volume or network `name:`/);
  });

  it('unreachable: /api/system carries the error, and runs get no DOCKER_HOST', async () => {
    await start('tcp://docker:2376');
    dockerAnswer = failed('Cannot connect to the Docker daemon at tcp://docker:2376. Is the docker daemon running?');
    await t.runs.docker.probe();
    const system: SystemStatus = (await api('GET', '/api/system')).json();
    expect(system.docker).toEqual({
      enabled: true,
      checked: true,
      available: false,
      version: null,
      error: 'Cannot connect to the Docker daemon at tcp://docker:2376. Is the docker daemon running?',
    });
    const project = await gitProject();
    const { prompt, docker } = await startRun(project.id);
    expect(docker).toBe(NO_DOCKER);
    expect(prompt).toBe('build it');
  });

  it('worktree.yml setup and teardown commands get the Docker variables when the engine is on', async () => {
    await start('tcp://docker:2376');
    await t.runs.docker.probe();
    const log = path.join(t.dir, 'teardown.log');
    const project = await gitProject(
      [
        'version: 1',
        'setup:',
        `  - ${JSON.stringify(`${PRINT_DOCKER_ENV} > setup-env`)}`,
        'teardown:',
        `  - ${JSON.stringify(`${PRINT_DOCKER_ENV} > ${log}`)}`,
        '',
      ].join('\n'),
    );
    const { run } = await startRun(project.id);
    const expected = dockerEnvLine(`emberline-${run.id.slice(0, 8)}`);
    expect(readFileSync(path.join(run.worktreePath, 'setup-env'), 'utf8')).toBe(expected);
    await t.runs.stop(run.id);
    // The terminal's exit is recorded by reconciliation (each prune attempt reconciles first).
    await expect
      .poll(async () => (await api('POST', `/api/runs/${run.id}/worktree/prune`, { force: true })).statusCode, { timeout: 8_000 })
      .not.toBe(409);
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe(expected);
  });

  it('worktree.yml commands get no Docker variables when the engine is off', async () => {
    await start(undefined);
    const project = await gitProject(
      `version: 1\nsetup:\n  - ${JSON.stringify(`${PRINT_DOCKER_ENV} > setup-env`)}\n`,
    );
    const { run } = await startRun(project.id);
    expect(readFileSync(path.join(run.worktreePath, 'setup-env'), 'utf8')).toBe(NO_DOCKER);
  });

  it('a run that starts before the first probe answered waits for it (no run starts without Docker by a race)', async () => {
    await start('tcp://docker:2376', 400);
    expect(t.runs.docker.status.checked).toBe(false);
    const project = await gitProject();
    const { run, docker } = await startRun(project.id);
    expect(docker).toBe(dockerEnvLine(`emberline-${run.id.slice(0, 8)}`));
  });

  it('Build & Verify setup gets the Docker variables: the run\'s project for a run, emberline-main-<id8> for main', async () => {
    await start('tcp://docker:2376');
    await t.runs.docker.probe();
    const project = await gitProject(
      `version: 1\nsetup:\n  - ${JSON.stringify(`${PRINT_DOCKER_ENV} > build-env`)}\nchecks:\n  build: "true"\n`,
    );
    const main = await api('POST', `/api/projects/${project.id}/build-demo`, { targetId: 'main' });
    expect(main.statusCode).toBe(200);
    expect(readFileSync(path.join(project.path, 'build-env'), 'utf8')).toBe(dockerEnvLine(`emberline-main-${project.id.slice(0, 8)}`));

    const { run } = await startRun(project.id);
    rmSync(path.join(run.worktreePath, 'build-env')); // written by the worktree's own setup
    const own = await api('POST', `/api/projects/${project.id}/build-demo`, { targetId: run.id });
    expect(own.statusCode).toBe(200);
    expect(readFileSync(path.join(run.worktreePath, 'build-env'), 'utf8')).toBe(dockerEnvLine(`emberline-${run.id.slice(0, 8)}`));
  });

  it('Build & Verify setup gets no Docker variables when the engine is off', async () => {
    await start(undefined);
    const project = await gitProject(
      `version: 1\nsetup:\n  - ${JSON.stringify(`${PRINT_DOCKER_ENV} > build-env`)}\nchecks:\n  build: "true"\n`,
    );
    expect((await api('POST', `/api/projects/${project.id}/build-demo`, { targetId: 'main' })).statusCode).toBe(200);
    expect(readFileSync(path.join(project.path, 'build-env'), 'utf8')).toBe(NO_DOCKER);
  });
});

describe('buildWorkspaceDemo with a Docker env', () => {
  it('passes it to the setup commands and the approved checks', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'docker-build-'));
    const seen: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      seen.push(request);
      return ok('');
    });
    try {
      const env = { ...CLIENT_ENV, EMBERLINE_COMPOSE_PROJECT: 'emberline-main-c0ffee12' };
      await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws, checks: { build: 'make' }, setup: ['make deps'], env });
      expect(seen.map((r) => r.args[1])).toEqual(['exec 2>&1\nmake deps', 'make']);
      expect(seen[0]!.env).toMatchObject(env);
      expect(seen[1]!.env).toMatchObject({ ...env, CI: 'true' });
    } finally {
      setCommandExecutor(localCommandExecutor);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
