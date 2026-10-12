import { existsSync } from 'node:fs';
import type { HealthResponse } from '@emberline/protocol';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export const VERSION = '0.0.0';

export interface CoreOptions {
  /** Built web UI directory; served with SPA fallback when present (production image). */
  webDir?: string;
}

export function buildServer(fastifyOptions: FastifyServerOptions = {}, options: CoreOptions = {}): FastifyInstance {
  const app = Fastify(fastifyOptions);
  const startedAt = Date.now();

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  if (options.webDir && existsSync(options.webDir)) {
    void app.register(fastifyStatic, { root: options.webDir, wildcard: false });
    // SPA fallback: unknown non-API GETs get index.html so client-side routes work on reload.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
