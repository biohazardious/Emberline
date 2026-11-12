/**
 * Every Emberline-made commit carries the configured identity: the agents' own commits in a run
 * (GIT_AUTHOR_* / GIT_COMMITTER_* in the session) as well as the merges core makes, and a project
 * may override the factory's identity.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryStatus, Run } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let ptydServer: PtydServer;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: authHeaders(cookie),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  // The agent commits in its worktree, as an agent merging main would; the repo's own identity is set.
  const script = path.join(t.dir, 'committing-claude.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'git config user.name "Repo Config"',
      'git config user.email repo@example.com',
      'git commit -q --allow-empty -m "Merge main into my branch"',
      `touch "${t.dir}/done-$EMBERLINE_RUN_ID"`,
      'while read line; do :; done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  t.config.claudeCommand = script;
});
afterEach(async () => {
  await ptydServer.close();
  await t.close();
});

async function agentCommit(projectId: string): Promise<string> {
  const res = await send('POST', '/api/runs', { projectId, prompt: 'work' });
  expect(res.statusCode).toBe(201);
  const run = res.json() as Run;
  await expect.poll(() => existsSync(path.join(t.dir, `done-${run.id}`)), { timeout: 8_000 }).toBe(true);
  return git(run.worktreePath, 'log', '-1', '--format=%an <%ae>|%cn <%ce>');
}

describe('commit identity', () => {
  it("an agent's own commits carry the factory's identity, then the project's own", async () => {
    const { project } = (await send('POST', '/api/projects', { name: 'Ident', initGit: true })).json();
    expect(git(project.path, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Emberline AI Factory <factory@emberline.local>',
    );
    const factory = await send('PATCH', '/api/factory/settings', {
      commitIdentity: { name: 'Factory Bot', email: 'bot@example.com' },
    });
    expect(factory.statusCode).toBe(200);
    expect(await agentCommit(project.id)).toBe('Factory Bot <bot@example.com>|Factory Bot <bot@example.com>');

    const own = await send('PATCH', `/api/projects/${project.id}/repository`, {
      commitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json() as RepositoryStatus).toMatchObject({
      commitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com' },
      factoryCommitIdentity: { name: 'Factory Bot', email: 'bot@example.com' },
    });
    expect(await agentCommit(project.id)).toBe(
      'Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>',
    );

    const back = await send('PATCH', `/api/projects/${project.id}/repository`, { commitIdentity: null });
    expect((back.json() as RepositoryStatus).commitIdentity).toBeNull();
  });

  it('refuses an identity with a line break or without an email address', async () => {
    const { project } = (await send('POST', '/api/projects', { name: 'Bad', initGit: true })).json();
    for (const commitIdentity of [
      { name: 'A\nB', email: 'a@example.com' },
      { name: 'A', email: 'nope' },
    ]) {
      expect(
        (await send('PATCH', `/api/projects/${project.id}/repository`, { commitIdentity })).statusCode,
      ).toBe(400);
      expect((await send('PATCH', '/api/factory/settings', { commitIdentity })).statusCode).toBe(400);
    }
  });
});
