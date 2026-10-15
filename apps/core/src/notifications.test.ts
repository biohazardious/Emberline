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
