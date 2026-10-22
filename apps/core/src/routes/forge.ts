import type { CreatePullRequestBody, RunForgeStatus } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { ForgeService } from '../forge/service.js';

export function registerForgeRoutes(app: FastifyInstance, forge: ForgeService): void {
  app.get<{ Params: { id: string } }>('/api/runs/:id/forge', async (request): Promise<RunForgeStatus> =>
    forge.getRunForgeStatus(request.params.id),
  );

  app.post<{ Params: { id: string }; Body: CreatePullRequestBody }>(
    '/api/runs/:id/forge/pr',
    async (request): Promise<RunForgeStatus> =>
      forge.createPullRequest(request.params.id, request.body ?? {}),
  );
}
