import type { Run, ServerEvent, Ticket } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { RunService } from '../runs/service.js';
import type { TicketService } from '../tickets/service.js';

/** `/api/events`: single push channel for the UI (runs + tickets). */
export function registerEventRoutes(app: FastifyInstance, runs: RunService, tickets: TicketService): void {
  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    const onRun = (run: Run) => send({ type: 'run', run });
    const onRunRemoved = (id: string) => send({ type: 'run_removed', id });
    const onTicket = (ticket: Ticket) => send({ type: 'ticket', ticket });
    const onTicketRemoved = (t: { id: string; projectId: string }) => send({ type: 'ticket_removed', ...t });

    runs.on('run', onRun);
    runs.on('removed', onRunRemoved);
    tickets.on('ticket', onTicket);
    tickets.on('removed', onTicketRemoved);
    socket.on('close', () => {
      runs.off('run', onRun);
      runs.off('removed', onRunRemoved);
      tickets.off('ticket', onTicket);
      tickets.off('removed', onTicketRemoved);
    });
  });
}
