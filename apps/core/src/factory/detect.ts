/**
 * Detection for an imported repository: project type, stack choices, the commands its worktrees
 * need and which Emberline files it already has. It only reads files; it never runs project code
 * (no install, no script, no build) and starts no process at all.
 *
 * Everything is read without following links: manifests go through the no-follow descriptor reads
 * of outputs/safe-fs.ts, the Emberline files are also looked up in HEAD (hardened `git ls-tree` /
 * `cat-file`, the only processes detection starts), and the existing helpers that read by name (`inspectWorkspaceProject`,
 * `planGateSteps`, `detectPreviewCommand`) only run when the manifests they read are plain files.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  ADOPT_FILE_PATHS,
  type AdoptWriteFile,
  type ExistingWorktreeYml,
  findOption,
  MAX_WORKTREE_YML_BYTES,
  type Project,
  type ProjectAppType,
  type ProjectChoices,
  type ProjectDetectResponse,
  STACK_DIMENSION_IDS,
  type StackChoice,
  type StackDimensionId,
} from '@emberline/protocol';
import { conflict } from '../errors.js';
import { execGitFile, UnsafeGitConfigError } from '../git-exec.js';
import { isMissing, openFileUnder, realDirUnder, UnsafePathError } from '../outputs/safe-fs.js';
import { detectPreviewCommand } from '../runs/preview-command.js';
import { parseWorktreeYml } from '../worktree-config/load.js';
import { generateClaudeInstructions, generateProjectBlueprint, renderWorktreeYml } from './blueprint.js';
import { planGateSteps } from './demo.js';
import { collectWorkspaceFiles, inspectWorkspaceProject } from './workspace-status.js';

export type DetectedCommands = ProjectDetectResponse['detected']['commands'];

/** Manifests the name-based helpers read; each must be a plain file before they run. */
const MANIFESTS = ['package.json', 'platformio.ini'] as const;
const MAX_MANIFEST_BYTES = 1024 * 1024;

type SafeRead = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unsafe'; reason: string };

/** Reads `rel` under the project through a verified, no-follow descriptor, refusing files over `max` bytes. */
async function readUnder(workspacesDir: string, projectPath: string, rel: string, max: number): Promise<SafeRead> {
  let opened;
  try {
    opened = await openFileUnder(workspacesDir, projectPath, rel);
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' };
    if (error instanceof UnsafePathError) return { kind: 'unsafe', reason: error.message.replace(projectPath + path.sep, '') };
    throw error;
  }
  try {
    if (opened.size > max) return { kind: 'unsafe', reason: `${rel} is larger than ${Math.round(max / 1024)} KB` };
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await opened.handle.read(buffer, 0, opened.size, 0);
    return { kind: 'ok', text: buffer.subarray(0, bytesRead).toString('utf8') };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** True when anything (a file, a directory or a link) has this name. */
async function entryExists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** One entry of HEAD's tree (`git ls-tree -l`). */
interface HeadEntry {
  mode: string;
  type: string;
  oid: string;
  size: number | null;
}

/** Files of interest as committed in HEAD; empty when there is no git or no commit yet. */
async function headEntries(dir: string, paths: readonly string[]): Promise<Map<string, HeadEntry>> {
  const entries = new Map<string, HeadEntry>();
  if (!(await entryExists(path.join(dir, '.git')))) return entries;
  let stdout: string;
  try {
    // Hardened git (git-exec.ts): reads the tree only; no filter, textconv or hook can run.
    stdout = (await execGitFile(['ls-tree', '-l', '-z', 'HEAD', '--', ...paths], { cwd: dir })).stdout;
  } catch (error) {
    if (error instanceof UnsafeGitConfigError) throw conflict(error.message);
    return entries; // no commit yet
  }
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', type = '', oid = '', size = ''] = record.slice(0, tab).split(/\s+/);
    entries.set(record.slice(tab + 1), { mode, type, oid, size: /^\d+$/.test(size) ? Number(size) : null });
  }
  return entries;
}

/**
 * The repo's worktree.yml as committed in HEAD: the only version that can be approved (runs branch
 * from HEAD, and an uncommitted edit is nobody's reviewed content). The 64 KB cap is checked on the
 * tree's size before the blob is read; `cat-file blob` applies no textconv or filter.
 */
async function headWorktreeYml(
  dir: string,
  entry: HeadEntry | undefined,
  workingTree: SafeRead,
  git: GitReadOptions = {},
): Promise<ExistingWorktreeYml | null> {
  const rel = ADOPT_FILE_PATHS.worktreeYml;
  if (!entry) {
    if (workingTree.kind === 'missing') return null;
    return {
      content: null,
      sha256: null,
      errors: [`${rel} is not committed: commit it, then review it again`],
      notCommitted: true,
      workingTreeDiffers: true,
    };
  }
  const fail = (message: string): ExistingWorktreeYml => ({
    content: null,
    sha256: null,
    errors: [message],
    notCommitted: false,
    workingTreeDiffers: true,
  });
  if (entry.mode === '120000') return fail(`${rel} is a symbolic link in HEAD`);
  if (entry.type !== 'blob' || !/^[0-9a-f]{40,64}$/.test(entry.oid)) return fail(`${rel} is not a file in HEAD`);
  if (entry.size === null || entry.size > MAX_WORKTREE_YML_BYTES) {
    return fail(`${rel} is larger than ${MAX_WORKTREE_YML_BYTES / 1024} KB`);
  }
  const blob = await execGitFile([...(git.args ?? []), 'cat-file', 'blob', entry.oid], {
    cwd: dir,
    env: git.env,
    encoding: 'buffer',
    maxBuffer: MAX_WORKTREE_YML_BYTES + 1,
  });
  const content = blob.stdout.toString('utf8');
  const parsed = parseWorktreeYml(content);
  return {
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    errors: parsed.ok ? [] : parsed.errors,
    notCommitted: false,
    workingTreeDiffers: workingTree.kind !== 'ok' || workingTree.text !== content,
  };
}

export type HeadWorktreeYml =
  | { kind: 'present'; yml: ExistingWorktreeYml }
  /** HEAD was read and has no `.emberline/worktree.yml`. */
  | { kind: 'absent' }
  /** git could not tell (no repository, no commit, a broken HEAD, unsafe config). */
  | { kind: 'unknown'; error: string };

/** Extra git arguments and environment for a read (e.g. one that must see only the real objects). */
export interface GitReadOptions {
  args?: readonly string[];
  env?: Record<string, string>;
}

/**
 * `.emberline/worktree.yml` as committed in `dir`'s HEAD (the main workspace's), or in another
 * commit `ref` of that repository, read the hardened way above. Unlike detection, a git failure is
 * reported as such, never as "no file". `git` adds arguments and environment to each git read.
 */
export async function readHeadWorktreeYml(dir: string, ref = 'HEAD', git: GitReadOptions = {}): Promise<HeadWorktreeYml> {
  const rel = ADOPT_FILE_PATHS.worktreeYml;
  if (!(await entryExists(path.join(dir, '.git')))) return { kind: 'unknown', error: 'the main workspace is not a git repository' };
  let stdout: string;
  try {
    stdout = (await execGitFile([...(git.args ?? []), 'ls-tree', '-l', '-z', ref, '--', rel], { cwd: dir, env: git.env })).stdout;
  } catch (error) {
    const message = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    return { kind: 'unknown', error: `git could not read ${ref}: ${message.slice(0, 300)}` };
  }
  const record = stdout.split('\0').find((r) => r.endsWith(`\t${rel}`));
  if (!record) return { kind: 'absent' };
  const [mode = '', type = '', oid = '', size = ''] = record.slice(0, record.indexOf('\t')).split(/\s+/);
  const entry: HeadEntry = { mode, type, oid, size: /^\d+$/.test(size) ? Number(size) : null };
  const yml = await headWorktreeYml(dir, entry, { kind: 'missing' }, git);
  return yml ? { kind: 'present', yml } : { kind: 'absent' };
}

interface Signals {
  /** Dependency names from package.json (empty when there is none or it is unsafe). */
  deps: Set<string>;
  hasPackageJson: boolean;
  /** `inspectWorkspaceProject` layers (empty when the manifests were not safe to read). */
  layers: readonly string[];
  /** Lower-case Python requirement names from requirements.txt / pyproject.toml. */
  py: Set<string>;
  hasPython: boolean;
  cargo: string;
  has: (rel: string) => boolean;
}

const anyDep = (s: Signals, ...names: string[]) => names.some((n) => s.deps.has(n));
const GAME_LIBS = ['phaser', 'pixi.js', 'three', '@babylonjs/core', 'kaplay'];
const NATIVE_LIBS = ['electron', 'expo', 'react-native', '@capacitor/core', '@tauri-apps/api'];

/** Best-effort option ids per dimension; anything not listed is left to the agent. */
function detectStack(s: Signals): Partial<Record<StackDimensionId, string>> {
  const out: Partial<Record<StackDimensionId, string>> = {};
  const staticOnly = !s.hasPackageJson && !s.hasPython && s.has('index.html');

  out.frontend = anyDep(s, 'next')
    ? 'nextjs'
    : anyDep(s, 'nuxt')
      ? 'nuxt'
      : anyDep(s, '@sveltejs/kit')
        ? 'sveltekit'
        : anyDep(s, 'astro')
          ? 'astro'
          : anyDep(s, '@11ty/eleventy')
            ? 'eleventy'
            : anyDep(s, '@angular/core')
              ? 'angular'
              : anyDep(s, 'expo', 'react-native')
                ? 'react-native-expo'
                : anyDep(s, 'phaser')
                  ? 'phaser'
                  : anyDep(s, 'pixi.js')
                    ? 'pixijs'
                    : anyDep(s, 'three')
                      ? 'threejs'
                      : anyDep(s, '@babylonjs/core')
                        ? 'babylonjs'
                        : anyDep(s, 'kaplay')
                          ? 'kaplay'
                          : anyDep(s, 'solid-js')
                            ? 'solid-vite'
                            : anyDep(s, 'vue')
                              ? 'vue-vite'
                              : anyDep(s, 'react') && anyDep(s, 'vite')
                                ? 'react-vite'
                                : anyDep(s, 'vite')
                                  ? 'vite-vanilla'
                                  : s.has('pubspec.yaml')
                                    ? 'flutter'
                                    : staticOnly
                                      ? 'plain-html'
                                      : undefined;
  if (!out.frontend && anyDep(s, 'react')) out.frontend = 'react';

  out.backend = anyDep(s, '@nestjs/core')
    ? 'nestjs'
    : anyDep(s, '@trpc/server') && anyDep(s, 'fastify')
      ? 'trpc-fastify'
      : anyDep(s, 'fastify')
        ? 'fastify'
        : anyDep(s, 'hono')
          ? 'hono'
          : anyDep(s, 'express')
            ? 'express'
            : anyDep(s, '@modelcontextprotocol/sdk')
              ? 'mcp-sdk'
              : anyDep(s, 'electron')
                ? 'electron-main'
                : anyDep(s, '@capacitor/core')
                  ? 'capacitor-bridge'
                  : s.py.has('fastapi')
                    ? 'fastapi'
                    : s.py.has('django')
                      ? 'django'
                      : s.has('src-tauri')
                        ? 'tauri-core'
                        : /^\s*axum\s*=/m.test(s.cargo)
                          ? 'rust-axum'
                          : s.has('platformio.ini')
                            ? 'platformio-arduino'
                            : undefined;

  out.database =
    anyDep(s, 'drizzle-orm') && anyDep(s, 'pg', 'postgres', '@neondatabase/serverless')
      ? 'postgres-drizzle'
      : anyDep(s, 'drizzle-orm')
        ? 'sqlite-drizzle'
        : anyDep(s, 'prisma', '@prisma/client')
          ? 'postgres-prisma'
          : anyDep(s, 'mongoose', 'mongodb')
            ? 'mongodb'
            : anyDep(s, 'mysql2')
              ? 'mysql'
              : anyDep(s, 'redis', 'ioredis')
                ? 'redis'
                : s.py.has('sqlalchemy')
                  ? 'postgres-sqlalchemy'
                  : undefined;

  out.auth = anyDep(s, '@clerk/nextjs', '@clerk/clerk-react', '@clerk/express')
    ? 'clerk'
    : anyDep(s, '@supabase/auth-helpers-nextjs', '@supabase/ssr')
      ? 'supabase-auth'
      : anyDep(s, 'firebase')
        ? 'firebase-auth'
        : undefined;

  out.deploy = s.has('vercel.json')
    ? 'vercel'
    : s.has('fly.toml')
      ? 'fly-io'
      : s.has('netlify.toml')
        ? 'static-hosting'
        : s.has('compose.yaml') || s.has('compose.yml') || s.has('docker-compose.yml') || s.has('docker-compose.yaml')
          ? 'docker-compose'
          : undefined;

  out.language = s.hasPackageJson
    ? s.hasPython
      ? 'typescript-python'
      : anyDep(s, 'typescript') || s.has('tsconfig.json')
        ? 'typescript-node'
        : 'javascript'
    : s.hasPython
      ? 'python'
      : s.has('go.mod')
        ? 'go'
        : s.has('Cargo.toml')
          ? 'rust'
          : s.has('pubspec.yaml')
            ? 'dart'
            : s.has('platformio.ini') || s.has('CMakeLists.txt') || s.has('Makefile')
              ? 'c-cpp'
              : staticOnly
                ? 'javascript'
                : undefined;

  out.styling = anyDep(s, 'tailwindcss') ? 'tailwind' : anyDep(s, '@mui/material') ? 'mui' : anyDep(s, '@mantine/core') ? 'mantine' : undefined;

  out.testing =
    anyDep(s, 'vitest') && anyDep(s, '@playwright/test')
      ? 'vitest-playwright'
      : anyDep(s, 'vitest') && anyDep(s, '@testing-library/react')
        ? 'vitest-testing-library'
        : anyDep(s, 'vitest')
          ? 'vitest'
          : anyDep(s, 'jest') && anyDep(s, 'cypress')
            ? 'jest-cypress'
            : anyDep(s, '@playwright/test')
              ? 'playwright-e2e'
              : s.py.has('pytest')
                ? 'pytest'
                : s.has('go.mod')
                  ? 'go-test'
                  : s.has('Cargo.toml')
                    ? 'cargo-test'
                    : undefined;
  return out;
}

const WEB_FRONTENDS = new Set(['nextjs', 'nuxt', 'sveltekit', 'angular', 'solid-vite', 'vue-vite', 'react-vite', 'react']);

function detectAppType(s: Signals, stack: Partial<Record<StackDimensionId, string>>): ProjectAppType {
  if (s.has('platformio.ini')) return 'embedded_iot';
  if (s.has('pubspec.yaml') || s.has('src-tauri') || anyDep(s, ...NATIVE_LIBS)) return 'mobile_desktop';
  if (anyDep(s, ...GAME_LIBS)) return 'game_interactive';
  if (['plain-html', 'eleventy', 'astro', 'vite-vanilla'].includes(stack.frontend ?? '')) return 'static_site';
  const web = WEB_FRONTENDS.has(stack.frontend ?? '');
  if (web && stack.backend) return 'fullstack';
  if (web) return 'web_saas';
  if (anyDep(s, '@modelcontextprotocol/sdk', '@anthropic-ai/sdk', 'openai', 'langchain') || s.py.has('langchain')) return 'ai_agents';
  if (stack.backend && !['platformio-arduino', 'tauri-core', 'electron-main', 'capacitor-bridge'].includes(stack.backend)) return 'api_service';
  if (anyDep(s, 'commander', '@clack/prompts', 'yargs', 'ink') || s.py.has('typer') || s.py.has('click')) return 'cli_tool';
  // The status view's layer scan as a last hint.
  if (s.layers.includes('CLI / System Automation') && !s.hasPackageJson) return 'cli_tool';
  return 'custom';
}

/** Option ids that do not fit the type become free text (still accurate); undetected layers go to the agent. */
function toChoices(
  stack: Partial<Record<StackDimensionId, string>>,
  appType: ProjectAppType,
): ProjectChoices {
  const choices: ProjectChoices = {};
  for (const dim of STACK_DIMENSION_IDS) {
    const id = stack[dim];
    let choice: StackChoice = 'agent';
    if (id) {
      const option = findOption(dim, id);
      choice = option ? (option.types.includes(appType) ? id : { other: option.label }) : { other: id[0]!.toUpperCase() + id.slice(1) };
    }
    choices[dim] = choice;
  }
  if (stack.frontend === 'plain-html') {
    choices.backend = 'none';
    choices.database = 'none';
  }
  return choices;
}

type CommandKind = 'setup' | 'build' | 'lint' | 'test';
/** One shell word: plain when it has no special characters, else single-quoted (`'` as `'\''`). */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function classify(command: string): CommandKind {
  if (/\b(install|ci|pub get|mod download|restore|deps\.get)\b/.test(command)) return 'setup';
  if (/\b(lint|analyze|clippy|vet)\b/.test(command)) return 'lint';
  if (/\btest\b/.test(command)) return 'test';
  return 'build';
}

/** Node setup with the lockfile the repo has, so worktrees install exactly what main uses. */
function nodeSetup(has: (rel: string) => boolean): string {
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (has('package-lock.json')) return 'npm ci --no-audit --no-fund';
  return 'npm install --no-audit --no-fund';
}

interface DetectionCore {
  root: string;
  appType: ProjectAppType;
  choices: ProjectChoices;
  commands: DetectedCommands;
  files: ProjectDetectResponse['detected']['files'];
  worktreeYml: ExistingWorktreeYml | null;
}

/** Reads the repository: stack, commands and the Emberline files it has. Never runs anything. */
export async function inspectImportedProject(workspacesDir: string, projectPath: string): Promise<DetectionCore> {
  let root: string | null;
  try {
    root = await realDirUnder(workspacesDir, projectPath);
  } catch (error) {
    if (error instanceof UnsafePathError) throw conflict(`the project folder cannot be read safely: ${error.message}`);
    throw error;
  }
  if (!root) throw conflict('the project folder does not exist (yet): wait for the clone to finish');
  const dir = root;

  const present = new Map<string, boolean>();
  const probe = async (rel: string) => present.set(rel, await entryExists(path.join(dir, rel)));
  const PROBED = [
    'index.html', 'tsconfig.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json',
    'requirements.txt', 'pyproject.toml', 'setup.py', 'pytest.ini', 'conftest.py', 'tests', 'go.mod', 'Cargo.toml',
    'pubspec.yaml', 'src-tauri', 'CMakeLists.txt', 'Makefile', 'vercel.json', 'fly.toml', 'netlify.toml',
    'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml',
    ...MANIFESTS, ...Object.values(ADOPT_FILE_PATHS), 'AGENTS.md',
  ];
  await Promise.all(PROBED.map(probe));
  const has = (rel: string) => present.get(rel) === true;

  // The name-based helpers may only read manifests that are plain files of a sane size.
  const read = (rel: string, max: number) => readUnder(workspacesDir, projectPath, rel, max);
  const manifestReads = await Promise.all(MANIFESTS.map((m) => read(m, MAX_MANIFEST_BYTES)));
  const manifestsSafe = manifestReads.every((r) => r.kind !== 'unsafe');
  const pkgRead = manifestReads[0]!;

  const deps = new Set<string>();
  if (pkgRead.kind === 'ok') {
    try {
      const pkg = JSON.parse(pkgRead.text) as { dependencies?: object; devDependencies?: object; peerDependencies?: object };
      for (const block of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
        if (block && typeof block === 'object') for (const name of Object.keys(block)) deps.add(name);
      }
    } catch {
      // invalid package.json: no dependency signals
    }
  }

  const py = new Set<string>();
  for (const rel of ['requirements.txt', 'pyproject.toml']) {
    const req = await read(rel, 256 * 1024);
    if (req.kind !== 'ok') continue;
    for (const m of req.text.matchAll(/^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) py.add(m[1]!.toLowerCase());
  }
  const cargoRead = await read('Cargo.toml', 256 * 1024);

  const { topFiles } = await collectWorkspaceFiles(dir);
  const hasPython = has('requirements.txt') || has('pyproject.toml') || has('setup.py') || topFiles.some((f) => f.endsWith('.py'));
  const inspection = manifestsSafe ? await inspectWorkspaceProject(dir, topFiles) : null;

  const signals: Signals = {
    deps,
    hasPackageJson: has('package.json'),
    py,
    hasPython,
    cargo: cargoRead.kind === 'ok' ? cargoRead.text : '',
    has,
    layers: inspection?.detectedLayers ?? [],
  };
  const stack = detectStack(signals);
  const appType = detectAppType(signals, stack);

  // Commands: the build gate's own plan, as strings only. Nothing here is executed.
  const byKind: Record<CommandKind, string[]> = { setup: [], build: [], lint: [], test: [] };
  const add = (kind: CommandKind, command: string) => {
    if (!byKind[kind].includes(command)) byKind[kind].push(command);
  };
  if (pkgRead.kind === 'ok') add('setup', nodeSetup(has));
  if (has('requirements.txt')) add('setup', 'pip install -r requirements.txt');
  else if (has('pyproject.toml')) add('setup', 'pip install -e .');
  if (has('go.mod')) add('setup', 'go mod download');
  if (manifestsSafe) {
    const steps = await planGateSteps(dir, topFiles).catch(() => []);
    for (const step of steps) {
      const rel = path.relative(dir, step.cwd);
      // A `sh -c` step is a fixed command line; any other step's arguments may be repo file names.
      const parts =
        step.file === 'sh' && step.args[0] === '-c' && step.args.length === 2
          ? step.display.split(' && ')
          : [[step.file, ...step.args].map(shellQuote).join(' ')];
      for (const part of parts) {
        const kind = classify(part);
        // Node installs come from the lockfile above, not the gate's "install when node_modules is missing".
        if (kind === 'setup' && /^(npm|pnpm|yarn) install\b/.test(part)) continue;
        add(kind, rel && !rel.startsWith('..') ? `cd ${shellQuote(rel)} && ${part}` : part);
      }
    }
  }
  if (hasPython && (py.has('pytest') || has('pytest.ini') || has('conftest.py') || has('tests'))) add('test', 'pytest');
  if (byKind.build.length === 0 && inspection?.buildCommand && !inspection.buildCommand.includes('*')) add('build', inspection.buildCommand);

  const services: DetectedCommands['services'] = [];
  const preview = pkgRead.kind === 'ok' && manifestsSafe ? detectPreviewCommand(dir) : null;
  if (preview) services.push({ name: 'web', command: preview, preview: true });
  else if (stack.frontend === 'plain-html') {
    services.push({ name: 'web', command: 'python3 -m http.server $PORT --bind 0.0.0.0', preview: true });
  }
  const join = (list: string[]) => (list.length > 0 ? list.join(' && ') : undefined);
  const commands: DetectedCommands = {
    setup: byKind.setup,
    ...(join(byKind.build) ? { build: join(byKind.build) } : {}),
    ...(join(byKind.lint) ? { lint: join(byKind.lint) } : {}),
    ...(join(byKind.test) ? { test: join(byKind.test) } : {}),
    services,
  };

  const tracked = [...Object.values(ADOPT_FILE_PATHS), 'AGENTS.md'];
  const head = await headEntries(dir, tracked);
  // "Present" means in HEAD or in the working tree: a committed file deleted locally is not missing.
  const exists = (rel: string) => has(rel) || head.has(rel);
  const worktreeYml = await headWorktreeYml(
    dir,
    head.get(ADOPT_FILE_PATHS.worktreeYml),
    has(ADOPT_FILE_PATHS.worktreeYml) ? await read(ADOPT_FILE_PATHS.worktreeYml, MAX_WORKTREE_YML_BYTES) : { kind: 'missing' },
  );

  return {
    root: dir,
    appType,
    choices: toChoices(stack, appType),
    commands,
    files: {
      projectMd: exists(ADOPT_FILE_PATHS.projectMd),
      claudeMd: exists(ADOPT_FILE_PATHS.claudeMd),
      agentsMd: exists('AGENTS.md'),
      worktreeYml: exists(ADOPT_FILE_PATHS.worktreeYml),
    },
    worktreeYml,
  };
}

/** The Emberline files an import would add, from its choices and the detected commands. */
export function importFileContents(input: {
  name: string;
  appType: ProjectAppType;
  description: string;
  choices: ProjectChoices;
  commands: DetectedCommands;
}): Record<AdoptWriteFile, string> {
  const { commands } = input;
  return {
    projectMd: generateProjectBlueprint({
      name: input.name,
      appType: input.appType,
      description: input.description,
      choices: input.choices,
      imported: true,
    }),
    claudeMd: generateClaudeInstructions(input.name),
    worktreeYml: renderWorktreeYml(
      {
        setup: commands.setup,
        services: commands.services,
        checks: { build: commands.build, lint: commands.lint, test: commands.test },
      },
      '# Generated by Emberline from the files in this repository. Runs read the approved copy of this file.',
    ),
  };
}

/** `GET /api/projects/:id/detect`. */
export async function detectProject(workspacesDir: string, project: Project): Promise<ProjectDetectResponse> {
  const core = await inspectImportedProject(workspacesDir, project.path);
  const contents = importFileContents({
    name: project.name,
    appType: core.appType,
    description: project.description,
    choices: core.choices,
    commands: core.commands,
  });
  const suggestions: ProjectDetectResponse['suggestions'] = {};
  for (const key of ['projectMd', 'claudeMd', 'worktreeYml'] as const) {
    if (!core.files[key]) suggestions[key] = contents[key];
  }
  return {
    detected: {
      appType: core.appType,
      choices: core.choices,
      commands: core.commands,
      files: core.files,
      worktreeYml: core.worktreeYml,
    },
    suggestions,
  };
}
