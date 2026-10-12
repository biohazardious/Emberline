import { HookEnvelope, type Run, type RunDetail } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { RunService } from '../runs/service.js';

/** Hook payloads can carry large tool inputs; core keeps only a summary. */
const HOOK_BODY_LIMIT = 8 * 1024 * 1024;

export function registerRunRoutes(app: FastifyInstance, runs: RunService): void {
  app.get('/api/runs', async (): Promise<Run[]> => runs.list());

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request): Promise<RunDetail> => runs.get(request.params.id));

  app.post('/api/runs', async (request, reply): Promise<Run> => {
    const run = await runs.create(request.body as never);
    reply.code(201);
    return run;
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (request): Promise<Run> => runs.stop(request.params.id));

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    await runs.remove(request.params.id);
    return { ok: true };
  });

  /**
   * Called by `emberline-hook` inside the runner. Exempt from cookie/CSRF auth (see auth
   * plugin); authenticated by the per-run bearer token instead.
   */
  app.post('/api/internal/hooks', { bodyLimit: HOOK_BODY_LIMIT }, async (request) => {
    const envelope = HookEnvelope.parse(request.body);
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const run = runs.ingestHook(envelope, token);
    return { ok: true, state: run.state };
  });
}
