import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CreateProjectBody,
  CreateProjectBody as CreateProjectBodySchema,
  type CreateProjectResponse,
  DOCKER_ENGINE_NOT_CONFIGURED_TEXT,
  DOCKER_ENGINE_OFF_TEXT,
  type DockerEngineStatus,
  type ProjectPreviewResponse,
  findOption,
  getPreset,
  PRESETS,
  PROJECT_TYPES,
  type Ticket,
} from '@emberline/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localCommandExecutor, setCommandExecutor } from './command-exec.js';
import type * as GitExec from './git-exec.js';
import { projects, projectWorktreeConfig } from './db/schema.js';
import { readProjectSettings, readWizardTickets } from './db/project-settings.js';
import { APP_TYPE_LABELS, generateProjectBlueprint, generateWorktreeYml } from './factory/blueprint.js';
import { planNewProject } from './factory/project-plan.js';
import { STARTERS } from './factory/starters.js';
import { parseWorktreeYml } from './worktree-config/load.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

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
  headers = authHeaders(cookie);
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
const AUTO: CreateProjectBody = {
  name: 'Cafe Site',
  source: 'new',
  appType: 'static_site',
  presetId: 'auto-static_site',
  vision: 'A one-page site for a cafe: menu, opening hours and a map.',
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

  it('Auto: PROJECT.md lists every open dimension under "Decided by the agent", with the vision deciding', () => {
    const sectionOf = (type: 'fullstack' | 'static_site') => {
      const md = generateProjectBlueprint({
        name: 'Cafe',
        appType: type,
        description: 'A cafe site.',
        choices: { ...getPreset(`auto-${type}`)!.choices },
      });
      return md.split('### Decided by the agent')[1]?.split('\n---')[0] ?? '';
    };
    const full = sectionOf('fullstack');
    expect(full).toMatch(/vision/i);
    expect(full).toMatch(/one-line reason/i);
    for (const label of ['Frontend', 'Backend', 'Database', 'Authentication', 'Deploy target', 'Language & runtime', 'Styling', 'Testing']) {
      expect(full, label).toContain(`- ${label}:`);
    }
    // a static site has no backend option, so Auto marks it none instead of leaving it open
    const site = sectionOf('static_site');
    expect(site).toContain('- Frontend:');
    expect(site).not.toContain('- Backend:');
  });

  it('a stack with no command hints gives a minimal worktree.yml that passes the strict schema', () => {
    for (const choices of [{}, { ...getPreset('auto-fullstack')!.choices }, { frontend: 'agent', backend: 'none' }]) {
      const yml = generateWorktreeYml(choices, undefined);
      expect(yml.trim().split('\n').pop()).toBe('version: 1');
      const parsed = parseWorktreeYml(yml);
      expect(parsed.ok, yml).toBe(true);
      if (parsed.ok) {
        expect(parsed.config.setup).toEqual([]);
        expect(parsed.config.services).toEqual([]);
        expect(parsed.config.checks).toEqual({});
      }
    }
    for (const preset of PRESETS) expect(parseWorktreeYml(generateWorktreeYml({}, preset)).ok, preset.id).toBe(true);
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

describe('Auto preset', () => {
  it('the Bootstrap ticket chooses from the vision, records reasons and writes the worktree commands for approval', async () => {
    const { project } = (await create(AUTO)).json() as CreateProjectResponse;
    const body = ticketsOf(project.id).find((x) => x.title.startsWith('Bootstrap'))?.body ?? '';
    expect(body).toContain(AUTO.vision!);
    expect(body).toMatch(/choose a stack that fits the vision and the constraints in PROJECT\.md/i);
    expect(body).toMatch(/each choice and a one-line reason in PROJECT\.md/i);
    expect(body).toMatch(/setup.*build.*lint.*test.*preview service.*\.emberline\/worktree\.yml/is);
    expect(body).toMatch(/a person approves the file before Emberline runs those commands/i);
    expect(body).toMatch(/until then runs have no setup/i);
    // there are no generated checks to satisfy, so the ticket does not say "do not edit them"
    expect(body).not.toMatch(/rather than editing the checks/i);
  });

  it('a concrete preset keeps the satisfy-the-checks wording and has no decide section', async () => {
    const { project } = (await create(STATIC)).json() as CreateProjectResponse;
    const body = ticketsOf(project.id).find((x) => x.title.startsWith('Bootstrap'))?.body ?? '';
    expect(body).not.toMatch(/choose a stack that fits the vision/i);
    expect(body).toMatch(/rather than editing the checks/i);
  });

  it('Auto with every dimension filled in by the person gets the satisfy-the-checks steps, not the open ones', async () => {
    const filled = {
      ...AUTO,
      name: 'Filled Auto',
      choices: {
        language: 'javascript', frontend: 'plain-html', backend: 'none', database: 'none',
        auth: 'none', deploy: 'static-hosting', styling: 'plain-css', testing: 'none',
      },
    } as const;
    const { project } = (await create(filled)).json() as CreateProjectResponse;
    const body = ticketsOf(project.id).find((x) => x.title.startsWith('Bootstrap'))?.body ?? '';
    expect(body).not.toContain('## Decide the open choices');
    expect(body).not.toMatch(/commands you write into `\.emberline\/worktree\.yml`/);
    expect(body).toMatch(/make the project satisfy them/i);
  });

  it('caps the vision quoted in the Bootstrap ticket at 2000 characters', async () => {
    const long = `${'A cafe site with a menu. '.repeat(100)}END-MARKER`;
    const { project } = (await create({ ...AUTO, name: 'Long Vision', vision: long })).json() as CreateProjectResponse;
    const body = ticketsOf(project.id).find((x) => x.title.startsWith('Bootstrap'))?.body ?? '';
    const quoted = body.split('### Vision')[1]?.split('## What to do')[0] ?? '';
    expect(quoted).not.toContain('END-MARKER');
    expect(quoted.trim().endsWith('…')).toBe(true);
    expect(quoted.replace(/^> ?/gm, '').trim().length).toBeLessThanOrEqual(2001);
  });

  it('stores the minimal generated worktree.yml as approved by the wizard', async () => {
    const res = await create(AUTO);
    expect(res.statusCode).toBe(201);
    const { project } = res.json() as CreateProjectResponse;
    const yml = read(project.path, '.emberline/worktree.yml');
    expect(parseWorktreeYml(yml).ok).toBe(true);
    const row = t.db.select().from(projectWorktreeConfig).where(eq(projectWorktreeConfig.projectId, project.id)).get();
    expect(row?.content).toBe(yml);
    expect(row?.sha256).toBe(createHash('sha256').update(yml).digest('hex'));
    expect(row?.approvedBy).toBe('wizard');
    expect(read(project.path, 'PROJECT.md')).toContain('### Decided by the agent');
  });

  it('refuses Auto, or three primary dimensions left to the agent, without a 20-character vision', async () => {
    expect((await preview({ ...AUTO, vision: '  too short  ' })).statusCode).toBe(400);
    expect((await create({ ...AUTO, vision: undefined })).statusCode).toBe(400);
    const open3 = { ...STATIC, vision: 'short', choices: { frontend: 'agent', backend: 'agent', database: 'agent' } } as const;
    expect((await preview(open3)).statusCode).toBe(400);
    expect((await preview({ ...open3, vision: AUTO.vision })).statusCode).toBe(200);
    expect((await preview(AUTO)).statusCode).toBe(200);
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
  vision: 'A small thing that people will actually use.',
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
    const dup = await create(STATIC);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('name_taken');
  });

  it('names a leftover folder with the slug directory_exists', async () => {
    mkdirSync(path.join(t.config.workspacesDir, 'bakery-site'), { recursive: true });
    writeFileSync(path.join(t.config.workspacesDir, 'bakery-site', 'stray.txt'), 'x');
    const res = await create(STATIC);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('directory_exists');
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

describe('wizard: compose preview for the Docker Compose deploy target (spec §7)', () => {
  const COMPOSE_WEB: CreateProjectBody = { ...WEB, choices: { auth: 'none', database: 'agent' } };

  it('with the engine: worktree.yml v2 with a compose preview service, the dev command kept as a non-preview service', () => {
    const preset = getPreset('web-react-fastify')!;
    expect(preset.choices.deploy).toBe('docker-compose');
    const yml = generateWorktreeYml({}, preset, { dockerEngine: true });
    const parsed = parseWorktreeYml(yml);
    expect(parsed.ok, yml).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.version).toBe(2);
    expect(parsed.config.services).toEqual([
      { name: 'web', command: 'pnpm dev --port $PORT --host 0.0.0.0' },
      { name: 'container', compose: { file: 'compose.yaml', service: 'web', port: 8080 }, preview: true },
    ]);
    // Setup and checks are the same as in the v1 file.
    const v1 = parseWorktreeYml(generateWorktreeYml({}, preset));
    expect(v1.ok && v1.config.setup).toEqual(parsed.config.setup);
    expect(v1.ok && v1.config.checks).toEqual(parsed.config.checks);
  });

  it('without the engine, or with another deploy target, it stays v1 with the command preview', () => {
    const preset = getPreset('web-react-fastify')!;
    for (const yml of [
      generateWorktreeYml({}, preset),
      generateWorktreeYml({}, preset, { dockerEngine: false }),
      generateWorktreeYml({ deploy: 'vercel' }, preset, { dockerEngine: true }),
    ]) {
      expect(yml).toContain('version: 1');
      expect(yml).not.toContain('compose');
      expect(yml).toContain('preview: true');
    }
  });

  it('every Docker Compose preset gives a valid v2 file with the engine', () => {
    for (const preset of PRESETS.filter((p) => p.choices.deploy === 'docker-compose')) {
      const parsed = parseWorktreeYml(generateWorktreeYml({}, preset, { dockerEngine: true }));
      expect(parsed.ok, preset.id).toBe(true);
      if (parsed.ok) expect(parsed.config.services.filter((s) => s.preview).map((s) => s.name), preset.id).toEqual(['container']);
    }
  });

  const deployBody = (dockerEngine: boolean, body: CreateProjectBody = COMPOSE_WEB) =>
    planNewProject(CreateProjectBodySchema.parse(body), { dockerEngine }).tickets.find((x) => x.key === 'deploy')?.body ?? '';

  it('the Deploy ticket has a Container preview step with the engine (as before)', () => {
    const body = deployBody(true);
    expect(body).toContain('4. **Container preview**: Emberline previews the container');
    expect(body).toContain('service `web` of `compose.yaml`');
    expect(body).toContain('container port 8080');
  });

  it('the Deploy ticket has a Container preview step without the engine; worktree.yml stays v1', () => {
    const plan = planNewProject(CreateProjectBodySchema.parse(COMPOSE_WEB), { dockerEngine: false });
    const body = plan.tickets.find((x) => x.key === 'deploy')?.body ?? '';
    expect(body).toContain(
      '4. **Container preview**: Make `compose.yaml` ready for a container preview: a `web` service that serves the app on container port 8080, no `container_name`, no fixed host ports (Emberline publishes the port itself). Emberline offers to switch the preview to it in Project settings once its Docker engine is on.',
    );
    expect(body).not.toContain('`container` entry');
    expect(plan.worktreeYml).toContain('version: 1');
    expect(plan.worktreeYml).not.toContain('compose');
  });

  it('other deploy targets get no Container preview step', () => {
    for (const dockerEngine of [true, false]) {
      expect(deployBody(dockerEngine, { ...COMPOSE_WEB, choices: { ...COMPOSE_WEB.choices, deploy: 'vercel' } })).not.toContain(
        'Container preview',
      );
    }
  });

  it('no generated file or ticket sets container_name or a fixed host port, for every preset, engine on or off', () => {
    const containerName = /container_name\s*:/;
    // A compose ports item that fixes a host port: `- "8080:80"`, `- 127.0.0.1:8080:80`.
    const hostPort = /^\s*-\s*["']?(?:[\d.]+:)?\d{1,5}:\d{1,5}["']?\s*$/m;
    for (const preset of PRESETS) {
      for (const dockerEngine of [true, false]) {
        const plan = planNewProject(
          CreateProjectBodySchema.parse({
            name: 'Mug Shop',
            source: 'new',
            appType: preset.type,
            presetId: preset.id,
            vision: 'A small shop that sells handmade mugs with a cart and a checkout.',
            startFactory: false,
          }),
          { dockerEngine },
        );
        const texts = [plan.projectMd, plan.claudeMd, plan.worktreeYml, ...Object.values(plan.starter), ...plan.tickets.map((x) => x.body)];
        for (const text of texts) {
          expect(text, `${preset.id} engine=${dockerEngine}`).not.toMatch(containerName);
          expect(text, `${preset.id} engine=${dockerEngine}`).not.toMatch(hostPort);
        }
      }
    }
  });

  describe('through the API', () => {
    const engine = { up: true };
    beforeEach(async () => {
      engine.up = true;
      await t.close();
      t = await createTestApp({ dockerHost: 'tcp://docker:2376' });
      cookie = await setupAndLogin(t.app);
      headers = authHeaders(cookie);
      setCommandExecutor(async (request) =>
        request.file === 'docker' && request.args[0] === 'version'
          ? { exitCode: engine.up ? 0 : 1, signal: null, stdout: engine.up ? '"29.8.2"\n' : '', stderr: engine.up ? '' : 'Cannot connect', timedOut: false, truncated: false }
          : localCommandExecutor(request),
      );
    });
    afterEach(() => setCommandExecutor(localCommandExecutor));

    it('the summary and the created project use v2 while the engine answers; no note', async () => {
      const body = (await preview(COMPOSE_WEB)).json() as ProjectPreviewResponse;
      expect(body.worktreeYml).toContain('version: 2');
      expect(body.notes).toEqual([]);
      const res = await create(COMPOSE_WEB);
      expect(res.statusCode).toBe(201);
      const { project } = res.json() as CreateProjectResponse;
      const onDisk = read(project.path, '.emberline/worktree.yml');
      expect(onDisk).toBe(body.worktreeYml);
      const approved = t.db.select().from(projectWorktreeConfig).where(eq(projectWorktreeConfig.projectId, project.id)).get();
      expect(approved?.content).toBe(onDisk);
      // The Deploy ticket tells the agent what the preview expects from compose.yaml.
      const deploy = ticketsOf(project.id).find((x) => x.title.startsWith('Deploy'))?.body ?? '';
      expect(deploy).toContain('service `web` of `compose.yaml`');
      expect(deploy).toContain('container port 8080');
    });

    it('an unreachable engine gives v1 and the summary says the container preview needs the engine', async () => {
      engine.up = false;
      await t.runs.docker.probe();
      const body = (await preview(COMPOSE_WEB)).json() as ProjectPreviewResponse;
      expect(body.worktreeYml).toContain('version: 1');
      expect(body.notes.join(' ')).toContain('previewing the container needs the Docker engine');
    });
  });

  it('with Docker off the summary notes it only for the Docker Compose deploy target', async () => {
    const notes = ((await preview(COMPOSE_WEB)).json() as ProjectPreviewResponse).notes.join(' ');
    expect(notes).toContain('previewing the container needs the Docker engine');
    // No host and nobody switched it off: an old compose file, not a line in .env.
    expect(notes).toContain(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    expect(((await preview(STATIC)).json() as ProjectPreviewResponse).notes).toEqual([]);
  });

  it('the summary note says why the engine is missing, and waits for it only while it is on', () => {
    const off = { enabled: false, checked: false, available: false, version: null } as const;
    const note = (engine: DockerEngineStatus) => planNewProject(CreateProjectBodySchema.parse(COMPOSE_WEB), { engine }).notes.join(' ');
    const switchedOff = note({ ...off, reason: 'switched_off' });
    expect(switchedOff).toContain(DOCKER_ENGINE_OFF_TEXT);
    expect(switchedOff).not.toContain('Until it answers');
    const notConfigured = note({ ...off, reason: 'not_configured' });
    expect(notConfigured).toContain(DOCKER_ENGINE_NOT_CONFIGURED_TEXT);
    expect(notConfigured).not.toContain('EMBERLINE_DOCKER_ENGINE=0 in .env');
    expect(note({ enabled: true, checked: true, available: false, version: null, error: 'refused' })).toContain('Until it answers');
  });
});

describe('wizard ticket roles', () => {
  const RULE =
    'Do not write `.emberline/new-tickets.json`: the [Factory] ticket plans the feature tickets once this ticket is merged.';

  it('stores Bootstrap and Deploy without a factory ticket when the factory does not start', async () => {
    const { project } = (await create(WEB)).json() as CreateProjectResponse;
    const list = ticketsOf(project.id);
    const id = (prefix: string) => list.find((x) => x.title.startsWith(prefix))?.id;
    expect(readWizardTickets(t.db, project.id)).toEqual({
      bootstrap: id('Bootstrap'),
      deploy: id('Deploy'),
      bootstrapWritesWorktree: false,
    });
  });

  it('stores the [Factory] ticket when the factory starts', async () => {
    vi.spyOn(t.tickets, 'dispatchNextReadyTicket').mockResolvedValue([]);
    const { project } = (await create({ ...WEB, startFactory: true })).json() as CreateProjectResponse;
    const factory = ticketsOf(project.id).find((x) => x.title.startsWith('[Factory]'));
    expect(factory).toBeDefined();
    expect(readWizardTickets(t.db, project.id)?.factory).toBe(factory?.id);
  });

  it('has no deploy key when deploy is none', async () => {
    const { project } = (await create(API)).json() as CreateProjectResponse;
    expect(readWizardTickets(t.db, project.id)).not.toHaveProperty('deploy');
  });

  it('bootstrapWritesWorktree: Auto true, a decided preset false', async () => {
    const auto = (await create(AUTO)).json() as CreateProjectResponse;
    const fixed = (await create(STATIC)).json() as CreateProjectResponse;
    expect(readWizardTickets(t.db, auto.project.id)?.bootstrapWritesWorktree).toBe(true);
    expect(readWizardTickets(t.db, fixed.project.id)?.bootstrapWritesWorktree).toBe(false);
  });

  it('an old-payload project has no wizardTickets', async () => {
    const res = await create({ name: 'Legacy', mode: 'wizard', appType: 'web_saas', description: 'old', seedStarterTickets: true });
    const { project } = res.json() as CreateProjectResponse;
    expect(readWizardTickets(t.db, project.id)).toBeNull();
  });

  it('Bootstrap and Deploy carry the factory-plans rule only when the factory starts with a vision', () => {
    const on = planNewProject(CreateProjectBodySchema.parse({ ...WEB, startFactory: true }));
    const off = planNewProject(CreateProjectBodySchema.parse(WEB));
    expect(on.tickets.map((x) => x.body.includes(RULE))).toEqual([true, true]);
    expect(off.tickets.some((x) => x.body.includes(RULE))).toBe(false);
  });
});
