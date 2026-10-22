import type {
  CreateScheduledJobBody,
  CronPreviewResponse,
  Run,
  ScheduledJob,
  UpdateScheduledJobBody,
} from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { CronService } from '../cron/service.js';

export function registerCronRoutes(app: FastifyInstance, cron: CronService): void {
  app.get<{ Querystring: { projectId?: string } }>('/api/cron', async (request): Promise<ScheduledJob[]> =>
    cron.list(request.query.projectId),
  );

  app.post<{ Body: CreateScheduledJobBody }>('/api/cron', async (request, reply): Promise<ScheduledJob> => {
    const job = cron.create(request.body ?? {});
    return reply.code(201).send(job);
  });

  app.post('/api/cron/preview', async (request): Promise<CronPreviewResponse> =>
    cron.preview(request.body ?? {}),
  );

  app.patch<{ Params: { id: string }; Body: UpdateScheduledJobBody }>(
    '/api/cron/:id',
    async (request): Promise<ScheduledJob> => cron.update(request.params.id, request.body ?? {}),
  );

  app.delete<{ Params: { id: string } }>('/api/cron/:id', async (request, reply): Promise<void> => {
    cron.remove(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    '/api/cron/:id/trigger',
    async (request): Promise<{ job: ScheduledJob; run: Run }> => cron.triggerNow(request.params.id),
  );
}
