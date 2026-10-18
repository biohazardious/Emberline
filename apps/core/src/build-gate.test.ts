import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { buildWorkspaceDemo, hasVerifiableBuildTarget, planGateSteps } from './factory/demo.js';
import { inspectWorkspaceProject } from './factory/workspace-status.js';
import { setupFinishedIn } from './worktree-config/load.js';

let ws: string;

function files(entries: Record<string, string>): void {
  for (const [rel, content] of Object.entries(entries)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  }
}

const plan = async () =>
  (await planGateSteps(ws, [])).map((s) => `${path.relative(ws, s.cwd) || '.'}: ${s.display}`);

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'gate-'));
});

afterEach(() => {
  setCommandExecutor(localCommandExecutor);
  rmSync(ws, { recursive: true, force: true });
});

describe('build gate planning', () => {
  it('builds firmware even when the repo also has a package.json', async () => {
    files({
      'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
      'node_modules/.keep': '',
      'platformio.ini': '[env:esp32dev]\nplatform = espressif32\n\n[env:native]\nplatform = native\n',
      'test/test_main.cpp': '',
    });
    expect(await plan()).toEqual(['.: npm run build', '.: pio run', '.: pio test -e native']);
  });

  it('checks a Tauri crate after the frontend build', async () => {
    files({
      'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
      'node_modules/.keep': '',
      'src-tauri/Cargo.toml': '[package]\nname = "app"\n',
    });
    expect(await plan()).toEqual(['.: npm run build', 'src-tauri: cargo check']);
  });

  it('assembles the Android app of a Capacitor or React Native project', async () => {
    files({
      'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
      'node_modules/.keep': '',
      'android/gradlew': '#!/bin/sh\n',
    });
    expect(await plan()).toEqual([
      '.: npm run build',
      'android: bash ./gradlew assembleDebug --no-daemon --console=plain',
    ]);
  });

  it('runs Flutter analysis and tests, and leaves Gradle to Flutter', async () => {
    files({ 'pubspec.yaml': 'name: app\n', 'test/widget_test.dart': '', 'android/gradlew': '#!/bin/sh\n' });
    expect(await plan()).toEqual([
      '.: flutter pub get',
      '.: flutter analyze --no-fatal-infos --no-fatal-warnings',
      '.: flutter test',
    ]);
    expect((await inspectWorkspaceProject(ws)).detectedStack).toBe('Flutter (Dart)');
  });

  it('falls back to Python, shell and make only when no toolchain project was found', async () => {
    files({ 'tool.py': 'print(1)\n', Makefile: 'all:\n' });
    expect((await planGateSteps(ws, ['tool.py', 'Makefile'])).map((s) => s.display)).toEqual([
      'python3 -m compileall -q .',
    ]);
  });
});

describe('build gate execution', () => {
  it('fails, with the install command, when the toolchain is missing instead of passing unbuilt firmware', async () => {
    files({ 'platformio.ini': '[env:esp32dev]\nplatform = espressif32\n' });
    const seen: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      seen.push(request);
      const missing = request.args[1] === 'command -v pio';
      return {
        exitCode: missing ? 1 : 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    });
    const res = await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('`pio` is not installed in the runner');
    expect(res.output).toContain('emberline-sdk install platformio');
    expect(seen.some((r) => r.args.includes('pio run'))).toBe(false);
  });

  it('runs every planned step once the toolchain is there', async () => {
    files({ 'platformio.ini': '[env:esp32dev]\nplatform = espressif32\n' });
    const seen: string[] = [];
    setCommandExecutor(async (request) => {
      seen.push([request.file, ...request.args].join(' '));
      return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, truncated: false };
    });
    const res = await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['sh -c command -v pio', 'sh -c pio run']);
  });
});

describe('approved worktree.yml checks', () => {
  it('replace the planned steps and run in the order build, lint, test (sh -c, in the worktree)', async () => {
    files({ 'package.json': JSON.stringify({ scripts: { build: 'vite build', test: 'vitest' } }), 'node_modules/.keep': '' });
    const seen: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      seen.push(request);
      return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, truncated: false };
    });
    const res = await buildWorkspaceDemo({
      projectId: 'p',
      targetId: 'main',
      workspacePath: ws,
      checks: { test: 'make test', build: 'make all', lint: 'make lint' },
    });
    expect(res.ok).toBe(true);
    expect(seen.map((r) => [r.file, ...r.args].join(' '))).toEqual(['sh -c make all', 'sh -c make lint', 'sh -c make test']);
    expect(seen.every((r) => r.cwd === ws)).toBe(true);
  });

  it('stop at the first failing check', async () => {
    const seen: string[] = [];
    setCommandExecutor(async (request) => {
      seen.push(request.args[1] ?? '');
      const failed = request.args[1] === 'make lint';
      return { exitCode: failed ? 2 : 0, signal: null, stdout: '', stderr: failed ? 'lint error' : '', timedOut: false, truncated: false };
    });
    const res = await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws, checks: { build: 'make all', lint: 'make lint', test: 'make test' } });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('lint error');
    expect(seen).toEqual(['make all', 'make lint']);
  });

  it('only some checks: the others are not run, and no detected step is added', async () => {
    files({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }), 'node_modules/.keep': '' });
    const seen: string[] = [];
    setCommandExecutor(async (request) => {
      seen.push([request.file, ...request.args].join(' '));
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false };
    });
    await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws, checks: { test: 'pytest' } });
    expect(seen).toEqual(['sh -c pytest']);
  });

  it('make a workspace without a detected target verifiable', () => {
    expect(hasVerifiableBuildTarget(ws)).toBe(false);
    expect(hasVerifiableBuildTarget(ws, {})).toBe(false);
    expect(hasVerifiableBuildTarget(ws, { lint: 'true' })).toBe(true);
  });
});

describe('approved setup before the checks', () => {
  const ok = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false };
  const cmdOf = (r: ExecRequest) => (r.args[1] ?? '').replace(/^exec 2>&1\n/, '');

  it('runs the setup commands first, in order, in the workspace', async () => {
    const seen: ExecRequest[] = [];
    setCommandExecutor(async (request) => {
      seen.push(request);
      return ok;
    });
    const res = await buildWorkspaceDemo({
      projectId: 'p',
      targetId: 'main',
      workspacePath: ws,
      checks: { build: 'npm run build', test: 'npm test' },
      setup: ['npm ci', 'npx playwright install'],
    });
    expect(res.ok).toBe(true);
    expect(seen.map(cmdOf)).toEqual(['npm ci', 'npx playwright install', 'npm run build', 'npm test']);
    expect(seen.every((r) => r.cwd === ws)).toBe(true);
  });

  it('a failing setup command fails the build with its output and runs no check', async () => {
    const seen: string[] = [];
    setCommandExecutor(async (request) => {
      seen.push(cmdOf(request));
      return cmdOf(request) === 'npm ci' ? { ...ok, exitCode: 1, stdout: 'ERR! lockfile out of date' } : ok;
    });
    const res = await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws, checks: { build: 'npm run build' }, setup: ['npm ci'] });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('exit 1');
    expect(res.output).toContain('lockfile out of date');
    expect(seen).toEqual(['npm ci']);
  });

  it('does not run setup without approved checks', async () => {
    const seen: string[] = [];
    setCommandExecutor(async (request) => {
      seen.push(cmdOf(request));
      return ok;
    });
    await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws, setup: ['npm ci'] });
    expect(seen).not.toContain('npm ci');
  });

  it('the gate skips setup only when the worktree setup finished and nothing failed after', () => {
    expect(setupFinishedIn(['spawned', 'worktree_setup_started', 'worktree_setup_finished'])).toBe(true);
    expect(setupFinishedIn(['worktree_setup_started', 'worktree_setup_failed'])).toBe(false);
    expect(setupFinishedIn(['worktree_setup_finished', 'worktree_setup_failed'])).toBe(false);
    expect(setupFinishedIn(['worktree_setup_skipped'])).toBe(false);
    expect(setupFinishedIn([])).toBe(false);
  });
});
