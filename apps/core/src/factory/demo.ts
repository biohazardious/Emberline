/** Build/lint/test gate, demo asset serving and viewport snapshots; commands run in the runner. */
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserViewportSnapshot, type BuildDemoResponse } from '@emberline/protocol';
import { CommandFailedError, execCommand } from '../command-exec.js';
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

const PLATFORMIO = { binary: 'pio', hint: 'Install it with `emberline-sdk install platformio`, then verify again.' };
const FLUTTER = { binary: 'flutter', hint: 'Install it with `emberline-sdk install flutter`, then verify again.' };
const JAVA = { binary: 'java', hint: 'Install the JDK and Android SDK with `emberline-sdk install android`, then verify again.' };
const CARGO = { binary: 'cargo', hint: 'Rust ships with the runner image; rebuild the runner.' };
const GO = { binary: 'go', hint: 'Go ships with the runner image; rebuild the runner.' };

/**
 * Plans the gate for every ecosystem the workspace contains, not just the first one found: a
 * firmware repo with a package.json for its web companion gets both `npm run build` and `pio run`.
 */
export async function planGateSteps(workspacePath: string, topFiles: readonly string[]): Promise<GateStep[]> {
  const steps: GateStep[] = [];
  const has = (...rel: string[]) => existsSync(path.join(workspacePath, ...rel));
  const ciEnv = { CI: 'true', FORCE_COLOR: '0' };

  if (has('package.json')) {
    const pkgManager = has('pnpm-lock.yaml') || has('pnpm-workspace.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
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
    const rawPkg = await readFile(path.join(workspacePath, 'package.json'), 'utf-8');
    const scripts = (JSON.parse(rawPkg) as { scripts?: Record<string, string> }).scripts ?? {};
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
    if (typeof scripts.lint === 'string' && buildScriptName !== 'check' && !scripts.lint.includes('--watch')) {
      steps.push(npmStep(['run', 'lint'], 90_000));
    }
    if (
      typeof scripts.test === 'string' &&
      !scripts.test.includes('no test specified') &&
      !scripts.test.includes('--watch') &&
      buildScriptName !== 'check'
    ) {
      steps.push(npmStep(scripts.test.trim() === 'vitest' ? ['run', 'test', '--', '--run'] : ['run', 'test'], 120_000));
    }
  }

  if (has('platformio.ini')) {
    // The first build downloads the board's toolchain and framework.
    steps.push(sh('pio run', workspacePath, 900_000, PLATFORMIO));
    const ini = await readFile(path.join(workspacePath, 'platformio.ini'), 'utf-8');
    if (/^\[env:native\]/m.test(ini) && has('test')) {
      steps.push(sh('pio test -e native', workspacePath, 600_000, PLATFORMIO));
    }
  }
  // Tauri's crate needs the frontend built first, so it comes after the npm steps.
  if (has('src-tauri', 'Cargo.toml')) steps.push(sh('cargo check', path.join(workspacePath, 'src-tauri'), 900_000, CARGO));
  if (has('Cargo.toml')) steps.push(sh('cargo check', workspacePath, 900_000, CARGO));
  if (has('go.mod')) steps.push(sh('go build ./... && go test ./...', workspacePath, 300_000, GO));
  if (has('pubspec.yaml')) {
    steps.push(sh('flutter pub get', workspacePath, 600_000, FLUTTER));
    steps.push(sh('flutter analyze --no-fatal-infos --no-fatal-warnings', workspacePath, 600_000, FLUTTER));
    if (has('test')) steps.push(sh('flutter test', workspacePath, 600_000, FLUTTER));
  } else {
    // Native Android, Capacitor and React Native projects; Flutter drives Gradle itself.
    const gradleDir = has('gradlew') ? workspacePath : has('android', 'gradlew') ? path.join(workspacePath, 'android') : null;
    if (gradleDir) {
      steps.push(sh('bash ./gradlew assembleDebug --no-daemon --console=plain', gradleDir, 1_800_000, JAVA));
    }
  }
  if (steps.length > 0) return steps;

  if (topFiles.some((f) => f.endsWith('.py'))) {
    return [{ display: 'python3 -m compileall -q .', file: 'python3', args: ['-m', 'compileall', '-q', '.'], cwd: workspacePath, timeout: 60_000 }];
  }
  const shFiles = topFiles.filter((f) => f.endsWith('.sh'));
  if (shFiles.length > 0) {
    return [{ display: `bash -n ${shFiles.join(' ')}`, file: 'bash', args: ['-n', ...shFiles], cwd: workspacePath, timeout: 30_000 }];
  }
  if (has('Makefile')) return [{ display: 'make', file: 'make', args: [], cwd: workspacePath, timeout: 120_000 }];
  return [];
}

export async function buildWorkspaceDemo(params: {
  projectId: string;
  targetId: string;
  workspacePath: string;
}): Promise<BuildDemoResponse> {
  const { projectId, targetId, workspacePath } = params;
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace path not found: ${workspacePath}`);
  }

  const logs: string[] = [];
  const filesInfo = await collectWorkspaceFiles(workspacePath);
  const inspection = await inspectWorkspaceProject(workspacePath, filesInfo.topFiles);
  let buildCommandSucceeded = false;

  try {
    const steps = await planGateSteps(workspacePath, filesInfo.topFiles);
    if (steps.length === 0) {
      logs.push(`Verified workspace structure (${filesInfo.fileCount} files, stack: ${inspection.detectedStack}).`);
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
    output:
      logs.join('\n').slice(-4000) ||
      `Build & verification succeeded (${inspection.detectedStack}).`,
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
  const notFound = { status: 404, contentType: 'text/plain; charset=utf-8', body: `Asset not found: ${requestedRel}` };

  // Dotfiles (.env, .git/...) are never part of a demo bundle.
  if (requestedRel.split(/[\\/]/).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
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
    const script = [
      'f=$(mktemp --suffix=.png) || exit 1',
      'for b in chromium chromium-browser google-chrome; do',
      '  command -v "$b" >/dev/null 2>&1 || continue',
      '  "$b" --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1280,720 --screenshot="$f" "$1" >/dev/null 2>&1 && [ -s "$f" ] && break',
      'done',
      'cat "$f"; rm -f "$f"',
    ].join('\n');
    const shot = await execCommand({
      file: 'sh',
      args: ['-c', script, 'sh', params.targetUrl],
      cwd: '/',
      timeoutMs: 20_000,
      encoding: 'base64',
    }).catch(() => null);
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
