import {
  type CollectBuildOutputsResponse,
  type ProjectBuildOutput,
  type ProjectBuildOutputsResponse,
  UpdateBuildOutputBody,
} from '@emberline/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { projects } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { BuildOutputArchive } from '../outputs/archive.js';
import { contentDisposition, UNTRUSTED_CONTENT_CSP } from '../security-headers.js';

/** Archived run deliverables: the per-project list, download, pin, delete and "collect now". */
export function registerBuildOutputRoutes(app: FastifyInstance, db: Db, archive: BuildOutputArchive): void {
  const requireProject = (id: string): void => {
    if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get())
      throw notFound('no such project');
  };

  /** `?run=<runId>` adds that run's handoff chain (`runChain`), which the page's run filter matches. */
  app.get<{ Params: { id: string }; Querystring: { run?: string } }>(
    '/api/projects/:id/build-outputs',
    async (request): Promise<ProjectBuildOutputsResponse> => {
      requireProject(request.params.id);
      const runId =
        typeof request.query.run === 'string' && request.query.run ? request.query.run : undefined;
      return archive.list(request.params.id, { runId });
    },
  );

  /**
   * Archives now from the project's runs whose worktrees still exist (outputs built before
   * archiving, or by hand). Runs in the background: 202 at once, the list reports progress.
   */
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/build-outputs/collect',
    async (request, reply): Promise<CollectBuildOutputsResponse> => {
      requireProject(request.params.id);
      reply.code(202);
      return { status: archive.startCollect(request.params.id) };
    },
  );

  /** Streams from a verified descriptor (APKs can be hundreds of MB), never inline. */
  app.get<{ Params: { id: string } }>('/api/build-outputs/:id/download', async (request, reply) => {
    const { stream, fileName, size } = await archive.open(request.params.id);
    try {
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(size));
      reply.header('Content-Disposition', contentDisposition('attachment', fileName));
      reply.header('Content-Security-Policy', UNTRUSTED_CONTENT_CSP);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return reply.send(stream);
  });

  app.patch<{ Params: { id: string } }>(
    '/api/build-outputs/:id',
    async (request): Promise<ProjectBuildOutput> => {
      const body = UpdateBuildOutputBody.parse(request.body);
      const row = archive.setPinned(request.params.id, body.pinned);
      const output = archive.list(row.projectId).outputs.find((o) => o.id === row.id);
      if (!output) throw notFound('no such build output');
      return output;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/build-outputs/:id', async (request, reply) => {
    await archive.remove(request.params.id);
    return reply.code(204).send();
  });
}
