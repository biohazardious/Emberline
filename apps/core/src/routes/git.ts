import type { FastifyInstance } from 'fastify';
import type { GitPageService } from '../git-page/service.js';

export function registerGitRoutes(app: FastifyInstance, git: GitPageService): void {
  type P = { Params: { id: string } };
  type Q = { ref?: string; cursor?: string; path?: string; base?: string; head?: string };
  app.get<P & { Querystring: Q }>('/api/projects/:id/git/commits', async (r) =>
    git.commits(r.params.id, r.query.ref, r.query.cursor),
  );
  app.get<{ Params: { id: string; sha: string } }>('/api/projects/:id/git/commits/:sha', async (r) =>
    git.commit(r.params.id, r.params.sha),
  );
  app.get<{ Params: { id: string; sha: string }; Querystring: Q }>(
    '/api/projects/:id/git/commits/:sha/file',
    async (r) => git.commitFile(r.params.id, r.params.sha, r.query.path),
  );
  app.get<P & { Querystring: Q }>('/api/projects/:id/git/compare', async (r) =>
    git.compare(r.params.id, r.query.base, r.query.head),
  );
  app.get<P & { Querystring: Q }>('/api/projects/:id/git/compare/file', async (r) =>
    git.compareFile(r.params.id, r.query.base, r.query.head, r.query.path),
  );
}
