import {
  BulkTicketBody,
  type BulkTicketResult,
  type Run,
  type Ticket,
  TicketExportQuery,
  TicketPromptBody,
} from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { contentDisposition } from '../security-headers.js';
import { ticketExportCsv, ticketExportFileName } from '../tickets/export.js';
import type { TicketService } from '../tickets/service.js';

export function registerTicketRoutes(app: FastifyInstance, tickets: TicketService): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tickets',
    async (request): Promise<Ticket[]> => tickets.list(request.params.projectId),
  );

  /** `?format=csv|json&status=ready,review`: always a download, never rendered by the browser. */
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tickets/export',
    async (request, reply) => {
      const query = TicketExportQuery.parse(request.query ?? {});
      const doc = tickets.exportBoard(request.params.projectId, query.status);
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header(
        'Content-Disposition',
        contentDisposition('attachment', ticketExportFileName(doc, query.format)),
      );
      if (query.format === 'csv') {
        reply.type('text/csv; charset=utf-8');
        return ticketExportCsv(doc);
      }
      reply.type('application/json; charset=utf-8');
      return JSON.stringify(doc, null, 2);
    },
  );

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/tickets', async (request, reply) => {
    const ticket = tickets.create(request.params.projectId, request.body as never);
    reply.code(201);
    return ticket;
  });

  /** One action (move, priority, persona, delete) over up to `BULK_TICKET_LIMIT` tickets. */
  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tickets/bulk',
    async (request): Promise<BulkTicketResult> =>
      tickets.bulk(request.params.projectId, BulkTicketBody.parse(request.body ?? {})),
  );

  app.get<{ Params: { id: string } }>('/api/tickets/:id', async (request): Promise<Ticket> =>
    tickets.get(request.params.id),
  );

  app.patch<{ Params: { id: string } }>('/api/tickets/:id', async (request): Promise<Ticket> =>
    tickets.update(request.params.id, (request.body ?? {}) as never, { byPerson: true }),
  );

  app.delete<{ Params: { id: string } }>('/api/tickets/:id', async (request) => {
    tickets.remove(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    '/api/tickets/:id/start',
    async (request, reply): Promise<{ ticket: Ticket; run: Run }> => {
      const result = await tickets.start(request.params.id, (request.body ?? {}) as never, {
        byPerson: true,
      });
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
