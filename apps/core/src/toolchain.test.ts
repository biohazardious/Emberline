import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-utils.js';
import { ToolchainService } from './toolchain/service.js';

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
    const slow = toolchain.executeAction('codex', { action: 'install', customCommand: 'sleep 1; echo slow-done' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      toolchain.executeAction('gemini', { action: 'install', customCommand: 'echo second' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await slow).output).toContain('slow-done');
    expect((await toolchain.executeAction('gemini', { action: 'install', customCommand: 'echo second' })).output).toContain(
      'second',
    );
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
      .poll(async () => (await toolchain.getSdkStatuses()).find((s) => s.id === 'flutter')?.installing, { timeout: 5_000 })
      .toBe(false);
  });
});
