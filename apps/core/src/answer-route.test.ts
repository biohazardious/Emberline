import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AnswerResponse } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCommandExecutor, localCommandExecutor } from './command-exec.js';
import { pickerTiming } from './runs/question-service.js';
import { projects, runEvents, runs, tickets } from './db/schema.js';
import { updateFactorySettings } from './factory/settings.js';
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

  /** A waiting run with an open picker of two options; the session is a spy, so nothing is typed. */
  function openPicker(id: string) {
    const wt = worktree(id, { 'app.js': 'x\n' });
    seedRun({ id, ...wt, hold: null, ended: false });
    t.db.update(runs).set({ state: 'waiting_input' }).where(eq(runs.id, id)).run();
    event(id, 'PreToolUse', {
      tool_name: 'AskUserQuestion',
      ask_user_question: {
        questions: [
          {
            question: 'Colour?',
            header: null,
            options: [
              { label: 'Red', detail: null },
              { label: 'Green', detail: null },
            ],
          },
        ],
      },
    });
    event(
      id,
      'Notification',
      { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      'waiting_input',
    );
    const calls: string[] = [];
    vi.spyOn(t.runs, 'sendKeys').mockImplementation(async (_id, keys) => {
      calls.push(`keys:${JSON.stringify(keys)}`);
    });
    vi.spyOn(t.runs, 'prompt').mockImplementation(async (rid, text) => {
      calls.push(`prompt:${text}`);
      return t.runs.getRun(rid);
    });
    return { wt, calls };
  }

  it('an option on an open picker selects it by its number', async () => {
    const { calls } = openPicker('a6');
    const res = await post('/api/runs/a6/answer', { option: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivery: 'picker', attachments: [] });
    expect(calls).toEqual(['prompt:2']);
  });

  it('an option the picker does not offer is a 400', async () => {
    const { calls } = openPicker('a10');
    const res = await post('/api/runs/a10/answer', { option: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_option');
    expect(res.json().message).toBe('That option is not offered.');
    expect(calls).toEqual([]);
  });

  it('text with a picker open cancels the picker first, then sends the text', async () => {
    pickerTiming.cancelWaitMs = 5;
    const { wt, calls } = openPicker('a11');
    const res = await post('/api/runs/a11/answer', {
      text: 'something else',
      attachments: [{ name: 'n.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnswerResponse;
    expect(body.delivery).toBe('session');
    expect(body.attachments).toHaveLength(1);
    expect(existsSync(path.join(wt.worktreePath, body.attachments[0]!))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('keys:"\\u001b"');
    expect(calls[1]).toContain('something else');
  });

  it('an option on a blocked run says the picker is closed: nothing written, nothing sent', async () => {
    const wt = worktree('a7', { 'app.js': 'x\n' });
    seedRun({ id: 'a7', ...wt, hold: blocked });
    const res = await post('/api/runs/a7/answer', { option: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('picker_closed');
    expect(res.json().message).toBe('This question has no open picker any more.');
    expect(existsSync(path.join(wt.worktreePath, '.emberline'))).toBe(false);
    expect(existsSync(path.join(t.dir, 'args-a7'))).toBe(false);
  });

  it('a permission prompt is never answered with text', async () => {
    const wt = worktree('a8', { 'app.js': 'x\n' });
    seedRun({ id: 'a8', ...wt, hold: null, ended: false });
    t.db.update(runs).set({ state: 'waiting_input' }).where(eq(runs.id, 'a8')).run();
    event(
      'a8',
      'Notification',
      { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      'waiting_input',
    );
    const res = await post('/api/runs/a8/answer', { text: 'yes' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('permission_prompt');
    expect(existsSync(path.join(t.dir, 'args-a8'))).toBe(false);
  });

  it('a failed write says so in a plain sentence', async () => {
    const wt = worktree('a9', { 'app.js': 'x\n' });
    seedRun({ id: 'a9', ...wt, hold: blocked });
    mkdirSync(path.join(wt.worktreePath, '.emberline'), { recursive: true });
    symlinkSync(t.dir, path.join(wt.worktreePath, '.emberline', 'attachments'));
    const res = await post('/api/runs/a9/answer', {
      text: 'x',
      attachments: [{ name: 'n.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }],
    });
    expect(res.json().message).toBe(
      "Couldn't store n.txt in the run's worktree. Try again, or send the answer without it.",
    );
  });

  it('a waiting question gets the text as written, in its session', async () => {
    const wt = worktree('a10', { 'app.js': 'x\n' });
    seedRun({ id: 'a10', ...wt, hold: null, ended: false });
    t.db.update(runs).set({ state: 'waiting_input' }).where(eq(runs.id, 'a10')).run();
    event('a10', 'Stop', { last_assistant_message: 'Which colour?' }, 'waiting_input');
    const res = await post('/api/runs/a10/answer', { text: 'green' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as AnswerResponse).delivery).toBe('session');
    expect(await resumedWith('a10')).toBe('green');
  });

  it('a held run gets the edited prompt unchanged', async () => {
    const wt = worktree('a11', { 'app.js': 'x\n' });
    seedRun({ id: 'a11', ...wt });
    const res = await post('/api/runs/a11/answer', { text: 'Resolve the conflicts in app.js.' });
    expect(res.statusCode).toBe(200);
    expect(await resumedWith('a11')).toBe('Resolve the conflicts in app.js.');
  });
});

describe('POST /api/runs/:id/question/suggest', () => {
  afterEach(() => setCommandExecutor(localCommandExecutor));
  const post = (url: string) => t.app.inject({ method: 'POST', url, headers: authHeaders(cookie) });
  const reply = (answer: string) =>
    ({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ structured_output: { answer } }),
      stderr: '',
      timedOut: false,
      durationMs: 1,
    }) as never;
  const blocked = { type: 'completion_blocked', payload: { blockers: ['no key'] } };
  const signedIn = () => updateFactorySettings(t.db, { anthropicApiKey: 'k' });

  it('200 with the drafted answer, run in the worktree', async () => {
    signedIn();
    seedRun({ id: 'g1', hold: blocked });
    let seen: { cwd: string; args: string[] } | undefined;
    setCommandExecutor(async (r) => {
      seen = { cwd: r.cwd, args: r.args };
      return reply('Use the test key.');
    });
    const res = await post('/api/runs/g1/question/suggest');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answer: 'Use the test key.' });
    expect(seen?.cwd).toBe(path.join(t.dir, '.worktrees', 'g1'));
    expect(seen?.args.join(' ')).toContain('no key');
  });

  it('a second suggestion while one is running is 409 suggest_busy', async () => {
    signedIn();
    seedRun({ id: 'g2', hold: blocked });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (entered = r));
    setCommandExecutor(async () => {
      entered();
      await gate;
      return reply('first');
    });
    const first = post('/api/runs/g2/question/suggest');
    await started;
    const second = await post('/api/runs/g2/question/suggest');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('suggest_busy');
    release();
    expect((await first).statusCode).toBe(200);
    setCommandExecutor(async () => reply('again'));
    expect((await post('/api/runs/g2/question/suggest')).statusCode).toBe(200);
  });

  it('409 suggest_unavailable while Claude is not signed in', async () => {
    seedRun({ id: 'g3', hold: blocked });
    const res = await post('/api/runs/g3/question/suggest');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'suggest_unavailable',
      message: 'Claude Code is not signed in.',
    });
  });

  it('an unreachable runner passes through and frees the run', async () => {
    signedIn();
    seedRun({ id: 'g4', hold: blocked });
    const { HttpError } = await import('./errors.js');
    setCommandExecutor(async () => {
      throw new HttpError(503, 'runner_unavailable', 'The runner is not reachable.');
    });
    const res = await post('/api/runs/g4/question/suggest');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('runner_unavailable');
    setCommandExecutor(async () => reply('ok'));
    expect((await post('/api/runs/g4/question/suggest')).statusCode).toBe(200);
  });
});
