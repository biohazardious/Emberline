/**
 * The Docker page API (`/api/docker`): inventory, ownership, Stop/Remove/Logs and "Clean up now",
 * with `docker` and `curl` faked in the command executor (a small in-memory engine). Covers the
 * plan's Review Focus 1-5.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  COMPOSE_SERVICE_NAME,
  DOCKER_ENGINE_NOT_ANSWERED_TEXT,
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  DOCKER_ENGINE_OFF_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  DockerCleanupResponse,
  DockerOverview,
  DockerProjectActionResponse,
  DockerProjectLogsResponse,
  type Run,
  type RunPreviewStatus,
} from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecRequest,
  type ExecResult,
  localCommandCanceller,
  localCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
  RUNNER_BIN,
} from './command-exec.js';
import { runEvents, runs } from './db/schema.js';
import { COMPOSE_OVERRIDE_ENV } from './docker/compose.js';
import { composeProjectName, mainComposeProjectName, previewComposeProjectName } from './docker/engine.js';
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
const failed = (stderr: string, exitCode = 1): ExecResult => ({
  exitCode,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false,
  truncated: false,
});

const COMPOSE_V2 = [
  'version: 2',
  'services:',
  '  - name: site',
  '    compose: { service: web, port: 80 }',
  '    preview: true',
  '',
].join('\n');
const PROJECT_COMPOSE = ['services:', '  web:', '    image: nginx:1.29.3-alpine', ''].join('\n');

const DF = [
  { Active: '2', Reclaimable: '1.2GB (50%)', Size: '2.4GB', TotalCount: '5', Type: 'Images' },
  { Active: '1', Reclaimable: '0B (0%)', Size: '12kB', TotalCount: '3', Type: 'Containers' },
  { Active: '0', Reclaimable: '0B', Size: '0B', TotalCount: '0', Type: 'Local Volumes' },
  { Active: '0', Reclaimable: '310MB', Size: '310MB', TotalCount: '12', Type: 'Build Cache' },
]
  .map((row) => JSON.stringify(row))
  .join('\n');

interface DockerCall {
  args: string[];
  env: Record<string, string>;
}

/** An engine in memory: compose projects with their services' states, published ports, the listings. */
class FakeEngine {
  available = true;
  calls: DockerCall[] = [];
  /** project → service → state */
  projects = new Map<string, Map<string, string>>();
  /** published host port → project */
  published = new Map<number, string>();
  /** Replace a listing's output, or fail it. */
  lsResult: ExecResult | null = null;
  psResult: ExecResult | null = null;
  dfResult: ExecResult | null = null;
  failDown = new Set<string>();
  failLogs = false;
  failPrune = false;
  logs = 'web-1  | \u001b[31mready\u001b[0m\n';
  /** While set, the next `compose ls` waits for it. */
  lsGate: Promise<void> | null = null;
  /** While set, `up` waits for it (or for a cancel). */
  upGate: Promise<void> | null = null;
  pendingUps = new Map<string, (result: ExecResult) => void>();
  cancels: string[] = [];

  add(project: string, services: Record<string, string> = { web: 'running' }): void {
    this.projects.set(project, new Map(Object.entries(services)));
  }

  readonly cancel = async (execId: string): Promise<boolean> => {
    this.cancels.push(execId);
    const pending = this.pendingUps.get(execId);
    if (!pending) return false;
    pending({ ...failed('', 137), exitCode: null, cancelled: true });
    return true;
  };

  readonly exec = async (request: ExecRequest): Promise<ExecResult> => {
    if (request.file === RUNNER_BIN.curl) {
      const port = Number(new URL(request.args.at(-1) ?? '').port);
      return ok(this.published.has(port) ? '200' : '000');
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
    this.calls.push({ args, env: request.env ?? {} });
    if (args[0] === 'ps') {
      if (this.psResult) return this.psResult;
      const lines = [...this.projects].flatMap(([project, services]) =>
        [...services].map(([service, state]) => {
          const port = [...this.published].find(([, owner]) => owner === project)?.[0];
          return JSON.stringify({
            ID: `${project}-${service}`,
            Names: `${project}-${service}-1`,
            Image: `${service}:latest`,
            State: state,
            Status: state === 'running' ? 'Up 5 minutes' : 'Exited (0) 1 minute ago',
            Ports: port && service === 'web' ? `0.0.0.0:${port}->80/tcp, [::]:${port}->80/tcp` : '',
            Labels: `com.docker.compose.project=${project},com.docker.compose.service=${service},com.docker.compose.oneoff=False`,
            CreatedAt: '2026-10-18 08:00:00 +0000 UTC',
            RunningFor: '5 minutes ago',
          });
        }),
      );
      return ok(lines.join('\n'));
    }
    if (args[0] === 'system' && args[1] === 'df') return this.dfResult ?? ok(`${DF}\n`);
    if ((args[0] === 'image' || args[0] === 'builder') && args[1] === 'prune')
      return this.failPrune ? failed('prune: disk I/O error') : ok('Total reclaimed space: 0B\n');
    if (args[0] !== 'compose') return failed(`unexpected docker ${args.join(' ')}`);
    if (args[1] === 'ls') {
      const gate = this.lsGate;
      this.lsGate = null;
      if (gate) await gate;
      if (this.lsResult) return this.lsResult;
      return ok(
        JSON.stringify(
          [...this.projects].map(([Name, s]) => ({
            Name,
            Status: `running(${s.size})`,
            ConfigFiles: '/x/compose.yaml',
          })),
        ),
      );
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
        if (cancelled) return cancelled;
      }
      this.add(project);
      const port = Number(/"(\d+):\d+"/.exec(stdin ?? '')?.[1]);
      if (port) this.published.set(port, project);
      return ok(' Container web-1 Started\n');
    }
    if (verb === 'ps') {
      const states = this.projects.get(project) ?? new Map();
      return ok(
        [...states]
          .map(([Service, State]) => JSON.stringify({ Service, State, Health: '', ExitCode: 0 }))
          .join('\n'),
      );
    }
    if (verb === 'logs') return this.failLogs ? failed(`no such project: ${project}`) : ok(this.logs);
    if (verb === 'down') {
      if (this.failDown.has(project)) return failed(`Error response from daemon: ${project} is stuck`);
      this.projects.delete(project);
      for (const [port, owner] of this.published) if (owner === project) this.published.delete(port);
      return ok();
    }
    return failed(`unexpected docker ${args.join(' ')}`);
  };

  downs(): string[][] {
    return this.calls.filter((c) => c.args[0] === 'compose' && c.args.includes('down')).map((c) => c.args);
  }
  count(match: (args: string[]) => boolean): number {
    return this.calls.filter((c) => match(c.args)).length;
  }
}

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;
let engine: FakeEngine;

afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  setCommandCanceller(localCommandCanceller);
  // ptyd first: it ends the sessions in the temp dir that t.close removes.
  await ptydServer.close();
  await t.close();
});

async function start(dockerHost: string | null = 'tcp://docker:2376', dockerEngineSwitchedOff = false) {
  t = await createTestApp({
    ...(dockerHost ? { dockerHost } : {}),
    ...(dockerEngineSwitchedOff ? { dockerEngineSwitchedOff } : {}),
  });
  // An agent that stays alive: a live run stays live for the whole test.
  const fake = path.join(t.dir, 'fake-claude.sh');
  writeFileSync(fake, '#!/bin/sh\nexec sleep 60\n');
  chmodSync(fake, 0o755);
  t.config.claudeCommand = fake;
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

const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({
    method,
    url,
    ...(method === 'POST' ? { payload: payload ?? {} } : {}),
    headers: authHeaders(cookie),
  });
const overview = async () => {
  const res = await api('GET', '/api/docker');
  expect(res.statusCode).toBe(200);
  // The contract Task 2's page reads.
  return DockerOverview.parse(res.json());
};

/** A git project; with `compose: true` it has a compose file and an approved compose preview service. */
async function createProject(name = 'Shop', { compose = false } = {}): Promise<{ id: string; path: string }> {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  if (compose) {
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, '.emberline/worktree.yml'), COMPOSE_V2);
    writeFileSync(path.join(project.path, 'compose.yaml'), PROJECT_COMPOSE);
    git('add', '-A');
  }
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (compose) {
    const { head } = (await api('GET', `/api/projects/${project.id}/worktree-config`)).json();
    expect(
      (await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: head.sha256 }))
        .statusCode,
    ).toBe(200);
  }
  return project;
}

/** A run whose agent is alive (dispatched, not ended). */
async function liveRun(projectId: string, prompt = 'live'): Promise<Run> {
  const run = await t.runs.enqueue({ projectId, prompt });
  await t.scheduler.tick();
  await expect.poll(() => t.runs.getRun(run.id).state, { timeout: 5_000 }).toBe('starting');
  return t.runs.getRun(run.id);
}

async function endedRun(projectId: string): Promise<Run> {
  const run = await t.runs.enqueue({ projectId, prompt: 'x' });
  await t.runs.stop(run.id);
  return t.runs.getRun(run.id);
}

const eventsOf = (id: string) => t.runs.get(id).events;
const typesOf = (id: string) => eventsOf(id).map((e) => e.type);
const preview = async (run: Run) =>
  (await api('GET', `/api/runs/${run.id}/preview`)).json() as RunPreviewStatus;
const downArgs = (project: string, cleanup: boolean) => [
  'compose',
  '-p',
  project,
  'down',
  ...(cleanup ? ['-v', '--rmi', 'local'] : []),
  '--remove-orphans',
];

describe('auth and names (Review Focus 1)', () => {
  it('needs a session, and CSRF for actions', async () => {
    await start();
    expect((await t.app.inject({ method: 'GET', url: '/api/docker' })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/docker/projects/emberline-abcd1234/stop',
      payload: {},
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const cleanupNoCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/docker/cleanup',
      payload: {},
      headers: { cookie },
    });
    expect(cleanupNoCsrf.statusCode).toBe(403);
    const removeNoCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/docker/projects/emberline-abcd1234/remove',
      payload: {},
      headers: { cookie },
    });
    expect(removeNoCsrf.statusCode).toBe(403);
    expect(engine.downs()).toEqual([]);
  });

  it('a name Emberline did not make is 400 for every action and runs no docker command', async () => {
    await start();
    engine.add('emberline');
    engine.add('emberline-verify-docker');
    const names = [
      'emberline',
      'emberline-verify-docker',
      '..',
      '%2e%2e',
      'emberline-abcd1234%20x',
      'emberline-abcd1234%2F..',
      'emberline-ABCD1234',
      'emberline-abcd1234-preview-x',
      'shop',
    ];
    for (const name of names) {
      for (const action of ['stop', 'remove']) {
        const res = await api('POST', `/api/docker/projects/${name}/${action}`);
        expect([400, 404], `${action} ${name}`).toContain(res.statusCode);
      }
      const logs = await api('GET', `/api/docker/projects/${name}/logs`);
      expect([400, 404], `logs ${name}`).toContain(logs.statusCode);
    }
    // The ones the router does reach are 400 by name, not 404.
    expect((await api('POST', '/api/docker/projects/emberline-verify-docker/stop')).statusCode).toBe(400);
    expect((await api('GET', '/api/docker/projects/emberline/logs')).statusCode).toBe(400);
    expect(engine.calls).toEqual([]);
    // And they are never listed.
    expect((await overview()).projects).toEqual([]);
  });
});

describe('engine off', () => {
  const ACTIONS = [
    ['POST', '/api/docker/projects/emberline-abcd1234/stop'],
    ['POST', '/api/docker/projects/emberline-abcd1234/remove'],
    ['GET', '/api/docker/projects/emberline-abcd1234/logs'],
    ['POST', '/api/docker/cleanup'],
  ] as const;

  it('switched off (EMBERLINE_DOCKER_ENGINE=0): the reason and the turn-on hint', async () => {
    await start(null, true);
    expect((await overview()).engine).toMatchObject({ enabled: false, reason: 'switched_off' });
    for (const [method, url] of ACTIONS) {
      const res = await api(method, url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().hint, url).toBe(DOCKER_ENGINE_OFF_TEXT);
    }
  });

  it('enabled but not answered yet: 409 that says so, never "turned off"', async () => {
    await start();
    // The first probe never answers within the wait.
    t.runs.docker.ready = async () => undefined;
    for (const [method, url] of ACTIONS) {
      const res = await api(method, url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().message, url).toContain(DOCKER_ENGINE_NOT_ANSWERED_TEXT);
      expect(res.json().message, url).not.toContain('turned off');
    }
  });

  it('lists nothing with enabled=false; actions are 409 with the hint; no docker command', async () => {
    await start(null);
    expect(await overview()).toMatchObject({
      engine: { enabled: false, available: false, reason: 'not_configured' },
      disk: { rows: [] },
      cleanup: {
        lastSweepAt: null,
        lastSweepRemoved: [],
        lastPruneAt: null,
        lastPruneOkAt: null,
        sweeping: false,
      },
      projects: [],
    });
    for (const [method, url] of [
      ['POST', '/api/docker/projects/emberline-abcd1234/stop'],
      ['POST', '/api/docker/projects/emberline-abcd1234/remove'],
      ['GET', '/api/docker/projects/emberline-abcd1234/logs'],
      ['POST', '/api/docker/cleanup'],
    ] as const) {
      const res = await api(method, url);
      expect(res.statusCode, url).toBe(409);
      // No host and nobody switched it off: an old compose file, not a line in .env.
      expect(res.json().hint, url).toBe(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    }
    expect(engine.calls).toEqual([]);
  });

  it('an engine that does not answer: 200 with its error and empty lists; actions 409', async () => {
    await start();
    engine.available = false;
    await t.runs.docker.probe();
    const o = await overview();
    expect(o).toMatchObject({
      engine: { enabled: true, available: false },
      projects: [],
      disk: { rows: [] },
    });
    expect(o.error).toContain('not reachable');
    for (const [method, url] of [
      ['POST', '/api/docker/projects/emberline-abcd1234/stop'],
      ['POST', '/api/docker/projects/emberline-abcd1234/remove'],
      ['GET', '/api/docker/projects/emberline-abcd1234/logs'],
      ['POST', '/api/docker/cleanup'],
    ] as const) {
      const res = await api(method, url);
      expect(res.statusCode, url).toBe(409);
      // Enabled but not answering: the message offers turning the engine off, no turn-on hint.
      expect(res.json().message, url).toContain('not reachable');
      expect(res.json().message, url).toContain(DOCKER_ENGINE_UNREACHABLE_HINT);
      expect(res.json().hint, url).toBeUndefined();
    }
    expect(engine.calls).toEqual([]);
  });

  it('an engine that came back is listed at the next page load, without waiting for the 60 s probe', async () => {
    await start();
    engine.available = false;
    await t.runs.docker.probe();
    engine.available = true;
    // The last answer is older than the page's 5 s debounce.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6_000);
    let o;
    try {
      o = await overview();
    } finally {
      vi.useRealTimers();
    }
    expect(o.engine.available).toBe(true);
    expect(o.error).toBeUndefined();
  });

  it('an engine that went away is shown as unreachable once its listings fail', async () => {
    await start();
    engine.available = false;
    engine.lsResult = engine.psResult = engine.dfResult = failed('Cannot connect to the Docker daemon');
    const o = await overview();
    expect(o.engine.available).toBe(false);
    expect(o.error).toContain('not reachable');
  });

  it('enabled but not answered yet: the page says so, never "not reachable"', async () => {
    await start();
    t.runs.docker.ready = async () => undefined;
    expect((await overview()).error).toBe(DOCKER_ENGINE_NOT_ANSWERED_TEXT);
  });

  it('a sweep that finds the engine unreachable says so', async () => {
    await start();
    engine.available = false;
    await t.runs.docker.probe();
    expect(await t.runs.sweepDockerProjects()).toEqual({
      removed: [],
      listed: false,
      pruned: false,
      error: 'the Docker engine is not reachable',
    });
  });
});

describe('inventory and ownership (Review Focus 3, 4)', () => {
  it('lists agent, preview, main and leftover projects with their owners, containers, disk and cleanup state', async () => {
    await start();
    const p = await createProject();
    const live = await liveRun(p.id);
    const review = await endedRun(p.id);
    const gone = await endedRun(p.id);
    rmTemp(gone.worktreePath);
    const agent = composeProjectName(live.id, live.worktreePath);
    const reviewPreview = previewComposeProjectName(review.id);
    const main = mainComposeProjectName(p.id);
    const leftover = composeProjectName(gone.id, gone.worktreePath);
    engine.add(agent, { web: 'running', db: 'exited' });
    engine.published.set(4330, agent);
    engine.add(reviewPreview);
    engine.add(main);
    engine.add(leftover);
    engine.add('emberline-main-00000000');
    engine.add('emberline');
    engine.add('emberline-verify-docker');

    const o = await overview();
    expect(o.engine).toMatchObject({ enabled: true, available: true, version: '29.8.2' });
    expect(o.disk.rows.map((r) => r.type)).toEqual(['Images', 'Containers', 'Local Volumes', 'Build Cache']);
    expect(o.disk.rows[0]).toEqual({
      type: 'Images',
      total: '5',
      active: '2',
      size: '2.4GB',
      reclaimable: '1.2GB (50%)',
    });
    expect(o.projectsError).toBeUndefined();
    expect(o.containersError).toBeUndefined();
    expect(o.error).toBeUndefined();
    const byName = new Map(o.projects.map((x) => [x.name, x]));
    expect([...byName.keys()].sort()).toEqual(
      [agent, reviewPreview, main, leftover, 'emberline-main-00000000'].sort(),
    );
    expect(byName.get(agent)).toMatchObject({
      status: 'running(2)',
      stale: false,
      projectId: p.id,
      owner: {
        kind: 'agent',
        runId: live.id,
        projectId: p.id,
        projectName: 'Shop',
        live: true,
        inReview: false,
      },
    });
    expect(byName.get(agent)!.containers).toEqual([
      expect.objectContaining({ service: 'db', state: 'exited', ports: [] }),
      expect.objectContaining({
        service: 'web',
        state: 'running',
        ports: [{ port: 4330, url: 'http://localhost:4330' }],
        image: 'web:latest',
        runningFor: '5 minutes ago',
        name: `${agent}-web-1`,
      }),
    ]);
    expect(byName.get(reviewPreview)).toMatchObject({
      stale: false,
      projectId: p.id,
      owner: { kind: 'preview', runId: review.id, live: false, inReview: true },
    });
    expect(byName.get(main)).toMatchObject({
      stale: false,
      projectId: p.id,
      owner: { kind: 'main', projectId: p.id, projectName: 'Shop' },
    });
    expect(byName.get(leftover)).toMatchObject({ stale: true, projectId: p.id, owner: { kind: 'orphan' } });
    expect(byName.get('emberline-main-00000000')).toMatchObject({ stale: true, owner: { kind: 'orphan' } });
    expect(byName.get('emberline-main-00000000')?.projectId).toBeNull();

    // Stale is exactly what the sweep removes.
    const stale = o.projects.filter((x) => x.stale).map((x) => x.name);
    const { removed } = await t.runs.sweepDockerProjects();
    expect(removed.sort()).toEqual(stale.sort());
  });

  it('a handoff successor in the same worktree owns the shared agent project', async () => {
    await start();
    const p = await createProject();
    const first = await endedRun(p.id);
    const successor = await liveRun(p.id, 'next');
    // Same worktree as the first run (what a handoff does).
    t.db.update(runs).set({ worktreePath: first.worktreePath }).where(eq(runs.id, successor.id)).run();
    const shared = composeProjectName(first.id, first.worktreePath);
    expect(composeProjectName(successor.id, first.worktreePath)).toBe(shared);
    engine.add(shared);
    const [project] = (await overview()).projects;
    expect(project).toMatchObject({
      name: shared,
      stale: false,
      projectId: p.id,
      owner: { kind: 'agent', runId: successor.id, live: true },
    });
  });

  it("a failed or garbled listing is a partial page with that part's error, never a 500", async () => {
    await start();
    engine.add('emberline-deadbeef');
    engine.psResult = ok('<html>not json</html>\n');
    engine.dfResult = failed('Cannot connect to the Docker daemon at tcp://docker:2376');
    let o = await overview();
    expect(o.projects.map((x) => x.name)).toEqual(['emberline-deadbeef']);
    expect(o.projects[0]!.containers).toEqual([]);
    expect(o.containersError).toContain('docker ps');
    expect(o.disk).toMatchObject({
      rows: [],
      error: expect.stringContaining('Cannot connect to the Docker daemon'),
    });

    engine.psResult = null;
    engine.dfResult = ok('garbage');
    engine.lsResult = failed('compose: boom');
    o = await overview();
    expect(o.projectsError).toContain('docker compose ls failed');
    // Projects still come from the containers' labels.
    expect(o.projects.map((x) => [x.name, x.status, x.containers.length])).toEqual([
      ['emberline-deadbeef', null, 1],
    ]);
    expect(o.disk.error).toContain('system df');

    engine.lsResult = ok('{"not":"an array"}');
    expect((await overview()).projectsError).toContain('compose ls');
  });
});

describe('published port links', () => {
  const portsOf = (o: DockerOverview, name: string) =>
    o.projects.find((x) => x.name === name)!.containers.flatMap((c) => c.ports);
  const overviewFrom = async (host: string) => {
    const res = await t.app.inject({ method: 'GET', url: '/api/docker', headers: { cookie, host } });
    expect(res.statusCode).toBe(200);
    return DockerOverview.parse(res.json());
  };

  it('links a port of the compose preview range on the host the page was opened by; other ports are not published', async () => {
    await start();
    engine.add('emberline-deadbeef');
    engine.published.set(4330, 'emberline-deadbeef');
    engine.add('emberline-main-00000000');
    engine.published.set(8080, 'emberline-main-00000000');
    engine.add('emberline-feedf00d');
    // The runner's range is published by the runner, not by the engine.
    engine.published.set(4300, 'emberline-feedf00d');
    const o = await overviewFrom('192.168.1.21:7420');
    expect(portsOf(o, 'emberline-deadbeef')).toEqual([{ port: 4330, url: 'http://192.168.1.21:4330' }]);
    expect(portsOf(o, 'emberline-main-00000000')).toEqual([{ port: 8080, url: null }]);
    expect(portsOf(o, 'emberline-feedf00d')).toEqual([{ port: 4300, url: null }]);
  });

  it('EMBERLINE_PREVIEW_HOST overrides the host, as for previews', async () => {
    await start();
    engine.add('emberline-deadbeef');
    engine.published.set(4349, 'emberline-deadbeef');
    vi.stubEnv('EMBERLINE_PREVIEW_HOST', 'https://previews.example.net/');
    try {
      expect(portsOf(await overviewFrom('192.168.1.21:7420'), 'emberline-deadbeef')).toEqual([
        { port: 4349, url: 'https://previews.example.net:4349' },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('stop and remove', () => {
  it('a leftover can only be removed: Stop is 409 with a hint and runs no down', async () => {
    await start();
    engine.add('emberline-deadbeef');
    const res = await api('POST', '/api/docker/projects/emberline-deadbeef/stop');
    expect(res.statusCode).toBe(409);
    expect(res.json().hint).toBe(
      'use Remove: a stopped leftover keeps its volumes and the cleanup can no longer find it',
    );
    expect(engine.downs()).toEqual([]);
    expect(engine.projects.has('emberline-deadbeef')).toBe(true);
  });

  it("stopping a live agent's project: down without volumes, a note on the run, a warning; the run's state is unchanged", async () => {
    await start();
    const p = await createProject();
    const live = await liveRun(p.id);
    const before = t.runs.getRun(live.id).state;
    const name = composeProjectName(live.id, live.worktreePath);
    engine.add(name);
    const res = await api('POST', `/api/docker/projects/${name}/stop`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      project: name,
      action: 'stop',
      owner: { kind: 'agent', runId: live.id },
    });
    expect(DockerProjectActionResponse.parse(res.json()).warning).toContain('is running and may be using it');
    expect(engine.downs()).toEqual([downArgs(name, false)]);
    const note = eventsOf(live.id).find((e) => e.type === 'docker_project_stopped');
    expect(note?.payload).toEqual({ project: name, by: 'person' });
    expect(t.runs.getRun(live.id).state).toBe(before);
  });

  it('removing an agent project: CLEANUP_DOWN and docker_project_removed', async () => {
    await start();
    const p = await createProject();
    const review = await endedRun(p.id);
    const name = composeProjectName(review.id, review.worktreePath);
    engine.add(name);
    const res = await api('POST', `/api/docker/projects/${name}/remove`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      action: 'remove',
      warning: null,
      owner: { kind: 'agent', inReview: true },
    });
    expect(engine.downs()).toEqual([downArgs(name, true)]);
    expect(eventsOf(review.id).find((e) => e.type === 'docker_project_removed')?.payload).toEqual({
      project: name,
      by: 'person',
    });
    expect(t.runs.getRun(review.id).state).toBe(review.state);
  });

  it('a leftover and a main project are taken down without any run note', async () => {
    await start();
    const p = await createProject();
    const main = mainComposeProjectName(p.id);
    engine.add(main);
    engine.add('emberline-deadbeef');
    expect((await api('POST', `/api/docker/projects/${main}/stop`)).json()).toMatchObject({
      owner: { kind: 'main', projectId: p.id },
    });
    expect((await api('POST', '/api/docker/projects/emberline-deadbeef/remove')).json()).toMatchObject({
      owner: { kind: 'orphan' },
    });
    expect(engine.downs()).toEqual([downArgs(main, false), downArgs('emberline-deadbeef', true)]);
  });

  it('a run note that cannot be recorded for another reason than a removed run is logged; the action stands', async () => {
    await start();
    const warn = vi.fn();
    t.runs.setLogger({ warn });
    const p = await createProject();
    const review = await endedRun(p.id);
    const name = composeProjectName(review.id, review.worktreePath);
    engine.add(name);
    const internals = t.runs as unknown as { record: (...args: unknown[]) => unknown };
    const original = internals.record.bind(t.runs);
    vi.spyOn(internals, 'record').mockImplementation((id: unknown, event: unknown) => {
      if ((event as { type: string }).type === 'docker_project_stopped')
        throw new Error('SQLITE_FULL: database or disk is full');
      return original(id, event);
    });
    const res = await api('POST', `/api/docker/projects/${name}/stop`);
    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: review.id,
        project: name,
        error: expect.stringContaining('SQLITE_FULL'),
      }),
      expect.any(String),
    );
  });

  it('a failed down is 502 with the output tail', async () => {
    await start();
    engine.add('emberline-deadbeef');
    engine.failDown.add('emberline-deadbeef');
    const res = await api('POST', '/api/docker/projects/emberline-deadbeef/remove');
    expect(res.statusCode).toBe(502);
    expect(res.json().output).toContain('emberline-deadbeef is stuck');
  });
});

describe("preview projects go through the run's preview stop (Review Focus 2)", () => {
  async function runningPreview(): Promise<{ run: Run; name: string }> {
    const p = await createProject('Site', { compose: true });
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    expect((await api('POST', `/api/runs/${run.id}/preview/start`)).statusCode).toBe(200);
    await expect.poll(async () => (await preview(run)).status, { timeout: 5_000 }).toBe('running');
    return { run, name: previewComposeProjectName(run.id) };
  }

  it('Stop records preview_stopped (the port is free again) and docker_project_stopped; volumes stay', async () => {
    await start();
    const { run, name } = await runningPreview();
    const res = await api('POST', `/api/docker/projects/${name}/stop`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owner: { kind: 'preview', runId: run.id }, warning: null });
    const types = typesOf(run.id);
    expect(types).toContain('preview_stopped');
    expect(types).toContain('docker_project_stopped');
    expect(await preview(run)).toMatchObject({ status: 'stopped', port: null, error: null });
    expect(engine.projects.has(name)).toBe(false);
    expect(engine.published.size).toBe(0);
    // The run's preview stop took it down; no second down.
    expect(engine.downs()).toEqual([downArgs(name, false)]);
  });

  it('Remove stops the preview through the run first, then CLEANUP_DOWN', async () => {
    await start();
    const { run, name } = await runningPreview();
    const res = await api('POST', `/api/docker/projects/${name}/remove`);
    expect(res.statusCode).toBe(200);
    const types = typesOf(run.id);
    expect(types).toContain('preview_stopped');
    expect(types).toContain('docker_project_removed');
    expect(types.indexOf('preview_stopped')).toBeLessThan(types.indexOf('docker_project_removed')); // oldest first
    expect(engine.downs()).toEqual([downArgs(name, true)]);
    expect((await preview(run)).status).toBe('stopped');
  });

  it('a run that never started a preview, or whose last preview was a command (or a legacy one without a kind): no preview_stopped, one down', async () => {
    await start();
    const p = await createProject();
    const none = await endedRun(p.id);
    const command = await endedRun(p.id);
    const legacy = await endedRun(p.id);
    const started = (runId: string, payload: object) =>
      t.db
        .insert(runEvents)
        .values({ runId, ts: new Date(), source: 'user', type: 'preview_started', payload })
        .run();
    started(command.id, { kind: 'command', terminalId: null, command: 'npm run dev', port: 4301 });
    started(legacy.id, { terminalId: null, command: 'npm run dev', port: 4302 });
    for (const run of [none, command, legacy]) {
      const name = previewComposeProjectName(run.id);
      engine.add(name);
      const res = await api('POST', `/api/docker/projects/${name}/stop`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ owner: { kind: 'preview', runId: run.id } });
      expect(typesOf(run.id)).not.toContain('preview_stopped');
      expect(typesOf(run.id)).toContain('docker_project_stopped');
    }
    expect(engine.downs()).toEqual(
      [none, command, legacy].map((r) => downArgs(previewComposeProjectName(r.id), false)),
    );
  });

  it('a Stop while the preview is still starting cancels the start under the run lock; no "restarted" status', async () => {
    await start();
    const p = await createProject('Site', { compose: true });
    const run = await t.runs.enqueue({ projectId: p.id, prompt: 'x' });
    let open!: () => void;
    engine.upGate = new Promise((resolve) => (open = resolve));
    expect((await api('POST', `/api/runs/${run.id}/preview/start`)).statusCode).toBe(200);
    await expect.poll(() => engine.pendingUps.size).toBe(1);
    const name = previewComposeProjectName(run.id);
    const stopping = api('POST', `/api/docker/projects/${name}/stop`);
    const seen: string[] = [];
    for (let i = 0; engine.cancels.length === 0 && i < 400; i++) {
      const s = await preview(run);
      seen.push(`${s.status}:${s.error ?? ''}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await stopping).statusCode).toBe(200);
    open();
    expect(seen.every((s) => !s.includes('restarted'))).toBe(true);
    expect(await preview(run)).toMatchObject({ status: 'stopped', error: null });
    expect(typesOf(run.id)).toContain('preview_stopped');
    expect(engine.projects.has(name)).toBe(false);
  });
});

describe('logs', () => {
  it('every service, or one; sanitised and at most 2000 chars', async () => {
    await start();
    engine.add('emberline-deadbeef');
    let res = await api('GET', '/api/docker/projects/emberline-deadbeef/logs');
    expect(res.statusCode).toBe(200);
    expect(DockerProjectLogsResponse.parse(res.json())).toEqual({
      project: 'emberline-deadbeef',
      service: null,
      logs: 'web-1  | ready',
    });
    expect(engine.calls.at(-1)!.args).toEqual([
      'compose',
      '-p',
      'emberline-deadbeef',
      'logs',
      '--no-color',
      '--tail',
      '200',
    ]);

    engine.logs = `${'x'.repeat(5000)}\u0007end\n`;
    res = await api('GET', '/api/docker/projects/emberline-deadbeef/logs?service=web');
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('web');
    expect(res.json().logs.length).toBeLessThanOrEqual(2000);
    expect(res.json().logs.endsWith('xend')).toBe(true);
    expect(engine.calls.at(-1)!.args).toEqual([
      'compose',
      '-p',
      'emberline-deadbeef',
      'logs',
      '--no-color',
      '--tail',
      '200',
      '--',
      'web',
    ]);
  });

  it('a failed `compose logs` is 502 with the output tail', async () => {
    await start();
    engine.failLogs = true;
    const res = await api('GET', '/api/docker/projects/emberline-deadbeef/logs');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: 'docker_failed',
      output: expect.stringContaining('no such project: emberline-deadbeef'),
    });
  });

  it('a repeated `service` is 400', async () => {
    await start();
    const res = await api('GET', '/api/docker/projects/emberline-deadbeef/logs?service=web&service=db');
    expect(res.statusCode).toBe(400);
    expect(engine.calls).toEqual([]);
  });

  it("a service that is not a service name is 400 (the protocol's compose service rule)", async () => {
    await start();
    expect(COMPOSE_SERVICE_NAME.test('web.1_a-b')).toBe(true);
    expect(COMPOSE_SERVICE_NAME.test('-web')).toBe(false);
    for (const service of ['--rm', 'a b', '../x', '']) {
      const res = await api(
        'GET',
        `/api/docker/projects/emberline-deadbeef/logs?service=${encodeURIComponent(service)}`,
      );
      expect(res.statusCode, service).toBe(service === '' ? 200 : 400);
    }
  });
});

describe('Clean up now (Review Focus 5)', () => {
  it('runs the sweep and the image prune even right after a scheduled one; the page shows the result', async () => {
    await start();
    await t.runs.sweepDockerProjects();
    const prunes = () => engine.count((a) => a[1] === 'prune');
    expect(prunes()).toBe(2);
    engine.add('emberline-deadbeef');
    const res = await api('POST', '/api/docker/cleanup');
    expect(res.statusCode).toBe(200);
    expect(DockerCleanupResponse.parse(res.json())).toEqual({
      removed: ['emberline-deadbeef'],
      listed: true,
      pruned: true,
    });
    expect(prunes()).toBe(4);
    const { cleanup } = await overview();
    expect(cleanup).toMatchObject({ lastSweepRemoved: ['emberline-deadbeef'], sweeping: false });
    expect(cleanup.lastSweepAt).not.toBeNull();
    expect(cleanup.lastPruneAt).not.toBeNull();
    expect(cleanup.lastPruneOkAt).toBe(cleanup.lastPruneAt);
  });

  it('a failed prune moves the last attempt, not the last successful prune', async () => {
    await start();
    await t.runs.sweepDockerProjects(Date.parse('2026-10-18T08:00:00Z'));
    engine.failPrune = true;
    expect(
      await t.runs.sweepDockerProjects(Date.parse('2026-10-18T09:00:00Z'), { forcePrune: true }),
    ).toMatchObject({
      pruned: false,
    });
    expect((await overview()).cleanup).toMatchObject({
      lastPruneAt: '2026-10-18T09:00:00.000Z',
      lastPruneOkAt: '2026-10-18T08:00:00.000Z',
    });
  });

  it('a failed listing still runs the forced prune and says so: 200, listed false, with the error', async () => {
    await start();
    engine.lsResult = failed('compose: boom');
    const res = await api('POST', '/api/docker/cleanup');
    expect(res.statusCode).toBe(200);
    const body = DockerCleanupResponse.parse(res.json());
    expect(body).toMatchObject({ removed: [], listed: false, pruned: true });
    expect(body.error).toContain('compose: boom');
    expect(engine.count((a) => a[1] === 'prune')).toBe(2);
    expect(engine.downs()).toEqual([]);
  });

  it('409 while a sweep runs; it never starts a second one', async () => {
    await start();
    let open!: () => void;
    engine.lsGate = new Promise((resolve) => (open = resolve));
    const scheduled = t.runs.sweepDockerProjects();
    await expect.poll(() => engine.count((a) => a[1] === 'ls')).toBe(1);
    expect((await overview()).cleanup.sweeping).toBe(true);
    const res = await api('POST', '/api/docker/cleanup');
    expect(res.statusCode).toBe(409);
    open();
    await scheduled;
    expect(engine.count((a) => a[1] === 'ls')).toBe(2); // the sweep's and the overview's
  });
});
