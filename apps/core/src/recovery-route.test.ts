import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONTINUE_PROMPT } from '@emberline/adapter-claude';
import type { RecoverResponse, Run, RunRecovery } from '@emberline/protocol';
import { PtydServer } from '@emberline/ptyd/server';
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projects, reviewComments, runEvents, runs, tickets } from './db/schema.js';
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
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
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
    .values({ id, projectId: 'p1', number, key, title: key, status, position: number, createdAt: new Date(), updatedAt: new Date() })
    .run();
  return id;
}

/** A worktree on its own branch off main, with `files` committed in it. */
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
  stops?: { source: 'system' | 'user'; reason?: string; type?: 'stop_requested' | 'cancelled'; payload?: Record<string, unknown> }[];
  handedOffTo?: string;
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
      handedOffTo: seed.handedOffTo ?? null,
    })
    .run();
  if (seed.completionTool) t.db.insert(runEvents).values({ runId: seed.id, ts: now, source: 'system', type: 'completion_tool_ready', payload: null }).run();
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
  t.db.insert(runEvents).values({ runId: seed.id, ts: now, source: 'hook', type: 'Stop', state: 'done', payload: null }).run();
  const hold = seed.hold === undefined ? { type: 'merge_failed', payload: { conflicts: ['app.js'], autoFix: false } } : seed.hold;
  if (hold) t.runs.note(seed.id, hold.type, hold.payload);
  return seed.id;
}

async function recovery(id: string): Promise<{ status: number; body: RunRecovery | null }> {
  const res = await t.app.inject({ method: 'GET', url: `/api/runs/${id}/recovery`, headers: { cookie } });
  return { status: res.statusCode, body: res.statusCode === 200 ? (res.json() as RunRecovery | null) : null };
}

/** Moves main on: a commit that changes app.js like the run's branch does, so they conflict. */
function conflictOnMain(): void {
  write(main, 'app.js', 'line1\nfrom-main\nline3\n');
  git(main, 'commit', '-q', '-am', 'feat(EL-12): main side');
}

describe('GET /api/runs/:id/recovery', () => {
  it('needs a session', async () => {
    seedRun({ id: 'r1' });
    expect((await t.app.inject({ method: 'GET', url: '/api/runs/r1/recovery' })).statusCode).toBe(401);
  });

  it('is null for a run that is not held', async () => {
    seedRun({ id: 'r1', hold: null });
    const res = await t.app.inject({ method: 'GET', url: '/api/runs/r1/recovery', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('is null once the ticket left Review (the hold is no longer anyone\'s)', async () => {
    seedRun({ id: 'r1' });
    t.db.update(tickets).set({ status: 'done' }).run();
    expect(await recovery('r1')).toEqual({ status: 200, body: null });
  });

  it('404 for an unknown run', async () => {
    expect((await recovery('nope')).status).toBe(404);
  });

  it('merge_failed: compares the branch with main now and suggests resolving the current conflicts', async () => {
    const wt = worktree('r1', { 'app.js': 'line1\nfrom-run\nline3\n' });
    conflictOnMain();
    seedRun({ id: 'r1', ...wt, hold: { type: 'merge_failed', payload: { conflicts: ['stale.txt'], autoFix: false } }, completionTool: true });
    const { status, body } = await recovery('r1');
    expect(status).toBe(200);
    expect(body).toMatchObject({ hold: 'merge_failed', label: 'Merge failed', delivery: 'session', why: 'main moved on and 1 file now conflicts: app.js' });
    expect(body!.suggestions.map((s) => s.kind)).toEqual(['prompt', 'discard', 'manual']);
    expect(body!.suggestions[0]!.prompt).toContain('conflicts in: app.js');
    expect(body!.suggestions[0]!.prompt!.endsWith('When finished, call `ticket_complete` again.')).toBe(true);
    expect(body!.suggestions[2]!.commands[0]).toBe(`git -C ${wt.worktreePath} merge main`);
  });

  it('merge_failed that merges cleanly now: Merge now, Discard', async () => {
    const wt = worktree('r1', { 'new.js': 'x\n' });
    seedRun({ id: 'r1', ...wt });
    const { body } = await recovery('r1');
    expect(body!.suggestions.map((s) => s.kind)).toEqual(['merge', 'discard']);
  });

  it('merge_failed against a branch that is gone: "could not compare with main", never a 500', async () => {
    seedRun({ id: 'r1', branch: 'emberline/gone' });
    const { status, body } = await recovery('r1');
    expect(status).toBe(200);
    expect(body!.why).toBe('could not compare with main: Needed a single revision');
    expect(body!.suggestions.map((s) => s.kind)).toEqual(['prompt', 'discard', 'manual']);
    expect(body!.suggestions[0]!.prompt).toContain('app.js');
  });

  /** EL-10 added a, b and c and was merged into main; the run's branch adds the same files. */
  function superseded(el10Status: string): void {
    addTicket('EL-10', el10Status);
    git(main, 'checkout', '-q', '-b', 'emberline/el-10');
    for (const f of ['a', 'b', 'c']) write(main, f, 'from EL-10\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'feat(EL-10): factory run output');
    git(main, 'checkout', '-q', 'main');
    git(main, 'merge', '--no-ff', '--no-edit', '-q', '-m', 'Merge EL-10 (emberline/el-10)', 'emberline/el-10');
  }

  it('superseded by a done ticket: Discard first, naming it', async () => {
    const wt = worktree('r1', { a: 'mine\n', b: 'mine\n', c: 'mine\n' });
    superseded('done');
    seedRun({ id: 'r1', ticketKey: 'EL-6', ...wt });
    const { body } = await recovery('r1');
    expect(body!.suggestions[0]).toMatchObject({ kind: 'discard', detail: 'EL-10 already added these files (3 of 3 conflicts)' });
  });

  it('a second read with unchanged heads looks nothing up again', async () => {
    const wt = worktree('r1', { a: 'mine\n', b: 'mine\n', c: 'mine\n' });
    superseded('done');
    seedRun({ id: 'r1', ticketKey: 'EL-6', ...wt });
    const logCalls = () => vi.mocked(gitExec.execGitFile).mock.calls.filter(([args]) => args.includes('log')).length;
    const first = await recovery('r1');
    const before = logCalls();
    expect(before).toBeGreaterThan(0);
    const second = await recovery('r1');
    expect(logCalls()).toBe(before);
    expect(second.body).toEqual(first.body);
  });

  it('superseded by a ticket that is not done: Discard is not first', async () => {
    const wt = worktree('r1', { a: 'mine\n', b: 'mine\n', c: 'mine\n' });
    superseded('review');
    seedRun({ id: 'r1', ticketKey: 'EL-6', ...wt });
    const { body } = await recovery('r1');
    expect(body!.suggestions[0]!.kind).toBe('prompt');
  });

  it('review_blocked: lists the open blocking comments in the prompt', async () => {
    seedRun({ id: 'r1', hold: { type: 'review_blocked', payload: { count: 1 } } });
    t.db
      .insert(reviewComments)
      .values({ id: 'c1', runId: 'r1', filePath: 'src/a.ts', line: 3, side: 'modified', body: 'use the helper', priority: 'blocking', createdAt: new Date() })
      .run();
    const { body } = await recovery('r1');
    expect(body!.suggestions.map((s) => s.kind)).toEqual(['open_review', 'prompt']);
    expect(body!.suggestions[1]!.prompt).toContain('- src/a.ts:3: use the helper');
  });

  it('holdPrompt is the first prompt suggestion', async () => {
    seedRun({ id: 'r1', hold: { type: 'completion_missing', payload: {} } });
    seedRun({ id: 'r2', hold: null });
    expect(await t.recovery.holdPrompt('r1')).toContain('ticket_complete');
    expect(await t.recovery.holdPrompt('r2')).toBeNull();
  });

  it('holdPrompt skips a prompt the person has to fill in (the blockers answer)', async () => {
    seedRun({ id: 'r1', hold: { type: 'completion_blocked', payload: { blockers: ['which API key?'] } } });
    const { body } = await recovery('r1');
    expect(body!.suggestions[0]).toMatchObject({ id: 'answer_blockers', kind: 'prompt' });
    expect(await t.recovery.holdPrompt('r1')).toBeNull();
  });

  it('no_changes: only an agent with the completion tool is asked to explain and finish', async () => {
    seedRun({ id: 'r1', agent: 'codex', hold: { type: 'no_changes', payload: { autoFix: false } } });
    seedRun({ id: 'r2', completionTool: true, hold: { type: 'no_changes', payload: { autoFix: false } } });
    const codex = (await recovery('r1')).body!;
    expect(codex.why).toBe('the agent ended without changing anything');
    expect(codex.suggestions[0]!.prompt).toContain('explain why in your reply; a person will mark the ticket done.');
    const claude = (await recovery('r2')).body!;
    expect(claude.why).toBe('the agent ended without changing anything or saying what it did');
    expect(claude.suggestions[0]!.prompt).toContain('explain why nothing is needed and finish.');
    expect(claude.suggestions[0]!.prompt).toContain('ticket_complete');
  });
});

describe('RecoveryService.deliveryFor', () => {
  const delivery = (id: string) => t.recovery.deliveryFor(t.runs.getRun(id));
  const legacyStop = { source: 'system' as const, reason: 'factory_step_finished' };

  it('session for a live run and for a resumable one', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'live'), { recursive: true });
    mkdirSync(path.join(t.dir, '.worktrees', 'resumable'), { recursive: true });
    seedRun({ id: 'live', ended: false });
    seedRun({ id: 'resumable' });
    expect(delivery('live')).toBe('session');
    expect(t.runs.getRun('resumable').resumable).toBe(true);
    expect(delivery('resumable')).toBe('session');
  });

  it('successor for a held run the pipeline cancelled before the upgrade, whose worktree exists', async () => {
    const wt = worktree('legacy', { 'new.js': 'x\n' });
    seedRun({ id: 'legacy', ...wt, stops: [legacyStop] });
    expect(delivery('legacy')).toBe('successor');
    expect((await recovery('legacy')).body!.delivery).toBe('successor');
  });

  it('none when a person stopped it, also besides the pipeline stop', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'user'), { recursive: true });
    mkdirSync(path.join(t.dir, '.worktrees', 'both'), { recursive: true });
    seedRun({ id: 'user', stops: [{ source: 'user' }] });
    seedRun({ id: 'both', stops: [legacyStop, { source: 'user' }] });
    expect(delivery('user')).toBe('none');
    expect(delivery('both')).toBe('none');
  });

  it('successor for a real legacy stop: the pipeline stop, then reconcile noting the exit', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'el-2'), { recursive: true });
    seedRun({ id: 'el-2', stops: [legacyStop, { source: 'system', type: 'cancelled', payload: { exitCode: 129, signal: 0 } }] });
    expect(delivery('el-2')).toBe('successor');
  });

  it('none when a person stopped it after the pipeline stop and the exit', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'el-3'), { recursive: true });
    seedRun({
      id: 'el-3',
      stops: [legacyStop, { source: 'system', type: 'cancelled', payload: { exitCode: 129, signal: 0 } }, { source: 'user' }],
    });
    expect(delivery('el-3')).toBe('none');
  });

  it('none for a person cancelling it directly (no agent to stop)', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'queued'), { recursive: true });
    seedRun({ id: 'queued', stops: [{ source: 'user', type: 'cancelled' }] });
    expect(delivery('queued')).toBe('none');
  });

  it('none for a system stop for another reason', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'other'), { recursive: true });
    seedRun({ id: 'other', stops: [{ source: 'system', reason: 'replaced' }] });
    expect(delivery('other')).toBe('none');
  });

  it('none for a handed-off run', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'handed'), { recursive: true });
    seedRun({ id: 'handed', stops: [legacyStop], handedOffTo: 'next' });
    expect(delivery('handed')).toBe('none');
  });

  it('none when the worktree is gone', () => {
    seedRun({ id: 'gone', stops: [legacyStop] });
    expect(delivery('gone')).toBe('none');
  });

  it('none for a resumable run whose worktree is gone', () => {
    seedRun({ id: 'gone' });
    expect(t.runs.getRun('gone').resumable).toBe(true);
    expect(delivery('gone')).toBe('none');
  });

  it('none for a cancelled run that is not held', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'free'), { recursive: true });
    seedRun({ id: 'free', stops: [legacyStop], hold: null });
    expect(delivery('free')).toBe('none');
  });
});

/** Delivering a prompt: these spawn agents, so a ptyd and a fake CLI that logs its arguments. */
describe('delivering a recovery prompt', () => {
  let ptydServer: PtydServer;
  const legacyStop = { source: 'system' as const, reason: 'factory_step_finished' };
  /** Reconcile's note of the exit that followed the pipeline's stop (a real pre-upgrade run, like EL-2). */
  const exitNoted = { source: 'system' as const, type: 'cancelled' as const, payload: { exitCode: 129, signal: 0 } };

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

  const post = (url: string, payload?: object) => t.app.inject({ method: 'POST', url, payload, headers: authHeaders(cookie) });
  const recover = (id: string, text: string) => post(`/api/runs/${id}/recover`, { text });
  /** The arguments the fake CLI was started with for `runId` (every start appends). */
  async function argsOf(runId: string): Promise<string> {
    const file = path.join(t.dir, `args-${runId}`);
    // `>>` creates the file before the start's line lands in it.
    await expect.poll(() => existsSync(file) && readFileSync(file, 'utf8').length > 0, { timeout: 5_000 }).toBe(true);
    return readFileSync(file, 'utf8');
  }
  /** The prompt of the run's latest `--resume <session>` start. */
  const resumedWith = async (runId: string) => (await argsOf(runId)).split('--resume\nsess\n--\n').at(-1)!.replace(/\n$/, '');
  const successorsOf = (id: string) => t.db.select().from(runs).where(eq(runs.predecessorRunId, id)).all();

  describe('POST /api/runs/:id/recover', () => {
    it('a held resumable run gets the prompt in its own session', async () => {
      const wt = worktree('r1', { 'app.js': 'line1\nfrom-run\nline3\n' });
      seedRun({ id: 'r1', ...wt });
      const res = await recover('r1', 'resolve the conflicts please');
      expect(res.statusCode).toBe(200);
      const body = res.json() as RecoverResponse;
      expect(body.delivery).toBe('session');
      expect(body.run.id).toBe('r1');
      expect(body.run.state).toBe('starting');
      expect(await resumedWith('r1')).toBe('resolve the conflicts please');
      expect(successorsOf('r1')).toHaveLength(0);
    });

    it('a legacy run the pipeline stopped continues in a successor on the same worktree and branch', async () => {
      const wt = worktree('el-2', { 'app.js': 'line1\nfrom-run\nline3\n' });
      seedRun({ id: 'el-2', ticketKey: 'EL-2', ...wt, stops: [legacyStop, exitNoted] });
      const res = await recover('el-2', 'resolve the conflicts in app.js');
      expect(res.statusCode).toBe(200);
      const body = res.json() as RecoverResponse;
      expect(body.delivery).toBe('successor');
      expect(body.run).toMatchObject({
        worktreePath: wt.worktreePath,
        branch: wt.branch,
        predecessorRunId: 'el-2',
        agent: 'claude',
        credential: 'login',
        ticketId: 'tk-EL-2',
      });
      expect(t.runs.getRun('el-2').handedOffTo).toBe(body.run.id);
      const handedOff = t.runs.get('el-2').events.find((e) => e.type === 'handed_off');
      expect(handedOff?.payload).toMatchObject({ reason: 'continued after a hold' });
      // The ticket follows the successor.
      const latest = t.db.select().from(runs).where(eq(runs.ticketId, 'tk-EL-2')).orderBy(desc(runs.createdAt), desc(runs.id)).get();
      expect(latest?.id).toBe(body.run.id);
      // Its prompt: the handoff context, then the person's text.
      const prompt = t.db.select({ prompt: runs.prompt }).from(runs).where(eq(runs.id, body.run.id)).get()!.prompt;
      expect(prompt).toContain('continued after a hold');
      expect(prompt.endsWith('\n\nresolve the conflicts in app.js')).toBe(true);
      expect(await argsOf(body.run.id)).toContain('resolve the conflicts in app.js');
      // The old run holds nothing any more.
      expect((await recover('el-2', 'again')).json()).toMatchObject({ error: 'not_held' });
    });

    it("the successor's finish runs the pipeline, also when no factory chain is going", async () => {
      const wt = worktree('el-2', { 'new.js': 'x\n' });
      seedRun({ id: 'el-2', ticketKey: 'EL-2', ...wt, stops: [legacyStop, exitNoted] });
      const body = (await recover('el-2', 'merge main and finish')).json() as RecoverResponse;
      expect(body.delivery).toBe('successor');
      // No ticket is ready and none is a [Factory] ticket: only the held predecessor makes it a factory run.
      const pipeline = t.tickets as unknown as { handleRunCompleted(r: Run): Promise<void> };
      await pipeline.handleRunCompleted(t.runs.get(body.run.id));
      expect(t.runs.get(body.run.id).events.map((e) => e.type)).toContain('merged_to_main');
      expect(git(main, 'log', '--format=%s', '-1')).toMatch(/EL-2/);
    });

    it('a run a person stopped stays stopped: 409 run_stopped_by_you, and Resume stays 409', async () => {
      const wt = worktree('user', { 'new.js': 'x\n' });
      seedRun({ id: 'user', ...wt, stops: [{ source: 'user' }] });
      const both = worktree('both', { 'new.js': 'y\n' });
      seedRun({ id: 'both', ...both, stops: [legacyStop, exitNoted, { source: 'user' }] });
      for (const id of ['user', 'both']) {
        const res = await recover(id, 'go on');
        expect(res.statusCode, id).toBe(409);
        expect(res.json(), id).toMatchObject({ error: 'run_stopped_by_you' });
        expect((await post(`/api/runs/${id}/resume`, {})).statusCode, id).toBe(409);
        expect(successorsOf(id), id).toHaveLength(0);
      }
    });

    it('a legacy run whose worktree is gone: 409 worktree_missing', async () => {
      seedRun({ id: 'gone', stops: [legacyStop, exitNoted] });
      const res = await recover('gone', 'go on');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'worktree_missing' });
    });

    it('a resumable run whose worktree is gone: 409 worktree_missing, nothing started', async () => {
      seedRun({ id: 'gone' });
      const res = await recover('gone', 'go on');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'worktree_missing' });
      expect(t.runs.getRun('gone').state).toBe('done');
    });

    it('a blocked run gets the answer the person wrote', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt, hold: { type: 'completion_blocked', payload: { blockers: ['which API key?'] } } });
      const res = await recover('r1', 'Use the TEST_KEY variable.');
      expect(res.statusCode).toBe(200);
      expect((res.json() as RecoverResponse).delivery).toBe('session');
      expect(await resumedWith('r1')).toBe('Use the TEST_KEY variable.');
    });

    it('two concurrent calls start one successor; the other is told nothing holds the run', async () => {
      const wt = worktree('el-2', { 'new.js': 'x\n' });
      seedRun({ id: 'el-2', ...wt, stops: [legacyStop, exitNoted] });
      const [a, b] = await Promise.all([recover('el-2', 'first'), recover('el-2', 'second')]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect((a.statusCode === 409 ? a : b).json()).toMatchObject({ error: 'not_held' });
      expect(successorsOf('el-2')).toHaveLength(1);
    });

    it('two concurrent calls on a resumable run deliver once; the other finds it busy', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt });
      const [a, b] = await Promise.all([recover('r1', 'first'), recover('r1', 'second')]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect((a.statusCode === 409 ? a : b).json()).toMatchObject({ error: 'run_busy' });
    });

    it('a busy run: 409 run_busy', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt });
      for (const state of ['queued', 'starting', 'working']) {
        t.db.update(runs).set({ state }).where(eq(runs.id, 'r1')).run();
        const res = await recover('r1', 'go on');
        expect(res.statusCode, state).toBe(409);
        expect(res.json(), state).toMatchObject({ error: 'run_busy' });
      }
    });

    it('a run whose hold was lifted: 409 not_held', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt, hold: null });
      const res = await recover('r1', 'go on');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'not_held' });
      seedRun({ id: 'r2', ...worktree('r2', { 'new.js': 'x\n' }) });
      t.db.update(tickets).set({ status: 'done' }).where(eq(tickets.id, t.runs.getRun('r2').ticketId!)).run();
      expect((await recover('r2', 'go on')).json()).toMatchObject({ error: 'not_held' });
    });

    it('needs text', async () => {
      seedRun({ id: 'r1' });
      expect((await post('/api/runs/r1/recover', { text: '  ' })).statusCode).toBe(400);
    });
  });

  describe('POST /api/runs/:id/resume', () => {
    it('without text on a held run sends the hold prompt', async () => {
      for (const [id, payload] of [['r1', {}], ['r2', { text: '   ' }]] as const) {
        seedRun({ id, ...worktree(id, { 'new.js': `${id}\n` }), hold: { type: 'completion_missing', payload: {} } });
        const expected = await t.recovery.holdPrompt(id);
        expect(expected, id).toContain('ticket_complete');
        expect((await post(`/api/runs/${id}/resume`, payload)).statusCode, id).toBe(200);
        expect(await resumedWith(id), id).toBe(expected);
      }
    });

    it('without text on a blocked run sends the plain continue, not the empty answer form', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt, hold: { type: 'completion_blocked', payload: { blockers: ['which API key?'] } } });
      expect((await post('/api/runs/r1/resume', {})).statusCode).toBe(200);
      expect(await resumedWith('r1')).toBe(CONTINUE_PROMPT);
    });

    it('with text keeps the text', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt, hold: { type: 'completion_missing', payload: {} } });
      expect((await post('/api/runs/r1/resume', { text: 'my own words' })).statusCode).toBe(200);
      expect(await resumedWith('r1')).toBe('my own words');
    });

    it('on a run that is not held sends the plain continue', async () => {
      const wt = worktree('r1', { 'new.js': 'x\n' });
      seedRun({ id: 'r1', ...wt, hold: null });
      expect((await post('/api/runs/r1/resume', {})).statusCode).toBe(200);
      expect(await resumedWith('r1')).toBe(CONTINUE_PROMPT);
    });
  });

  describe('resuming a provider without session resume (a fresh conversation)', () => {
    beforeEach(() => {
      process.env.EMBERLINE_GEMINI_COMMAND = t.config.claudeCommand;
    });
    afterEach(() => {
      delete process.env.EMBERLINE_GEMINI_COMMAND;
    });
    /** The `-p` prompt of the run's latest start. */
    const freshPrompt = async (runId: string) => (await argsOf(runId)).split('-p\n').at(-1)!.replace(/\n$/, '');

    it('an empty Resume of a held run gets the handoff context, then the hold prompt', async () => {
      seedRun({ id: 'g1', agent: 'gemini', ...worktree('g1', { 'new.js': 'x\n' }), hold: { type: 'completion_missing', payload: {} } });
      const expected = await t.recovery.holdPrompt('g1');
      expect((await post('/api/runs/g1/resume', {})).statusCode).toBe(200);
      const prompt = await freshPrompt('g1');
      expect(prompt).toContain('Your previous session on this task ended');
      expect(prompt.endsWith(`\n\n${expected}`)).toBe(true);
    });

    it('explicit text gets the handoff context first', async () => {
      seedRun({ id: 'g2', agent: 'gemini', ...worktree('g2', { 'new.js': 'x\n' }), hold: null });
      expect((await post('/api/runs/g2/resume', { text: 'my own words' })).statusCode).toBe(200);
      const prompt = await freshPrompt('g2');
      expect(prompt).toContain('Your previous session on this task ended');
      expect(prompt.endsWith('\n\nmy own words')).toBe(true);
    });

    it('a bare continue is the handoff context alone, as before', async () => {
      seedRun({ id: 'g3', agent: 'gemini', ...worktree('g3', { 'new.js': 'x\n' }), hold: null });
      expect((await post('/api/runs/g3/resume', {})).statusCode).toBe(200);
      const prompt = await freshPrompt('g3');
      expect(prompt).toContain('Your previous session on this task ended');
      expect(prompt).not.toContain(CONTINUE_PROMPT);
    });

    it('a finished run from before the headless check is not resumed in Accept edits, and keeps its result', async () => {
      seedRun({ id: 'g4', agent: 'gemini', permissionMode: 'acceptEdits', ...worktree('g4', { 'new.js': 'x\n' }), hold: null });
      const res = await post('/api/runs/g4/resume', { text: 'more' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'headless_needs_auto' });
      expect(res.json().message).toContain('Gemini runs without a terminal to answer in, so in Accept edits mode');
      expect(t.runs.getRun('g4').state).toBe('done');
      expect(existsSync(path.join(t.dir, 'args-g4'))).toBe(false);
    });
  });

  describe('RunService.handOff of a cancelled run', () => {
    const route = { agent: 'claude', model: 'auto', credential: 'login' } as const;
    const held = { reason: 'continued after a hold', source: 'user' as const, automatic: false, extraPrompt: 'go on' };

    it('continues a held run the pipeline alone stopped, only when asked to', async () => {
      const wt = worktree('el-2', { 'new.js': 'x\n' });
      seedRun({ id: 'el-2', ...wt, stops: [legacyStop, exitNoted] });
      await expect(t.runs.handOff('el-2', route, held)).rejects.toMatchObject({ statusCode: 409 });
      const successor = await t.runs.handOff('el-2', route, { ...held, allowSystemFinishedCancel: true });
      expect(successor.predecessorRunId).toBe('el-2');
    });

    it('still refuses a run a person stopped, another system stop, and a stopped run that is not held', async () => {
      const cases: RunSeed[] = [
        { id: 'user', stops: [{ source: 'user' }] },
        { id: 'both', stops: [legacyStop, exitNoted, { source: 'user' }] },
        { id: 'queued', stops: [{ source: 'user', type: 'cancelled' }] },
        { id: 'other', stops: [{ source: 'system', reason: 'replaced' }] },
        { id: 'free', stops: [legacyStop, exitNoted], hold: null },
      ];
      for (const seed of cases) {
        seedRun({ ...seed, ...worktree(seed.id, { 'new.js': `${seed.id}\n` }) });
        await expect(t.runs.handOff(seed.id, route, { ...held, allowSystemFinishedCancel: true }), seed.id).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(successorsOf(seed.id), seed.id).toHaveLength(0);
      }
    });

    it('a manual handoff of a run a person stopped is still refused', async () => {
      const wt = worktree('user', { 'new.js': 'x\n' });
      seedRun({ id: 'user', ...wt, stops: [{ source: 'user' }] });
      t.db.update(runs).set({ state: 'failed' }).where(eq(runs.id, 'user')).run();
      const res = await post('/api/runs/user/handoff', { route });
      expect(res.statusCode).toBe(409);
      expect(successorsOf('user')).toHaveLength(0);
    });
  });
});
