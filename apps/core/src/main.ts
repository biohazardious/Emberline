/**
 * Core entrypoint. Configuration comes from EMBERLINE_* env vars (see config.ts).
 */
import path from 'node:path';
import {
  ptydCommandCanceller,
  ptydCommandExecutor,
  setCommandCanceller,
  setCommandExecutor,
} from './command-exec.js';
import { loadConfig } from './config.js';
import { DockerEngine } from './docker/engine.js';
import { openDb } from './db/index.js';
import { PtydBridge } from './ptyd-bridge.js';
import { RunService } from './runs/service.js';
import { exitOnSecretsKeyError, forgetLogLine, startSecrets } from './secrets/startup.js';
import { Scheduler } from './scheduler/service.js';
import { buildServer } from './server.js';
import { startupWarnings } from './startup-warnings.js';
import { TicketService } from './tickets/service.js';

const config = loadConfig();
const { db, close: closeDb } = openDb(path.join(config.dataDir, 'emberline.db'));
// Before any service reads a secret: a wrong or missing key stops here and nothing is written.
let secrets: ReturnType<typeof startSecrets>;
try {
  secrets = startSecrets(db, { env: process.env, dataDir: config.dataDir });
} catch (error) {
  exitOnSecretsKeyError(error, {
    write: (text) => process.stderr.write(text),
    closeDb,
    exit: (code) => process.exit(code),
  });
  throw error; // unreachable for a key refusal (the process exited); other errors were rethrown above
}
const ptyd = new PtydBridge(config.ptydSocket);
// git, builds and tests for workspaces run in the runner container, never here.
setCommandExecutor(ptydCommandExecutor(ptyd));
setCommandCanceller(ptydCommandCanceller(ptyd));
// Probed through the runner (ptyd exec) like any other command; see docker/engine.ts.
let logDocker: (status: DockerEngine['status']) => void = () => undefined;
const docker = new DockerEngine(config.dockerHost, {
  certPath: config.dockerCertPath,
  cwd: config.workspacesDir,
  switchedOff: config.dockerEngineSwitchedOff,
  onChange: (status) => logDocker(status),
});
const runs = new RunService(db, config, ptyd, docker);
const scheduler = new Scheduler(db, runs, ptyd, config);
const tickets = new TicketService(db, runs, scheduler);

const app = await buildServer(
  { config, db, ptyd, runs, tickets, scheduler },
  { logger: { level: config.logLevel } },
);
if (secrets.source === 'created') {
  app.log.info(`secrets: created ${secrets.file}; back it up separately from the database`);
}
if (config.dockerEngineSettingInvalid !== undefined) {
  app.log.error(
    `EMBERLINE_DOCKER_ENGINE is "${config.dockerEngineSettingInvalid}". Only 0 (off) or 1 (on) are allowed. Compose starts one engine container per unit on the same volumes; set it to 0 or 1 in .env and run make up.`,
  );
}
if (secrets.encrypted > 0) app.log.info(`secrets: encrypted ${secrets.encrypted} stored secrets`);
if (secrets.cleanedRepoUrls > 0) {
  app.log.info(`secrets: removed credentials from ${secrets.cleanedRepoUrls} stored repository URLs`);
}
if (secrets.plaintextSnapshots.length > 0) {
  app.log.warn(
    `secrets: these snapshots from before this start still hold secrets in plaintext; delete them once you no longer need to roll back: ${secrets.plaintextSnapshots.join(', ')}`,
  );
}
const forgotten = forgetLogLine(secrets.forget);
if (forgotten) app.log[forgotten.level](forgotten.message);
for (const warning of startupWarnings(process.env, config)) {
  if (warning.data) app.log.warn(warning.data, warning.message);
  else app.log.warn(warning.message);
}
logDocker = (status) => {
  if (status.available)
    app.log.info({ host: config.dockerHost, version: status.version }, 'Docker engine available');
  else app.log.warn({ host: config.dockerHost, error: status.error }, 'Docker engine unreachable');
};
// A background task that forgot a .catch must not take down every running agent's control plane.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled promise rejection');
});
// Once the runner is back (first connect) and the exits are noted: Review tickets whose pipeline a
// restart cut off get it again, in every project, and factory chains that were on carry on.
let chainsResumed = false;
ptyd.on('status', (status) => {
  app.log.info({ socket: config.ptydSocket }, `ptyd ${status}`);
  if (status === 'connected') {
    const reconciled = runs.reconcile();
    // The engine is probed through the runner: probes start with the first connection (then every
    // 60 s), and each reconnect probes at once (a concurrent probe is shared).
    docker.start();
    void docker.probe();
    void scheduler.tick();
    if (!chainsResumed) {
      chainsResumed = true;
      void reconciled
        .catch(() => undefined)
        .then(() => tickets.resumeChains())
        .catch((err: unknown) => app.log.error({ err }, 'resuming factory chains failed'));
    }
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
      tickets.dispose();
      runs.dispose();
      scheduler.dispose();
      docker.stop();
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
