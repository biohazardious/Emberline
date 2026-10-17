import { ClientPresenceMessage, type Run, type SchedulerState, type ServerEvent, type Ticket } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { PresenceRegistry } from '../notifications/presence.js';
import type { RunService } from '../runs/service.js';
import type { Scheduler } from '../scheduler/service.js';
import type { TicketService } from '../tickets/service.js';
import { EVENTS_SEND_CAP, sendBounded } from './ws-send.js';

/** `/api/events`: single push channel for the UI (runs, tickets, scheduler); clients report presence on it. */
export function registerEventRoutes(
  app: FastifyInstance,
  runs: RunService,
  tickets: TicketService,
  scheduler: Scheduler,
  presence?: PresenceRegistry,
): void {
  app.get('/api/events', { websocket: true }, (socket) => {
    const id = Symbol('events-socket');
    const send = (event: ServerEvent) => void sendBounded(socket, event, EVENTS_SEND_CAP);
    // Attention is computed once per emit (memoised on the payload), not once per connected socket.
    const onRun = (run: Run) => send({ type: 'run', run: runs.attentionOf(run) });
    const onRunRemoved = (runId: string) => send({ type: 'run_removed', id: runId });
    const onTicket = (ticket: Ticket) => send({ type: 'ticket', ticket });
    const onTicketRemoved = (t: { id: string; projectId: string }) => send({ type: 'ticket_removed', ...t });
    const onScheduler = (state: SchedulerState) => send({ type: 'scheduler', scheduler: state });

    runs.on('run', onRun);
    runs.on('removed', onRunRemoved);
    tickets.on('ticket', onTicket);
    tickets.on('removed', onTicketRemoved);
    scheduler.on('state', onScheduler);

    // A bad message is ignored; the socket stays open.
    socket.on('message', (raw: unknown) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = ClientPresenceMessage.safeParse(data);
      if (parsed.success) presence?.set(id, parsed.data);
    });
    socket.on('close', () => {
      presence?.remove(id);
      runs.off('run', onRun);
      runs.off('removed', onRunRemoved);
      tickets.off('ticket', onTicket);
      tickets.off('removed', onTicketRemoved);
      scheduler.off('state', onScheduler);
    });
  });
}
