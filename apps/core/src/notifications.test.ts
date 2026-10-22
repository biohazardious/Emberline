import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { NotificationSettings } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Db, openDb } from './db/index.js';
import { notificationLog, runEvents } from './db/schema.js';
import { PresenceRegistry } from './notifications/presence.js';
import { NotificationService, type NotificationServiceOptions } from './notifications/service.js';

describe('NotificationService.dispatch', () => {
  it('delivers ntfy notifications whose title contains non-Latin-1 characters', async () => {
    const received: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push(req.headers);
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };

    try {
      const service = new NotificationService({} as Db);
      const cfg: NotificationSettings = {
        enabled: true,
        provider: 'ntfy',
        url: `http://127.0.0.1:${port}/emberline`,
        token: null,
        onRateLimited: true,
        onQuotaResumed: true,
        onWaitingInput: true,
        onRunFinished: true,
      };
      const title = 'Claude quota limit reached — dispatch paused 🔥';
      const result = await service.dispatch(cfg, { event: 'rate_limited', title, body: 'body' });

      expect(result).toEqual({ ok: true, status: 200, error: null });
      const header = String(received[0]?.title ?? '');
      const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(header);
      expect(match).not.toBeNull();
      expect(Buffer.from(match?.[1] ?? '', 'base64').toString('utf8')).toBe(title);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const CFG: NotificationSettings = {
  enabled: true,
  provider: 'webhook',
  url: 'http://127.0.0.1:9/unused',
  token: null,
  onRateLimited: false,
  onQuotaResumed: false,
  onWaitingInput: true,
  onRunFinished: true,
};

type Attention = { reason: string; detail: string | null; since: string; occurrence: string };

/** A service on a real in-memory DB, fed by a fake run source whose attention the test states per run. */
async function harness(
  cfg: Partial<NotificationSettings> = {},
  options: NotificationServiceOptions = {},
  db: Db = openDb(':memory:').db,
) {
  const { EventEmitter } = await import('node:events');
  const runs = Object.assign(new EventEmitter(), {
    attentionOf: (run: { attention?: Attention | null }) => ({ attention: null, ...run }),
  });
  const current = new Map<string, unknown>();
  runs.on('run', (r: { id: string }) => current.set(r.id, r));
  Object.assign(runs, {
    getRun: (id: string) => {
      const r = current.get(id);
      if (!r) throw new Error('no run');
      return r;
    },
  });
  const logged: string[] = [];
  const service = new NotificationService(db, runs as never, undefined, {
    now: () => Date.parse('2026-10-18T09:00:00Z'),
    log: (message) => logged.push(message),
    ...options,
  });
  let settings: NotificationSettings = { ...CFG, ...cfg };
  service.getSettings = () => settings;
  const sent: { event: string; title: string; body: string; priority?: string }[] = [];
  let result = { ok: true, status: 200 as number | null, error: null as string | null };
  service.dispatch = async (_cfg, msg) => {
    sent.push({ event: msg.event, title: msg.title, body: msg.body, priority: msg.priority });
    return result;
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    db,
    runs,
    logged,
    current,
    service,
    sent,
    flush,
    set: (patch: Partial<NotificationSettings>) => {
      settings = { ...settings, ...patch };
    },
    failSends: (ok: boolean) => {
      result = ok ? { ok: true, status: 200, error: null } : { ok: false, status: 500, error: 'HTTP 500' };
    },
  };
}

const att = (reason: string, id: number, detail: string | null = null, runId = 'r1'): Attention => ({
  reason,
  detail,
  since: '2026-10-18T10:00:00.000Z',
  occurrence: `${runId}:${reason}:${id}`,
});
const run = (state: string, lastEvent: string, attention: Attention | null, extra: object = {}) => ({
  id: 'r1',
  projectId: 'p1',
  title: 'T',
  branch: null,
  state,
  lastEvent,
  cancelled: false,
  stateChangedAt: '2026-10-18T10:00:00.000Z',
  attention,
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotificationService run events', () => {
  it('does not page on session startup or on runs the user cancelled (B14)', async () => {
    const h = await harness();
    // Core computes no attention for these: SessionStart-only waiting, a cancelled failure.
    h.runs.emit('run', run('waiting_input', 'SessionStart', null), true);
    h.runs.emit('run', run('failed', 'cancelled', null, { cancelled: true }), true);
    await h.flush();
    expect(h.sent).toEqual([]);
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), true);
    h.runs.emit('run', run('failed', 'process_exited', att('failed', 9)), true);
    await h.flush();
    expect(h.sent.map((m) => m.event)).toEqual(['waiting_input', 'run_finished']);
  });

  it('does not announce a handed-off run as completed', async () => {
    const h = await harness();
    h.runs.emit('run', run('done', 'Stop', null, { handedOffTo: 'x' }), true);
    await h.flush();
    expect(h.sent).toEqual([]);
  });

  it('pages once per occurrence, however often the same attention is emitted', async () => {
    const h = await harness();
    const waiting = run('waiting_input', 'Notification', att('permission', 5, 'Allow Bash?'));
    h.runs.emit('run', waiting, true);
    h.runs.emit('run', { ...waiting }, false);
    h.runs.emit('run', { ...waiting }, true);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body).toContain('Allow Bash?');
    // A new occurrence (the agent asks again) pages again.
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 8, 'Which store?')), false);
    await h.flush();
    expect(h.sent).toHaveLength(2);
  });

  it('never repeats a logged occurrence after a restart', async () => {
    const first = await harness();
    first.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), true);
    await first.flush();
    expect(first.sent).toHaveLength(1);
    const second = await harness({}, {}, first.db);
    second.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), false);
    second.runs.emit('run', run('waiting_input', 'Notification', att('question', 6)), false);
    await second.flush();
    expect(second.sent).toHaveLength(1);
  });

  it('logs as suppressed, without sending, an occurrence older than the service start (upgrade/restart)', async () => {
    const h = await harness({}, { now: () => Date.parse('2026-10-18T11:00:00Z') });
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), false);
    await h.flush();
    expect(h.sent).toEqual([]);
    expect(h.db.select().from(notificationLog).get()?.outcome).toBe('suppressed');
  });

  it('a throwing attention computation neither breaks the emit for other listeners nor escapes', async () => {
    const h = await harness();
    (h.runs as unknown as { attentionOf: () => never }).attentionOf = () => {
      throw new Error('db is locked');
    };
    const other = vi.fn();
    h.runs.on('run', other);
    expect(() =>
      h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), true),
    ).not.toThrow();
    expect(other).toHaveBeenCalled();
    expect(h.logged.join()).toMatch(/notification/i);
  });

  it('maps attention reasons to the toggles: waiting-input covers all but failures, which follow run-finished', async () => {
    const h = await harness({ onWaitingInput: false, onRunFinished: false });
    for (const [n, reason] of ['question', 'permission', 'stalled', 'held', 'blocked', 'failed'].entries()) {
      h.runs.emit('run', run('waiting_input', 'x', att(reason, n + 1)), true);
    }
    await h.flush();
    expect(h.sent).toEqual([]);
    h.set({ onWaitingInput: true });
    for (const [n, reason] of ['question', 'permission', 'stalled', 'held', 'blocked', 'failed'].entries()) {
      h.runs.emit(
        'run',
        run(reason === 'failed' ? 'failed' : 'waiting_input', 'x', att(reason, n + 1)),
        true,
      );
    }
    await h.flush();
    expect(h.sent.map((m) => m.event)).toEqual([
      'waiting_input',
      'waiting_input',
      'waiting_input',
      'waiting_input',
      'waiting_input',
    ]);
    h.set({ onRunFinished: true });
    h.runs.emit('run', run('failed', 'x', att('failed', 6)), true);
    await h.flush();
    expect(h.sent.at(-1)!.event).toBe('run_finished');
    h.set({ enabled: false });
    h.runs.emit('run', run('waiting_input', 'x', att('question', 99)), true);
    await h.flush();
    expect(h.sent).toHaveLength(6);
  });

  it('pages a held or blocked ticket with the blockers as text, not on the nudge', async () => {
    const h = await harness();
    h.runs.emit('run', run('done', 'completion_nudged', null), false);
    h.runs.emit(
      'run',
      run('done', 'completion_blocked', att('blocked', 7, 'No signing key\nWhich store account?')),
      false,
    );
    h.runs.emit('run', run('done', 'completion_missing', att('held', 9, 'No completion signal')), false);
    await h.flush();
    expect(h.sent).toEqual([
      {
        event: 'waiting_input',
        title: 'Agent waiting on you: T',
        body: 'Run "T" cannot finish its ticket and needs you:\n- No signing key\n- Which store account?',
        priority: 'high',
      },
      expect.objectContaining({
        event: 'waiting_input',
        body: expect.stringContaining('No completion signal'),
      }),
    ]);
  });

  it('keeps the opt-in finished page, once per finish, and none for a failed or cancelled run', async () => {
    const h = await harness({ onRunFinished: true });
    h.runs.emit('run', run('done', 'Stop', null), true);
    h.runs.emit('run', run('done', 'Stop', null), true);
    await h.flush();
    expect(h.sent.map((m) => m.title)).toEqual(['Run completed: T']);
    const log = h.db.select().from(notificationLog).all();
    expect(log).toHaveLength(1);
    expect(log[0]!.occurrence).toMatch(/^r1:finished:/);
    const off = await harness({ onRunFinished: false });
    off.runs.emit('run', run('done', 'Stop', null), true);
    await off.flush();
    expect(off.sent).toEqual([]);
  });

  it('suppresses and logs a page for the run a visible client has open, only that run', async () => {
    const presence = new PresenceRegistry();
    const h = await harness({}, { presence });
    const tab = Symbol('tab');
    presence.set(tab, { visible: true, runId: 'r1' });
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), true);
    await h.flush();
    expect(h.sent).toEqual([]);
    expect(
      h.db.select().from(notificationLog).where(eq(notificationLog.occurrence, 'r1:question:5')).get()
        ?.outcome,
    ).toBe('suppressed');
    // Leaving the run later does not resurrect the suppressed page.
    presence.set(tab, { visible: true, runId: 'other' });
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), false);
    await h.flush();
    expect(h.sent).toEqual([]);
    // Looking at another run, a hidden tab, or Fleet in general does not suppress a new occurrence.
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 6)), false);
    presence.set(tab, { visible: false, runId: 'r1' });
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 7)), false);
    presence.set(tab, { visible: true, runId: null });
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 8)), false);
    await h.flush();
    expect(h.sent).toHaveLength(3);
  });

  it('retries a failed page once after 60 s, then drops it', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.failSends(false);
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(1);
    const outcome = () => h.db.select().from(notificationLog).get()?.outcome;
    expect(outcome()).toBe('failed');
    // The same occurrence is not re-sent by a new emit meanwhile.
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), false);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(2);
    expect(outcome()).toBe('failed');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sent).toHaveLength(2);
  });

  it('drops the retry when the occurrence is no longer current, the toggle is off, or someone is looking', async () => {
    vi.useFakeTimers();
    const presence = new PresenceRegistry();
    const h = await harness({}, { presence });
    const fail = async (id: number) => {
      h.failSends(false);
      h.runs.emit('run', run('waiting_input', 'Notification', att('question', id)), true);
      await vi.advanceTimersByTimeAsync(0);
    };
    // 1: the run moved on (its attention is another occurrence by the time of the retry).
    await fail(1);
    h.runs.emit('run', run('working', 'PreToolUse', null), false);
    // 2: the toggle is switched off.
    await fail(2);
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 2)), false);
    h.set({ onWaitingInput: false });
    // 3: a visible client opens the run.
    h.set({ onWaitingInput: true });
    await fail(3);
    presence.set(Symbol('tab'), { visible: true, runId: 'r1' });
    const before = h.sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent).toHaveLength(before);
    const outcomes = Object.fromEntries(
      h.db
        .select()
        .from(notificationLog)
        .all()
        .map((r) => [r.occurrence, r.outcome]),
    );
    expect(outcomes['r1:question:3']).toBe('suppressed');
    expect(outcomes['r1:question:1']).toBe('failed');
  });

  it('records the retry as sent when it gets through', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.failSends(false);
    h.runs.emit('run', run('waiting_input', 'Notification', att('question', 5)), true);
    await vi.advanceTimersByTimeAsync(0);
    h.failSends(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent).toHaveLength(2);
    expect(h.db.select().from(notificationLog).get()?.outcome).toBe('sent');
  });

  it('prunes log rows older than 30 days', async () => {
    const day = 24 * 60 * 60_000;
    const t0 = Date.parse('2026-10-18T00:00:00Z');
    const h = await harness({}, { now: () => t0 });
    const insert = (occurrence: string, ageDays: number) =>
      h.db
        .insert(notificationLog)
        .values({ occurrence, event: 'waiting_input', sentAt: new Date(t0 - ageDays * day), outcome: 'sent' })
        .run();
    insert('old', 31);
    insert('edge', 29);
    h.service.prune();
    expect(
      h.db
        .select()
        .from(notificationLog)
        .all()
        .map((r) => r.occurrence),
    ).toEqual(['edge']);
  });

  it('explains a waiting-input timeout instead of a generic failure', async () => {
    const h = await harness();
    h.runs.emit('run', run('failed', 'waiting_input_timeout', att('failed', 4), { title: 'Nightly' }), true);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.title).toContain('Nightly');
    expect(h.sent[0]!.body).toMatch(/permission/i);
    expect(h.sent[0]!.body).toMatch(/30 minutes/);
  });

  it('says a stalled run may be stuck, through the waiting-input switch', async () => {
    const h = await harness({ onRunFinished: false });
    h.runs.emit('run', run('waiting_input', 'stall_detected', att('stalled', 3), { title: 'Big job' }), true);
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.event).toBe('waiting_input');
    expect(h.sent[0]!.body).toMatch(/20 minutes/);
    expect(h.sent[0]!.body).toMatch(/stuck/i);
  });
});

describe('NotificationService factory pause', () => {
  it('pages when a factory chain pauses, once per pause, under the "waiting on you" switch', async () => {
    const h = await harness({ onRunFinished: false });
    const r = run('failed', 'factory_chain_paused', null, { title: 'DP-3: Build the APK' });
    const message =
      '2 ticket runs failed in a row; the factory paused — fix the cause and click Run pipeline';
    h.runs.emit('note', r, 'retry_scheduled', {});
    await h.flush();
    expect(h.sent).toEqual([]);
    h.runs.emit('note', r, 'factory_chain_paused', { reason: 'failed_in_a_row', message });
    await h.flush();
    expect(h.sent).toEqual([
      {
        event: 'factory_paused',
        title: 'Factory paused: DP-3: Build the APK',
        body: message,
        priority: 'high',
      },
    ]);
    // The same pause again (another emit of the same note) does not page twice.
    h.runs.emit('note', r, 'factory_chain_paused', { reason: 'failed_in_a_row', message });
    await h.flush();
    expect(h.sent).toHaveLength(1);
    h.set({ onWaitingInput: false });
    h.runs.emit('note', r, 'factory_chain_paused', { reason: 'failed_in_a_row', message });
    await h.flush();
    expect(h.sent).toHaveLength(1);
  });
});

describe('NotificationService quota lanes', () => {
  it('pages once per lane that runs out and once when it is back, naming the lane', async () => {
    const { EventEmitter } = await import('node:events');
    const base = { maxConcurrentRuns: 2, busy: 1, queued: 0, rateLimited: 1 };
    const lane = (id: string, agent: string, pool: string, credential = 'login') => ({
      id,
      agent,
      credential,
      pool,
      exhaustedAt: '2026-10-16T10:00:00.000Z',
      resetsAt: '2026-10-16T15:00:00.000Z',
      resumeAt: '2026-10-16T15:01:00.000Z',
      resetSource: 'hook' as const,
      message: 'limit reached',
      resumedAt: null,
    });
    const scheduler = Object.assign(new EventEmitter(), {
      state: () => ({ ...base, window: null, windows: [] }),
    });
    const service = new NotificationService({} as Db, undefined, scheduler as never);
    const sent: { event: string; title: string; body: string }[] = [];
    service.getSettings = () =>
      ({
        enabled: true,
        provider: 'webhook',
        url: 'http://127.0.0.1:9/unused',
        token: null,
        onRateLimited: true,
        onQuotaResumed: true,
        onWaitingInput: true,
        onRunFinished: true,
      }) satisfies NotificationSettings;
    service.dispatch = async (_cfg, msg) => {
      sent.push({ event: msg.event, title: msg.title, body: msg.body });
      return { ok: true, status: 200, error: null };
    };
    const emit = async (windows: ReturnType<typeof lane>[]) => {
      scheduler.emit('state', { ...base, window: windows[0] ?? null, windows });
      await new Promise((resolve) => setImmediate(resolve));
    };
    const agy = lane('w1', 'antigravity', '*');
    const opus = lane('w2', 'claude', 'opus');

    await emit([agy]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'rate_limited', title: 'Antigravity (all models) quota reached' });
    expect(sent[0]!.body).toContain('other providers keep running');
    // The same lane again (e.g. a refined reset time) does not page twice; a second lane does.
    await emit([agy]);
    await emit([agy, opus]);
    expect(sent.map((s) => s.title)).toEqual([
      'Antigravity (all models) quota reached',
      'Claude (opus) quota reached',
    ]);
    await emit([opus]);
    expect(sent.at(-1)).toMatchObject({
      event: 'quota_resumed',
      title: 'Antigravity (all models) quota is back',
    });
    await emit([]);
    expect(sent.at(-1)).toMatchObject({ event: 'quota_resumed', title: 'Claude (opus) quota is back' });
    expect(sent).toHaveLength(4);
  });

  it('a window refined in place to one model pool neither pages again nor says the lane is back', async () => {
    const { EventEmitter } = await import('node:events');
    const base = { maxConcurrentRuns: 2, busy: 1, queued: 0, rateLimited: 1 };
    const window = (pool: string) => ({
      id: 'w1',
      agent: 'claude',
      credential: 'login',
      pool,
      exhaustedAt: '2026-10-16T10:00:00.000Z',
      resetsAt: '2026-10-16T15:00:00.000Z',
      resumeAt: '2026-10-16T15:01:00.000Z',
      resetSource: 'hook' as const,
      message: 'limit reached',
      resumedAt: null,
    });
    const scheduler = Object.assign(new EventEmitter(), {
      state: () => ({ ...base, window: null, windows: [] }),
    });
    const service = new NotificationService({} as Db, undefined, scheduler as never);
    const sent: string[] = [];
    service.getSettings = () =>
      ({
        enabled: true,
        provider: 'webhook',
        url: 'http://127.0.0.1:9/unused',
        token: null,
        onRateLimited: true,
        onQuotaResumed: true,
        onWaitingInput: true,
        onRunFinished: true,
      }) satisfies NotificationSettings;
    service.dispatch = async (_cfg, msg) => {
      sent.push(msg.title);
      return { ok: true, status: 200, error: null };
    };
    const emit = async (windows: ReturnType<typeof window>[]) => {
      scheduler.emit('state', { ...base, window: windows[0] ?? null, windows });
      await new Promise((resolve) => setImmediate(resolve));
    };

    await emit([window('*')]);
    await emit([window('opus')]);
    expect(sent).toEqual(['Claude (all models) quota reached']);
    await emit([]);
    expect(sent).toEqual(['Claude (all models) quota reached', 'Claude (opus) quota is back']);
  });
});

describe('NotificationService on a real RunService', () => {
  it('pages exactly once, with the held text, when the completion gate holds a done run', async () => {
    const { createTestApp, setupAndLogin, authHeaders } = await import('./test-utils.js');
    const { runs } = await import('./db/schema.js');
    const t = await createTestApp();
    try {
      const cookie = await setupAndLogin(t.app);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Int', initGit: false },
        headers: authHeaders(cookie),
      });
      const projectId = res.json().project.id as string;
      const now = new Date();
      t.db
        .insert(runs)
        .values({
          id: 'run-int',
          projectId,
          agent: 'claude',
          state: 'done',
          worktreePath: '/tmp/x',
          hookTokenHash: 'h',
          stateChangedAt: now,
          createdAt: now,
          title: 'DP-3',
        })
        .run();
      // A real done run has the event that moved it there; the pipeline notes after it decide the hold.
      t.db
        .insert(runEvents)
        .values({ runId: 'run-int', ts: now, source: 'hook', type: 'Stop', state: 'done', payload: null })
        .run();
      const service = new NotificationService(t.db, t.runs);
      service.getSettings = () => ({ ...CFG, onRunFinished: false });
      const sent: { body: string }[] = [];
      service.dispatch = async (_cfg, msg) => {
        sent.push({ body: msg.body });
        return { ok: true, status: 200, error: null };
      };
      t.runs.note('run-int', 'completion_missing', {});
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toContain('No completion signal');
      t.runs.note('run-int', 'completion_nudged', {});
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toHaveLength(1);
      service.stop();
    } finally {
      await t.close();
    }
  });
});

describe('NotificationService on real hooks', () => {
  it("a wait entered without a Notification (StopFailure) and Claude's later idle reminder are one occurrence, one page", async () => {
    const { createHash } = await import('node:crypto');
    const { createTestApp, setupAndLogin, authHeaders } = await import('./test-utils.js');
    const { runs } = await import('./db/schema.js');
    const t = await createTestApp();
    try {
      const cookie = await setupAndLogin(t.app);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Hooks', initGit: false },
        headers: authHeaders(cookie),
      });
      const projectId = res.json().project.id as string;
      const now = new Date();
      const hookTokenHash = createHash('sha256').update('tok').digest('hex');
      t.db
        .insert(runs)
        .values({
          id: 'run-sf',
          projectId,
          agent: 'claude',
          state: 'working',
          worktreePath: '/tmp/x',
          hookTokenHash,
          stateChangedAt: now,
          createdAt: now,
          title: 'SF',
        })
        .run();
      const service = new NotificationService(t.db, t.runs, undefined, { now: () => now.getTime() - 1000 });
      service.getSettings = () => ({ ...CFG, onRunFinished: false });
      const sent: { body: string }[] = [];
      service.dispatch = async (_cfg, msg) => {
        sent.push({ body: msg.body });
        return { ok: true, status: 200, error: null };
      };
      const hook = (event: string, payload: Record<string, unknown>) =>
        t.runs.ingestHook(
          { runId: 'run-sf', event: event as never, receivedAt: new Date().toISOString(), payload },
          'tok',
        );
      hook('StopFailure', { error: 'invalid_request', message: 'Prompt is too long' });
      await new Promise((resolve) => setImmediate(resolve));
      const first = t.runs.getRun('run-sf');
      expect(first.state).toBe('waiting_input');
      expect(first.attention?.reason).toBe('question');
      hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
      await new Promise((resolve) => setImmediate(resolve));
      const second = t.runs.getRun('run-sf');
      expect(second.attention?.occurrence).toBe(first.attention?.occurrence);
      expect(second.attention?.since).toBe(first.attention?.since);
      expect(sent).toHaveLength(1);
      service.stop();
    } finally {
      await t.close();
    }
  });
});
