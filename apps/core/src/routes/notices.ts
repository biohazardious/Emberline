import type { Notice } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors.js';
import type { NoticeService } from '../notices/service.js';

/** Inbox notices: the list and Dismiss. */
export function registerNoticeRoutes(app: FastifyInstance, notices: NoticeService): void {
  app.get('/api/notices', async (): Promise<Notice[]> => notices.list());

  app.post<{ Params: { id: string } }>('/api/notices/:id/dismiss', async (req) => {
    if (!notices.dismiss(req.params.id)) throw notFound('no such notice');
    return { ok: true };
  });
}
