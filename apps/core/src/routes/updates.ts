import type { UpdatesResponse } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { UpdateService } from '../updates/service.js';

export function registerUpdateRoutes(app: FastifyInstance, updates: UpdateService): void {
  app.get('/api/updates', async (): Promise<UpdatesResponse> => updates.get());

  app.post('/api/updates/check', async (): Promise<UpdatesResponse> => {
    await updates.check();
    return updates.get();
  });

  app.patch('/api/updates/config', async (request): Promise<UpdatesResponse> =>
    updates.updateConfig(request.body ?? {}),
  );

  app.post<{ Params: { id: string } }>(
    '/api/updates/mcp/:id/refresh',
    async (request): Promise<UpdatesResponse> => updates.refreshMcp(request.params.id),
  );
}
