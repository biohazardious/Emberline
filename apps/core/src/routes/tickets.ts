import { type Run, type Ticket, TicketPromptBody } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { TicketService } from '../tickets/service.js';

export function registerTicketRoutes(app: FastifyInstance, tickets: TicketService): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tickets',
    async (request): Promise<Ticket[]> => tickets.list(request.params.projectId),
  );

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/tickets', async (request, reply) => {
    const ticket = tickets.create(request.params.projectId, request.body as never);
    reply.code(201);
    return ticket;
  });

  app.get<{ Params: { id: string } }>('/api/tickets/:id', async (request): Promise<Ticket> => tickets.get(request.params.id));

  app.patch<{ Params: { id: string } }>(
    '/api/tickets/:id',
    async (request): Promise<Ticket> => tickets.update(request.params.id, (request.body ?? {}) as never),
  );

  app.delete<{ Params: { id: string } }>('/api/tickets/:id', async (request) => {
    tickets.remove(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    '/api/tickets/:id/start',
    async (request, reply): Promise<{ ticket: Ticket; run: Run }> => {
      const result = await tickets.start(request.params.id, (request.body ?? {}) as never);
      reply.code(201);
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/tickets/:id/prompt',
    async (request): Promise<{ ticket: Ticket; run: Run }> =>
      tickets.prompt(request.params.id, TicketPromptBody.parse(request.body).text),
  );
}
