/**
 * Core entrypoint. Configuration comes from EMBERLINE_* env vars (see config.ts).
 */
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { PtydBridge } from './ptyd-bridge.js';
import { RunService } from './runs/service.js';
import { buildServer } from './server.js';
import { TicketService } from './tickets/service.js';

const config = loadConfig();
const { db, close: closeDb } = openDb(path.join(config.dataDir, 'emberline.db'));
const ptyd = new PtydBridge(config.ptydSocket);
const runs = new RunService(db, config, ptyd);
const tickets = new TicketService(db, runs);

const app = await buildServer({ config, db, ptyd, runs, tickets }, { logger: { level: config.logLevel } });
ptyd.on('status', (status) => {
  app.log.info({ socket: config.ptydSocket }, `ptyd ${status}`);
  if (status === 'connected') void runs.reconcile();
});
ptyd.start();
runs.startReconciler();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().finally(() => {
      runs.dispose();
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
