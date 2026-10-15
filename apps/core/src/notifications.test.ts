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
});
