/**
 * Core entrypoint. Configuration comes from EMBERLINE_* env vars (see config.ts).
 */
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { PtydBridge } from './ptyd-bridge.js';
import { RunService } from './runs/service.js';
import { Scheduler } from './scheduler/service.js';
import { buildServer } from './server.js';
import { TicketService } from './tickets/service.js';

const config = loadConfig();
const { db, close: closeDb } = openDb(path.join(config.dataDir, 'emberline.db'));
const ptyd = new PtydBridge(config.ptydSocket);
const runs = new RunService(db, config, ptyd);
const scheduler = new Scheduler(db, runs, ptyd, config);
const tickets = new TicketService(db, runs, scheduler);

const app = await buildServer(
  { config, db, ptyd, runs, tickets, scheduler },
  { logger: { level: config.logLevel } },
);
// A background task that forgot a .catch must not take down every running agent's control plane.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});
ptyd.on('status', (status) => {
  app.log.info({ socket: config.ptydSocket }, `ptyd ${status}`);
  if (status === 'connected') {
    void runs.reconcile();
    void scheduler.tick();
  }
});
ptyd.start();
runs.startReconciler();
scheduler.start();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().finally(() => {
      runs.dispose();
      scheduler.dispose();
      ptyd.stop();
      closeDb();
      process.exit(0);
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
