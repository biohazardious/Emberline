import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-utils.js';
import {
  ensureSetupPackageManager,
  parsePackageManagerField,
  setupInvokes,
} from './toolchain/package-manager.js';
import { ToolchainService } from './toolchain/service.js';
import { runWorktreeCommand } from './worktree-config/lifecycle.js';

let t: TestApp;
let ptydServer: PtydServer;
let previousToolsDir: string | undefined;
let previousSdkCommand: string | undefined;

beforeEach(async () => {
  t = await createTestApp();
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  previousToolsDir = process.env.EMBERLINE_TOOLS_DIR;
  process.env.EMBERLINE_TOOLS_DIR = path.join(t.dir, 'ai-tools');
  mkdirSync(t.config.workspacesDir, { recursive: true });
  // Stands in for the runner's emberline-sdk: `<action> <id>`, writes the version marker on install.
  previousSdkCommand = process.env.EMBERLINE_SDK_COMMAND;
  const fakeSdk = path.join(t.dir, 'fake-sdk');
  writeFileSync(
    fakeSdk,
    [
      '#!/usr/bin/env bash',
      // Once a test arms the gate, blocks until it opens, so timing never matters. The paths are
      // written in: ptyd hands sessions only an allowlisted environment.
      `if [ -e ${JSON.stringify(path.join(t.dir, 'sdk-gate-armed'))} ]; then while [ ! -e ${JSON.stringify(path.join(t.dir, 'sdk-gate'))} ]; do sleep 0.05; done; fi`,
      'mkdir -p "$EMBERLINE_TOOLS_DIR/sdk/.installed"',
      'echo "installing $2"',
      'echo "9.9.9" > "$EMBERLINE_TOOLS_DIR/sdk/.installed/$2"',
    ].join('\n'),
  );
  chmodSync(fakeSdk, 0o755);
  process.env.EMBERLINE_SDK_COMMAND = fakeSdk;
});

afterEach(async () => {
  if (previousToolsDir === undefined) delete process.env.EMBERLINE_TOOLS_DIR;
  else process.env.EMBERLINE_TOOLS_DIR = previousToolsDir;
  if (previousSdkCommand === undefined) delete process.env.EMBERLINE_SDK_COMMAND;
  else process.env.EMBERLINE_SDK_COMMAND = previousSdkCommand;
  await ptydServer.close();
  await t.close();
});

describe('ToolchainService', () => {
  it('runs CLI installs as runner sessions and reports their output', async () => {
    const toolchain = new ToolchainService(t.db, t.ptyd, t.config.workspacesDir);
    const res = await toolchain.executeAction('codex', {
      action: 'install',
      customCommand: 'echo "installed-in-runner $NPM_CONFIG_PREFIX"',
    });
    expect(res.output).toContain(`installed-in-runner ${path.join(t.dir, 'ai-tools', 'npm')}`);
    // The one-shot session is cleaned up afterwards.
    expect((await t.ptyd.get().list()).sessions).toHaveLength(0);
  });

  it('surfaces a failing install', async () => {
    const toolchain = new ToolchainService(t.db, t.ptyd, t.config.workspacesDir);
    await expect(
      toolchain.executeAction('codex', { action: 'install', customCommand: 'echo boom; exit 3' }),
    ).rejects.toThrow(/boom[\s\S]*exited with code 3/);
    expect((await toolchain.getToolStatus('codex')).lastError).toContain('boom');
  });

  it('runs one CLI install at a time, across providers (B24)', async () => {
    const toolchain = new ToolchainService(t.db, t.ptyd, t.config.workspacesDir);
    const slow = toolchain.executeAction('codex', {
      action: 'install',
      customCommand: 'sleep 1; echo slow-done',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      toolchain.executeAction('gemini', { action: 'install', customCommand: 'echo second' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await slow).output).toContain('slow-done');
    expect(
      (await toolchain.executeAction('gemini', { action: 'install', customCommand: 'echo second' })).output,
    ).toContain('second');
  });

  it('installs SDKs in a runner terminal and reads the installed version from its marker', async () => {
    const toolchain = new ToolchainService(t.db, t.ptyd, t.config.workspacesDir);
    expect((await toolchain.getSdkStatuses()).find((s) => s.id === 'platformio')).toMatchObject({
      installed: false,
      version: null,
    });
    const res = await toolchain.executeSdkAction('platformio', { action: 'install' });
    expect(res.terminal.title).toContain('PlatformIO');
    await expect
      .poll(async () => (await toolchain.getSdkStatuses()).find((s) => s.id === 'platformio'))
      .toMatchObject({ installed: true, version: '9.9.9', installing: false });
  });

  it('runs one SDK action at a time', async () => {
    writeFileSync(path.join(t.dir, 'sdk-gate-armed'), '');
    const toolchain = new ToolchainService(t.db, t.ptyd, t.config.workspacesDir);
    try {
      await toolchain.executeSdkAction('flutter', { action: 'install' });
      expect((await toolchain.getSdkStatuses()).find((s) => s.id === 'flutter')?.installing).toBe(true);
      await expect(toolchain.executeSdkAction('android', { action: 'install' })).rejects.toMatchObject({
        statusCode: 409,
      });
    } finally {
      writeFileSync(path.join(t.dir, 'sdk-gate'), '');
    }
    await expect
      .poll(async () => (await toolchain.getSdkStatuses()).find((s) => s.id === 'flutter')?.installing, {
        timeout: 5_000,
      })
      .toBe(false);
  });
});

describe('setup package manager provisioning', () => {
  let previousPath: string | undefined;
  let fakeBin: string;
  let npmLog: string;
  let worktree: string;

  /** A stand-in `npm` that "installs" `<name>@<version>` as a stub binary in $NPM_CONFIG_PREFIX/bin. */
  function writeFakeNpm(exitCode = 0) {
    writeFileSync(
      path.join(fakeBin, 'npm'),
      [
        '#!/bin/sh',
        `echo "$@" >> ${JSON.stringify(npmLog)}`,
        `if [ ${exitCode} -ne 0 ]; then echo "npm ERR! network unreachable"; exit ${exitCode}; fi`,
        'for arg in "$@"; do case "$arg" in *@*) spec="$arg";; esac; done',
        'name="${spec%@*}"; version="${spec##*@}"',
        'mkdir -p "$NPM_CONFIG_PREFIX/bin"',
        'printf \'#!/bin/sh\\necho %s\\n\' "$version" > "$NPM_CONFIG_PREFIX/bin/$name"',
        'chmod +x "$NPM_CONFIG_PREFIX/bin/$name"',
      ].join('\n'),
    );
    chmodSync(path.join(fakeBin, 'npm'), 0o755);
  }

  function writePackageJson(packageManager: string | undefined) {
    writeFileSync(
      path.join(worktree, 'package.json'),
      JSON.stringify({ name: 'app', private: true, ...(packageManager ? { packageManager } : {}) }),
    );
  }

  const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n') : []);

  beforeEach(() => {
    fakeBin = path.join(t.dir, 'fake-bin');
    npmLog = path.join(t.dir, 'npm-calls.log');
    worktree = path.join(t.config.workspacesDir, 'wt');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFakeNpm();
    // The runner's PATH without any pnpm: the fake npm, the runner-tools volume's npm/bin, the system.
    previousPath = process.env.PATH;
    process.env.PATH = [fakeBin, path.join(t.dir, 'ai-tools', 'npm', 'bin'), '/usr/bin', '/bin'].join(':');
  });

  afterEach(() => {
    process.env.PATH = previousPath;
  });

  it('parses only exact packageManager versions', () => {
    expect(parsePackageManagerField('pnpm@10.15.0')).toEqual({ name: 'pnpm', version: '10.15.0' });
    expect(parsePackageManagerField('pnpm@10.15.0+sha512.abc123')).toEqual({
      name: 'pnpm',
      version: '10.15.0',
    });
    expect(parsePackageManagerField('yarn@4.5.1')).toEqual({ name: 'yarn', version: '4.5.1' });
    expect(parsePackageManagerField('pnpm@^10')).toBeNull();
    expect(parsePackageManagerField('pnpm@latest')).toBeNull();
    expect(parsePackageManagerField('pnpm@10.0.0;touch /tmp/x')).toBeNull();
    expect(parsePackageManagerField('bun@1.1.0')).toBeNull();
  });

  it('matches the package manager only as a command word', () => {
    expect(setupInvokes(['pnpm install --frozen-lockfile'], 'pnpm')).toBe(true);
    expect(setupInvokes(['[ ! -f package.json ] || pnpm install'], 'pnpm')).toBe(true);
    expect(setupInvokes(['cd web && pnpm i'], 'pnpm')).toBe(true);
    expect(setupInvokes(['npm ci', 'rm -rf pnpm-store'], 'pnpm')).toBe(false);
    expect(setupInvokes(['./scripts/pnpm-free.sh'], 'pnpm')).toBe(false);
  });

  it('installs the pinned pnpm when setup names it and PATH lacks it', async () => {
    writePackageJson('pnpm@10.15.0+sha512.deadbeef');
    expect((await runWorktreeCommand('command -v pnpm || echo missing', worktree, 10_000)).tail).toContain(
      'missing',
    );

    const outcome = await ensureSetupPackageManager(worktree, ['pnpm install --frozen-lockfile']);

    expect(outcome).toEqual({
      status: 'installed',
      manager: 'pnpm',
      version: '10.15.0',
      message: 'Installed pnpm 10.15.0 for setup',
    });
    expect(npmCalls()).toEqual(['install -g --no-audit --no-fund pnpm@10.15.0']);
    expect(existsSync(path.join(t.dir, 'ai-tools', 'npm', 'bin', 'pnpm'))).toBe(true);
    const setup = await runWorktreeCommand('pnpm --version', worktree, 10_000);
    expect(setup).toMatchObject({ ok: true, exitCode: 0 });
    expect(setup.tail).toBe('10.15.0');
  });

  it('leaves an installed pnpm alone', async () => {
    writePackageJson('pnpm@10.15.0');
    await ensureSetupPackageManager(worktree, ['pnpm install']);
    expect(await ensureSetupPackageManager(worktree, ['pnpm install'])).toEqual({
      status: 'present',
      manager: 'pnpm',
      version: '10.15.0',
    });
    expect(npmCalls()).toHaveLength(1);
  });

  it('reports a failed install instead of letting setup exit 127', async () => {
    writeFakeNpm(1);
    writePackageJson('pnpm@10.15.0');
    const outcome = await ensureSetupPackageManager(worktree, ['pnpm install']);
    expect(outcome).toMatchObject({
      status: 'failed',
      manager: 'pnpm',
      version: '10.15.0',
      outcome: { exitCode: 1, timedOut: false },
    });
    expect(outcome.status === 'failed' && outcome.outcome.tail).toContain('network unreachable');
  });

  it('does not touch yarn, npm or undeclared projects', async () => {
    writePackageJson('yarn@4.5.1');
    expect(await ensureSetupPackageManager(worktree, ['yarn install --immutable'])).toEqual({
      status: 'not_needed',
    });
    writePackageJson('npm@10.9.0');
    expect(await ensureSetupPackageManager(worktree, ['npm ci'])).toEqual({ status: 'not_needed' });
    writePackageJson(undefined);
    expect(await ensureSetupPackageManager(worktree, ['pnpm install'])).toEqual({ status: 'not_needed' });
    writePackageJson('pnpm@10.15.0');
    expect(await ensureSetupPackageManager(worktree, ['make deps'])).toEqual({ status: 'not_needed' });
    expect(npmCalls()).toEqual([]);
  });
});
