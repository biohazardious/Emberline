import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AnswerResponse } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projects, runEvents, runs, tickets } from './db/schema.js';
import * as gitExec from './git-exec.js';
import { authHeaders, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let main: string;
let ticketNo = 0;

vi.mock('./git-exec.js', async (orig) => {
  const actual = await orig<typeof gitExec>();
  return { ...actual, execGitFile: vi.fn(actual.execGitFile) };
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const write = (dir: string, name: string, body: string) => writeFileSync(path.join(dir, name), body);

beforeEach(async () => {
  t = await createTestApp();
  cookie = await setupAndLogin(t.app);
  main = path.join(t.dir, 'p1');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  write(main, 'app.js', 'line1\nline2\nline3\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  t.db.insert(projects).values({ id: 'p1', name: 'p1', slug: 'p1', path: main, createdAt: new Date() }).run();
  ticketNo = 0;
});
afterEach(async () => {
  await t.close();
  vi.mocked(gitExec.execGitFile).mockClear();
});

function addTicket(key: string, status: string): string {
  const id = `tk-${key}`;
  const number = Number(key.split('-')[1] ?? ++ticketNo);
  t.db
    .insert(tickets)
    .values({
      id,
      projectId: 'p1',
      number,
      key,
      title: key,
      status,
      position: number,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

function worktree(id: string, files: Record<string, string>): { worktreePath: string; branch: string } {
  const worktreePath = path.join(t.dir, '.worktrees', id);
  const branch = `emberline/${id}`;
  git(main, 'worktree', 'add', '-q', '-b', branch, worktreePath, 'main');
  for (const [name, body] of Object.entries(files)) write(worktreePath, name, body);
  git(worktreePath, 'add', '-A');
  git(worktreePath, 'commit', '-q', '-m', `feat(${id}): work`);
  return { worktreePath, branch };
}

interface RunSeed {
  id: string;
  agent?: string;
  ticketKey?: string;
  branch?: string | null;
  worktreePath?: string;
  ended?: boolean;
  /** Who stopped it: `system` = the pipeline's factory_step_finished stop. */
  stops?: {
    source: 'system' | 'user';
    reason?: string;
    type?: 'stop_requested' | 'cancelled';
    payload?: Record<string, unknown>;
  }[];
  /** The hold note after the run's switch to done; null for none. */
  hold?: { type: string; payload: Record<string, unknown> } | null;
  completionTool?: boolean;
  permissionMode?: 'default' | 'acceptEdits' | 'auto';
}

function seedRun(seed: RunSeed): string {
  const now = new Date();
  const ticketId = addTicket(seed.ticketKey ?? `EL-${100 + ++ticketNo}`, 'review');
  t.db
    .insert(runs)
    .values({
      id: seed.id,
      projectId: 'p1',
      ticketId,
      agent: seed.agent ?? 'claude',
      // A headless CLI (gemini) refuses a prompt in Ask, so it runs Autonomous.
      permissionMode: seed.permissionMode ?? (seed.agent === 'gemini' ? 'auto' : 'default'),
      state: 'done',
      branch: seed.branch ?? null,
      worktreePath: seed.worktreePath ?? path.join(t.dir, '.worktrees', seed.id),
      hookTokenHash: 'h',
      agentSessionId: 'sess',
      stateChangedAt: now,
      createdAt: now,
      endedAt: seed.ended === false ? null : now,
      cancelledAt: seed.stops?.length ? now : null,
    })
    .run();
  if (seed.completionTool)
    t.db
      .insert(runEvents)
      .values({ runId: seed.id, ts: now, source: 'system', type: 'completion_tool_ready', payload: null })
      .run();
  for (const stop of seed.stops ?? []) {
    t.db
      .insert(runEvents)
      .values({
        runId: seed.id,
        ts: now,
        source: stop.source,
        type: stop.type ?? 'stop_requested',
        payload: stop.payload ?? (stop.reason ? { reason: stop.reason } : null),
      })
      .run();
  }
  t.db
    .insert(runEvents)
    .values({ runId: seed.id, ts: now, source: 'hook', type: 'Stop', state: 'done', payload: null })
    .run();
  const hold =
    seed.hold === undefined
      ? { type: 'merge_failed', payload: { conflicts: ['app.js'], autoFix: false } }
      : seed.hold;
  if (hold) t.runs.note(seed.id, hold.type, hold.payload);
  return seed.id;
}

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });

function event(runId: string, type: string, payload: Record<string, unknown> | null, state?: string) {
  t.db
    .insert(runEvents)
    .values({ runId, ts: new Date(), source: 'hook', type, payload, state: state ?? null })
    .run();
}

function waiting(id: string) {
  seedRun({ id, hold: null, ended: false });
  t.db.update(runs).set({ state: 'waiting_input' }).where(eq(runs.id, id)).run();
}

describe('GET /api/runs/:id/question', () => {
  it('blocked: the blockers', async () => {
    seedRun({ id: 'b1', hold: { type: 'completion_blocked', payload: { blockers: ['no API key'] } } });
    const res = await get('/api/runs/b1/question');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'blocked',
      text: 'no API key',
      source: 'blockers',
      options: [],
    });
  });

  it('a waiting run: its last message and the options in it', async () => {
    waiting('q1');
    event('q1', 'Stop', { last_assistant_message: 'Which colour?\n1. Red\n2. Green' }, 'waiting_input');
    const res = await get('/api/runs/q1/question');
    expect(res.json()).toMatchObject({
      kind: 'question',
      source: 'last_message',
      options: [
        { label: 'Red', detail: null },
        { label: 'Green', detail: null },
      ],
      picker: false,
    });
  });

  it('an open AskUserQuestion picker', async () => {
    waiting('q2');
    event('q2', 'Stop', { last_assistant_message: 'thinking' }, 'waiting_input');
    event('q2', 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      ask_user_question: {
        questions: [{ question: 'Colour?', header: null, options: [{ label: 'Red', detail: null }] }],
      },
    });
    expect((await get('/api/runs/q2/question')).json()).toMatchObject({
      source: 'ask_user_question',
      picker: true,
    });
  });

  it('a picker that was answered is not open', async () => {
    waiting('q3');
    event('q3', 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      ask_user_question: { questions: [{ question: 'Colour?', header: null, options: [] }] },
    });
    event('q3', 'PostToolUse', { tool_name: 'AskUserQuestion' });
    event('q3', 'Stop', { last_assistant_message: 'Done?' }, 'waiting_input');
    expect((await get('/api/runs/q3/question')).json()).toMatchObject({
      source: 'last_message',
      picker: false,
    });
  });

  it('an open picker raises a permission notification: still a question, suggestible', async () => {
    waiting('q4');
    event('q4', 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      ask_user_question: {
        questions: [{ question: 'Colour?', header: null, options: [{ label: 'Red', detail: null }] }],
      },
    });
    event(
      'q4',
      'Notification',
      { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      'waiting_input',
    );
    const body = (await get('/api/runs/q4/question')).json();
    expect(body).toMatchObject({ kind: 'question', picker: true, source: 'ask_user_question' });
    expect(body.suggest.reason).not.toMatch(/permission/i);
  });

  it('a permission prompt without a picker stays a permission', async () => {
    waiting('q5');
    event(
      'q5',
      'Notification',
      { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      'waiting_input',
    );
    expect((await get('/api/runs/q5/question')).json()).toMatchObject({ kind: 'permission' });
  });

  const PICKER = {
    tool_name: 'AskUserQuestion',
    ask_user_question: {
      questions: [{ question: 'Colour?', header: null, options: [{ label: 'Red', detail: null }] }],
    },
  };
  const PERMISSION = { notification_type: 'permission_prompt', message: 'Claude needs your permission' };

  it('a picker before a Stop is closed: a later permission prompt is a permission', async () => {
    waiting('s1');
    event('s1', 'PreToolUse', PICKER);
    event('s1', 'Stop', { last_assistant_message: 'ok' });
    event('s1', 'Notification', PERMISSION, 'waiting_input');
    expect((await get('/api/runs/s1/question')).json()).toMatchObject({ kind: 'permission', picker: false });
  });

  it('a picker before a new prompt is closed', async () => {
    waiting('s2');
    event('s2', 'PreToolUse', PICKER);
    event('s2', 'UserPromptSubmit', null);
    event('s2', 'Stop', { last_assistant_message: 'Done?' }, 'waiting_input');
    expect((await get('/api/runs/s2/question')).json()).toMatchObject({
      source: 'last_message',
      picker: false,
    });
  });

  it('a picker followed by another tool is closed', async () => {
    waiting('s3');
    event('s3', 'PreToolUse', PICKER);
    event('s3', 'PreToolUse', { tool_name: 'Bash' });
    event('s3', 'Notification', PERMISSION, 'waiting_input');
    expect((await get('/api/runs/s3/question')).json()).toMatchObject({ kind: 'permission', picker: false });
  });

  it('suggest is unavailable while Claude is not signed in, with the reason', async () => {
    seedRun({ id: 'b2', hold: { type: 'completion_blocked', payload: { blockers: ['x'] } } });
    expect((await get('/api/runs/b2/question')).json().suggest).toEqual({
      available: false,
      reason: 'Claude Code is not signed in.',
    });
  });

  it('404 no_question for a run that needs nothing', async () => {
    seedRun({ id: 'n1', hold: null });
    const res = await get('/api/runs/n1/question');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_question');
  });
});

describe('POST /api/runs/:id/answer', () => {
  let ptydServer: PtydServer;

  beforeEach(async () => {
    const file = path.join(t.dir, 'fake-claude.sh');
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        // Written whole, then appended in one go: a reader never sees a half-written start.
        `printf '%s\\n' "$@" > "${t.dir}/.args-$EMBERLINE_RUN_ID.$$"`,
        `cat "${t.dir}/.args-$EMBERLINE_RUN_ID.$$" >> "${t.dir}/args-$EMBERLINE_RUN_ID"`,
        `rm -f "${t.dir}/.args-$EMBERLINE_RUN_ID.$$"`,
        `printf %s "$EMBERLINE_HOOK_TOKEN" > "${t.dir}/.token-$EMBERLINE_RUN_ID"`,
        `mv "${t.dir}/.token-$EMBERLINE_RUN_ID" "${t.dir}/token-$EMBERLINE_RUN_ID"`,
        'read line',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    t.config.claudeCommand = file;
    ptydServer = new PtydServer({ socketPath: t.config.ptydSocket });
    await ptydServer.listen();
    t.ptyd.start();
    await t.ptyd.waitUntilConnected();
  });
  afterEach(async () => {
    t.scheduler.dispose();
    for (const run of t.runs.list()) {
      if (!run.endedAt) await t.runs.stop(run.id).catch(() => undefined);
    }
    await ptydServer.close();
  });

  const post = (url: string, payload?: object) =>
    t.app.inject({ method: 'POST', url, payload, headers: authHeaders(cookie) });
  /** The arguments the fake CLI was started with for `runId` (every start appends). */
  async function argsOf(runId: string): Promise<string> {
    const file = path.join(t.dir, `args-${runId}`);
    await expect
      .poll(() => existsSync(file) && readFileSync(file, 'utf8').length > 0, { timeout: 5_000 })
      .toBe(true);
    return readFileSync(file, 'utf8');
  }
  /** The prompt of the run's latest `--resume <session>` start. */
  const resumedWith = async (runId: string) =>
    (await argsOf(runId)).split('--resume\nsess\n--\n').at(-1)!.replace(/\n$/, '');
  const blocked = { type: 'completion_blocked', payload: { blockers: ['no key'] } };

  it('a blocked run gets the template with the answer and the stored file', async () => {
    const wt = worktree('a1', { 'app.js': 'x\n' });
    seedRun({ id: 'a1', ...wt, hold: blocked });
    const res = await post('/api/runs/a1/answer', {
      text: 'use the test key',
      attachments: [
        { name: 'note.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnswerResponse;
    expect(body.delivery).toBe('session');
    expect(body.attachments[0]).toMatch(/^\.emberline\/attachments\/answers\/\d{8}-\d{6}-1-note\.txt$/);
    expect(readFileSync(path.join(wt.worktreePath, body.attachments[0]!), 'utf8')).toBe('hello');
    const prompt = await resumedWith('a1');
    expect(prompt).toContain('> no key');
    expect(prompt).toContain('My answer:\n\nuse the test key');
    expect(prompt).toContain(`- ${body.attachments[0]} (text/plain, 5 bytes)`);
  });

  it('files only: the answer section holds just the attachments block', async () => {
    const wt = worktree('a5', { 'app.js': 'x\n' });
    seedRun({ id: 'a5', ...wt, hold: blocked });
    const res = await post('/api/runs/a5/answer', {
      attachments: [{ name: 'note.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }],
    });
    expect(res.statusCode).toBe(200);
    const prompt = await resumedWith('a5');
    expect(prompt).toMatch(
      /My answer:\n\nAttached files \(in your worktree\):\n- \S+ \(text\/plain, 2 bytes\)\n\nContinue the work/,
    );
  });

  it('a planted symlink keeps the file inside the worktree: nothing written outside, nothing sent', async () => {
    const wt = worktree('a2', { 'app.js': 'x\n' });
    seedRun({ id: 'a2', ...wt, hold: blocked });
    const outside = path.join(t.dir, 'outside');
    mkdirSync(outside);
    mkdirSync(path.join(wt.worktreePath, '.emberline'), { recursive: true });
    symlinkSync(outside, path.join(wt.worktreePath, '.emberline', 'attachments'));
    const res = await post('/api/runs/a2/answer', {
      text: 'x',
      attachments: [{ name: 'n.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }],
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('attachment_write_failed');
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(t.dir, 'args-a2'))).toBe(false);
  });

  it('nothing at all is a 400', async () => {
    const wt = worktree('a3', { 'app.js': 'x\n' });
    seedRun({ id: 'a3', ...wt, hold: blocked });
    expect((await post('/api/runs/a3/answer', { text: ' ' })).statusCode).toBe(400);
  });

  it('a run that no longer waits: 404 no_question', async () => {
    seedRun({ id: 'a4', hold: null });
    const res = await post('/api/runs/a4/answer', { text: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_question');
  });

  it('an open picker refuses an answer and writes nothing', async () => {
    const wt = worktree('a6', { 'app.js': 'x\n' });
    seedRun({ id: 'a6', ...wt, hold: null, ended: false });
    t.db.update(runs).set({ state: 'waiting_input' }).where(eq(runs.id, 'a6')).run();
    event('a6', 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      ask_user_question: {
        questions: [{ question: 'Colour?', header: null, options: [{ label: 'Red', detail: null }] }],
      },
    });
    event(
      'a6',
      'Notification',
      { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      'waiting_input',
    );
    const res = await post('/api/runs/a6/answer', {
      text: 'x',
      attachments: [{ name: 'n.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('picker_open');
    expect(existsSync(path.join(wt.worktreePath, '.emberline'))).toBe(false);
    expect(existsSync(path.join(t.dir, 'args-a6'))).toBe(false);
  });
});
