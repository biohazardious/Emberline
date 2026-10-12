import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { type OpenedDb, openDb } from './db/index.js';
import { PtydBridge } from './ptyd-bridge.js';
import { RunService } from './runs/service.js';
import { buildServer } from './server.js';
import { TicketService } from './tickets/service.js';

export interface TestApp {
  app: FastifyInstance;
  config: CoreConfig;
  dir: string;
  ptyd: PtydBridge;
  runs: RunService;
  tickets: TicketService;
  close(): Promise<void>;
}

/** Core wired to an in-memory DB and a ptyd socket path (ptyd itself is optional). */
export async function createTestApp(overrides: Partial<CoreConfig> = {}): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'core-'));
  const config: CoreConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    ptydSocket: path.join(dir, 'ptyd.sock'),
    workspacesDir: dir,
    secureCookies: false,
    trustProxy: false,
    sessionTtlMs: 60_000,
    logLevel: 'silent',
    hookUrl: 'http://127.0.0.1:0',
    hookCommand: 'emberline-hook',
    claudeCommand: 'claude',
    ...overrides,
  };
  const opened: OpenedDb = openDb(':memory:');
  const ptyd = new PtydBridge(config.ptydSocket);
  const runs = new RunService(opened.db, config, ptyd);
  const tickets = new TicketService(opened.db, runs);
  const app = await buildServer({ config, db: opened.db, ptyd, runs, tickets });
  return {
    app,
    config,
    dir,
    ptyd,
    runs,
    tickets,
    async close() {
      await app.close();
      runs.dispose();
      ptyd.stop();
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const CSRF = { [CSRF_HEADER]: '1' };

/** Runs first-time setup and returns the session cookie header value. */
export async function setupAndLogin(app: FastifyInstance, password = 'correct horse battery'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { password } });
  if (res.statusCode !== 200) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'emberline_session');
  if (!cookie) throw new Error('no session cookie');
  return `${cookie.name}=${cookie.value}`;
}
