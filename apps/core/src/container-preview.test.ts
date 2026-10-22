import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ContainerPreviewOptionsResponse,
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  type WorktreeConfigStatusResponse,
} from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecRequest,
  type ExecResult,
  localCommandExecutor,
  setCommandExecutor,
} from './command-exec.js';
import { COMPOSE_OVERRIDE_ENV } from './docker/compose.js';
import { ComposeConfigReader, findHeadComposeFile } from './docker/compose-config.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';
import {
  ALREADY_CONTAINER_PREVIEW_TEXT,
  NO_COMPOSE_FILE_TEXT,
  WORKTREE_YML_NOT_APPROVED_TEXT,
} from './worktree-config/container-preview.js';

let t: TestApp;
let cookie: string;
const ok = (stdout: string, stderr = ''): ExecResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  truncated: false,
});
const CONFIG = JSON.stringify({
  services: { db: { expose: ['5432'] }, web: { ports: [{ target: 8080 }], expose: ['9229'] } },
});
const engine = { up: true };
/** What `docker compose config` answers next (a result, or a thrown error), and every request it got. */
const compose: { next: ExecResult | Error; requests: ExecRequest[]; gate: Promise<void> | null } = {
  next: ok(CONFIG),
  requests: [],
  gate: null,
};

beforeEach(async () => {
  engine.up = true;
  compose.next = ok(CONFIG);
  compose.requests = [];
  compose.gate = null;
  setCommandExecutor(async (request) => {
    if (request.file === 'docker' && request.args[0] === 'version') {
      return engine.up ? ok('"29.8.2"\n') : { ...ok(''), exitCode: 1, stderr: 'Cannot connect' };
    }
    if (request.file === 'sh' && request.args.includes('config')) {
      compose.requests.push(request);
      if (compose.next instanceof Error) throw compose.next;
      if (compose.gate) await compose.gate;
      return compose.next;
    }
    return localCommandExecutor(request);
  });
  t = await createTestApp({ dockerHost: 'tcp://docker:2376' });
  await t.runs.docker.probe();
  cookie = await setupAndLogin(t.app);
});
afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  await t.close();
});

const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: authHeaders(cookie) });
const options = async (id: string) =>
  (await api('GET', `/api/projects/${id}/container-preview`)).json() as ContainerPreviewOptionsResponse;
const YML = '.emberline/worktree.yml';
const V1 = 'version: 1\nservices:\n  - name: web\n    command: "pnpm dev --port $PORT"\n    preview: true\n';
const COMPOSE =
  'services:\n  web:\n    build: .\n    ports:\n      - "8080"\n  db:\n    image: postgres:17\n';

/** A git project whose HEAD commits `files`; worktree.yml (if given) is approved. */
async function createProject(files: Record<string, string>, name = 'Shop') {
  const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', project.path, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(project.path, rel)), { recursive: true });
    writeFileSync(path.join(project.path, rel), content);
    git('add', '-f', rel);
  }
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (files[YML] !== undefined) {
    const status = (
      await api('GET', `/api/projects/${project.id}/worktree-config`)
    ).json() as WorktreeConfigStatusResponse;
    expect(
      (
        await api('POST', `/api/projects/${project.id}/worktree-config/approve`, {
          sha256: status.head!.sha256,
        })
      ).statusCode,
    ).toBe(200);
  }
  return { ...(project as { id: string; path: string }), git };
}
const commitAll = (p: { git: (...a: string[]) => string }, message: string) => {
  p.git('add', '-A');
  p.git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', message);
};

describe('GET /api/projects/:id/container-preview', () => {
  it('lists the services and their container ports from HEAD, through one docker compose config in the runner', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    writeFileSync(path.join(p.path, 'compose.yaml'), 'services: {}\n'); // the working tree does not count, HEAD does
    expect(await options(p.id)).toEqual({
      available: true,
      reason: null,
      file: 'compose.yaml',
      services: [
        { name: 'db', ports: [5432] },
        { name: 'web', ports: [8080, 9229] },
      ],
      commandPreview: true,
    });
    expect(compose.requests).toHaveLength(1);
    const [request] = compose.requests;
    expect(request!.cwd).toBe(p.path);
    expect(request!.args).toEqual(
      expect.arrayContaining([
        'compose',
        '--project-directory',
        p.path,
        '-f',
        '-',
        'config',
        '--format',
        'json',
      ]),
    );
    expect(request!.args).not.toContain('--no-interpolate');
    // Only the file and the remote-resource switches travel in the environment: no project or engine variables.
    expect(request!.env).toEqual({
      [COMPOSE_OVERRIDE_ENV]: COMPOSE,
      COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false',
      COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false',
    });
    expect(request!.env![COMPOSE_OVERRIDE_ENV]).toBe(COMPOSE);
    expect(request!.timeoutMs).toBe(15_000);
    expect(request!.maxOutputBytes).toBe(1024 * 1024);
  });

  it('takes the first compose file in the spec order', async () => {
    const p = await createProject({ 'docker-compose.yaml': COMPOSE, 'compose.yml': COMPOSE });
    expect((await options(p.id)).file).toBe('compose.yml');
  });

  it('engine off: not available, the engine reason, no box', async () => {
    await t.close();
    t = await createTestApp(); // no host: not configured
    cookie = await setupAndLogin(t.app);
    const p = await createProject({ 'compose.yaml': COMPOSE });
    expect(await options(p.id)).toEqual({
      available: false,
      reason: DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
      file: null,
      services: [],
      commandPreview: false,
    });
    expect(compose.requests).toHaveLength(0);
  });

  it('engine unreachable: says so', async () => {
    engine.up = false;
    await t.runs.docker.probe();
    const p = await createProject({ 'compose.yaml': COMPOSE });
    const res = await options(p.id);
    expect(res).toMatchObject({ available: false, file: null });
    expect(res.reason).toContain('The Docker engine is not reachable: Cannot connect');
  });

  it('no box without a committed compose file', async () => {
    const p = await createProject({ [YML]: V1 });
    writeFileSync(path.join(p.path, 'compose.yaml'), COMPOSE); // untracked
    expect(await options(p.id)).toEqual({
      available: false,
      reason: NO_COMPOSE_FILE_TEXT,
      file: null,
      services: [],
      commandPreview: true,
    });
  });

  it('no box when the approved worktree.yml already previews a container', async () => {
    const p = await createProject({
      'compose.yaml': COMPOSE,
      [YML]:
        'version: 2\nservices:\n  - name: container\n    compose:\n      service: web\n      port: 8080\n    preview: true\n',
    });
    expect(await options(p.id)).toMatchObject({
      available: false,
      reason: ALREADY_CONTAINER_PREVIEW_TEXT,
      file: null,
      commandPreview: false,
    });
  });

  it('an unapproved HEAD file shows the box with the review reason (Review Focus 1)', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    writeFileSync(path.join(p.path, YML), `${V1}setup:\n  - "true"\n`);
    commitAll(p, 'agent: change worktree.yml');
    expect(await options(p.id)).toEqual({
      available: false,
      reason: WORKTREE_YML_NOT_APPROVED_TEXT,
      file: 'compose.yaml',
      services: [],
      commandPreview: true,
    });
    // A never-approved file counts the same.
    const q = await createProject({ 'compose.yaml': COMPOSE }, 'Other');
    mkdirSync(path.join(q.path, '.emberline'), { recursive: true });
    writeFileSync(path.join(q.path, YML), V1);
    commitAll(q, 'add worktree.yml');
    expect((await options(q.id)).reason).toBe(WORKTREE_YML_NOT_APPROVED_TEXT);
  });

  it('no worktree.yml at all (an imported project): the box can save', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE });
    expect(await options(p.id)).toMatchObject({
      available: true,
      file: 'compose.yaml',
      commandPreview: false,
    });
  });

  it('a compose killed by a signal (out of memory) says so', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE });
    compose.next = { ...ok(''), exitCode: null, signal: 'SIGKILL' };
    expect((await options(p.id)).reason).toBe(
      "Docker Compose couldn't read compose.yaml: docker compose config was stopped by SIGKILL.",
    );
  });

  it('a compose error quotes its first line that is not a warning (Review Focus 3)', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE });
    compose.next = {
      ...ok(''),
      exitCode: 15,
      stderr: 'WARN[0000] The "TAG" variable is not set.\nyaml: line 2: did not find expected key\n',
    };
    expect(await options(p.id)).toMatchObject({
      available: false,
      file: 'compose.yaml',
      reason: "Docker Compose couldn't read compose.yaml: yaml: line 2: did not find expected key.",
      services: [],
    });
  });

  it('a remote include (git or oci://) is not fetched: compose runs with both remote switches off', async () => {
    const remote = `include:\n  - https://github.com/example/stack.git#main:compose.yaml\n  - oci://docker.io/example/stack:1\n${COMPOSE}`;
    const p = await createProject({ 'compose.yaml': remote });
    // What compose 5.6 answers with COMPOSE_EXPERIMENTAL_GIT_REMOTE=false.
    compose.next = {
      ...ok(''),
      exitCode: 1,
      stderr: 'git remote resource is disabled by "COMPOSE_EXPERIMENTAL_GIT_REMOTE"\n',
    };
    expect(await options(p.id)).toMatchObject({
      available: false,
      file: 'compose.yaml',
      reason:
        'Docker Compose couldn\'t read compose.yaml: git remote resource is disabled by "COMPOSE_EXPERIMENTAL_GIT_REMOTE".',
      services: [],
    });
    expect(compose.requests).toHaveLength(1);
    expect(compose.requests[0]!.env).toMatchObject({
      [COMPOSE_OVERRIDE_ENV]: remote,
      COMPOSE_EXPERIMENTAL_GIT_REMOTE: 'false',
      COMPOSE_EXPERIMENTAL_OCI_REMOTE: 'false',
    });
  });

  it('a YAML error names the file instead of compose\'s stdin "-"', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE });
    compose.next = {
      ...ok(''),
      exitCode: 1,
      stderr:
        'failed to parse -: go-yaml load error in parser at L3.C1: did not find expected node content\n',
    };
    expect((await options(p.id)).reason).toBe(
      "Docker Compose couldn't read compose.yaml: failed to parse compose.yaml: go-yaml load error in parser at L3.C1: did not find expected node content.",
    );
  });

  it('warnings next to a good result still list the services', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE });
    compose.next = ok(CONFIG, 'WARN[0000] The "TAG" variable is not set. Defaulting to a blank string.\n');
    expect((await options(p.id)).available).toBe(true);
  });

  it('oversized output, a file over 64 KB, a link and no services each give a reason', async () => {
    const a = await createProject({ 'compose.yaml': COMPOSE }, 'A');
    compose.next = { ...ok(''), truncated: true };
    expect((await options(a.id)).reason).toBe(
      "Docker Compose couldn't read compose.yaml: its configuration is larger than 1 MB.",
    );
    const b = await createProject({ 'compose.yaml': `${COMPOSE}#${'x'.repeat(64 * 1024)}\n` }, 'B');
    const before = compose.requests.length;
    expect((await options(b.id)).reason).toBe(
      "Docker Compose couldn't read compose.yaml: it is larger than 64 KB.",
    );
    expect(compose.requests.length).toBe(before);
    const c = await createProject({ 'real.yaml': COMPOSE }, 'C');
    symlinkSync('real.yaml', path.join(c.path, 'compose.yaml'));
    commitAll(c, 'link');
    expect((await options(c.id)).reason).toBe(
      "Docker Compose couldn't read compose.yaml: it is a symbolic link in HEAD.",
    );
    const d = await createProject({ 'compose.yaml': 'services: {}\n' }, 'D');
    compose.next = ok(JSON.stringify({ services: {} }));
    expect((await options(d.id)).reason).toBe('compose.yaml has no services.');
  });

  describe('cache (Review Focus 4)', () => {
    it('one compose call per HEAD commit, file and .env; concurrent GETs share it', async () => {
      const p = await createProject({ 'compose.yaml': COMPOSE });
      await Promise.all([options(p.id), options(p.id), options(p.id)]);
      expect(compose.requests).toHaveLength(1);
      await options(p.id);
      expect(compose.requests).toHaveLength(1);
      writeFileSync(path.join(p.path, '.env'), 'WEB_PORT=8081\n'); // interpolation input
      await options(p.id);
      expect(compose.requests).toHaveLength(2);
      writeFileSync(path.join(p.path, 'README.md'), 'x\n');
      commitAll(p, 'readme'); // another HEAD commit
      await options(p.id);
      expect(compose.requests).toHaveLength(3);
    });

    it('concurrent reads share one compose call and its timeout; the next read asks again', async () => {
      const p = await createProject({ 'compose.yaml': COMPOSE });
      const head = await findHeadComposeFile(p.path);
      if (head.kind !== 'present') throw new Error('no compose file');
      const reader = new ComposeConfigReader();
      let open!: () => void;
      compose.gate = new Promise((resolve) => (open = resolve));
      compose.next = { ...ok(''), exitCode: null, timedOut: true };
      // All three join in the same tick; the compose call is released only afterwards.
      const reads = [1, 2, 3].map(() => reader.read(p.id, p.path, head.entry));
      open();
      const results = await Promise.all(reads);
      expect(compose.requests).toHaveLength(1);
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
      expect(results[0]).toMatchObject({ ok: false });
      await reader.read(p.id, p.path, head.entry);
      expect(compose.requests).toHaveLength(2);
    });

    it('a file compose cannot read is cached like a good one: no new call until HEAD, the file or .env changes', async () => {
      const p = await createProject({ 'compose.yaml': COMPOSE });
      compose.next = { ...ok(''), exitCode: 15, stderr: 'yaml: line 2: did not find expected key\n' };
      await options(p.id);
      compose.next = ok('not json');
      expect((await options(p.id)).reason).toBe(
        "Docker Compose couldn't read compose.yaml: yaml: line 2: did not find expected key.",
      );
      expect(compose.requests).toHaveLength(1);
      writeFileSync(path.join(p.path, '.env'), 'X=1\n');
      expect((await options(p.id)).reason).toBe(
        "Docker Compose couldn't read compose.yaml: docker compose config printed something unexpected.",
      );
      await options(p.id);
      expect(compose.requests).toHaveLength(2);
    });

    it('a file with a NUL byte is refused without compose, and the answer is cached', async () => {
      const p = await createProject({ 'compose.yaml': `${COMPOSE}#\0\n` });
      expect((await options(p.id)).reason).toBe(
        "Docker Compose couldn't read compose.yaml: it is not a text file.",
      );
      expect((await options(p.id)).reason).toBe(
        "Docker Compose couldn't read compose.yaml: it is not a text file.",
      );
      expect(compose.requests).toHaveLength(0);
    });

    it('a timeout or a runner that cannot run compose is not cached', async () => {
      const p = await createProject({ 'compose.yaml': COMPOSE });
      compose.next = { ...ok(''), exitCode: null, timedOut: true };
      expect((await options(p.id)).reason).toBe(
        "Docker Compose couldn't read compose.yaml: no answer within 15 s.",
      );
      compose.next = new Error('the runner image is older than core');
      expect((await options(p.id)).reason).toBe(
        "Docker Compose couldn't read compose.yaml: the runner image is older than core.",
      );
      compose.next = ok(CONFIG);
      expect((await options(p.id)).available).toBe(true);
      expect(compose.requests).toHaveLength(3);
    });
  });

  it('404 for an unknown project', async () => {
    expect((await api('GET', '/api/projects/nope/container-preview')).statusCode).toBe(404);
  });
});

describe('switching the preview to the container', () => {
  const diff = (id: string, body: object) => api('POST', `/api/projects/${id}/container-preview/diff`, body);
  const use = (id: string, body: object) => api('POST', `/api/projects/${id}/container-preview`, body);
  const CHOICE = { file: 'compose.yaml', service: 'web', port: 8080 };

  it('the diff shows the change from the approved content and the base to save from', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const res = await diff(p.id, CHOICE);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.diff).toContain('-version: 1');
    expect(body.diff).toContain('+version: 2');
    expect(body.diff).toContain('+    preview: false');
    expect(body.diff).toContain('+  - name: container');
    const status = (
      await api('GET', `/api/projects/${p.id}/worktree-config`)
    ).json() as WorktreeConfigStatusResponse;
    expect(body.baseSha256).toBe(status.head!.sha256);
  });

  it("409 when the chosen file is not HEAD's compose file; nothing committed", async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const count = p.git('rev-list', '--count', 'HEAD');
    const res = await use(p.id, { ...CHOICE, file: 'docker-compose.yml', baseSha256: null });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'container_preview_unavailable',
      message: "HEAD's compose file is now compose.yaml. Reload to see it.",
    });
    expect(p.git('rev-list', '--count', 'HEAD')).toBe(count);
  });

  it('the diff refuses an unknown service (400) and an unavailable preview (409)', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    expect((await diff(p.id, { ...CHOICE, service: 'api' })).json()).toMatchObject({
      error: 'container_preview_unknown_service',
    });
    engine.up = false;
    await t.runs.docker.probe();
    const res = await diff(p.id, CHOICE);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('container_preview_unavailable');
  });

  it('saves: one commit on main with the spec message and only worktree.yml, approved; the box goes away', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const { content, baseSha256 } = (await diff(p.id, CHOICE)).json();
    const res = await use(p.id, { ...CHOICE, baseSha256 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      changed: false,
      approved: { content, approvedBy: 'person' },
      head: { content },
    });
    expect(p.git('log', '-1', '--format=%s')).toBe('chore: preview the web container from compose.yaml');
    expect(p.git('show', '--name-only', '--format=', 'HEAD')).toBe(YML);
    expect(await options(p.id)).toMatchObject({
      file: null,
      reason: ALREADY_CONTAINER_PREVIEW_TEXT,
      commandPreview: false,
    });
  });

  it('creates worktree.yml for a project without one', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE });
    const { baseSha256 } = (await diff(p.id, CHOICE)).json();
    expect(baseSha256).toBeNull();
    expect((await use(p.id, { ...CHOICE, baseSha256 })).statusCode).toBe(200);
    expect(p.git('show', `HEAD:${YML}`)).toContain('name: container');
  });

  it('400 for a service that is not in the file; nothing committed', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const count = p.git('rev-list', '--count', 'HEAD');
    const res = await use(p.id, { ...CHOICE, service: 'api', baseSha256: null });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'container_preview_unknown_service',
      message: '"api" is not a service in compose.yaml.',
    });
    expect(p.git('rev-list', '--count', 'HEAD')).toBe(count);
  });

  it('400 with the schema words when the file already has 20 services', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `  - name: s${i}\n    command: "true"\n`).join('');
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: `version: 1\nservices:\n${many}` });
    const res = await diff(p.id, CHOICE);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.join(' ')).toMatch(/services/);
  });

  it('POST refuses while HEAD differs from the approval (Review Focus 1)', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const { baseSha256 } = (await diff(p.id, CHOICE)).json();
    writeFileSync(path.join(p.path, YML), `${V1}teardown:\n  - "true"\n`);
    commitAll(p, 'agent: change worktree.yml');
    const res = await use(p.id, { ...CHOICE, baseSha256 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'container_preview_unavailable',
      message: WORKTREE_YML_NOT_APPROVED_TEXT,
    });
    expect(p.git('log', '-1', '--format=%s')).toBe('agent: change worktree.yml');
  });

  it('409 worktree_config_changed when the base is not the one the diff gave', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const res = await use(p.id, { ...CHOICE, baseSha256: 'f'.repeat(64) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('worktree_config_changed');
  });

  it('409 worktree_config_dirty and main_workspace_detached come through from the save', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const { baseSha256 } = (await diff(p.id, CHOICE)).json();
    writeFileSync(path.join(p.path, YML), `${V1}# mine\n`);
    expect((await use(p.id, { ...CHOICE, baseSha256 })).json().error).toBe('worktree_config_dirty');
    p.git('checkout', '-q', '--', YML);
    p.git('checkout', '-q', '--detach');
    expect((await use(p.id, { ...CHOICE, baseSha256 })).json().error).toBe('main_workspace_detached');
  });

  it('409 container_preview_unavailable when the engine went away', async () => {
    const p = await createProject({ 'compose.yaml': COMPOSE, [YML]: V1 });
    const { baseSha256 } = (await diff(p.id, CHOICE)).json();
    engine.up = false;
    await t.runs.docker.probe();
    expect((await use(p.id, { ...CHOICE, baseSha256 })).json().error).toBe('container_preview_unavailable');
  });
});
