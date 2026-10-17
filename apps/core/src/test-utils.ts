import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { type OpenedDb, openDb } from './db/index.js';
import { PresenceRegistry } from './notifications/presence.js';
import { PtydBridge } from './ptyd-bridge.js';
import { RunService } from './runs/service.js';
import { Scheduler, type SchedulerOptions } from './scheduler/service.js';
import { buildServer } from './server.js';
import { TicketService, type TicketServiceOptions } from './tickets/service.js';

export interface TestApp {
  app: FastifyInstance;
  config: CoreConfig;
  dir: string;
  db: OpenedDb['db'];
  ptyd: PtydBridge;
  runs: RunService;
  tickets: TicketService;
  scheduler: Scheduler;
  presence: PresenceRegistry;
  close(): Promise<void>;
}

/** Core wired to an in-memory DB and a ptyd socket path (ptyd itself is optional). */
export async function createTestApp(
  overrides: Partial<CoreConfig> = {},
  schedulerOptions: Partial<SchedulerOptions> = {},
  ticketOptions: Partial<TicketServiceOptions> = {},
): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'core-'));
  const config: CoreConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    ptydSocket: path.join(dir, 'ptyd.sock'),
    workspacesDir: dir,
    workspacesHostDir: undefined,
    secureCookies: false,
    trustProxy: false,
    sessionTtlMs: 60_000,
    logLevel: 'silent',
    hookUrl: 'http://127.0.0.1:0',
    hookCommand: 'emberline-hook',
    claudeCommand: 'claude',
    timeZone: 'UTC',
    setupToken: TEST_SETUP_TOKEN,
    allowedHosts: [],
    transcriptsDir: path.join(dir, 'transcripts'),
    ...overrides,
  };
  const opened: OpenedDb = openDb(':memory:');
  const ptyd = new PtydBridge(config.ptydSocket);
  const runs = new RunService(opened.db, config, ptyd);
  // No periodic ticks in tests: event-driven kicks plus explicit tick() calls.
  const scheduler = new Scheduler(opened.db, runs, ptyd, config, {
    jitterMinMs: 0,
    jitterMaxMs: 0,
    screenSettleMs: 200,
    ...schedulerOptions,
  });
  // Pipelines run right after a Stop unless a test asks for the settle window.
  const tickets = new TicketService(opened.db, runs, scheduler, { pipelineSettleMs: 0, ...ticketOptions });
  const presence = new PresenceRegistry();
  const app = await buildServer({ config, db: opened.db, ptyd, runs, tickets, scheduler, presence });
  return {
    app,
    config,
    dir,
    db: opened.db,
    ptyd,
    runs,
    tickets,
    scheduler,
    presence,
    async close() {
      await app.close();
      // Background archive passes must not outlive the DB and temp dir they use.
      await runs.outputs.idle();
      tickets.dispose();
      runs.dispose();
      scheduler.dispose();
      ptyd.stop();
      opened.close();
      // A process that is still exiting may add a file while the tree is removed (ENOTEMPTY): retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export const CSRF = { [CSRF_HEADER]: '1' };

/** Runs first-time setup and returns the session cookie header value. */
export const TEST_SETUP_TOKEN = 'test-setup-token';

export async function setupAndLogin(app: FastifyInstance, password = 'correct horse battery'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: CSRF,
    payload: { password, setupToken: TEST_SETUP_TOKEN },
  });
  if (res.statusCode !== 200) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'emberline_session');
  if (!cookie) throw new Error('no session cookie');
  return `${cookie.name}=${cookie.value}`;
}
