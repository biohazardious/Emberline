import type {
  DockerCleanupResponse,
  DockerOverview,
  DockerProjectActionResponse,
  DockerProjectLogsResponse,
} from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.js';
import type { RunService } from '../runs/service.js';

/**
 * The Docker page: Emberline's compose projects in the engine sidecar and the actions on them.
 * Only names Emberline makes are acted on (400 otherwise); with the engine off, actions are 409.
 */
export function registerDockerRoutes(app: FastifyInstance, runs: RunService): void {
  app.get('/api/docker', async (): Promise<DockerOverview> => runs.dockerOverview());

  app.post<{ Params: { name: string } }>(
    '/api/docker/projects/:name/stop',
    async (request): Promise<DockerProjectActionResponse> => runs.stopDockerProject(request.params.name),
  );

  app.post<{ Params: { name: string } }>(
    '/api/docker/projects/:name/remove',
    async (request): Promise<DockerProjectActionResponse> => runs.removeDockerProject(request.params.name),
  );

  /** `?service=<svc>`: one service's output; without it, every service's. */
  app.get<{ Params: { name: string }; Querystring: { service?: unknown } }>(
    '/api/docker/projects/:name/logs',
    async (request): Promise<DockerProjectLogsResponse> => {
      const service = request.query.service;
      if (service !== undefined && typeof service !== 'string') throw badRequest('give `service` once');
      return runs.dockerProjectLogs(
        request.params.name,
        typeof service === 'string' && service !== '' ? service : undefined,
      );
    },
  );

  app.post('/api/docker/cleanup', async (): Promise<DockerCleanupResponse> => runs.dockerCleanupNow());
}
