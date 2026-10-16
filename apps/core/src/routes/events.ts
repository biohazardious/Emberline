import type { Run, SchedulerState, ServerEvent, Ticket } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';
import type { TicketService } from '../tickets/service.js';
import { EVENTS_SEND_CAP, sendBounded } from './ws-send.js';

/** `/api/events`: single push channel for the UI (runs, tickets, scheduler). */
export function registerEventRoutes(
  app: FastifyInstance,
  runs: RunService,
  tickets: TicketService,
  scheduler: Scheduler,
): void {
  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: ServerEvent) => void sendBounded(socket, event, EVENTS_SEND_CAP);
    const onRun = (run: Run) => send({ type: 'run', run });
    const onRunRemoved = (id: string) => send({ type: 'run_removed', id });
    const onTicket = (ticket: Ticket) => send({ type: 'ticket', ticket });
    const onTicketRemoved = (t: { id: string; projectId: string }) => send({ type: 'ticket_removed', ...t });
    const onScheduler = (state: SchedulerState) => send({ type: 'scheduler', scheduler: state });

    runs.on('run', onRun);
    runs.on('removed', onRunRemoved);
    tickets.on('ticket', onTicket);
    tickets.on('removed', onTicketRemoved);
    scheduler.on('state', onScheduler);
    socket.on('close', () => {
      runs.off('run', onRun);
      runs.off('removed', onRunRemoved);
      tickets.off('ticket', onTicket);
      tickets.off('removed', onTicketRemoved);
      scheduler.off('state', onScheduler);
    });
  });
}
