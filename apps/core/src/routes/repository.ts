import type { RepositoryStatus } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { RepositoryService } from '../repository/service.js';

export function registerRepositoryRoutes(app: FastifyInstance, repository: RepositoryService): void {
  type P = { Params: { id: string } };
  // No network: local refs and the last read of origin.
  app.get<P>('/api/projects/:id/repository', async (r): Promise<RepositoryStatus> =>
    repository.status(r.params.id),
  );
  app.post<P>('/api/projects/:id/repository/refresh', async (r): Promise<RepositoryStatus> =>
    repository.refresh(r.params.id),
  );
  app.post<P>('/api/projects/:id/repository/connect', async (r): Promise<RepositoryStatus> =>
    repository.connect(r.params.id, r.body),
  );
  app.post<P>('/api/projects/:id/repository/create', async (r): Promise<RepositoryStatus> =>
    repository.create(r.params.id, r.body),
  );
  app.post<P>('/api/projects/:id/repository/push-main', async (r): Promise<RepositoryStatus> =>
    repository.pushMain(r.params.id),
  );
  app.patch<P>('/api/projects/:id/repository', async (r): Promise<RepositoryStatus> =>
    repository.update(r.params.id, r.body),
  );
}
