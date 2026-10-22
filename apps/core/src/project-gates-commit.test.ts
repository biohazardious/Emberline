import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateFactorySettings } from './factory/settings.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let headers: Record<string, string>;

beforeEach(async () => {
  t = await createTestApp();
  writeFileSync(path.join(t.dir, 'fake-claude.sh'), '#!/bin/sh\nsleep 1\nexit 0\n', { mode: 0o755 });
  t.config.claudeCommand = path.join(t.dir, 'fake-claude.sh');
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  headers = authHeaders(await setupAndLogin(t.app));
});
afterEach(async () => {
  await ptydServer.close();
  await t.close();
});

const call = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method, url, payload, headers });

/** A project with a run whose worktree holds an uncommitted leaked key. */
async function projectWithSecret(name: string): Promise<{ projectId: string; run: Run }> {
  const { project } = (await call('POST', '/api/projects', { name, initGit: false })).json() as {
    project: { id: string; path: string };
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(project.path, 'README.md'), '# x\n');
  git('add', 'README.md');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const run: Run = (await call('POST', '/api/runs', { projectId: project.id, prompt: 'p' })).json();
  writeFileSync(
    path.join(run.worktreePath, '.env'),
    'OPENAI_API_KEY="sk-proj-1234567890abcdefghijklmnop"\n', // gitleaks:allow (fake key)
  );
  return { projectId: project.id, run };
}

const commit = (run: Run) => call('POST', `/api/runs/${run.id}/git/commit`, { message: 'wip', stageAll: true });

describe('secret guard per project (Review Focus 5)', () => {
  it('Off for project A commits; project B inherits and is blocked; B follows a global change', async () => {
    const a = await projectWithSecret('Gate A');
    const b = await projectWithSecret('Gate B');
    expect((await call('PATCH', `/api/projects/${a.projectId}/settings`, { gates: { secretGuardGate: false } })).statusCode).toBe(200);

    expect((await commit(a.run)).statusCode).toBe(200);
    const blocked = await commit(b.run);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('Secret Guard');

    updateFactorySettings(t.db, { secretGuardGate: false });
    expect((await commit(b.run)).statusCode).toBe(200);
  });
});
