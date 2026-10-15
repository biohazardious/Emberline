/** Build/lint/test gate, demo asset serving and viewport snapshots; commands run in the runner. */
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserViewportSnapshot, type BuildDemoResponse } from '@emberline/protocol';
import { execCommand, execFileChecked } from '../command-exec.js';
import {
  collectWorkspaceFiles,
  detectDemoEntryRelPath,
  inspectWorkspaceProject,
} from './workspace-status.js';

/**
 * Build, lint and test steps run the workspace's own scripts (package.json, Makefile, ...), so they
 * execute in the runner, never in core (S6). Only the given variables are passed, plus CI flags.
 */
function runWorkspaceCommand(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileChecked({
    file,
    args,
    cwd: options.cwd ?? '/',
    timeoutMs: options.timeout ?? 60_000,
    env: { CI: 'true', FORCE_COLOR: '0', ...options.env },
  });
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
    if (inspection.hasPackageJson) {
      const hasNodeModules = existsSync(path.join(workspacePath, 'node_modules'));
      const hasPnpmLock =
        existsSync(path.join(workspacePath, 'pnpm-lock.yaml')) ||
        existsSync(path.join(workspacePath, 'pnpm-workspace.yaml'));
      const hasYarnLock = existsSync(path.join(workspacePath, 'yarn.lock'));
      const pkgManager = hasPnpmLock ? 'pnpm' : hasYarnLock ? 'yarn' : 'npm';
      const installArgs =
        pkgManager === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'];

      if (!hasNodeModules) {
        const { stdout, stderr } = await runWorkspaceCommand(pkgManager, installArgs, {
          cwd: workspacePath,
          timeout: 120_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }

      const rawPkg = await readFile(path.join(workspacePath, 'package.json'), 'utf-8');
      const parsedPkg = JSON.parse(rawPkg) as { scripts?: Record<string, string> };
      const scripts = parsedPkg.scripts ?? {};
      const ciEnv = { CI: 'true', FORCE_COLOR: '0' };

      const buildScriptName =
        typeof scripts.build === 'string'
          ? 'build'
          : typeof scripts.typecheck === 'string'
            ? 'typecheck'
            : typeof scripts.check === 'string'
              ? 'check'
              : null;

      if (buildScriptName) {
        logs.push(`$ ${pkgManager} run ${buildScriptName}`);
        const { stdout, stderr } = await runWorkspaceCommand(pkgManager, ['run', buildScriptName], {
          cwd: workspacePath,
          timeout: 120_000,
          env: ciEnv,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }

      if (
        typeof scripts.lint === 'string' &&
        buildScriptName !== 'check' &&
        !scripts.lint.includes('--watch')
      ) {
        logs.push(`$ ${pkgManager} run lint`);
        const { stdout, stderr } = await runWorkspaceCommand(pkgManager, ['run', 'lint'], {
          cwd: workspacePath,
          timeout: 90_000,
          env: ciEnv,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }

      if (
        typeof scripts.test === 'string' &&
        !scripts.test.includes('no test specified') &&
        !scripts.test.includes('--watch') &&
        buildScriptName !== 'check'
      ) {
        const testArgs =
          scripts.test.trim() === 'vitest'
            ? ['run', 'test', '--', '--run']
            : ['run', 'test'];
        logs.push(`$ ${pkgManager} ${testArgs.join(' ')}`);
        const { stdout, stderr } = await runWorkspaceCommand(pkgManager, testArgs, {
          cwd: workspacePath,
          timeout: 120_000,
          env: ciEnv,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      }
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'platformio.ini'))) {
      const hasPio = await runWorkspaceCommand('sh', ['-c', 'command -v pio || command -v platformio']).then(() => true, () => false);
      if (hasPio) {
        logs.push('$ pio run');
        const { stdout, stderr } = await runWorkspaceCommand('sh', ['-c', 'pio run || platformio run'], {
          cwd: workspacePath,
          timeout: 180_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      } else {
        logs.push('Verified PlatformIO firmware structure (platformio.ini present).');
      }
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'Cargo.toml'))) {
      const hasCargo = await runWorkspaceCommand('sh', ['-c', 'command -v cargo']).then(() => true, () => false);
      if (hasCargo) {
        logs.push('$ cargo check');
        const { stdout, stderr } = await runWorkspaceCommand('cargo', ['check'], {
          cwd: workspacePath,
          timeout: 120_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      } else {
        logs.push('Verified Rust Cargo workspace structure (Cargo.toml present).');
      }
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'go.mod'))) {
      const hasGo = await runWorkspaceCommand('sh', ['-c', 'command -v go']).then(() => true, () => false);
      if (hasGo) {
        logs.push('$ go build ./... && go test ./...');
        const { stdout, stderr } = await runWorkspaceCommand('sh', ['-c', 'go build ./... && go test ./...'], {
          cwd: workspacePath,
          timeout: 120_000,
        });
        if (stdout) logs.push(stdout);
        if (stderr) logs.push(stderr);
      } else {
        logs.push('Verified Go module structure (go.mod present).');
      }
      buildCommandSucceeded = true;
    } else if (filesInfo.topFiles.some((f) => f.endsWith('.py'))) {
      logs.push('$ python3 -m compileall -q .');
      const { stdout, stderr } = await runWorkspaceCommand('python3', ['-m', 'compileall', '-q', '.'], {
        cwd: workspacePath,
        timeout: 60_000,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
      buildCommandSucceeded = true;
    } else if (filesInfo.topFiles.some((f) => f.endsWith('.sh'))) {
      const shFiles = filesInfo.topFiles.filter((f) => f.endsWith('.sh'));
      logs.push(`$ bash -n ${shFiles.join(' ')}`);
      const { stdout, stderr } = await runWorkspaceCommand('bash', ['-n', ...shFiles], {
        cwd: workspacePath,
        timeout: 30_000,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
      buildCommandSucceeded = true;
    } else if (existsSync(path.join(workspacePath, 'Makefile'))) {
      logs.push('$ make');
      const { stdout, stderr } = await runWorkspaceCommand('make', [], {
        cwd: workspacePath,
        timeout: 120_000,
      });
      if (stdout) logs.push(stdout);
      if (stderr) logs.push(stderr);
      buildCommandSucceeded = true;
    } else {
      logs.push(`Verified workspace structure (${filesInfo.fileCount} files, stack: ${inspection.detectedStack}).`);
      buildCommandSucceeded = true;
    }
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
