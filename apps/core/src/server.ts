import { existsSync } from 'node:fs';
import { API_VERSION, type HealthResponse, PTYD_PROTOCOL_VERSION, type SystemStatus } from '@emberline/protocol';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { CoreConfig } from './config.js';
import { CronService } from './cron/service.js';
import type { Db } from './db/index.js';
import { installErrorHandler } from './errors.js';
import { ForgeService } from './forge/service.js';
import { NotificationService } from './notifications/service.js';
import { registerOpsRoutes } from './ops.js';
import type { PtydBridge } from './ptyd-bridge.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerEventRoutes } from './routes/events.js';
import { registerForgeRoutes } from './routes/forge.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { ReviewService } from './review/service.js';
import type { RunService } from './runs/service.js';
import type { Scheduler } from './scheduler/service.js';
import { DEFAULT_BODY_LIMIT, installSecurityHeaders } from './security-headers.js';
import type { TicketService } from './tickets/service.js';
import { UpdateService } from './updates/service.js';

export const VERSION = '0.2.1';

export interface CoreDeps {
  config: CoreConfig;
  db: Db;
  ptyd: PtydBridge;
  runs: RunService;
  tickets: TicketService;
  scheduler: Scheduler;
}

export async function buildServer(deps: CoreDeps, fastifyOptions: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: DEFAULT_BODY_LIMIT,
    // Demo capability tokens travel as a path parameter.
    routerOptions: { maxParamLength: 512 },
    ...fastifyOptions,
    trustProxy: deps.config.trustProxy,
  });
  const startedAt = Date.now();
  const notifications = new NotificationService(deps.db, deps.runs, deps.scheduler);
  const forge = new ForgeService(deps.db, deps.runs);
  const cron = new CronService(deps.db, deps.runs, deps.scheduler, deps.config.timeZone);
  const updates = new UpdateService(deps.db, { version: VERSION });
  cron.start();
  updates.start();
  app.addHook('onClose', async () => {
    cron.stop();
    updates.stop();
  });

  installErrorHandler(app);
  installSecurityHeaders(app);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  registerAuth(app, deps);
  registerOpsRoutes(app, deps, startedAt);

  app.get('/api/system', async (): Promise<SystemStatus> => ({
    version: VERSION,
    apiVersion: API_VERSION,
    ptyd: deps.ptyd.status,
    runnerOutdated: deps.ptyd.status === 'connected' && (deps.ptyd.protocolVersion ?? 0) < PTYD_PROTOCOL_VERSION,
  }));
  registerProjectRoutes(app, deps);
  registerTerminalRoutes(app, deps);
  registerRunRoutes(app, deps.runs, deps.scheduler);
  registerReviewRoutes(app, new ReviewService(deps.db, deps.runs));
  registerTicketRoutes(app, deps.tickets);
  registerSchedulerRoutes(app, deps.scheduler);
  registerNotificationRoutes(app, notifications);
  registerForgeRoutes(app, forge);
  registerCronRoutes(app, cron);
  registerUpdateRoutes(app, updates);
  registerEventRoutes(app, deps.runs, deps.tickets, deps.scheduler);

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
