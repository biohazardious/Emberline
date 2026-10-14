import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  GitCommitResponse,
  GitPushResponse,
  Run,
  RunArtifact,
  RunDiffSummary,
  RunFileDiff,
} from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let ptydServer: PtydServer;
let cookie: string;

function writeFakeClaude(dir: string): string {
  const file = path.join(dir, 'fake-claude.sh');
  writeFileSync(file, '#!/bin/sh\nsleep 1\nexit 0\n', { mode: 0o755 });
  return file;
}

beforeEach(async () => {
  t = await createTestApp();
  t.config.claudeCommand = writeFakeClaude(t.dir);
  ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
  await ptydServer.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await t.close();
  await ptydServer.close();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

async function createGitProjectWithBareRemote(name: string) {
  const { project } = (await api('POST', '/api/projects', { name })).json() as {
    project: { id: string; path: string };
  };
  const remoteDir = path.join(t.dir, 'remote.git');
  mkdirSync(remoteDir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir]);

  const git = (...args: string[]) => execFileSync('git', ['-C', project.path, ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(project.path, 'README.md'), '# Hello\nLine 2\n');
  git('add', 'README.md');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remoteDir);
  git('push', '-q', '-u', 'origin', 'main');

  return { project, remoteDir };
}

describe('M6 review, git commit/push, and artifacts', () => {
  it('inspects branch/unstaged/staged diffs, stages, commits, and pushes to remote', async () => {
    const { project, remoteDir } = await createGitProjectWithBareRemote('Review App');
    const runRes = await api('POST', '/api/runs', { projectId: project.id, prompt: 'feature' });
    expect(runRes.statusCode).toBe(201);
    const run: Run = runRes.json();

    // Modify existing tracked file + create untracked file in worktree
    writeFileSync(path.join(run.worktreePath, 'README.md'), '# Hello World\nLine 2\nLine 3\n');
    mkdirSync(path.join(run.worktreePath, 'src'), { recursive: true });
    writeFileSync(path.join(run.worktreePath, 'src', 'index.ts'), 'export const x = 42;\n');

    // 1. Inspect unstaged diff
    const unstagedRes = await api('GET', `/api/runs/${run.id}/diff?scope=unstaged`);
    expect(unstagedRes.statusCode).toBe(200);
    const unstaged: RunDiffSummary = unstagedRes.json();
    expect(unstaged.files.map((f) => f.path)).toEqual(['README.md', 'src/index.ts']);

    // 2. Inspect single file diff for Monaco
    const fileDiffRes = await api(
      'GET',
      `/api/runs/${run.id}/diff/file?path=${encodeURIComponent('README.md')}&scope=unstaged`,
    );
    expect(fileDiffRes.statusCode).toBe(200);
    const fileDiff: RunFileDiff = fileDiffRes.json();
    expect(fileDiff.original).toBe('# Hello\nLine 2\n');
    expect(fileDiff.modified).toBe('# Hello World\nLine 2\nLine 3\n');
    expect(fileDiff.binary).toBe(false);

    // 3. Stage src/index.ts
    const stageRes = await api('POST', `/api/runs/${run.id}/git/stage`, {
      paths: ['src/index.ts'],
      unstage: false,
    });
    expect(stageRes.statusCode).toBe(200);
    const afterStage: RunDiffSummary = stageRes.json();
    expect(afterStage.files.some((f) => f.path === 'src/index.ts' && f.staged)).toBe(true);

    // 4. Commit all changes
    const commitRes = await api('POST', `/api/runs/${run.id}/git/commit`, {
      message: 'feat: implement M6 review',
      stageAll: true,
    });
    expect(commitRes.statusCode).toBe(200);
    const committed: GitCommitResponse = commitRes.json();
    expect(committed.sha).toMatch(/^[0-9a-f]{7,12}$/);
    expect(committed.summary).toContain('feat: implement M6 review');

    // Branch diff vs main should now show 1 commit ahead and 2 files changed
    const branchDiffRes = await api('GET', `/api/runs/${run.id}/diff?scope=branch`);
    expect(branchDiffRes.statusCode).toBe(200);
    const branchDiff: RunDiffSummary = branchDiffRes.json();
    expect(branchDiff.aheadCount).toBe(1);
    expect(branchDiff.files.map((f) => f.path)).toEqual(['README.md', 'src/index.ts']);

    // 5. Push branch to bare origin
    const pushRes = await api('POST', `/api/runs/${run.id}/git/push`, {});
    expect(pushRes.statusCode).toBe(200);
    const pushed: GitPushResponse = pushRes.json();
    expect(pushed.remote).toBe('origin');
    expect(pushed.branch).toBe(run.branch);

    // Verify bare remote received the branch
    const remoteBranches = execFileSync('git', ['-C', remoteDir, 'branch', '--list'], {
      encoding: 'utf8',
    });
    expect(remoteBranches).toContain(run.branch!);

    // 6. Verify protected branch (master/main) cannot be pushed via run API
    execFileSync('git', ['-C', run.worktreePath, 'checkout', '-q', '-B', 'master']);
    const mainPushRes = await api('POST', `/api/runs/${run.id}/git/push`, {});
    expect(mainPushRes.statusCode).toBe(409);
  });

  it('lists worktree artifacts, serves raw artifact bytes, and blocks path traversal', async () => {
    const { project } = await createGitProjectWithBareRemote('Artifact App');
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'art' })).json();

    mkdirSync(path.join(run.worktreePath, 'screenshots'), { recursive: true });
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(path.join(run.worktreePath, 'screenshots', 'home.png'), fakePng);

    const listRes = await api('GET', `/api/runs/${run.id}/artifacts`);
    expect(listRes.statusCode).toBe(200);
    const artifacts: RunArtifact[] = listRes.json();
    expect(artifacts).toContainEqual(
      expect.objectContaining({
        path: 'screenshots/home.png',
        name: 'home.png',
        kind: 'image',
        sizeBytes: fakePng.length,
      }),
    );

    const rawRes = await api(
      'GET',
      `/api/runs/${run.id}/artifacts/raw?path=${encodeURIComponent('screenshots/home.png')}`,
    );
    expect(rawRes.statusCode).toBe(200);
    expect(rawRes.headers['content-type']).toBe('image/png');
    expect(rawRes.rawPayload).toEqual(fakePng);

    const traversalRes = await api(
      'GET',
      `/api/runs/${run.id}/artifacts/raw?path=${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(traversalRes.statusCode).toBe(400);
  });
});
