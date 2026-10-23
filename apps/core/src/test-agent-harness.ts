import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PtydServer } from '@emberline/ptyd/server';
import { expect } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

/**
 * Shared setup for the tests that drive a run with a Claude stand-in: the app, a ptyd server, a
 * signed-in cookie, hook calls and a throwaway git project. Test-only (not in the build).
 */

/** Runs git in `cwd` with a fixed identity and returns the trimmed stdout. */
export const wgit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();

/**
 * Writes a Claude stand-in into `dir` and returns its path. It publishes the run's hook token as
 * `token-<runId>` in `dir`, then stays alive (a run that exits early is not merged like a finished one).
 */
export function writeStandIn(dir: string, opts: { name?: string; stayAlive?: boolean } = {}): string {
  const file = path.join(dir, opts.name ?? 'living-claude.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${dir}/.token-$EMBERLINE_RUN_ID" "${dir}/token-$EMBERLINE_RUN_ID"`,
      'echo "fake claude ready"',
      ...(opts.stayAlive === false ? [] : ['while read line; do :; done']),
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

export interface AgentHarness {
  t: TestApp;
  cookie: string;
  api: (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => Promise<InjectResponse>;
  hook: (runId: string, event: string, token: string, payload?: object) => Promise<InjectResponse>;
  /** Waits for `name` in the app's temp directory and returns its content. */
  waitFile: (name: string) => Promise<string>;
  /** Creates a project with an initialised git repository and one empty commit. */
  gitProject: (name?: string) => Promise<{ id: string; path: string }>;
  close: () => Promise<void>;
}

export async function startAgentHarness(opts: { standIn?: string } = {}): Promise<AgentHarness> {
  const t = await createTestApp();
  t.config.claudeCommand = opts.standIn ?? writeStandIn(t.dir);
  const ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  const cookie = await setupAndLogin(t.app);

  const api: AgentHarness['api'] = (method, url, payload) =>
    t.app.inject({ method, url, payload, headers: authHeaders(cookie) });

  return {
    t,
    cookie,
    api,
    hook: (runId, event, token, payload = {}) =>
      t.app.inject({
        method: 'POST',
        url: '/api/internal/hooks',
        headers: { authorization: `Bearer ${token}` },
        payload: { runId, event, receivedAt: new Date().toISOString(), payload },
      }),
    async waitFile(name) {
      const file = path.join(t.dir, name);
      await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
      return readFileSync(file, 'utf8');
    },
    async gitProject(name = 'Loop Project') {
      const { project } = (await api('POST', '/api/projects', { name, initGit: false })).json();
      wgit(project.path, 'init', '-q', '-b', 'main');
      wgit(project.path, 'commit', '-q', '--allow-empty', '-m', 'init');
      return project as { id: string; path: string };
    },
    async close() {
      await ptydServer.close();
      await t.close();
    },
  };
}
