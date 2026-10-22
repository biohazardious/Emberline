/** Project settings → Container preview (worktree-config/container-preview.ts). */
import type { ContainerPreviewOptionsResponse } from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projects } from '../db/schema.js';
import { ComposeConfigReader } from '../docker/compose-config.js';
import { notFound } from '../errors.js';
import { assertNotCloning } from '../factory/project-import.js';
import type { CoreDeps } from '../server.js';
import { containerPreviewOptions } from '../worktree-config/container-preview.js';

export function registerContainerPreviewRoutes(app: FastifyInstance, { db, ptyd, runs }: CoreDeps): void {
  const deps = { db, docker: runs.docker, reader: new ComposeConfigReader() };
  const projectOr404 = (id: string) => {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('no such project');
    return row;
  };

  /** Whether the box shows and can save; one cached `docker compose config` in the runner, no network. */
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/container-preview',
    async (request): Promise<ContainerPreviewOptionsResponse> => {
      const project = projectOr404(request.params.id);
      await assertNotCloning(ptyd, project.id);
      return containerPreviewOptions(deps, project);
    },
  );
}
