import type { ForgeAccount, ForgeAccountsResponse } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { ForgeAccountsService } from '../forge/accounts.js';

export function registerForgeAccountRoutes(app: FastifyInstance, accounts: ForgeAccountsService): void {
  app.get('/api/forge/accounts', async (): Promise<ForgeAccountsResponse> => accounts.list());
  app.post('/api/forge/accounts', async (request, reply): Promise<ForgeAccount> => {
    const created = await accounts.create(request.body);
    reply.code(201);
    return created;
  });
  app.patch<{ Params: { id: string } }>('/api/forge/accounts/:id', async (request): Promise<ForgeAccount> =>
    accounts.update(request.params.id, request.body),
  );
  app.delete<{ Params: { id: string } }>('/api/forge/accounts/:id', async (request) => {
    accounts.remove(request.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    '/api/forge/accounts/:id/check',
    async (request): Promise<ForgeAccount> => accounts.check(request.params.id),
  );
}
