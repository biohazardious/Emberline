import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-utils.js';
import { ToolchainService } from './toolchain/service.js';

let t: TestApp;
let ptydServer: PtydServer;
let previousToolsDir: string | undefined;

beforeEach(async () => {
  t = await createTestApp();
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  previousToolsDir = process.env.EMBERLINE_TOOLS_DIR;
  process.env.EMBERLINE_TOOLS_DIR = path.join(t.dir, 'ai-tools');
  mkdirSync(t.config.workspacesDir, { recursive: true });
});

afterEach(async () => {
  if (previousToolsDir === undefined) delete process.env.EMBERLINE_TOOLS_DIR;
  else process.env.EMBERLINE_TOOLS_DIR = previousToolsDir;
  await t.close();
  await ptydServer.close();
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
});
