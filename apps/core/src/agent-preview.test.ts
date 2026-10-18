/**
 * QA on its own work (Review Focus 4): a run's `EMBERLINE_DEMO_URL` and the agent's `preview` tool
 * (`POST /api/internal/runs/:id/preview`, hook token) serve the run's own worktree, never main.
 * `docker` and `curl` are faked in the command executor; no real engine is involved.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentPreviewResponse, type Run, type RunDetail } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ExecRequest,
  type ExecResult,
  localCommandCanceller,
  localCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
} from './command-exec.js';
import type { CoreConfig } from './config.js';
import { runs } from './db/schema.js';
import { DemoTokens } from './demo-token.js';
import { COMPOSE_OVERRIDE_ENV } from './docker/compose.js';
import { mainPreviewComposeProjectName, previewComposeProjectName } from './docker/engine.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false });
const failed = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, signal: null, stdout: '', stderr, timedOut: false, truncated: false });

const COMPOSE_V2 = ['version: 2', 'services:', '  - name: site', '    compose: { service: web, port: 80 }', '    preview: true', ''].join('\n');
const PROJECT_COMPOSE = ['services:', '  web:', '    image: nginx:1.29.3-alpine', '    ports: ["8080:80"]', ''].join('\n');

interface DockerCall {
  args: string[];
  cwd: string;
}

/** Just enough of an engine for a compose preview: `up` publishes the port, `ps` and curl answer. */
class FakeEngine {
  available = true;
  calls: DockerCall[] = [];
  projects = new Map<string, string>();
  published = new Map<number, string>();
  upFails: string | null = null;
  upGate: Promise<void> | null = null;
  pendingUps = new Map<string, (result: ExecResult) => void>();

  readonly cancel = async (execId: string): Promise<boolean> => {
    const pending = this.pendingUps.get(execId);
    if (!pending) return false;
    pending({ ...failed('', 137), exitCode: null, cancelled: true });
    return true;
  };

  readonly exec = async (request: ExecRequest): Promise<ExecResult> => {
    if (request.file === 'curl') return ok(this.published.has(Number(new URL(request.args.at(-1) ?? '').port)) ? '200' : '000');
    let args: string[];
    let stdin: string | undefined;
    if (request.file === 'docker') args = request.args;
    else if (request.file === 'sh' && request.args[1]?.includes('exec docker')) {
      args = request.args.slice(3);
      stdin = request.env?.[COMPOSE_OVERRIDE_ENV];
    } else return localCommandExecutor(request);
    if (args[0] === 'version') return this.available ? ok('"29.8.2"\n') : failed('Cannot connect to the Docker daemon');
    this.calls.push({ args, cwd: request.cwd });
    if (args[0] !== 'compose') return ok('');
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
      this.projects.set(project, 'running');
      const port = Number(/"(\d+):\d+"/.exec(stdin ?? '')?.[1]);
      if (port) this.published.set(port, project);
      return ok(' Container web-1 Started\n');
    }
    if (verb === 'ps') {
      const state = this.projects.get(project);
      return ok(state ? JSON.stringify({ Service: 'web', State: state, Health: '', ExitCode: 0 }) : '');
    }
    if (verb === 'logs') return ok('web-1  | npm ci exited 1\n');
    if (verb === 'down') {
      this.projects.delete(project);
      for (const [port, owner] of this.published) if (owner === project) this.published.delete(port);
      return ok();
    }
    return failed(`unexpected docker ${args.join(' ')}`);
  };

  ups(): DockerCall[] {
    return this.calls.filter((c) => c.args[0] === 'compose' && c.args.includes('up'));
  }
}

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
  t = await createTestApp({ ...(dockerHost ? { dockerHost } : {}), hookUrl: 'http://core:7420', ...overrides });
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

const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, ...(method === 'POST' ? { payload: payload ?? {} } : {}), headers: { ...CSRF, cookie } });

/** A git project; `yml` is approved; main gets an untracked static build saying MAIN. */
async function createProject(yml: string | null = COMPOSE_V2, files: Record<string, string> = { 'compose.yaml': PROJECT_COMPOSE }) {
  const { project } = (await api('POST', '/api/projects', { name: 'Shop', initGit: false })).json();
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  if (yml) {
    mkdirSync(path.join(project.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(project.path, '.emberline/worktree.yml'), yml);
  }
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(project.path, file), content);
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (yml) {
    const { head } = (await api('GET', `/api/projects/${project.id}/worktree-config`)).json();
    expect((await api('POST', `/api/projects/${project.id}/worktree-config/approve`, { sha256: head.sha256 })).statusCode).toBe(200);
  }
  writeDemo(project.path, 'MAIN');
  return project as { id: string; path: string };
}

function writeDemo(dir: string, text: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'dist/index.html'), `<!doctype html><title>${text}</title><p>${text}</p>`);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A queued run of the project whose hook token is `token`. */
async function runWithToken(projectId: string, token = 'tok'): Promise<Run> {
  const run = await t.runs.enqueue({ projectId, prompt: 'check it' });
  t.db.update(runs).set({ hookTokenHash: sha256(token) }).where(eq(runs.id, run.id)).run();
  return run;
}

const preview = (runId: string, token: string | null = 'tok', body: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/internal/runs/${runId}/preview`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: body,
  });

async function previewOk(runId: string, body: object = {}): Promise<AgentPreviewResponse> {
  const res = await preview(runId, 'tok', body);
  expect(res.statusCode).toBe(200);
  return AgentPreviewResponse.parse(res.json());
}

/** The demo target a token URL on core names. */
function demoTarget(url: string): { projectId: string; targetId: string } | null {
  const token = /\/api\/demo\/([^/]+)\//.exec(url)?.[1] ?? '';
  return new DemoTokens(t.db).verify(token);
}

describe("EMBERLINE_DEMO_URL is the run's own demo (Review Focus 4)", () => {
  it("points at the run's worktree, not main's, and serves the run's build", async () => {
    await start(null);
    const script = path.join(t.dir, 'env-claude.sh');
    writeFileSync(
      script,
      ['#!/bin/sh', `printf %s "$EMBERLINE_DEMO_URL" > "${t.dir}/.demo-$EMBERLINE_RUN_ID"`, `mv "${t.dir}/.demo-$EMBERLINE_RUN_ID" "${t.dir}/demo-$EMBERLINE_RUN_ID"`, 'while read line; do :; done', ''].join('\n'),
      { mode: 0o755 },
    );
    t.config.claudeCommand = script;
    const p = await createProject(null, {});
    const res = await api('POST', '/api/runs', { projectId: p.id, prompt: 'check it' });
    expect(res.statusCode).toBe(201);
    const run = res.json() as Run;
    writeDemo(run.worktreePath, 'RUN');
    const file = path.join(t.dir, `demo-${run.id}`);
    await expect.poll(() => existsSync(file), { timeout: 8_000 }).toBe(true);
    const url = readFileSync(file, 'utf8');
    expect(url.startsWith('http://core:7420/api/demo/')).toBe(true);
    expect(demoTarget(url)).toEqual({ projectId: p.id, targetId: run.id });
    const page = await t.app.inject({ method: 'GET', url: new URL(url).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('RUN');
    expect(page.body).not.toContain('MAIN');
  });
});

describe('the preview tool endpoint: auth', () => {
  it('needs the run’s own hook token; no session; unknown 404, ended 409; nothing starts', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id, 'tok');
    const other = await runWithToken(p.id, 'other');
    expect((await preview(run.id, null)).statusCode).toBe(401);
    expect((await preview(run.id, 'wrong')).statusCode).toBe(401);
    // Another run's token never acts on this run.
    expect((await preview(run.id, 'other')).statusCode).toBe(401);
    expect((await preview('nope', 'tok')).statusCode).toBe(404);
    t.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, other.id)).run();
    expect((await preview(other.id, 'other')).statusCode).toBe(409);
    expect(engine.ups()).toEqual([]);
    expect((await api('GET', `/api/runs/${run.id}/preview`)).json()).toMatchObject({ status: 'stopped' });
  });

  it('a bad body is 400', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    expect((await preview(run.id, 'tok', { restart: 'yes' })).statusCode).toBe(400);
  });
});

describe('the preview tool endpoint: compose', () => {
  it("starts the run's own container preview, waits until it answers, and returns the runner-side URL", async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    let open!: () => void;
    engine.upGate = new Promise((resolve) => (open = resolve));
    setTimeout(() => open(), 300);
    const answer = await previewOk(run.id);
    expect(answer.status).toBe('running');
    expect(answer.kind).toBe('compose');
    expect(answer.url).toMatch(/^http:\/\/docker:43(2[5-9]|[34]\d)\/$/);
    const ups = engine.ups();
    expect(ups).toHaveLength(1);
    expect(ups[0]!.args[2]).toBe(previewComposeProjectName(run.id));
    expect(ups[0]!.cwd).toBe(run.worktreePath);
    expect(ups.some((c) => c.cwd === p.path || c.args[2] === mainPreviewComposeProjectName(p.id))).toBe(false);
  });

  it('a running preview is reused; restart starts it again, at most once per cooldown', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    const first = await previewOk(run.id);
    expect(first.status).toBe('running');
    expect(await previewOk(run.id)).toEqual(first);
    expect(engine.ups()).toHaveLength(1);
    // Right after the start: the current preview, with a note, and no second `up`.
    const soon = await previewOk(run.id, { restart: true });
    expect(soon).toMatchObject({ status: 'running', kind: 'compose', url: first.url });
    expect(soon.note).toContain('started less than 30 s ago');
    expect(engine.ups()).toHaveLength(1);
    t.runs.agentPreviewCooldownMs = 0;
    expect((await previewOk(run.id, { restart: true })).status).toBe('running');
    expect(engine.ups()).toHaveLength(2);
  });

  it('restart is ignored while a start is still going: the call waits for that start', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    t.runs.agentPreviewCooldownMs = 0;
    t.runs.agentPreviewWaitMs = 200;
    engine.upGate = new Promise(() => undefined);
    expect((await previewOk(run.id)).status).toBe('starting');
    expect((await previewOk(run.id, { restart: true })).status).toBe('starting');
    expect(engine.ups()).toHaveLength(1);
    expect(engine.pendingUps.size).toBe(1);
    await t.runs.stopPreview(run.id);
  });

  it('a failed preview is started again on the next call, but not within the cooldown', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    engine.upFails = 'failed to solve: npm ci exited 1\n';
    expect((await previewOk(run.id)).status).toBe('failed');
    const again = await previewOk(run.id);
    expect(again.status).toBe('failed');
    expect(again.note).toContain('started less than 30 s ago');
    expect(engine.ups()).toHaveLength(1);
    t.runs.agentPreviewCooldownMs = 0;
    expect((await previewOk(run.id)).status).toBe('failed');
    expect(engine.ups()).toHaveLength(2);
  });

  it("the agent's start is recorded as the hook's in the timeline, a person's as the user's", async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    await previewOk(run.id);
    expect((await api('POST', `/api/runs/${run.id}/preview/start`)).statusCode).toBe(200);
    const started = ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.filter((e) => e.type === 'preview_started');
    expect(started.map((e) => e.source).sort()).toEqual(['hook', 'user']);
  });

  it('the body is small: over 1 KB is refused', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    expect((await preview(run.id, 'tok', { restart: false, pad: 'x'.repeat(2048) })).statusCode).toBe(413);
    expect(engine.ups()).toEqual([]);
  });

  it("a failed start gives the error and the logs tail; the URL falls back to the run's static build", async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    engine.upFails = 'failed to solve: npm ci exited 1\n';
    const noBuild = await previewOk(run.id);
    expect(noBuild).toMatchObject({ status: 'failed', kind: 'static', url: null });
    expect(noBuild.error).toContain('docker compose up failed (exit 1)');
    expect(noBuild.logs).toContain('npm ci exited 1');
    writeDemo(run.worktreePath, 'RUN');
    const withBuild = await previewOk(run.id);
    expect(withBuild).toMatchObject({ status: 'failed', kind: 'static' });
    expect(demoTarget(withBuild.url!)).toEqual({ projectId: p.id, targetId: run.id });
  });

  it('the wait is bounded: a start still going answers starting', async () => {
    await start();
    const p = await createProject();
    const run = await runWithToken(p.id);
    t.runs.agentPreviewWaitMs = 200;
    engine.upGate = new Promise(() => undefined);
    const answer = await previewOk(run.id);
    expect(answer).toMatchObject({ status: 'starting', kind: 'static', url: null });
    expect(answer.note).toContain('still starting');
    // A second call waits for the same start instead of starting another.
    expect((await previewOk(run.id)).status).toBe('starting');
    expect(engine.pendingUps.size).toBe(1);
    await t.runs.stopPreview(run.id);
  });
});

describe('the preview tool endpoint: unavailable', () => {
  it('engine off: unavailable with the hint, not an error status; the static build of the run is the URL', async () => {
    await start(null);
    const p = await createProject();
    const run = await runWithToken(p.id);
    writeDemo(run.worktreePath, 'RUN');
    const answer = await previewOk(run.id);
    expect(answer.status).toBe('unavailable');
    expect(answer.error).toContain('enable the Docker engine (COMPOSE_PROFILES=docker)');
    expect(answer.kind).toBe('static');
    expect(demoTarget(answer.url!)).toEqual({ projectId: p.id, targetId: run.id });
    expect(engine.calls).toEqual([]);
  });

  it('no preview service and no dev script: unavailable, and no terminal is started', async () => {
    await start();
    const p = await createProject(null, {});
    const run = await runWithToken(p.id);
    const answer = await previewOk(run.id);
    expect(answer).toMatchObject({ status: 'unavailable', kind: 'static', url: null });
    expect(answer.error).toContain('no preview');
    expect((await api('GET', `/api/runs/${run.id}/preview`)).json()).toMatchObject({ status: 'stopped', terminalId: null });
  });
});

describe('the preview tool endpoint: command', () => {
  it("a command preview runs in the runner: the URL is the runner's localhost", async () => {
    await start(null);
    const p = await createProject(['version: 1', 'services:', '  - name: web', '    command: "sleep 30"', '    preview: true', ''].join('\n'), {});
    const run = await runWithToken(p.id);
    const answer = await previewOk(run.id);
    expect(answer.status).toBe('running');
    expect(answer.kind).toBe('command');
    expect(answer.url).toMatch(/^http:\/\/localhost:43(0\d|1\d|2[0-4])\/$/);
    const started = ((await api('GET', `/api/runs/${run.id}`)).json() as RunDetail).events.find((e) => e.type === 'preview_started');
    expect(started?.source).toBe('hook');
    await t.runs.stopPreview(run.id);
  });
});
