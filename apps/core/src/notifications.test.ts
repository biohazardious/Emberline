import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { NotificationSettings } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import type { Db } from './db/index.js';
import { NotificationService } from './notifications/service.js';

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

describe('NotificationService run events', () => {
  it('does not page on session startup or on runs the user cancelled (B14)', async () => {
    const { EventEmitter } = await import('node:events');
    const runs = new EventEmitter();
    const service = new NotificationService({} as Db, runs as never);
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
      sent.push(msg.event);
      return { ok: true, status: 200, error: null };
    };
    const run = (state: string, lastEvent: string, cancelled = false) => ({
      id: 'r1',
      title: 'T',
      branch: null,
      state,
      lastEvent,
      cancelled,
    });
    runs.emit('run', run('waiting_input', 'SessionStart'), true);
    runs.emit('run', run('failed', 'cancelled', true), true);
    expect(sent).toEqual([]);
    runs.emit('run', run('waiting_input', 'Notification'), true);
    runs.emit('run', run('failed', 'process_exited'), true);
    expect(sent).toEqual(['waiting_input', 'run_finished']);
  });

  it('does not announce a handed-off run as completed', async () => {
    const { EventEmitter } = await import('node:events');
    const runs = new EventEmitter();
    const service = new NotificationService({} as Db, runs as never);
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
      sent.push(msg.event);
      return { ok: true, status: 200, error: null };
    };
    runs.emit('run', { id: 'r1', title: 'T', branch: null, state: 'done', lastEvent: 'Stop', cancelled: false, handedOffTo: 'x' }, true);
    expect(sent).toEqual([]);
  });
});

describe('NotificationService factory pause', () => {
  it('pages when a factory chain pauses, under the "waiting on you" switch', async () => {
    const { EventEmitter } = await import('node:events');
    const runs = new EventEmitter();
    const service = new NotificationService({} as Db, runs as never);
    let onWaitingInput = true;
    const sent: { event: string; title: string; body: string }[] = [];
    service.getSettings = () =>
      ({
        enabled: true,
        provider: 'webhook',
        url: 'http://127.0.0.1:9/unused',
        token: null,
        onRateLimited: false,
        onQuotaResumed: false,
        onWaitingInput,
        onRunFinished: false,
      }) satisfies NotificationSettings;
    service.dispatch = async (_cfg, msg) => {
      sent.push({ event: msg.event, title: msg.title, body: msg.body });
      return { ok: true, status: 200, error: null };
    };
    const run = { id: 'r1', title: 'DP-3: Build the APK', branch: null, state: 'failed', lastEvent: 'factory_chain_paused' };
    const message = '2 ticket runs failed in a row; the factory paused — fix the cause and click Run pipeline';
    runs.emit('note', run, 'retry_scheduled', {});
    expect(sent).toEqual([]);
    runs.emit('note', run, 'factory_chain_paused', { reason: 'failed_in_a_row', message });
    expect(sent).toEqual([{ event: 'factory_paused', title: 'Factory paused: DP-3: Build the APK', body: message }]);
    onWaitingInput = false;
    runs.emit('note', run, 'factory_chain_paused', { reason: 'failed_in_a_row', message });
    expect(sent).toHaveLength(1);
  });
});

describe('NotificationService completion holds', () => {
  it('pages "waiting on you" when the completion gate holds a ticket, with the blockers as text', async () => {
    const { EventEmitter } = await import('node:events');
    const runs = new EventEmitter();
    const service = new NotificationService({} as Db, runs as never);
    let onWaitingInput = true;
    const sent: { event: string; title: string; body: string; priority?: string }[] = [];
    service.getSettings = () =>
      ({
        enabled: true,
        provider: 'webhook',
        url: 'http://127.0.0.1:9/unused',
        token: null,
        onRateLimited: false,
        onQuotaResumed: false,
        onWaitingInput,
        onRunFinished: false,
      }) satisfies NotificationSettings;
    service.dispatch = async (_cfg, msg) => {
      sent.push({ event: msg.event, title: msg.title, body: msg.body, priority: msg.priority });
      return { ok: true, status: 200, error: null };
    };
    const run = { id: 'r1', title: 'DP-3 Build the APK', branch: null, state: 'done', lastEvent: 'completion_blocked' };
    runs.emit('note', run, 'completion_nudged', {});
    expect(sent).toEqual([]);
    runs.emit('note', run, 'completion_blocked', { blockers: ['No signing key', 'Which store account?'] });
    expect(sent).toEqual([
      {
        event: 'waiting_input',
        title: 'Agent waiting on you: DP-3 Build the APK',
        body: 'Run "DP-3 Build the APK" cannot finish its ticket and needs you:\n- No signing key\n- Which store account?',
        priority: 'high',
      },
    ]);
    runs.emit('note', run, 'completion_missing', {});
    expect(sent[1]).toEqual({
      event: 'waiting_input',
      title: 'Agent waiting on you: DP-3 Build the APK',
      body: 'Run "DP-3 Build the APK" stopped without confirming its ticket is finished; the ticket stays in Review until you answer it.',
      priority: 'high',
    });
    onWaitingInput = false;
    runs.emit('note', run, 'completion_blocked', { blockers: ['x'] });
    expect(sent).toHaveLength(2);
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
    const scheduler = Object.assign(new EventEmitter(), { state: () => ({ ...base, window: null, windows: [] }) });
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
    expect(sent.map((s) => s.title)).toEqual(['Antigravity (all models) quota reached', 'Claude (opus) quota reached']);
    await emit([opus]);
    expect(sent.at(-1)).toMatchObject({ event: 'quota_resumed', title: 'Antigravity (all models) quota is back' });
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
    const scheduler = Object.assign(new EventEmitter(), { state: () => ({ ...base, window: null, windows: [] }) });
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

  it('explains a waiting-input timeout instead of a generic failure', async () => {
    const { EventEmitter } = await import('node:events');
    const runs = new EventEmitter();
    const service = new NotificationService({} as Db, runs as never);
    const sent: { title: string; body: string }[] = [];
    service.getSettings = () =>
      ({ enabled: true, provider: 'webhook', url: 'http://127.0.0.1:9/unused', token: null, onRateLimited: true, onQuotaResumed: true, onWaitingInput: true, onRunFinished: true }) satisfies NotificationSettings;
    service.dispatch = async (_cfg, msg) => {
      sent.push({ title: msg.title, body: msg.body });
      return { ok: true, status: 200, error: null };
    };
    runs.emit('run', { id: 'r1', title: 'Nightly', branch: null, state: 'failed', lastEvent: 'waiting_input_timeout', cancelled: false }, true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('Nightly');
    expect(sent[0]!.body).toMatch(/permission/i);
    expect(sent[0]!.body).toMatch(/30 minutes/);
  });

  it('says a stalled run may be stuck, through the waiting-input switch', async () => {
    const { EventEmitter } = await import('node:events');
    const runs = new EventEmitter();
    const service = new NotificationService({} as Db, runs as never);
    const sent: { event: string; body: string }[] = [];
    service.getSettings = () =>
      ({ enabled: true, provider: 'webhook', url: 'http://127.0.0.1:9/unused', token: null, onRateLimited: true, onQuotaResumed: true, onWaitingInput: true, onRunFinished: false }) satisfies NotificationSettings;
    service.dispatch = async (_cfg, msg) => {
      sent.push({ event: msg.event, body: msg.body });
      return { ok: true, status: 200, error: null };
    };
    runs.emit('run', { id: 'r1', title: 'Big job', branch: null, state: 'waiting_input', lastEvent: 'stall_detected', cancelled: false }, true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('waiting_input');
    expect(sent[0]!.body).toMatch(/20 minutes/);
    expect(sent[0]!.body).toMatch(/stuck/i);
  });
});
