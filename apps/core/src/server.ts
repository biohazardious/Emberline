import { existsSync } from 'node:fs';
import type { HealthResponse, SystemStatus } from '@emberline/protocol';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { CoreConfig } from './config.js';
import type { Db } from './db/index.js';
import { installErrorHandler } from './errors.js';
import type { PtydBridge } from './ptyd-bridge.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import type { RunService } from './runs/service.js';

export const VERSION = '0.0.0';

export interface CoreDeps {
  config: CoreConfig;
  db: Db;
  ptyd: PtydBridge;
  runs: RunService;
}

export async function buildServer(deps: CoreDeps, fastifyOptions: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ ...fastifyOptions, trustProxy: deps.config.trustProxy });
  const startedAt = Date.now();

  installErrorHandler(app);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  registerAuth(app, deps);

  app.get('/api/system', async (): Promise<SystemStatus> => ({ version: VERSION, ptyd: deps.ptyd.status }));
  registerProjectRoutes(app, deps);
  registerTerminalRoutes(app, deps);
  registerRunRoutes(app, deps.runs);

  const { webDir } = deps.config;
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    // SPA fallback: unknown non-API GETs get index.html so client-side routes work on reload.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'route not found' });
    });
  } else {
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: 'not_found', message: 'route not found' }),
    );
  }

  return app;
}
