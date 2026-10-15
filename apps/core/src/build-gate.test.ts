import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecRequest, localCommandExecutor, setCommandExecutor } from './command-exec.js';
import { buildWorkspaceDemo, planGateSteps } from './factory/demo.js';
import { inspectWorkspaceProject } from './factory/workspace-status.js';

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
