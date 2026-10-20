import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunRecovery } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects, reviewComments, runEvents, runs, tickets } from './db/schema.js';
import { createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

let t: TestApp;
let cookie: string;
let main: string;
let ticketNo = 0;

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
  ticketKey?: string;
  branch?: string | null;
  worktreePath?: string;
  ended?: boolean;
  /** Who stopped it: `system` = the pipeline's factory_step_finished stop. */
  stops?: { source: 'system' | 'user'; reason?: string }[];
  handedOffTo?: string;
  /** The hold note after the run's switch to done; null for none. */
  hold?: { type: string; payload: Record<string, unknown> } | null;
  completionTool?: boolean;
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
      agent: 'claude',
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
      .values({ runId: seed.id, ts: now, source: stop.source, type: 'stop_requested', payload: stop.reason ? { reason: stop.reason } : null })
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
});

describe('RecoveryService.deliveryFor', () => {
  const delivery = (id: string) => t.recovery.deliveryFor(t.runs.getRun(id));
  const legacyStop = { source: 'system' as const, reason: 'factory_step_finished' };

  it('session for a live run and for a resumable one', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'live'), { recursive: true });
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

  it('none for a cancelled run that is not held', () => {
    mkdirSync(path.join(t.dir, '.worktrees', 'free'), { recursive: true });
    seedRun({ id: 'free', stops: [legacyStop], hold: null });
    expect(delivery('free')).toBe('none');
  });
});
