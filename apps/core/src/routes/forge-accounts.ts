import type { ForgeAccount, ForgeAccountsResponse, ForgeOwnersResponse } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { forgetLegacyToken } from '../forge/account-store.js';
import type { ForgeAccountsService } from '../forge/accounts.js';

export function registerForgeAccountRoutes(
  app: FastifyInstance,
  accounts: ForgeAccountsService,
  db: Db,
): void {
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
  app.get<{ Params: { id: string } }>(
    '/api/forge/accounts/:id/owners',
    async (request): Promise<ForgeOwnersResponse> => accounts.owners(request.params.id),
  );
  app.delete('/api/forge/legacy-token', async () => {
    forgetLegacyToken(db);
    return { ok: true };
  });
}
