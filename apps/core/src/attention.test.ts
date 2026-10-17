import { HOLD_LABELS, type Run } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { runEvents, runs } from './db/schema.js';
import { attentionBoundsQuery, computeAttention, FAILURE_WINDOW_MS, type AttentionFacts } from './runs/attention.js';
import { HOLD_EVENTS } from './runs/hold-events.js';
import { CSRF, createTestApp, setupAndLogin, type TestApp } from './test-utils.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo);
const iso = (msAgo: number) => at(msAgo).toISOString();

const baseRun = (over: Partial<Run> = {}) =>
  ({
    id: 'r1',
    state: 'waiting_input',
    lastEvent: 'Notification',
    autoRetry: null,
    cancelled: false,
    handedOffTo: null,
    endedAt: null,
    stateChangedAt: iso(60_000),
    ...over,
  }) as Pick<Run, 'id' | 'state' | 'lastEvent' | 'autoRetry' | 'cancelled' | 'handedOffTo' | 'endedAt' | 'stateChangedAt'>;

const ev = (id: number, type: string, payload: Record<string, unknown> | null = null, msAgo = 30_000) => ({
  id,
  ts: at(msAgo),
  type,
  payload,
});
const facts = (over: Partial<AttentionFacts> = {}): AttentionFacts => ({
  enteredId: 5,
  waiting: [],
  pipeline: [],
  failure: null,
  ...over,
});

describe('computeAttention rules', () => {
  it('question: a waiting run with an ordinary Notification', () => {
    const a = computeAttention(baseRun(), facts({ waiting: [ev(6, 'Notification', { message: 'Which db?' })] }), NOW);
    expect(a).toEqual({ reason: 'question', detail: 'Which db?', since: iso(30_000), occurrence: 'r1:question:6' });
  });

  it('permission: a Notification of the wait is a permission prompt (by type or by text)', () => {
    const byType = computeAttention(
      baseRun(),
      facts({ waiting: [ev(6, 'Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' })] }),
      NOW,
    );
    expect(byType).toMatchObject({ reason: 'permission', detail: 'Allow Bash?', occurrence: 'r1:permission:6' });
    const byText = computeAttention(baseRun(), facts({ waiting: [ev(6, 'Notification', { message: 'needs your permission to use X' })] }), NOW);
    expect(byText?.reason).toBe('permission');
    const idleLater = computeAttention(
      baseRun(),
      facts({ waiting: [ev(6, 'Notification', { notification_type: 'permission_prompt' }), ev(7, 'Notification', { notification_type: 'idle_prompt', message: 'idle' })] }),
      NOW,
    );
    // One wait is one occurrence: the idle reminder after a permission prompt changes nothing.
    expect(idleLater).toMatchObject({ reason: 'permission', occurrence: 'r1:permission:6' });
  });

  it('one wait is one occurrence: anchored at its first Notification, permission wins, idle reminders never count', () => {
    const idle = (id: number) => ev(id, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    const permission = computeAttention(
      baseRun(),
      facts({ waiting: [ev(6, 'Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' }), idle(9)] }),
      NOW,
    );
    expect(permission).toMatchObject({ reason: 'permission', detail: 'Allow Bash?', occurrence: 'r1:permission:6' });
    const question = computeAttention(baseRun(), facts({ waiting: [ev(6, 'Notification', { message: 'Which db?' }), idle(9)] }), NOW);
    expect(question).toMatchObject({ reason: 'question', detail: 'Which db?', occurrence: 'r1:question:6' });
    const idleOnly = computeAttention(baseRun(), facts({ waiting: [idle(6), idle(9)] }), NOW);
    expect(idleOnly).toMatchObject({ reason: 'question', detail: 'Claude is waiting for your input', occurrence: 'r1:question:6' });
  });

  it('stalled: the first reason after entering the state is stall_detected', () => {
    const a = computeAttention(baseRun(), facts({ waiting: [ev(6, 'stall_detected', { message: 'No output for 20 minutes' })] }), NOW);
    expect(a).toMatchObject({ reason: 'stalled', detail: 'No output for 20 minutes', occurrence: 'r1:stalled:6' });
  });

  it('the latest of Notification and stall_detected decides', () => {
    const stallLast = computeAttention(baseRun(), facts({ waiting: [ev(6, 'Notification', { message: 'q' }), ev(7, 'stall_detected')] }), NOW);
    expect(stallLast).toMatchObject({ reason: 'stalled', occurrence: 'r1:stalled:7' });
    const notificationLast = computeAttention(
      baseRun(),
      facts({ waiting: [ev(6, 'stall_detected'), ev(7, 'Notification', { notification_type: 'permission_prompt', message: 'ok?' })] }),
      NOW,
    );
    expect(notificationLast).toMatchObject({ reason: 'permission', detail: 'ok?', occurrence: 'r1:permission:7' });
  });

  it('uses a deterministic time-based occurrence when no triggering event is known', () => {
    const run = baseRun({ stateChangedAt: '2026-10-18T11:59:00.000Z' });
    const t0 = Date.parse('2026-10-18T11:59:00.000Z');
    expect(computeAttention(run, facts({ enteredId: null }), NOW)?.occurrence).toBe(`r1:question:t${t0}`);
    expect(computeAttention(run, undefined, NOW)?.occurrence).toBe(`r1:question:t${t0}`);
    expect(computeAttention({ ...run, state: 'rate_limited' }, facts({ enteredId: null }), NOW)?.occurrence).toBe(`r1:rate_limited:t${t0}`);
    expect(computeAttention({ ...run, state: 'failed', endedAt: run.stateChangedAt }, facts(), NOW)?.occurrence).toBe(`r1:failed:5`);
  });

  it('skips a waiting run whose last event is SessionStart', () => {
    expect(computeAttention(baseRun({ lastEvent: 'SessionStart' }), facts({ waiting: [ev(6, 'Notification')] }), NOW)).toBeNull();
  });

  it('question without any Notification falls back to the state-entering event', () => {
    expect(computeAttention(baseRun(), facts(), NOW)).toMatchObject({ reason: 'question', detail: null, occurrence: 'r1:question:5' });
  });

  it('rate_limited only without auto-retry', () => {
    const limited = baseRun({ state: 'rate_limited' });
    expect(computeAttention(limited, facts(), NOW)).toMatchObject({ reason: 'rate_limited', occurrence: 'r1:rate_limited:5' });
    expect(computeAttention({ ...limited, autoRetry: { attempt: 1, max: 3, at: iso(-1000) } }, facts(), NOW)).toBeNull();
  });

  describe('failed', () => {
    const failed = (over: Partial<Run> = {}) => baseRun({ state: 'failed', endedAt: iso(60_000), ...over });
    const failure = facts({ failure: ev(9, 'waiting_input_timeout', null, 60_000) });

    it('carries the reason of the final event', () => {
      expect(computeAttention(failed(), failure, NOW)).toEqual({
        reason: 'failed',
        detail: 'waiting_input_timeout',
        since: iso(60_000),
        occurrence: 'r1:failed:9',
      });
    });
    it('excludes cancelled and handed-off runs', () => {
      expect(computeAttention(failed({ cancelled: true }), failure, NOW)).toBeNull();
      expect(computeAttention(failed({ handedOffTo: 'r2' }), failure, NOW)).toBeNull();
    });
    it('stops after the 24 h window', () => {
      expect(FAILURE_WINDOW_MS).toBe(24 * 3_600_000);
      expect(computeAttention(failed({ endedAt: iso(FAILURE_WINDOW_MS - 1000) }), failure, NOW)).not.toBeNull();
      expect(computeAttention(failed({ endedAt: iso(FAILURE_WINDOW_MS + 1000) }), failure, NOW)).toBeNull();
    });
  });

  describe('done with a hold', () => {
    const done = baseRun({ state: 'done' });
    it('labels every hold event but the nudge', () => {
      for (const type of HOLD_EVENTS.filter((t) => t !== 'completion_blocked' && t !== 'completion_nudged')) {
        const a = computeAttention(done, facts({ pipeline: [ev(8, type)] }), NOW);
        expect(a).toMatchObject({ reason: 'held', detail: HOLD_LABELS[type], occurrence: `r1:held:8` });
      }
      expect(HOLD_LABELS.merge_failed).toBe('Merge failed');
      expect(HOLD_LABELS.secret_guard_blocked).toBe('Secret found in the diff');
      expect(HOLD_LABELS.build_gate_failed).toBe('Build checks failed');
    });
    it('completion_blocked is blocked, blockers joined', () => {
      const a = computeAttention(done, facts({ pipeline: [ev(8, 'completion_blocked', { blockers: ['no api key', 'need review'] })] }), NOW);
      expect(a).toMatchObject({ reason: 'blocked', detail: 'no api key\nneed review', occurrence: 'r1:blocked:8' });
    });
    it('completion_nudged alone is not counted', () => {
      expect(computeAttention(done, facts({ pipeline: [ev(8, 'completion_nudged')] }), NOW)).toBeNull();
    });
    it('a nudge after a real hold keeps the hold; merged and clean runs are null', () => {
      expect(computeAttention(done, facts({ pipeline: [ev(8, 'merge_failed'), ev(9, 'completion_nudged')] }), NOW)?.occurrence).toBe('r1:held:8');
      expect(computeAttention(done, facts({ pipeline: [ev(8, 'merged_to_main')] }), NOW)).toBeNull();
      expect(computeAttention(done, facts(), NOW)).toBeNull();
    });
  });

  it('is null for runs that work or wait in the queue', () => {
    for (const state of ['queued', 'starting', 'working'] as const) expect(computeAttention(baseRun({ state }), facts(), NOW)).toBeNull();
  });
});

describe('attention through RunService', () => {
  let t: TestApp;
  let projectId: string;
  let n = 0;

  beforeEach(async () => {
    t = await createTestApp();
    const cookie = await setupAndLogin(t.app);
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Att', initGit: false }, headers: { ...CSRF, cookie } });
    projectId = res.json().project.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const seedRun = (state: string, over: Partial<typeof runs.$inferInsert> = {}) => {
    const id = `run-${++n}`;
    const now = new Date(Date.now() - 1000 * (100 - n));
    t.db
      .insert(runs)
      .values({
        id,
        projectId,
        agent: 'claude',
        state,
        worktreePath: '/tmp/x',
        hookTokenHash: 'h',
        stateChangedAt: now,
        createdAt: now,
        ...over,
      })
      .run();
    return id;
  };
  const seedEvent = (runId: string, type: string, state: string | null = null, payload: unknown = null) =>
    t.db.insert(runEvents).values({ runId, ts: new Date(), source: 'hook', type, state, payload }).returning({ id: runEvents.id }).get().id;
  const find = (id: string) => t.runs.list().find((r) => r.id === id) as Run;

  it('a waiting run gets the permission attention, stable across reads and in the detail', () => {
    const id = seedRun('waiting_input', { lastEvent: 'Notification' });
    seedEvent(id, 'PreToolUse', 'working');
    seedEvent(id, 'Notification', 'waiting_input', { notification_type: 'permission_prompt', message: 'Allow rm?' });
    const first = find(id).attention;
    expect(first).toMatchObject({ reason: 'permission', detail: 'Allow rm?' });
    expect(first?.occurrence).toMatch(new RegExp(`^${id}:permission:\\d+$`));
    expect(find(id).attention).toEqual(first);
    expect(t.runs.get(id).attention).toEqual(first);
    // A later note that does not change state leaves the occurrence alone.
    seedEvent(id, 'auto_nudged');
    expect(find(id).attention?.occurrence).toBe(first?.occurrence);
  });

  it('a permission prompt then Claude\'s idle reminder stay one occurrence and one page', () => {
    const id = seedRun('waiting_input', { lastEvent: 'Notification' });
    seedEvent(id, 'PreToolUse', 'working');
    seedEvent(id, 'Notification', 'waiting_input', { notification_type: 'permission_prompt', message: 'Allow rm?' });
    const first = find(id).attention;
    seedEvent(id, 'Notification', null, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(find(id).attention).toEqual(first);
    expect(first?.reason).toBe('permission');
  });

  it('every Run handed out by the service carries attention', () => {
    const id = seedRun('waiting_input', { lastEvent: 'Notification' });
    seedEvent(id, 'Notification', 'waiting_input', { message: 'Which?' });
    expect(t.runs.getRun(id).attention).toMatchObject({ reason: 'question', detail: 'Which?' });
    const ticket = t.tickets.create(projectId, { title: 'TT', status: 'in_progress' });
    t.db.update(runs).set({ ticketId: ticket.id }).where(eq(runs.id, id)).run();
    expect(t.runs.latestRunForTicket(ticket.id)?.attention?.reason).toBe('question');
    expect(t.runs.activeRunForTicket(ticket.id)?.attention?.reason).toBe('question');
  });

  it('reads the run bounds through the partial state index', () => {
    const plan = (t.db as unknown as { all: (q: unknown) => { detail: string }[] }).all(
      sql`EXPLAIN QUERY PLAN ${attentionBoundsQuery(['a', 'b'])}`,
    );
    const text = plan.map((r) => r.detail).join('\n');
    expect(text).toContain('run_events_state_idx');
  });

  it('a hold after the latest done counts; one before it does not', () => {
    const id = seedRun('done');
    seedEvent(id, 'Stop', 'done');
    seedEvent(id, 'merge_failed');
    expect(find(id).attention).toMatchObject({ reason: 'held', detail: 'Merge failed' });
    seedEvent(id, 'UserPromptSubmit', 'working');
    seedEvent(id, 'Stop', 'done');
    expect(find(id).attention).toBeNull();
  });

  it('a failed run reports the failing event type', () => {
    const id = seedRun('failed', { endedAt: new Date() });
    seedEvent(id, 'process_exited', 'failed', { message: 'x' });
    expect(find(id).attention).toMatchObject({ reason: 'failed', detail: 'process_exited' });
  });

  it('reviewReady: done, ticket in review, no hold, latest run of the ticket', () => {
    const ticket = t.tickets.create(projectId, { title: 'T', status: 'review' });
    const older = seedRun('done', { ticketId: ticket.id });
    seedEvent(older, 'Stop', 'done');
    const latest = seedRun('done', { ticketId: ticket.id });
    seedEvent(latest, 'Stop', 'done');
    expect(find(latest).reviewReady).toBe(true);
    expect(find(older).reviewReady).toBe(false);
    seedEvent(latest, 'build_gate_failed');
    expect(find(latest).reviewReady).toBe(false);
    expect(find(latest).attention?.reason).toBe('held');
    const plain = seedRun('done');
    expect(find(plain).reviewReady).toBe(false);
  });

  it('list loads the attention events once, in a fixed number of statements', () => {
    const spy = vi.spyOn(t.runs, 'loadAttentionFacts');
    const all = vi.spyOn(t.db, 'all');
    for (let i = 0; i < 3; i++) {
      const id = seedRun('done');
      seedEvent(id, 'Stop', 'done');
    }
    t.runs.list();
    const statementsSmall = all.mock.calls.length;
    expect(spy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 40; i++) {
      const id = seedRun(i % 2 ? 'waiting_input' : 'failed', { endedAt: new Date() });
      seedEvent(id, 'Notification', i % 2 ? 'waiting_input' : 'failed');
    }
    spy.mockClear();
    all.mockClear();
    const list = t.runs.list();
    expect(list.length).toBe(43);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(all.mock.calls.length).toBe(statementsSmall);
  });
});

describe('attentionOf', () => {
  it('computes the attention of one emitted run once, for every listener', async () => {
    const { createTestApp } = await import('./test-utils.js');
    const t = await createTestApp();
    try {
      const spy = vi.spyOn(t.runs, 'withAttention');
      const payload = { id: 'x', state: 'working' } as never;
      const first = t.runs.attentionOf(payload);
      const second = t.runs.attentionOf(payload);
      expect(second).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await t.close();
    }
  });
});
