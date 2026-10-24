/** Build/lint/test gate, demo asset serving and viewport snapshots; commands run in the runner. */
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type BrowserViewportSnapshot,
  type BuildDemoResponse,
  type WorktreeChecks,
} from '@emberline/protocol';
import { CommandFailedError, execCommand, RUNNER_BIN, systemCommand } from '../command-exec.js';
import type { Db } from '../db/index.js';
import { notFound } from '../errors.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { readWorktreeBytes } from '../runs/git.js';
import { approvedChecks, approvedSetup } from '../worktree-config/load.js';
import {
  inlineCode,
  runWorktreeCommand,
  SETUP_TIMEOUT_MS,
  SETUP_TOTAL_MS,
} from '../worktree-config/lifecycle.js';
import { buildStartCommit, recordDemoBuild } from './demo-builds.js';
import {
  collectWorkspaceFiles,
  detectDemoEntryRelPath,
  inspectWorkspaceProject,
} from './workspace-status.js';

/**
 * Build, lint and test steps run the workspace's own scripts (package.json, Makefile, ...), so they
 * execute in the runner, never in core (S6). Only the given variables are passed, plus CI flags.
 */
async function runWorkspaceCommand(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const request = {
    file,
    args,
    cwd: options.cwd ?? '/',
    timeoutMs: options.timeout ?? 60_000,
    env: { CI: 'true', FORCE_COLOR: '0', ...options.env },
  };
  const result = await execCommand(request);
  // B17: a build is judged by its exit code; very chatty output only gets cut, it is not a failure.
  if (result.exitCode !== 0 || result.timedOut) {
    throw new CommandFailedError(request, result, result.exitCode, result.stdout, result.stderr);
  }
  const note = result.truncated ? '\n[output truncated]' : '';
  return { stdout: result.stdout + note, stderr: result.stderr };
}

/** One command of the build/lint/test gate. */
export interface GateStep {
  /** Shown in the gate log as `$ <display>`. */
  display: string;
  file: string;
  args: string[];
  cwd: string;
  timeout: number;
  env?: Record<string, string>;
  /** A binary the step needs, and how to get it when the runner lacks it. */
  requires?: { binary: string; hint: string };
}

const sh = (display: string, cwd: string, timeout: number, requires?: GateStep['requires']): GateStep => ({
  display,
  file: 'sh',
  args: ['-c', display],
  cwd,
  timeout,
  requires,
});

const PLATFORMIO = {
  binary: 'pio',
  hint: 'Install it with `emberline-sdk install platformio`, then verify again.',
};
const FLUTTER = {
  binary: 'flutter',
  hint: 'Install it with `emberline-sdk install flutter`, then verify again.',
};
const JAVA = {
  binary: 'java',
  hint: 'Install the JDK and Android SDK with `emberline-sdk install android`, then verify again.',
};
const CARGO = { binary: 'cargo', hint: 'Rust ships with the runner image; rebuild the runner.' };
const GO = { binary: 'go', hint: 'Go ships with the runner image; rebuild the runner.' };

/** package.json files larger than this are not read for the build-target check or the gate plan. */
const PACKAGE_JSON_MAX = 1024 * 1024;
/** platformio.ini files larger than this are not read for the gate plan. */
const PLATFORMIO_INI_MAX = 256 * 1024;

/**
 * A small workspace file the gate plan reads, through a verified, capped descriptor (the workspace
 * is agent-writable: a FIFO or a link there must not block or redirect core). Null when it is not a
 * regular file of its own or is over `max`.
 */
async function readGateFile(workspacePath: string, rel: string, max: number): Promise<string | null> {
  const raw = await readWorktreeBytes(workspacePath, rel, max).catch(() => null);
  return raw ? raw.toString('utf8') : null;
}

/**
 * Plans the gate for every ecosystem the workspace contains, not just the first one found: a
 * firmware repo with a package.json for its web companion gets both `npm run build` and `pio run`.
 */
export async function planGateSteps(workspacePath: string, topFiles: readonly string[]): Promise<GateStep[]> {
  const steps: GateStep[] = [];
  const has = (...rel: string[]) => existsSync(path.join(workspacePath, ...rel));
  const ciEnv = { CI: 'true', FORCE_COLOR: '0' };

  if (has('package.json')) {
    const pkgManager =
      has('pnpm-lock.yaml') || has('pnpm-workspace.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    if (!has('node_modules')) {
      const installArgs = pkgManager === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'];
      steps.push({
        display: `${pkgManager} ${installArgs.join(' ')}`,
        file: pkgManager,
        args: installArgs,
        cwd: workspacePath,
        timeout: 120_000,
      });
    }
    // Unreadable (a FIFO, a link, over the cap): no scripts to run.
    const rawPkg = await readGateFile(workspacePath, 'package.json', PACKAGE_JSON_MAX);
    const scripts =
      rawPkg === null ? {} : ((JSON.parse(rawPkg) as { scripts?: Record<string, string> }).scripts ?? {});
    const buildScriptName =
      typeof scripts.build === 'string'
        ? 'build'
        : typeof scripts.typecheck === 'string'
          ? 'typecheck'
          : typeof scripts.check === 'string'
            ? 'check'
            : null;
    const npmStep = (args: string[], timeout: number): GateStep => ({
      display: `${pkgManager} ${args.join(' ')}`,
      file: pkgManager,
      args,
      cwd: workspacePath,
      timeout,
      env: ciEnv,
    });
    if (buildScriptName) steps.push(npmStep(['run', buildScriptName], 120_000));
    if (
      typeof scripts.lint === 'string' &&
      buildScriptName !== 'check' &&
      !scripts.lint.includes('--watch')
    ) {
      steps.push(npmStep(['run', 'lint'], 90_000));
    }
    if (
      typeof scripts.test === 'string' &&
      !scripts.test.includes('no test specified') &&
      !scripts.test.includes('--watch') &&
      buildScriptName !== 'check'
    ) {
      steps.push(
        npmStep(scripts.test.trim() === 'vitest' ? ['run', 'test', '--', '--run'] : ['run', 'test'], 120_000),
      );
    }
  }

  if (has('platformio.ini')) {
    // The first build downloads the board's toolchain and framework.
    steps.push(sh('pio run', workspacePath, 900_000, PLATFORMIO));
    const ini = (await readGateFile(workspacePath, 'platformio.ini', PLATFORMIO_INI_MAX)) ?? '';
    if (/^\[env:native\]/m.test(ini) && has('test')) {
      steps.push(sh('pio test -e native', workspacePath, 600_000, PLATFORMIO));
    }
  }
  // Tauri's crate needs the frontend built first, so it comes after the npm steps.
  if (has('src-tauri', 'Cargo.toml'))
    steps.push(sh('cargo check', path.join(workspacePath, 'src-tauri'), 900_000, CARGO));
  if (has('Cargo.toml')) steps.push(sh('cargo check', workspacePath, 900_000, CARGO));
  if (has('go.mod')) steps.push(sh('go build ./... && go test ./...', workspacePath, 300_000, GO));
  if (has('pubspec.yaml')) {
    steps.push(sh('flutter pub get', workspacePath, 600_000, FLUTTER));
    steps.push(sh('flutter analyze --no-fatal-infos --no-fatal-warnings', workspacePath, 600_000, FLUTTER));
    if (has('test')) steps.push(sh('flutter test', workspacePath, 600_000, FLUTTER));
  } else {
    // Native Android, Capacitor and React Native projects; Flutter drives Gradle itself.
    const gradleDir = has('gradlew')
      ? workspacePath
      : has('android', 'gradlew')
        ? path.join(workspacePath, 'android')
        : null;
    if (gradleDir) {
      steps.push(sh('bash ./gradlew assembleDebug --no-daemon --console=plain', gradleDir, 1_800_000, JAVA));
    }
  }
  if (steps.length > 0) return steps;

  if (topFiles.some((f) => f.endsWith('.py'))) {
    return [
      {
        display: 'python3 -m compileall -q .',
        file: 'python3',
        args: ['-m', 'compileall', '-q', '.'],
        cwd: workspacePath,
        timeout: 60_000,
      },
    ];
  }
  const shFiles = topFiles.filter((f) => f.endsWith('.sh'));
  if (shFiles.length > 0) {
    return [
      {
        display: `bash -n ${shFiles.join(' ')}`,
        file: 'bash',
        args: ['-n', ...shFiles],
        cwd: workspacePath,
        timeout: 30_000,
      },
    ];
  }
  if (has('Makefile'))
    return [{ display: 'make', file: 'make', args: [], cwd: workspacePath, timeout: 120_000 }];
  return [];
}

/**
 * Whether the build gate has something to verify: approved worktree.yml checks, or a detected
 * target. package.json is read through a verified, capped descriptor (the workspace is
 * agent-writable: a FIFO or link there must not block or redirect core).
 */
export async function hasVerifiableBuildTarget(
  workspacePath: string,
  checks?: WorktreeChecks | null,
): Promise<boolean> {
  if (checks && (checks.build || checks.lint || checks.test)) return true;
  const raw = await readWorktreeBytes(workspacePath, 'package.json', PACKAGE_JSON_MAX).catch(() => null);
  if (raw) {
    try {
      const pkg = JSON.parse(raw.toString('utf8')) as { scripts?: Record<string, string> };
      const hasValidTest =
        typeof pkg.scripts?.test === 'string' && !pkg.scripts.test.includes('no test specified');
      if (
        pkg.scripts?.build ||
        pkg.scripts?.typecheck ||
        pkg.scripts?.check ||
        pkg.scripts?.lint ||
        hasValidTest
      ) {
        return true;
      }
    } catch {
      // ignore invalid package.json
    }
  }
  return (
    existsSync(path.join(workspacePath, 'Cargo.toml')) ||
    existsSync(path.join(workspacePath, 'go.mod')) ||
    existsSync(path.join(workspacePath, 'pyproject.toml')) ||
    existsSync(path.join(workspacePath, 'requirements.txt')) ||
    existsSync(path.join(workspacePath, 'setup.py')) ||
    existsSync(path.join(workspacePath, 'platformio.ini')) ||
    existsSync(path.join(workspacePath, 'src-tauri', 'Cargo.toml')) ||
    existsSync(path.join(workspacePath, 'pubspec.yaml')) ||
    existsSync(path.join(workspacePath, 'gradlew')) ||
    existsSync(path.join(workspacePath, 'android', 'gradlew')) ||
    existsSync(path.join(workspacePath, 'Makefile'))
  );
}

/** A check of an approved worktree.yml may take this long. */
export const CHECK_TIMEOUT_MS = 15 * 60_000;

/**
 * The approved worktree.yml's `checks` as gate steps, in the order build, lint, test; empty when it
 * sets none. They replace {@link planGateSteps} entirely.
 */
export function checkSteps(
  workspacePath: string,
  checks: WorktreeChecks | null | undefined,
  /** The Docker engine's variables while it answers, the same the setup commands get. */
  env: Record<string, string> = {},
): GateStep[] {
  if (!checks) return [];
  return (['build', 'lint', 'test'] as const).flatMap((kind) => {
    const command = checks[kind];
    return command
      ? [
          {
            display: command,
            file: 'sh',
            args: ['-c', command],
            cwd: workspacePath,
            timeout: CHECK_TIMEOUT_MS,
            env: { CI: 'true', FORCE_COLOR: '0', ...env },
          },
        ]
      : [];
  });
}

/**
 * Runs the approved `setup` commands in the workspace (same runner path and limits as a run
 * worktree's setup). Throws with the exit code and output tail of the first one that fails, so the
 * checks never run on a workspace that is not set up.
 */
export async function runApprovedSetup(
  workspacePath: string,
  setup: readonly string[],
  logs: string[],
  /** Extra variables for the commands: the Docker engine's while it answers. */
  env: Record<string, string> = {},
): Promise<void> {
  const deadline = Date.now() + SETUP_TOTAL_MS;
  for (const command of setup) {
    const left = deadline - Date.now();
    if (left <= 0)
      throw new Error(`Setup stopped after ${SETUP_TOTAL_MS / 60_000} min; not run: ${inlineCode(command)}`);
    logs.push(`$ ${command}`);
    const outcome = await runWorktreeCommand(
      command,
      workspacePath,
      Math.min(SETUP_TIMEOUT_MS, left),
      undefined,
      env,
    );
    if (!outcome.ok) {
      const how = outcome.timedOut
        ? `timed out after ${Math.round(outcome.timeoutMs / 60_000)} min`
        : outcome.exitCode === null
          ? 'did not finish'
          : `exit ${outcome.exitCode}`;
      throw new Error(
        `Setup command ${inlineCode(command)} failed (${how}); the checks were not run.\n${outcome.tail}`,
      );
    }
    if (outcome.tail) logs.push(outcome.tail);
  }
}

export interface BuildWorkspaceDemoParams {
  projectId: string;
  targetId: string;
  workspacePath: string;
  /** The project's approved worktree.yml checks: when any is set, the gate runs exactly those. */
  checks?: WorktreeChecks | null;
  /** The approved worktree.yml `setup` commands: run first, in this workspace, when checks are used. */
  setup?: readonly string[];
  /**
   * Extra variables for the setup commands and the approved checks: the Docker client variables and
   * the target's compose project while the engine answers (RunService.dockerEnvFor / dockerEnvForMain).
   */
  env?: Record<string, string>;
  /** Records the build (commit at start, outcome) under the project's `demoBuilds` when given. */
  db?: Db;
}

/** One build per workspace at a time: a person's Build & Verify waits for the rebuild after a merge. */
const demoBuildLock = new KeyedMutex();

/** Whether a build of this workspace is running or waiting for one. */
export function isDemoBuildRunning(workspacePath: string): boolean {
  return demoBuildLock.isLocked(path.resolve(workspacePath));
}

/**
 * Runs the build/lint/test gate in a workspace and reports its demo entry. With `db`, the build is
 * recorded with the workspace HEAD it started from (also when it fails or cannot run).
 */
export async function buildWorkspaceDemo(params: BuildWorkspaceDemoParams): Promise<BuildDemoResponse> {
  return demoBuildLock.run(path.resolve(params.workspacePath), async () => {
    const { db } = params;
    if (!db) return runWorkspaceBuild(params);
    const commit = existsSync(params.workspacePath) ? await buildStartCommit(params.workspacePath) : null;
    const record = (ok: boolean) =>
      recordDemoBuild(db, params.projectId, params.targetId, {
        commit,
        builtAt: new Date().toISOString(),
        ok,
      });
    let res: BuildDemoResponse;
    try {
      res = await runWorkspaceBuild(params);
    } catch (error) {
      if (existsSync(params.workspacePath)) record(false);
      throw error;
    }
    record(res.ok);
    return res;
  });
}

/** The services {@link buildDemoTarget} needs from RunService. */
export interface DemoTargetRuns {
  get(id: string): { id: string; projectId: string; worktreePath: string };
  dockerEnvFor(run: { id: string; worktreePath: string }): Promise<Record<string, string>>;
  dockerEnvForMain(projectId: string): Promise<Record<string, string>>;
}

/**
 * Builds a project target ('main' or a run id) the way Run Build & Verify does: the approved setup
 * and checks, the target's Docker variables, and a recorded result. 404 for a run of another project.
 */
export async function buildDemoTarget(
  deps: { db: Db; runs: DemoTargetRuns },
  project: { id: string; path: string },
  targetId: string,
): Promise<BuildDemoResponse> {
  const { db, runs } = deps;
  let workspacePath = project.path;
  let env: Record<string, string>;
  if (targetId !== 'main') {
    const run = runs.get(targetId);
    if (!run || run.projectId !== project.id) throw notFound('no such run target for this project');
    workspacePath = run.worktreePath;
    env = await runs.dockerEnvFor({ id: run.id, worktreePath: run.worktreePath });
  } else {
    env = await runs.dockerEnvForMain(project.id);
  }
  return buildWorkspaceDemo({
    db,
    projectId: project.id,
    targetId,
    workspacePath,
    checks: approvedChecks(db, project.id),
    setup: approvedSetup(db, project.id),
    env,
  });
}

async function runWorkspaceBuild(params: BuildWorkspaceDemoParams): Promise<BuildDemoResponse> {
  const { projectId, targetId, workspacePath } = params;
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace path not found: ${workspacePath}`);
  }

  const logs: string[] = [];
  const filesInfo = await collectWorkspaceFiles(workspacePath);
  const inspection = await inspectWorkspaceProject(workspacePath, filesInfo.topFiles);
  let buildCommandSucceeded = false;

  try {
    const approved = checkSteps(workspacePath, params.checks, params.env);
    if (approved.length > 0 && params.setup && params.setup.length > 0) {
      await runApprovedSetup(workspacePath, params.setup, logs, params.env);
    }
    const steps = approved.length > 0 ? approved : await planGateSteps(workspacePath, filesInfo.topFiles);
    if (steps.length === 0) {
      logs.push(
        `Verified workspace structure (${filesInfo.fileCount} files, stack: ${inspection.detectedStack}).`,
      );
    }
    const checkedBinaries = new Set<string>();
    for (const step of steps) {
      if (step.requires && !checkedBinaries.has(step.requires.binary)) {
        // A missing toolchain fails the gate: passing it would ship firmware or apps nobody compiled.
        const present = await runWorkspaceCommand('sh', ['-c', `command -v ${step.requires.binary}`]).then(
          () => true,
          () => false,
        );
        if (!present) {
          throw new Error(
            `\`${step.requires.binary}\` is not installed in the runner, so \`${step.display}\` cannot run. ${step.requires.hint}`,
          );
        }
        checkedBinaries.add(step.requires.binary);
      }
      logs.push(`$ ${step.display}`);
      const { stdout, stderr } = await runWorkspaceCommand(step.file, step.args, {
        cwd: step.cwd,
        timeout: step.timeout,
        env: step.env,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
    }
    buildCommandSucceeded = true;
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) logs.push(execErr.stdout);
    if (typeof execErr.stderr === 'string' && execErr.stderr.trim()) logs.push(execErr.stderr);
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(msg);
    const fallbackEntry = await detectDemoEntryRelPath(workspacePath);
    return {
      ok: false,
      targetId,
      demoEntryRelPath: fallbackEntry,
      demoUrl: fallbackEntry ? `/api/projects/${projectId}/demo/${targetId}/` : null,
      output: logs.join('\n').slice(-4000),
    };
  }

  const demoEntryRelPath = await detectDemoEntryRelPath(workspacePath);
  return {
    ok: buildCommandSucceeded || Boolean(demoEntryRelPath),
    targetId,
    demoEntryRelPath,
    demoUrl: demoEntryRelPath ? `/api/projects/${projectId}/demo/${targetId}/` : null,
    output: logs.join('\n').slice(-4000) || `Build & verification succeeded (${inspection.detectedStack}).`,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export async function serveWorkspaceDemoAsset(params: {
  workspacePath: string;
  demoBaseHref: string;
  subPath: string;
}): Promise<{ status: number; contentType: string; body: Buffer | string }> {
  const { workspacePath, demoBaseHref, subPath } = params;
  const entryRel = await detectDemoEntryRelPath(workspacePath);
  if (!entryRel) {
    return {
      status: 404,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body style="background:#0d0f14;color:#e2e8f0;font-family:sans-serif;padding:2rem;"><h3>No playable demo bundle found in ${workspacePath}</h3><p>Click <b>Build Demo</b> in the Emberline Project Status panel to compile the project.</p></body></html>`,
    };
  }

  const entryAbs = path.join(workspacePath, entryRel);
  const demoRootDir = path.dirname(entryAbs);
  const cleanSub = subPath.replace(/^\/+/, '');
  const requestedRel = cleanSub.length === 0 ? path.basename(entryAbs) : cleanSub;
  const resolvedAbs = path.resolve(demoRootDir, requestedRel);
  const notFound = {
    status: 404,
    contentType: 'text/plain; charset=utf-8',
    body: `Asset not found: ${requestedRel}`,
  };

  // Dotfiles (.env, .git/...) are never part of a demo bundle.
  if (
    requestedRel
      .split(/[\\/]/)
      .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')
  ) {
    return notFound;
  }

  // Prevent path traversal outside demoRootDir
  if (!resolvedAbs.startsWith(demoRootDir + path.sep) && resolvedAbs !== demoRootDir) {
    return {
      status: 403,
      contentType: 'text/plain; charset=utf-8',
      body: 'Forbidden path',
    };
  }

  let targetFile = resolvedAbs;
  if (!existsSync(targetFile)) {
    // SPA fallback to entry HTML when extensionless route is requested
    if (!path.extname(targetFile)) {
      targetFile = entryAbs;
    } else {
      return notFound;
    }
  } else {
    const fileStat = await stat(targetFile);
    if (fileStat.isDirectory()) {
      targetFile = path.join(targetFile, 'index.html');
      if (!existsSync(targetFile)) {
        targetFile = entryAbs;
      }
    }
  }

  // The lexical check above does not see symlinks; resolve them and stay inside the demo root.
  const realRoot = await realpath(demoRootDir).catch(() => null);
  const realTarget = await realpath(targetFile).catch(() => null);
  if (!realRoot || !realTarget || (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep))) {
    return notFound;
  }
  targetFile = realTarget;

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  if (ext === '.html' || ext === '.htm') {
    let html = await readFile(targetFile, 'utf-8');
    const errorBridgeScript = `<script>(function(){function send(msg,stack){try{window.parent.postMessage({type:'emberline:demo-error',message:String(msg||'Runtime error'),stack:String(stack||'')},'*');}catch(_){}}window.addEventListener('error',function(e){send(e.message,e.error&&e.error.stack||e.filename+':'+e.lineno);});window.addEventListener('unhandledrejection',function(e){var r=e.reason;send(r&&r.message||String(r),r&&r.stack||'');});var origErr=console.error;console.error=function(){origErr.apply(console,arguments);try{var msg=Array.prototype.slice.call(arguments).map(function(a){return a instanceof Error?a.message:typeof a==='string'?a:JSON.stringify(a);}).join(' ');send(msg,'');}catch(_){}};})();</script>`;
    // Rewrite root-relative Vite/static asset URLs so they resolve under demoBaseHref
    html = html
      .replace(/\b(src|href)=["']\/(?!\/)/g, '$1="./')
      .replace(/<head([^>]*)>/i, `<head$1><base href="${demoBaseHref}">${errorBridgeScript}`);
    return {
      status: 200,
      contentType,
      body: html,
    };
  }

  const buf = await readFile(targetFile);
  return {
    status: 200,
    contentType,
    body: buf,
  };
}

// --- F11: Live Browser / X11 & Headless Chromium Viewport Stream ------------

export async function captureBrowserViewportSnapshot(params: {
  targetUrl: string | null;
}): Promise<BrowserViewportSnapshot> {
  const nowIso = new Date().toISOString();
  // Chromium lives in the runner; the screenshot comes back on stdout (base64), no shared temp file.
  if (params.targetUrl) {
    // A fresh profile and home for the browser, removed afterwards: the runner user's own (agents can
    // write it) could hold extensions, certificates or settings that change the picture.
    const script = [
      'f=$(mktemp --suffix=.png) || exit 1',
      'd=$(mktemp -d) || exit 1',
      'trap \'rm -rf -- "$f" "$d"\' EXIT',
      'for b in chromium chromium-browser google-chrome; do',
      '  command -v "$b" >/dev/null 2>&1 || continue',
      '  HOME="$d" "$b" --headless --no-sandbox --disable-gpu --hide-scrollbars --user-data-dir="$d/profile" --window-size=1280,720 --screenshot="$f" "$1" >/dev/null 2>&1 && [ -s "$f" ] && break',
      'done',
      'cat "$f"',
    ].join('\n');
    // Core's own script: the image's sh, and the system PATH for the browser, mktemp, cat and rm,
    // with nothing of the runner's environment.
    const shot = await execCommand(
      systemCommand({
        file: RUNNER_BIN.sh,
        args: ['-c', script, 'sh', params.targetUrl],
        cwd: '/',
        timeoutMs: 20_000,
        encoding: 'base64',
      }),
    ).catch(() => null);
    if (shot && shot.exitCode === 0 && !shot.truncated && shot.stdout.length > 0) {
      return {
        available: true,
        source: 'headless_browser',
        targetUrl: params.targetUrl,
        imageDataUrl: `data:image/png;base64,${shot.stdout}`,
        capturedAt: nowIso,
        message: `Captured live Chromium frame from ${params.targetUrl}`,
      };
    }
  }

  return {
    available: false,
    source: 'none',
    targetUrl: params.targetUrl,
    imageDataUrl: null,
    capturedAt: nowIso,
    message: 'Use the embedded Live Demo Player above or start a Playwright/Preview session.',
  };
}
