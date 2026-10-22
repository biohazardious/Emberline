import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PTYD_PROTOCOL_VERSION } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelCommand,
  type ExecRequest,
  execCommand,
  execFileChecked,
  localCommandCanceller,
  localCommandExecutor,
  ptydCommandCanceller,
  ptydCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
} from './command-exec.js';
import { buildWorkspaceDemo } from './factory/service.js';
import { runGit } from './git-exec.js';
import { PtydBridge } from './ptyd-bridge.js';

let dir: string;
let server: PtydServer;
let bridge: PtydBridge;
const seen: ExecRequest[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmd-exec-'));
  server = new PtydServer({ socketPath: path.join(dir, 'ptyd.sock') });
  await server.listen();
  bridge = new PtydBridge(path.join(dir, 'ptyd.sock'));
  bridge.start();
  await bridge.waitUntilConnected();
  const viaRunner = ptydCommandExecutor(bridge);
  setCommandExecutor((request) => {
    seen.push(request);
    return viaRunner(request);
  });
  seen.length = 0;
});

afterEach(async () => {
  setCommandExecutor(localCommandExecutor);
  setCommandCanceller(localCommandCanceller);
  bridge.stop();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('command execution through the runner', () => {
  it('runs hardened git through ptyd exec without forwarding core env', async () => {
    const repo = path.join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    process.env.EMBERLINE_CORE_SECRET_FOR_TEST = 'must-not-leak';
    try {
      expect((await runGit(repo, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('main');
    } finally {
      delete process.env.EMBERLINE_CORE_SECRET_FOR_TEST;
    }
    expect(seen.length).toBeGreaterThanOrEqual(2); // config check + the command
    for (const request of seen) {
      expect(request.file).toBe('git');
      expect(Object.keys(request.env ?? {}).every((key) => key.startsWith('GIT_'))).toBe(true);
    }
  });

  it('cancels a running command in the runner by its execId (ptyd protocol 3)', async () => {
    setCommandCanceller(ptydCommandCanceller(bridge));
    const startedAt = Date.now();
    const running = execCommand({ file: 'sleep', args: ['30'], cwd: dir, timeoutMs: 60_000, execId: 'setup-x' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await cancelCommand('setup-x')).toBe(true);
    expect(await running).toMatchObject({ cancelled: true, exitCode: null });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // An older runner cannot cancel: false, never a throw.
    const outdated = { get: () => bridge.get(), protocolVersion: 2 } as unknown as PtydBridge;
    setCommandCanceller(ptydCommandCanceller(outdated));
    expect(await cancelCommand('setup-x')).toBe(false);
  });

  it('reports the runner protocol and refuses exec on an outdated runner', async () => {
    expect(bridge.protocolVersion).toBe(PTYD_PROTOCOL_VERSION);
    const outdated = { get: () => bridge.get(), protocolVersion: 1 } as unknown as PtydBridge;
    await expect(ptydCommandExecutor(outdated)({ file: 'true', args: [], cwd: dir })).rejects.toMatchObject({
      code: 'runner_outdated',
    });
  });

  it('rejects non-zero exits with the command output, like execFile', async () => {
    await expect(execFileChecked({ file: 'sh', args: ['-c', 'echo bad >&2; exit 2'], cwd: dir })).rejects.toMatchObject({
      code: 2,
      stderr: 'bad\n',
    });
  });

  it('runs workspace build scripts through the runner, not in core', async () => {
    const ws = path.join(dir, 'ws');
    execFileSync('mkdir', ['-p', path.join(ws, 'node_modules')]);
    writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ scripts: { build: 'node -e "console.log(process.env.CI)"' } }),
    );
    const res = await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws });
    expect(res.ok).toBe(true);
    expect(seen.map((r) => [r.file, ...r.args].join(' '))).toContain('npm run build');
    expect(seen.find((r) => r.args.includes('build'))?.env).toMatchObject({ CI: 'true' });
  });

  it('judges a chatty build by its exit code, not by its output size (B17)', async () => {
    const ws = path.join(dir, 'chatty');
    execFileSync('mkdir', ['-p', path.join(ws, 'node_modules')]);
    writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ scripts: { build: 'node -e "process.stdout.write(\'x\'.repeat(9000000))"' } }),
    );
    const res = await buildWorkspaceDemo({ projectId: 'p', targetId: 'main', workspacePath: ws });
    expect(res.ok).toBe(true);
  });
});
