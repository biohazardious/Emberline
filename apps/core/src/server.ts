import { existsSync } from 'node:fs';
import {
  API_VERSION,
  type HealthResponse,
  PTYD_MIN_PROTOCOL_VERSION,
  PTYD_PROTOCOL_VERSION,
  type SystemStatus,
  WS_PROTOCOL,
} from '@emberline/protocol';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { CoreConfig } from './config.js';
import { CronService } from './cron/service.js';
import type { Db } from './db/index.js';
import { installErrorHandler } from './errors.js';
import { PostMergeJobs } from './factory/post-merge.js';
import { IssueSyncService } from './forge/issue-sync.js';
import { requestUrlForLog } from './git-gateway/gateway.js';
import { ForgeService } from './forge/service.js';
import { PresenceRegistry } from './notifications/presence.js';
import { NotificationService } from './notifications/service.js';
import { registerOpsRoutes } from './ops.js';
import type { PtydBridge } from './ptyd-bridge.js';
import { KeepMainPushed } from './repository/keep-pushed.js';
import { RepositoryService } from './repository/service.js';
import { registerContainerPreviewRoutes } from './routes/container-preview.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerDockerRoutes } from './routes/docker.js';
import { registerEventRoutes } from './routes/events.js';
import { registerForgeRoutes } from './routes/forge.js';
import { registerForgeAccountRoutes } from './routes/forge-accounts.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerProjectImportRoutes } from './routes/project-import.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRepositoryRoutes } from './routes/repository.js';
import { registerWorktreeConfigRoutes } from './routes/worktree-config.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerBuildOutputRoutes } from './routes/build-outputs.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { ReviewService } from './review/service.js';
import { QuestionService } from './runs/question-service.js';
import { RecoveryService } from './runs/recovery-service.js';
import type { RunService } from './runs/service.js';
import type { Scheduler } from './scheduler/service.js';
import { DEFAULT_BODY_LIMIT, installSecurityHeaders } from './security-headers.js';
import { IssueImportService } from './tickets/issue-import.js';
import type { TicketService } from './tickets/service.js';
import { UpdateService } from './updates/service.js';

export const VERSION = '0.5.2';

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
  /** Recovery suggestions for held runs; built from `db`, `runs` and `tickets` when omitted. */
  recovery?: RecoveryService;
  /** Project repository actions; built from db and the forge accounts when omitted. */
  repository?: RepositoryService;
  /** Keep main pushed after merges; built when omitted. */
  mainPush?: KeepMainPushed;
}

/** Fastify's request serializer, with a git gateway capability in the URL redacted (see `requestUrlForLog`). */
const requestLogSerializer = (req: FastifyRequest) => ({
  method: req.method,
  url: requestUrlForLog(req.url),
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});

/** The logger options with that serializer (an explicit `logger: false` stays off). */
function withRequestRedaction(logger: FastifyServerOptions['logger']): FastifyServerOptions['logger'] {
  if (!logger) return logger;
  const options = logger === true ? {} : logger;
  return { ...options, serializers: { ...options.serializers, req: requestLogSerializer } };
}

export async function buildServer(
  deps: CoreDeps,
  fastifyOptions: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: DEFAULT_BODY_LIMIT,
    // Demo capability tokens travel as a path parameter.
    routerOptions: { maxParamLength: 512 },
    ...fastifyOptions,
    logger: withRequestRedaction(fastifyOptions.logger),
    trustProxy: deps.config.trustProxy,
  });
  const startedAt = Date.now();
  const presence = deps.presence ?? new PresenceRegistry();
  deps.runs.setLogger(app.log);
  const notifications = new NotificationService(deps.db, deps.runs, deps.scheduler, {
    presence,
    log: (message, err) => app.log.error({ err }, message),
  });
  const forge = deps.forge ?? new ForgeService(deps.db, deps.runs);
  void forge.accounts.start((message) => app.log.warn(message));
  const cron = new CronService(deps.db, deps.runs, deps.scheduler, deps.config.timeZone);
  const updates = new UpdateService(deps.db, { version: VERSION });
  const issueSync =
    deps.issueSync ??
    new IssueSyncService(deps.db, deps.tickets, deps.runs, forge, {
      log: (message, err) => app.log.warn({ err }, message),
    });
  const postMerge =
    deps.postMerge ??
    new PostMergeJobs(deps.db, deps.runs, {
      log: (message, err) => (err ? app.log.warn({ err }, message) : app.log.info(message)),
    });
  const repository = deps.repository ?? new RepositoryService(deps.db, forge.accounts, deps.runs.gitGateway);
  const mainPush =
    deps.mainPush ??
    new KeepMainPushed(deps.db, deps.runs, repository, { log: (message) => app.log.warn(message) });
  // A person's review feedback for a fresh attempt starts the ticket like the Board's Start does.
  const review = new ReviewService(deps.db, deps.runs, {
    log: (message, err) => app.log.warn({ err }, message),
    startTicketRun: async ({ ticketId, permissionMode, persona, section, replaceIdleRuns }) =>
      (
        await deps.tickets.start(
          ticketId,
          { permissionMode, persona },
          {
            byPerson: true,
            extraPromptSection: section,
            replaceIdleRun: { ids: replaceIdleRuns, reason: 'review_new_run' },
          },
        )
      ).run,
    // Review feedback asks for more work: a run with the completion tool must signal again.
    completionHint: (run) => deps.tickets.completionReminder(run, '\n\n'),
  });
  const recovery =
    deps.recovery ??
    new RecoveryService(deps.db, deps.runs, deps.scheduler, {
      completionReminder: (run) => deps.tickets.completionReminder(run, '\n\n'),
    });
  const questions = new QuestionService(deps.db, deps.runs, recovery, {
    completionReminder: (run) => deps.tickets.completionReminder(run, '\n\n'),
    suggestModel: deps.config.suggestModel,
    claudeCommand: deps.config.claudeCommand,
  });
  cron.start();
  notifications.start();
  review.start();
  updates.start();
  issueSync.start();
  // After a merge into main, a running main container preview is rebuilt on its port.
  postMerge.registerPostMergeStep('refresh main preview', ({ projectId }) =>
    deps.runs.mainPreviews.refresh(projectId),
  );
  postMerge.start();
  mainPush.start();
  // Stored pushes (from before a restart, or kept while the runner was away) run once core listens
  // and the runner is connected, and again on each reconnect.
  let listening = false;
  const resumeMainPushes = () => {
    if (listening && deps.ptyd.status === 'connected') mainPush.resumePending();
  };
  const onPtydStatus = (status: string) => {
    if (status === 'connected') resumeMainPushes();
  };
  deps.ptyd.on('status', onPtydStatus);
  app.addHook('onListen', async () => {
    listening = true;
    resumeMainPushes();
  });
  app.addHook('onClose', async () => {
    deps.ptyd.off('status', onPtydStatus);
    cron.stop();
    notifications.stop();
    review.stop();
    updates.stop();
    await issueSync.stop();
    await postMerge.stop();
    await mainPush.stop();
  });

  installErrorHandler(app);
  installSecurityHeaders(app, deps.config.previewPorts);
  await app.register(cookie);
  // Browsers offer `emberline` plus `emberline.key.<key>` (the per-login key, see auth/plugin.ts);
  // only `emberline` is echoed, so the key never comes back in a response.
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
      handleProtocols: (p: Set<string>) => (p.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    },
  });

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
    runnerOutdated:
      deps.ptyd.status === 'connected' && (deps.ptyd.protocolVersion ?? 0) < PTYD_MIN_PROTOCOL_VERSION,
    runnerUpdateAvailable:
      deps.ptyd.status === 'connected' &&
      (deps.ptyd.protocolVersion ?? 0) >= PTYD_MIN_PROTOCOL_VERSION &&
      (deps.ptyd.protocolVersion ?? 0) < PTYD_PROTOCOL_VERSION,
    docker: deps.runs.docker.status,
  }));
  registerProjectRoutes(app, { ...deps, postMerge, mainPush });
  registerProjectImportRoutes(app, deps);
  registerWorktreeConfigRoutes(app, deps);
  registerContainerPreviewRoutes(app, deps);
  registerTerminalRoutes(app, deps);
  registerRunRoutes(app, deps.runs, deps.scheduler, recovery, questions);
  // The runner's git with a forge account (`/api/internal/git/<capability>/…`): core adds the credential.
  deps.runs.gitGateway.register(app);
  registerBuildOutputRoutes(app, deps.db, deps.runs.outputs);
  registerDockerRoutes(app, deps.runs);
  registerReviewRoutes(app, review);
  registerTicketRoutes(app, deps.tickets);
  registerSchedulerRoutes(app, deps.scheduler);
  registerNotificationRoutes(app, notifications);
  registerForgeRoutes(app, forge);
  registerForgeAccountRoutes(app, forge.accounts, deps.db);
  registerRepositoryRoutes(app, repository);
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
