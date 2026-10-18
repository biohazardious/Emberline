import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewComment, Run, RunReviewState } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let server: PtydServer;
let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  // Agent stand-in: leaks its hook token, records the first prompt line it receives.
  const fake = path.join(t.dir, 'fake-claude.sh');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `printf %s "$EMBERLINE_HOOK_TOKEN" > "${t.dir}/.token-$EMBERLINE_RUN_ID"`,
      `mv "${t.dir}/.token-$EMBERLINE_RUN_ID" "${t.dir}/token-$EMBERLINE_RUN_ID"`,
      'read line',
      `printf %s "$line" > "${t.dir}/prompt-$EMBERLINE_RUN_ID"`,
      'sleep 5',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  t.config.claudeCommand = fake;
  server = new PtydServer({ socketPath: t.config.ptydSocket });
  await server.listen();
  t.ptyd.start();
  await t.ptyd.waitUntilConnected();
  cookie = await setupAndLogin(t.app);
});

afterEach(async () => {
  await t.close();
  await server.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload, headers: { ...CSRF, cookie } });

async function startRun(name = 'Review Project'): Promise<Run> {
  const { project } = (await api('POST', '/api/projects', { name })).json();
  return (await api('POST', '/api/runs', { projectId: project.id })).json();
}

/** Lets the stand-in report that it is up and at its prompt (prompts to a starting agent are refused). */
async function ready(run: Run): Promise<void> {
  const file = path.join(t.dir, `token-${run.id}`);
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/internal/hooks',
    headers: { authorization: `Bearer ${readFileSync(file, 'utf8')}` },
    payload: { runId: run.id, event: 'SessionStart', receivedAt: new Date().toISOString(), payload: { session_id: 's' } },
  });
  expect(res.json().state).toBe('waiting_input');
}

describe('persistent code review', () => {
  it('stores comments, sends open ones as one prompt and tracks their status', async () => {
    const run = await startRun();
    const add = (filePath: string, line: number, body: string) =>
      api('POST', `/api/runs/${run.id}/review/comments`, { filePath, line, body });
    const a: ReviewComment = (await add('src/app.ts', 12, 'Handle the empty list')).json();
    await add('src/app.ts', 40, 'Rename this');
    expect((await add('', 1, 'x')).statusCode).toBe(400);

    let state: RunReviewState = (await api('GET', `/api/runs/${run.id}/review`)).json();
    expect(state.comments.map((c) => [c.line, c.status])).toEqual([
      [12, 'open'],
      [40, 'open'],
    ]);

    await ready(run);
    const sent = await api('POST', `/api/runs/${run.id}/review/request-changes`, { note: 'Nearly there' });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().sent).toBe(2);
    const promptFile = path.join(t.dir, `prompt-${run.id}`);
    await expect.poll(() => existsSync(promptFile), { timeout: 5_000 }).toBe(true);
    expect(readFileSync(promptFile, 'utf8')).toContain('Please address the following code review feedback');

    state = (await api('GET', `/api/runs/${run.id}/review`)).json();
    expect(state.comments.every((c) => c.status === 'sent' && c.sentAt)).toBe(true);
    // Nothing open any more: a second request without a note is refused.
    expect((await api('POST', `/api/runs/${run.id}/review/request-changes`, {})).statusCode).toBe(400);

    const resolved: ReviewComment = (
      await api('PATCH', `/api/runs/${run.id}/review/comments/${a.id}`, { status: 'resolved' })
    ).json();
    expect(resolved).toMatchObject({ status: 'resolved' });
    const reopened: ReviewComment = (
      await api('PATCH', `/api/runs/${run.id}/review/comments/${a.id}`, { status: 'open' })
    ).json();
    // Reopened ("Not done"): open again, so the next batch sends it; its history stays.
    expect(reopened).toMatchObject({ status: 'open', round: 1 });
    expect(reopened.sentAt).toBeTruthy();

    expect((await api('DELETE', `/api/runs/${run.id}/review/comments/${a.id}`)).statusCode).toBe(204);
    expect((await api('DELETE', `/api/runs/${run.id}/review/comments/${a.id}`)).statusCode).toBe(404);
  });

  it('remembers viewed files with the diff signature that was seen', async () => {
    const run = await startRun();
    const mark = (viewed: boolean, signature = 'modified:3:1') =>
      api('PUT', `/api/runs/${run.id}/review/viewed`, { filePath: 'src/app.ts', signature, viewed });
    expect((await mark(true)).json().viewed).toMatchObject([{ filePath: 'src/app.ts', signature: 'modified:3:1' }]);
    expect((await mark(true, 'modified:5:1')).json().viewed).toMatchObject([{ signature: 'modified:5:1' }]);
    expect((await mark(false)).json().viewed).toEqual([]);
  });

  it('is scoped to the run', async () => {
    const run = await startRun();
    const other = await startRun('Other Project');
    const c: ReviewComment = (
      await api('POST', `/api/runs/${run.id}/review/comments`, { filePath: 'a.ts', line: 1, body: 'x' })
    ).json();
    expect((await api('PATCH', `/api/runs/${other.id}/review/comments/${c.id}`, { body: 'y' })).statusCode).toBe(404);
    expect((await api('GET', '/api/runs/nope/review')).statusCode).toBe(404);
  });
});
