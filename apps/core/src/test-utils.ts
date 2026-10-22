import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type ForgeProvider } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { type CoreConfig, DEFAULT_DOCKER_CERT_PATH, DEFAULT_PREVIEW_PORTS } from './config.js';
import { type OpenedDb, openDb } from './db/index.js';
import { PostMergeJobs } from './factory/post-merge.js';
import { deriveApiUrl, insertAccount, normalizeServerUrl } from './forge/account-store.js';
import { IssueSyncService } from './forge/issue-sync.js';
import type { FetchLike } from './forge/issues.js';
import { ForgeService } from './forge/service.js';
import { PresenceRegistry } from './notifications/presence.js';
import { PtydBridge } from './ptyd-bridge.js';
import { KeepMainPushed } from './repository/keep-pushed.js';
import { RepositoryService } from './repository/service.js';
import { RecoveryService } from './runs/recovery-service.js';
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
  forge: ForgeService;
  /** The forge's fetch: tests assign `current` to fake the provider (the default is the global fetch). */
  forgeFetch: { current: FetchLike };
  /** The server's label sync and write-back (started with the server). */
  issueSync: IssueSyncService;
  /** The server's post-merge jobs (rebuild main after a merge). */
  postMerge: PostMergeJobs;
  /** The server's recovery suggestions for held runs. */
  recovery: RecoveryService;
  /** The server's project repository actions (status, connect, create, push main). */
  repository: RepositoryService;
  /** The server's Keep main pushed (pushes main after merges when the project opted in). */
  mainPush: KeepMainPushed;
  close(): Promise<void>;
}

/** Makes the test app listen on 127.0.0.1 and points the git gateway at it (the local git plays the runner). */
export async function startGitGateway(t: TestApp): Promise<string> {
  const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
  t.runs.gitGateway.baseUrl = address;
  return address;
}

/** Core wired to an in-memory DB and a ptyd socket path (ptyd itself is optional). */
export async function createTestApp(
  overrides: Partial<CoreConfig> = {},
  schedulerOptions: Partial<SchedulerOptions> = {},
  ticketOptions: Partial<TicketServiceOptions> = {},
  /** Runs on the fresh DB before core starts (what an earlier version left behind). */
  beforeStart?: (db: OpenedDb['db']) => void,
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
    runnerHosts: ['localhost'],
    hookCommand: 'emberline-hook',
    claudeCommand: 'claude',
    timeZone: 'UTC',
    setupToken: TEST_SETUP_TOKEN,
    allowedHosts: [],
    transcriptsDir: path.join(dir, 'transcripts'),
    previewPorts: DEFAULT_PREVIEW_PORTS,
    dockerCertPath: DEFAULT_DOCKER_CERT_PATH,
    ...overrides,
  };
  const opened: OpenedDb = openDb(':memory:');
  beforeStart?.(opened.db);
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
  const forgeFetch: { current: FetchLike } = { current: (url, init) => globalThis.fetch(url, init) };
  const forge = new ForgeService(opened.db, runs, { fetch: (url, init) => forgeFetch.current(url, init) });
  const issueSync = new IssueSyncService(opened.db, tickets, runs, forge);
  const postMerge = new PostMergeJobs(opened.db, runs);
  const recovery = new RecoveryService(opened.db, runs, scheduler, { completionReminder: (run) => tickets.completionReminder(run, '\n\n') });
  const repository = new RepositoryService(opened.db, forge.accounts, runs.gitGateway);
  const mainPush = new KeepMainPushed(opened.db, runs, repository);
  const app = await buildServer({
    config,
    db: opened.db,
    ptyd,
    runs,
    tickets,
    scheduler,
    presence,
    forge,
    issueSync,
    postMerge,
    recovery,
    repository,
    mainPush,
  });
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
    forge,
    forgeFetch,
    issueSync,
    postMerge,
    recovery,
    repository,
    mainPush,
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

/** A forge account without a forge call (tests); `apiUrl` defaults to the derived one. */
export function seedForgeAccount(
  db: OpenedDb['db'],
  input: { provider: ForgeProvider; serverUrl: string; token: string; username?: string | null; apiUrl?: string },
): string {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (!serverUrl) throw new Error(`bad server URL ${input.serverUrl}`);
  return insertAccount(db, {
    provider: input.provider,
    serverUrl,
    apiUrl: input.apiUrl ?? deriveApiUrl(input.provider, serverUrl),
    username: input.username ?? null,
    token: input.token,
  }).id;
}
