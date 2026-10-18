import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CreateProjectBody,
  type CreateProjectResponse,
  type ProjectPreviewResponse,
  findOption,
  PRESETS,
  PROJECT_TYPES,
  type Ticket,
} from '@emberline/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GitExec from './git-exec.js';
import { projects, projectWorktreeConfig } from './db/schema.js';
import { readProjectSettings } from './db/project-settings.js';
import { APP_TYPE_LABELS, generateProjectBlueprint, generateWorktreeYml } from './factory/blueprint.js';
import { STARTERS } from './factory/starters.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

/** Makes `git init` fail while set (the rest of git keeps working). */
const git = vi.hoisted(() => ({ failInit: false }));
vi.mock('./git-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExec>();
  return {
    ...actual,
    execGitFile: ((args, opts) =>
      git.failInit && args[0] === 'init'
        ? Promise.reject(new Error('git init failed'))
        : actual.execGitFile(args, opts)) as typeof actual.execGitFile,
  };
});

let t: TestApp;
let headers: Record<string, string>;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  headers = { ...CSRF, cookie };
});
afterEach(async () => {
  git.failInit = false;
  vi.restoreAllMocks();
  await t.close();
});

const preview = (payload: CreateProjectBody) =>
  t.app.inject({ method: 'POST', url: '/api/projects/preview', headers, payload });
const create = (payload: CreateProjectBody) => t.app.inject({ method: 'POST', url: '/api/projects', headers, payload });
const read = (p: string, rel: string) => readFileSync(path.join(p, rel), 'utf8');
const ticketsOf = (projectId: string): Ticket[] => t.tickets.list(projectId);

function filesOnDisk(root: string, dir = ''): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .flatMap((e) =>
      e.isDirectory() ? filesOnDisk(root, path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
    .sort();
}

const STATIC: CreateProjectBody = {
  name: 'Bakery Site',
  source: 'new',
  appType: 'static_site',
  presetId: 'static-plain',
  vision: 'A landing page for a small bakery with opening hours and a menu.',
  startFactory: false,
};
const WEB: CreateProjectBody = {
  name: 'Pulse Portal',
  source: 'new',
  appType: 'web_saas',
  presetId: 'web-react-fastify',
  vision: 'Analytics portal.',
  choices: { auth: { other: 'company SSO' }, database: 'agent' },
  startFactory: false,
};
const API: CreateProjectBody = {
  name: 'Orders API',
  source: 'new',
  appType: 'api_service',
  presetId: 'api-ts-fastify',
  vision: 'Order service.',
  choices: { deploy: 'none' },
  startFactory: false,
};

describe('generators', () => {
  it('APP_TYPE_LABELS reads the protocol registry', () => {
    for (const type of PROJECT_TYPES) expect(APP_TYPE_LABELS[type.id]).toBe(type.label);
  });

  it('PROJECT.md has a line for every dimension, incl. auth, deploy and agent-decided items', () => {
    const md = generateProjectBlueprint({
      name: 'X',
      appType: 'web_saas',
      description: 'd',
      choices: { frontend: 'react-vite', backend: 'none', database: 'agent', auth: { other: 'SSO' }, deploy: 'vercel' },
    });
    for (const label of ['Frontend', 'Backend', 'Database', 'Authentication', 'Deploy target', 'Language', 'Styling', 'Testing']) {
      expect(md).toContain(label);
    }
    expect(md).toContain('React + Vite');
    expect(md).toContain('SSO');
    expect(md).toContain('Decided by the agent');
    expect(md).toMatch(/Database[^\n]*decided by the agent/i);
    expect(md).toMatch(/Backend[^\n]*none/i);
  });

  it('worktree.yml comes from the option hints, with a $PORT preview service', () => {
    const yml = generateWorktreeYml({ frontend: 'plain-html' }, undefined);
    expect(yml).toContain('version: 1');
    expect(yml).toContain('python3 -m http.server $PORT --bind 0.0.0.0');
    expect(yml).toContain('preview: true');
    const web = generateWorktreeYml({ frontend: 'react-vite', backend: 'fastify' }, undefined);
    expect(web).toContain('pnpm install --frozen-lockfile');
    expect(web).toContain('build: "pnpm build"');
    expect(web).toContain('lint: "pnpm lint"');
    expect(web).toContain('test: "pnpm test"');
    expect(web).toContain('pnpm dev --port $PORT --host 0.0.0.0');
    expect(generateWorktreeYml({ frontend: 'agent' }, undefined).trim().split('\n').pop()).toBe('version: 1');
  });

  it('the static-plain starter is three small files', () => {
    const files = STARTERS['static-plain']({ name: 'A & B', description: '' });
    expect(Object.keys(files).sort()).toEqual(['index.html', 'script.js', 'styles.css']);
    expect(files['index.html']).toContain('<!doctype html>');
    expect(files['index.html']).toContain('lang="en"');
    expect(files['index.html']).toContain('A &amp; B');
    expect(files['index.html']).toContain('styles.css');
    expect(files['index.html']).toContain('script.js');
  });
});

describe('worktree.yml hints', () => {
  const FRAMEWORK_DIMS = ['frontend', 'backend', 'database', 'testing'] as const;

  it('embedded presets use the framework build, not the language build joined to it', () => {
    const yml = (id: string) => {
      const preset = PRESETS.find((p) => p.id === id)!;
      return generateWorktreeYml({}, preset);
    };
    expect(yml('iot-platformio')).toContain('build: "pio run"');
    expect(yml('iot-platformio')).toContain('test: "pio test -e native"');
    expect(yml('iot-esp-idf')).toContain('build: "idf.py build"');
    expect(yml('iot-esp-idf')).not.toContain('cmake');
    expect(yml('iot-stm32')).toContain('build: "cmake --build build"');
    expect(yml('iot-platformio')).not.toContain('&&');
  });

  it('language hints are only a per-key fallback; testing wins for test', () => {
    const yml = generateWorktreeYml({ language: 'go', frontend: 'agent', backend: 'fastify', testing: 'pytest' }, undefined);
    expect(yml).toContain('test: "pytest"');
    expect(yml).toContain('build: "pnpm build"');
    expect(yml).not.toContain('go build');
    // nothing else supplies lint: the language fills in
    expect(yml).toContain('lint: "pnpm lint"');
    const fallback = generateWorktreeYml({ language: 'go', backend: 'agent' }, undefined);
    expect(fallback).toContain('build: "go build ./..."');
    expect(fallback).toContain('lint: "go vet ./..."');
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))('no check of %s joins a language hint with a framework hint', (_id, preset) => {
    const yml = generateWorktreeYml({}, preset);
    const lang = typeof preset.choices.language === 'string' ? findOption('language', preset.choices.language)?.worktree : undefined;
    for (const key of ['build', 'lint', 'test'] as const) {
      const value = new RegExp(`^ {2}${key}: (.*)$`, 'm').exec(yml)?.[1];
      if (!value) continue;
      const parts = (JSON.parse(value) as string).split(' && ');
      const frameworkParts = new Set(
        FRAMEWORK_DIMS.flatMap((d) => {
          const c = preset.choices[d];
          const h = typeof c === 'string' ? findOption(d, c)?.worktree?.[key] : undefined;
          return h ? [h] : [];
        }),
      );
      const langHint = lang?.[key];
      if (langHint && !frameworkParts.has(langHint)) {
        expect(parts.length === 1 || !parts.includes(langHint), `${preset.id} ${key}: ${value}`).toBe(true);
      }
    }
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))('setup of %s is manifest-guarded', (_id, preset) => {
    const yml = generateWorktreeYml({}, preset);
    for (const m of yml.matchAll(/^ {2}- (".*")$/gm)) {
      const cmd = JSON.parse(m[1]!) as string;
      if (!/install|restore|download|pub get|deps\.get/.test(cmd)) continue;
      expect(cmd, cmd).toMatch(/^(\[ ! -f [\w.]+ \]|\[ -z ".*" \]) \|\| /);
    }
  });

  it('guards setup commands on their manifest and leaves checks bare', () => {
    const yml = generateWorktreeYml({ frontend: 'react-vite', backend: 'fastapi' }, undefined);
    expect(yml).toContain('"[ ! -f package.json ] || pnpm install --frozen-lockfile"');
    expect(yml).toContain('"[ ! -f requirements.txt ] || pip install -r requirements.txt"');
    expect(yml).toContain('build: "pnpm build"');
    const go = generateWorktreeYml({ backend: 'go-http' }, undefined);
    expect(go).toContain('"[ ! -f go.mod ] || go mod download"');
    expect(generateWorktreeYml({ frontend: 'flutter' }, undefined)).toContain('"[ ! -f pubspec.yaml ] || flutter pub get"');
  });

  it('the Bootstrap ticket tells the agent to satisfy, not edit, the checks', async () => {
    const { project } = (await create({ ...WEB, startFactory: false })).json() as CreateProjectResponse;
    const body = ticketsOf(project.id).find((x) => x.title.startsWith('Bootstrap'))?.body ?? '';
    expect(body).toMatch(/build gate runs the approved/i);
    expect(body).toMatch(/approves it in the project banner/i);
    expect(body).toMatch(/build.*lint.*test.*scripts/is);
  });
});

describe('POST /api/projects/preview', () => {
  it('has no side effects', async () => {
    const res = await preview(STATIC);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProjectPreviewResponse;
    expect(body.starterFiles).toEqual(['index.html', 'script.js', 'styles.css']);
    expect(body.projectMd).toContain('Bakery Site');
    expect(t.db.select().from(projects).all()).toHaveLength(0);
    expect(existsSync(path.join(t.config.workspacesDir, 'bakery-site'))).toBe(false);
  });

  it('lists the tickets with stable keys and key-based dependencies', async () => {
    const res = await preview({ ...WEB, startFactory: true });
    const body = res.json() as ProjectPreviewResponse;
    expect(body.tickets.map((x) => x.key)).toEqual(['bootstrap', 'deploy', 'factory']);
    expect(body.tickets[0]).toMatchObject({ persona: 'architect', dependsOn: [] });
    expect(body.tickets[1]).toMatchObject({ dependsOn: ['bootstrap'] });
    expect(body.tickets[2]).toMatchObject({ persona: 'product_owner', dependsOn: ['bootstrap'] });
    expect(body.tickets[2]?.title.startsWith('[Factory]')).toBe(true);
    const noFactory = (await preview({ ...API })).json() as ProjectPreviewResponse;
    expect(noFactory.tickets.map((x) => x.key)).toEqual(['bootstrap']);
  });

  it('echoes gates', async () => {
    const res = await preview({ ...STATIC, gates: { secretGuardGate: false } });
    expect((res.json() as ProjectPreviewResponse).gates).toEqual({ secretGuardGate: false });
  });

  it('rejects unknown presets and choices that do not exist or do not fit the type', async () => {
    expect((await preview({ ...STATIC, presetId: 'nope' })).statusCode).toBe(400);
    const unknown = await preview({ ...STATIC, choices: { frontend: 'not-a-thing' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain('frontend');
    // react-vite does not apply to static_site
    const wrongType = await preview({ ...STATIC, choices: { frontend: 'react-vite' } });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().message).toContain('frontend');
    expect((await preview({ ...STATIC, choices: { database: 'none', auth: 'agent', deploy: { other: 'rsync' } } })).statusCode).toBe(200);
  });
});

const bodyFor = (preset: (typeof PRESETS)[number]): CreateProjectBody => ({
  name: `Proj ${preset.id}`,
  source: 'new',
  appType: preset.type,
  presetId: preset.id,
  vision: 'A thing.',
  startFactory: false,
});

describe.each([
  ['static plain', STATIC],
  ['web app', WEB],
  ['api', API],
  ...PRESETS.map((p) => [`preset ${p.id}`, bodyFor(p)] as const),
] as const)('create v2 (%s)', (_label, body) => {
  it('writes exactly what the preview showed', async () => {
    const pv = (await preview(body)).json() as ProjectPreviewResponse;
    const res = await create(body);
    expect(res.statusCode).toBe(201);
    const { project, terminalId } = res.json() as CreateProjectResponse;
    expect(terminalId).toBeNull();
    expect(read(project.path, 'PROJECT.md')).toBe(pv.projectMd);
    expect(read(project.path, 'CLAUDE.md')).toBe(pv.claudeMd);
    expect(read(project.path, '.emberline/worktree.yml')).toBe(pv.worktreeYml);
    expect(filesOnDisk(project.path)).toEqual(
      ['.emberline/worktree.yml', 'CLAUDE.md', 'PROJECT.md', ...pv.starterFiles].sort(),
    );
    const created = ticketsOf(project.id);
    expect(created.map((x) => x.title).sort()).toEqual(pv.tickets.map((x) => x.title).sort());
    expect(project.appType).toBe(body.appType);
    // committed, so run worktrees branch from it
    expect(existsSync(path.join(project.path, '.git'))).toBe(true);
  });
});

describe('create v2 behaviour', () => {
  it('commits the files and stores the generated worktree.yml as approved', async () => {
    const { project } = (await create(STATIC)).json() as CreateProjectResponse;
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files'], { cwd: project.path, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(tracked.sort()).toEqual(['.emberline/worktree.yml', 'CLAUDE.md', 'PROJECT.md', 'index.html', 'script.js', 'styles.css']);
    const row = t.db.select().from(projectWorktreeConfig).where(eq(projectWorktreeConfig.projectId, project.id)).get();
    const yml = read(project.path, '.emberline/worktree.yml');
    expect(row?.content).toBe(yml);
    expect(row?.sha256).toBe(createHash('sha256').update(yml).digest('hex'));
    expect(row?.approvedBy).toBe('wizard');
    expect(row?.approvedAt).toBeInstanceOf(Date);
  });

  it('stores the wizard gates in project_settings', async () => {
    const { project } = (await create({ ...STATIC, gates: { secretGuardGate: true, antiSlopGate: false } })).json() as CreateProjectResponse;
    expect(readProjectSettings(t.db, project.id).gates).toEqual({ secretGuardGate: true, antiSlopGate: false });
    const { project: p2 } = (await create({ ...STATIC, name: 'Other Site' })).json() as CreateProjectResponse;
    expect(readProjectSettings(t.db, p2.id).gates).toBeUndefined();
  });

  it('serves the static starter through the demo path', async () => {
    const { project } = (await create(STATIC)).json() as CreateProjectResponse;
    const redirect = await t.app.inject({ url: `/api/projects/${project.id}/demo/main/`, headers: { cookie } });
    expect(redirect.statusCode).toBe(302);
    const base = String(redirect.headers.location);
    const html = await t.app.inject({ url: base });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Bakery Site');
    expect((await t.app.inject({ url: `${base}styles.css` })).statusCode).toBe(200);
    expect((await t.app.inject({ url: `${base}script.js` })).statusCode).toBe(200);
  });

  it('with startFactory: Bootstrap ready, Deploy and [Factory] depend on it, chain on, dispatch kicked', async () => {
    const dispatch = vi.spyOn(t.tickets, 'dispatchNextReadyTicket').mockResolvedValue([]);
    const res = await create({ ...WEB, startFactory: true });
    expect(res.statusCode).toBe(201);
    const { project } = res.json() as CreateProjectResponse;
    const list = ticketsOf(project.id);
    const bootstrap = list.find((x) => x.title.startsWith('Bootstrap'));
    const deploy = list.find((x) => x.title.startsWith('Deploy'));
    const factory = list.find((x) => x.title.startsWith('[Factory]'));
    expect(bootstrap).toMatchObject({ status: 'ready', persona: 'architect' });
    expect(bootstrap?.body).toContain('.emberline/worktree.yml');
    expect(bootstrap?.body).toContain('PROJECT.md');
    expect(deploy?.blockedBy.map((b) => b.id)).toEqual([bootstrap?.id]);
    expect(deploy?.body).toMatch(/credentials/i);
    expect(factory?.blockedBy.map((b) => b.id)).toEqual([bootstrap?.id]);
    expect(factory?.persona).toBe('product_owner');
    expect(factory?.body).toContain('Analytics portal.');
    expect(t.tickets.isAutoChainActive(project.id)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(project.id);
  });

  it('defaults startFactory to true for new projects', async () => {
    vi.spyOn(t.tickets, 'dispatchNextReadyTicket').mockResolvedValue([]);
    const { startFactory: _ignored, ...rest } = WEB;
    const { project } = (await create(rest)).json() as CreateProjectResponse;
    expect(t.tickets.isAutoChainActive(project.id)).toBe(true);
    expect(ticketsOf(project.id).some((x) => x.title.startsWith('[Factory]'))).toBe(true);
  });

  it('without startFactory: tickets exist, no [Factory] ticket, nothing dispatches, no chaining', async () => {
    const dispatch = vi.spyOn(t.tickets, 'dispatchNextReadyTicket').mockResolvedValue([]);
    const { project } = (await create(WEB)).json() as CreateProjectResponse;
    const list = ticketsOf(project.id);
    expect(list.map((x) => x.title.split(':')[0]).sort()).toEqual(['Bootstrap', 'Deploy']);
    expect(list.find((x) => x.title.startsWith('Bootstrap'))?.status).toBe('ready');
    expect(t.tickets.isAutoChainActive(project.id)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('no Deploy ticket when deploy is none', async () => {
    const { project } = (await create(API)).json() as CreateProjectResponse;
    expect(ticketsOf(project.id).map((x) => x.title)).toHaveLength(1);
  });

  it('keeps old payloads working: no Bootstrap ticket, no worktree config, old starter tickets', async () => {
    const res = await create({ name: 'Legacy', mode: 'wizard', appType: 'web_saas', description: 'old', seedStarterTickets: true });
    expect(res.statusCode).toBe(201);
    const { project } = res.json() as CreateProjectResponse;
    const list = ticketsOf(project.id);
    expect(list).toHaveLength(4);
    expect(list.some((x) => x.title.startsWith('Bootstrap'))).toBe(false);
    expect(existsSync(path.join(project.path, '.emberline'))).toBe(false);
    expect(t.db.select().from(projectWorktreeConfig).all()).toHaveLength(0);
  });

  it('rejects bad input before touching the disk', async () => {
    const bad = await create({ ...STATIC, choices: { backend: 'bogus' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('backend');
    expect(existsSync(path.join(t.config.workspacesDir, 'bakery-site'))).toBe(false);
    expect((await create(STATIC)).statusCode).toBe(201);
    expect((await create(STATIC)).statusCode).toBe(409);
  });

  it('fails the create and removes the directory when git init fails', async () => {
    git.failInit = true;
    const res = await create(STATIC);
    expect(res.statusCode).toBe(500);
    expect(existsSync(path.join(t.config.workspacesDir, 'bakery-site'))).toBe(false);
    expect(t.db.select().from(projects).all()).toHaveLength(0);
    git.failInit = false;
    expect((await create(STATIC)).statusCode).toBe(201);
  });

  it('a ticket failure after the commit keeps the project and answers 201 with a warning', async () => {
    vi.spyOn(t.tickets, 'create').mockImplementation(() => {
      throw new Error('boom');
    });
    const error = vi.spyOn(t.app.log, 'error');
    // tickets are created after the commit: the project stays, with its config and gates
    const res = await create({ ...STATIC, gates: { antiSlopGate: true } });
    expect(res.statusCode).toBe(201);
    const out = res.json() as CreateProjectResponse;
    expect(out.warning).toMatch(/tickets/i);
    const row = t.db.select().from(projects).get();
    expect(row).toBeDefined();
    expect(out.project.id).toBe(row!.id);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ projectId: row!.id }), expect.any(String));
    expect(t.db.select().from(projectWorktreeConfig).all()).toHaveLength(1);
    expect(readProjectSettings(t.db, row!.id).gates).toEqual({ antiSlopGate: true });
    expect(existsSync(row!.path)).toBe(true);
  });

  it('removes the directory when the database write fails', async () => {
    t.db.run(sql`drop table project_worktree_config`);
    const res = await create(STATIC);
    expect(res.statusCode).toBe(500);
    expect(existsSync(path.join(t.config.workspacesDir, 'bakery-site'))).toBe(false);
    expect(t.db.select().from(projects).all()).toHaveLength(0);
  });

  it('a double submit creates once; the second gets 409', async () => {
    const [a, b] = await Promise.all([create(STATIC), create(STATIC)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(t.db.select().from(projects).all()).toHaveLength(1);
  });

  it('import_url needs a repoUrl', async () => {
    expect((await create({ name: 'Imp', source: 'import_url' })).statusCode).toBe(400);
  });

  it('logs a failed post-create dispatch instead of swallowing it', async () => {
    vi.spyOn(t.tickets, 'dispatchNextReadyTicket').mockRejectedValue(new Error('no runner'));
    const warn = vi.spyOn(t.app.log, 'warn');
    expect((await create({ ...WEB, startFactory: true })).statusCode).toBe(201);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});
