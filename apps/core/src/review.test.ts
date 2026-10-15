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
  RunForgeStatus,
  ScheduledJob,
} from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeNextCronDate } from './cron/service.js';
import { parseForgeRemote } from './forge/service.js';
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

  it('prunes an ended run worktree while keeping the branch and blocking active run prune', async () => {
    const { project } = await createGitProjectWithBareRemote('Prune App');
    const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'prune' })).json();

    // Active run cannot be pruned yet
    const activePrune = await api('POST', `/api/runs/${run.id}/worktree/prune`, {});
    expect(activePrune.statusCode).toBe(409);

    // Stop run, wait for process exit, then prune worktree
    await api('POST', `/api/runs/${run.id}/stop`);
    await expect
      .poll(async () => {
        await t.runs.reconcile();
        return ((await api('GET', `/api/runs/${run.id}`)).json() as Run).endedAt;
      })
      .toBeTruthy();

    const prunedRes = await api('POST', `/api/runs/${run.id}/worktree/prune`, {});
    expect(prunedRes.statusCode).toBe(200);
    expect(prunedRes.json()).toEqual({
      runId: run.id,
      worktreePath: run.worktreePath,
      removed: true,
    });

    // Repeat prune is idempotent (removed: false)
    const secondPrune = await api('POST', `/api/runs/${run.id}/worktree/prune`, {});
    expect(secondPrune.statusCode).toBe(200);
    expect(secondPrune.json().removed).toBe(false);
  });

  it('configures and dispatches ntfy / webhook notifications', async () => {
    const { createServer } = await import('node:http');
    const received: { headers: Record<string, unknown>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    const webhookUrl = `http://127.0.0.1:${address.port}/hook`;

    try {
      const patchRes = await t.app.inject({
        method: 'PATCH',
        url: '/api/notifications',
        headers: { ...CSRF, cookie },
        payload: {
          enabled: true,
          provider: 'webhook',
          url: webhookUrl,
          token: 'secret-tok',
          onRateLimited: true,
          onQuotaResumed: true,
          onWaitingInput: true,
          onRunFinished: true,
        },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({
        enabled: true,
        provider: 'webhook',
        url: webhookUrl,
        token: 'secret-tok',
      });

      const testRes = await api('POST', '/api/notifications/test', {});
      expect(testRes.statusCode).toBe(200);
      expect(testRes.json()).toEqual({ ok: true, status: 200, error: null });
      expect(received).toHaveLength(1);
      expect(received[0]?.headers.authorization).toBe('Bearer secret-tok');
      expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({
        event: 'test',
        title: 'Emberline test notification',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('parses forge remotes, builds compare URLs, and creates a PR with CI status via ForgeService', async () => {
    const gh = parseForgeRemote('git@github.com:acme/emberline.git', 'auto', null, 'main', 'emberline/run-1');
    expect(gh).toMatchObject({
      provider: 'github',
      repoPath: 'acme/emberline',
      repoWebUrl: 'https://github.com/acme/emberline',
      apiBaseUrl: 'https://api.github.com',
      compareUrl: 'https://github.com/acme/emberline/compare/main...emberline%2Frun-1?expand=1',
    });

    const gl = parseForgeRemote('https://gitlab.example.com/group/sub/app.git', 'auto', null, 'main', 'feat/x');
    expect(gl).toMatchObject({
      provider: 'gitlab',
      repoPath: 'group/sub/app',
      compareUrl:
        'https://gitlab.example.com/group/sub/app/-/merge_requests/new?merge_request[source_branch]=feat%2Fx&merge_request[target_branch]=main',
    });

    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/repos/acme/widget/pulls') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            number: 42,
            title: 'Add widget feature',
            html_url: 'https://github.com/acme/widget/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc1234' },
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/repos/acme/widget/commits/abc1234/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'success' }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    const apiBase = `http://127.0.0.1:${address.port}`;

    try {
      const { project } = await createGitProjectWithBareRemote('Forge App');
      const run: Run = (await api('POST', '/api/runs', { projectId: project.id, prompt: 'pr test' })).json();
      execFileSync('git', ['-C', run.worktreePath, 'remote', 'set-url', 'origin', 'git@github.com:acme/widget.git']);

      const patchForge = await t.app.inject({
        method: 'PATCH',
        url: '/api/forge',
        headers: { ...CSRF, cookie },
        payload: {
          provider: 'github',
          apiUrl: apiBase,
          token: 'ghp_test_token_123',
        },
      });
      expect(patchForge.statusCode).toBe(200);
      expect(patchForge.json()).toEqual({
        provider: 'github',
        apiUrl: apiBase,
        tokenConfigured: true,
      });

      const statusBefore: RunForgeStatus = (await api('GET', `/api/runs/${run.id}/forge`)).json();
      expect(statusBefore.provider).toBe('github');
      expect(statusBefore.repoPath).toBe('acme/widget');
      expect(statusBefore.compareUrl).toContain('https://github.com/acme/widget/compare/');
      expect(statusBefore.pullRequest).toBeNull();

      const createPrRes = await api('POST', `/api/runs/${run.id}/forge/pr`, {
        title: 'Add widget feature',
        body: 'Implements widget',
        draft: false,
        pushFirst: false,
      });
      expect(createPrRes.statusCode).toBe(200);
      const statusAfter: RunForgeStatus = createPrRes.json();
      expect(statusAfter.pullRequest).toMatchObject({
        provider: 'github',
        number: 42,
        title: 'Add widget feature',
        url: 'https://github.com/acme/widget/pull/42',
        state: 'open',
        ciStatus: 'success',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('creates, updates, triggers, and deletes scheduled cron agent jobs', async () => {
    const base = new Date('2026-10-14T01:30:00.000Z');
    const nextDaily = computeNextCronDate('0 2 * * *', base);
    expect(nextDaily.toISOString()).toBe('2026-10-14T02:00:00.000Z');

    const { project } = await createGitProjectWithBareRemote('Cron App');

    // Invalid cron expression should return 400
    const badRes = await api('POST', '/api/cron', {
      projectId: project.id,
      name: 'Bad Job',
      cronExpr: 'not a cron',
      prompt: 'test',
    });
    expect(badRes.statusCode).toBe(400);

    // Create valid scheduled job
    const createRes = await api('POST', '/api/cron', {
      projectId: project.id,
      name: 'Nightly Test Suite',
      cronExpr: '0 2 * * *',
      prompt: 'Run tests and fix failures',
      permissionMode: 'acceptEdits',
    });
    expect(createRes.statusCode).toBe(201);
    const job: ScheduledJob = createRes.json();
    expect(job.name).toBe('Nightly Test Suite');
    expect(job.enabled).toBe(true);
    expect(job.lastRunId).toBeNull();

    // Pause and re-enable job
    const patchRes = await t.app.inject({
      method: 'PATCH',
      url: `/api/cron/${job.id}`,
      headers: { ...CSRF, cookie },
      payload: { enabled: false },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as ScheduledJob).enabled).toBe(false);

    // Trigger job manually ("Run Now")
    const triggerRes = await api('POST', `/api/cron/${job.id}/trigger`, {});
    expect(triggerRes.statusCode).toBe(200);
    const triggered = triggerRes.json() as { job: ScheduledJob; run: Run };
    expect(triggered.run.projectId).toBe(project.id);
    expect(triggered.job.lastRunId).toBe(triggered.run.id);
    expect(triggered.job.lastRunAt).toBeTruthy();

    // Delete job
    const delRes = await api('DELETE', `/api/cron/${job.id}`);
    expect(delRes.statusCode).toBe(204);
    const listAfter: ScheduledJob[] = (await api('GET', '/api/cron')).json();
    expect(listAfter).toHaveLength(0);
  });

  it('starts/stops per-worktree preview environments and supports secondary CLI adapters (codex/aider)', async () => {
    const { buildSecondaryCliLaunchSpec } = await import('@emberline/adapter-claude');
    const codexSpec = buildSecondaryCliLaunchSpec({
      agent: 'codex',
      runId: 'run-codex-1234',
      hookToken: 'tok',
      coreUrl: 'http://127.0.0.1:7420',
      permissionMode: 'auto',
      prompt: 'Fix lint',
    });
    expect(codexSpec.file).toBe('sh');
    expect(codexSpec.args[1]).toContain('--full-auto');
    expect(codexSpec.env.EMBERLINE_PROMPT).toBe('Fix lint');

    const { project } = await createGitProjectWithBareRemote('Preview App');
    const run: Run = (
      await api('POST', '/api/runs', {
        projectId: project.id,
        agent: 'codex',
        prompt: 'build preview',
      })
    ).json();
    expect(run.agent).toBe('codex');

    writeFileSync(
      path.join(run.worktreePath, 'package.json'),
      JSON.stringify({ name: 'preview-app', scripts: { dev: 'node -e "setInterval(()=>{},1000)"' } }),
    );

    const statusBefore = (await api('GET', `/api/runs/${run.id}/preview`)).json();
    expect(statusBefore).toMatchObject({
      runId: run.id,
      status: 'stopped',
      detectedCommand: 'npm run dev',
    });

    const startRes = await api('POST', `/api/runs/${run.id}/preview/start`, {
      command: 'sleep 10',
      port: 3456,
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json()).toMatchObject({
      runId: run.id,
      status: 'running',
      command: 'sleep 10',
      port: 3456,
      url: 'http://localhost:3456',
    });

    const stopRes = await api('POST', `/api/runs/${run.id}/preview/stop`, {});
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json()).toMatchObject({
      runId: run.id,
      status: 'stopped',
      terminalId: null,
    });
  });
});




