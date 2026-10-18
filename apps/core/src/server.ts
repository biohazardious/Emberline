import { existsSync } from 'node:fs';
import { API_VERSION, type HealthResponse, PTYD_MIN_PROTOCOL_VERSION, PTYD_PROTOCOL_VERSION, type SystemStatus } from '@emberline/protocol';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { CoreConfig } from './config.js';
import { CronService } from './cron/service.js';
import type { Db } from './db/index.js';
import { installErrorHandler } from './errors.js';
import { PostMergeJobs } from './factory/post-merge.js';
import { IssueSyncService } from './forge/issue-sync.js';
import { ForgeService } from './forge/service.js';
import { PresenceRegistry } from './notifications/presence.js';
import { NotificationService } from './notifications/service.js';
import { registerOpsRoutes } from './ops.js';
import type { PtydBridge } from './ptyd-bridge.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerDockerRoutes } from './routes/docker.js';
import { registerEventRoutes } from './routes/events.js';
import { registerForgeRoutes } from './routes/forge.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerProjectImportRoutes } from './routes/project-import.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerWorktreeConfigRoutes } from './routes/worktree-config.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerBuildOutputRoutes } from './routes/build-outputs.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { ReviewService } from './review/service.js';
import type { RunService } from './runs/service.js';
import type { Scheduler } from './scheduler/service.js';
import { DEFAULT_BODY_LIMIT, installSecurityHeaders } from './security-headers.js';
import { IssueImportService } from './tickets/issue-import.js';
import type { TicketService } from './tickets/service.js';
import { UpdateService } from './updates/service.js';

export const VERSION = '0.3.2';

export interface CoreDeps {
  config: CoreConfig;
  db: Db;
  ptyd: PtydBridge;
  runs: RunService;
  tickets: TicketService;
  scheduler: Scheduler;
  /** Which clients are looking at which run; a fresh registry when omitted. */
  presence?: PresenceRegistry;
  /** The forge service; built from `db` and `runs` when omitted. */
  forge?: ForgeService;
  /** Issue label sync and write-back; built from the other services when omitted. */
  issueSync?: IssueSyncService;
  /** Background work after merges into main (rebuild main's demo); built from `db` and `runs` when omitted. */
  postMerge?: PostMergeJobs;
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
  const presence = deps.presence ?? new PresenceRegistry();
  deps.runs.setLogger(app.log);
  const notifications = new NotificationService(deps.db, deps.runs, deps.scheduler, { presence, log: (message, err) => app.log.error({ err }, message) });
  const forge = deps.forge ?? new ForgeService(deps.db, deps.runs);
  const cron = new CronService(deps.db, deps.runs, deps.scheduler, deps.config.timeZone);
  const updates = new UpdateService(deps.db, { version: VERSION });
  const issueSync =
    deps.issueSync ??
    new IssueSyncService(deps.db, deps.tickets, deps.runs, forge, { log: (message, err) => app.log.warn({ err }, message) });
  const postMerge =
    deps.postMerge ??
    new PostMergeJobs(deps.db, deps.runs, {
      log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)),
    });
  // A person's review feedback for a fresh attempt starts the ticket like the Board's Start does.
  const review = new ReviewService(deps.db, deps.runs, {
    log: (message, err) => app.log.warn({ err }, message),
    startTicketRun: async ({ ticketId, permissionMode, persona, section, replaceIdleRuns }) =>
      (
        await deps.tickets.start(
          ticketId,
          { permissionMode, persona },
          { byPerson: true, extraPromptSection: section, replaceIdleRun: { ids: replaceIdleRuns, reason: 'review_new_run' } },
        )
      ).run,
    // Review feedback asks for more work: a run with the completion tool must signal again.
    completionHint: (run) => deps.tickets.completeAgain(run, '\n\n'),
  });
  cron.start();
  notifications.start();
  review.start();
  updates.start();
  issueSync.start();
  postMerge.start();
  app.addHook('onClose', async () => {
    cron.stop();
    notifications.stop();
    review.stop();
    updates.stop();
    await issueSync.stop();
    await postMerge.stop();
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
    runnerOutdated: deps.ptyd.status === 'connected' && (deps.ptyd.protocolVersion ?? 0) < PTYD_MIN_PROTOCOL_VERSION,
    runnerUpdateAvailable:
      deps.ptyd.status === 'connected' &&
      (deps.ptyd.protocolVersion ?? 0) >= PTYD_MIN_PROTOCOL_VERSION &&
      (deps.ptyd.protocolVersion ?? 0) < PTYD_PROTOCOL_VERSION,
    docker: deps.runs.docker.status,
  }));
  registerProjectRoutes(app, { ...deps, postMerge });
  registerProjectImportRoutes(app, deps);
  registerWorktreeConfigRoutes(app, deps);
  registerTerminalRoutes(app, deps);
  registerRunRoutes(app, deps.runs, deps.scheduler);
  registerBuildOutputRoutes(app, deps.db, deps.runs.outputs);
  registerDockerRoutes(app, deps.runs);
  registerReviewRoutes(app, review);
  registerTicketRoutes(app, deps.tickets);
  registerSchedulerRoutes(app, deps.scheduler);
  registerNotificationRoutes(app, notifications);
  registerForgeRoutes(app, forge);
  registerIssueRoutes(app, new IssueImportService(deps.db, deps.tickets, forge, issueSync), issueSync);
  registerCronRoutes(app, cron);
  registerUpdateRoutes(app, updates);
  registerEventRoutes(app, deps.runs, deps.tickets, deps.scheduler, presence);

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
