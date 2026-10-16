import { ResumeSchedulerBody, type SchedulerState } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { Scheduler } from '../scheduler/service.js';

export function registerSchedulerRoutes(app: FastifyInstance, scheduler: Scheduler): void {
  app.get('/api/scheduler', async (): Promise<SchedulerState> => scheduler.state());

  app.patch('/api/scheduler', async (request): Promise<SchedulerState> => scheduler.update((request.body ?? {}) as never));

  /** Ends a quota pause now (one lane, or every lane) instead of waiting for the reset time. */
  app.post('/api/scheduler/resume', async (request): Promise<SchedulerState> =>
    scheduler.resumeNow(ResumeSchedulerBody.parse(request.body ?? {})),
  );
}
