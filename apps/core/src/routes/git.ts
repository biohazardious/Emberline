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
  app.get<P>('/api/projects/:id/git/branches', async (r) => git.branches(r.params.id));
  app.post<P>('/api/projects/:id/git/branches', async (r) => {
    await git.createBranch(r.params.id, r.body);
    return { ok: true };
  });
  // A branch name holds slashes (feature/login): the client sends it URL-encoded as one segment.
  app.delete<{ Params: { id: string; name: string }; Querystring: { remote?: string } }>(
    '/api/projects/:id/git/branches/:name',
    async (r) => git.deleteBranch(r.params.id, r.params.name, r.query.remote === '1'),
  );
  app.post<P>('/api/projects/:id/git/working-branch', async (r) => {
    await git.setWorkingBranch(r.params.id, r.body);
    return { ok: true };
  });
  app.patch<P>('/api/projects/:id/git', async (r) => git.updateSettings(r.params.id, r.body));
  app.post<P>('/api/projects/:id/git/fetch', async (r) => git.fetch(r.params.id));
  app.post<P>('/api/projects/:id/git/pull', async (r) => git.pull(r.params.id, { auto: false }));
  app.post<P>('/api/projects/:id/git/pull/ticket', async (r) => git.pullTicket(r.params.id));
  app.post<P>('/api/projects/:id/git/release/draft', async (r) => git.draftRelease(r.params.id));
  app.post<P>('/api/projects/:id/git/match-origin', async (r) => git.matchOrigin(r.params.id, r.body));
}
