/** The approved `.emberline/worktree.yml` and the review of HEAD's version (worktree-config/trust.ts). */
import { ApproveWorktreeConfigBody, type WorktreeConfigStatusResponse } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projects } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { assertNotCloning } from '../factory/project-import.js';
import type { CoreDeps } from '../server.js';
import { approveWorktreeConfig, approveWorktreeConfigRemoval, worktreeConfigStatus } from '../worktree-config/trust.js';

export function registerWorktreeConfigRoutes(app: FastifyInstance, { db, ptyd }: CoreDeps): void {
  const projectOr404 = (id: string) => {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('no such project');
    return row;
  };

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/worktree-config',
    async (request): Promise<WorktreeConfigStatusResponse> => {
      const project = projectOr404(request.params.id);
      await assertNotCloning(ptyd, project.id);
      return worktreeConfigStatus(db, project);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/worktree-config/approve',
    async (request): Promise<WorktreeConfigStatusResponse> => {
      const project = projectOr404(request.params.id);
      const body = ApproveWorktreeConfigBody.safeParse(request.body ?? {});
      if (!body.success) {
        throw badRequest('send { sha256 } (the 64-character hex sha256 of the reviewed content) or { removal: true }');
      }
      await assertNotCloning(ptyd, project.id);
      return 'removal' in body.data
        ? approveWorktreeConfigRemoval(db, project)
        : approveWorktreeConfig(db, project, body.data.sha256);
    },
  );
}
