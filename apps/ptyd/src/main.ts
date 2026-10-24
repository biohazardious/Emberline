#!/usr/bin/env node
/**
 * ptyd entrypoint.
 *
 * Env:
 *   EMBERLINE_PTYD_SOCKET   socket path (default $XDG_RUNTIME_DIR/emberline/ptyd.sock or <tmp>/emberline/ptyd.sock)
 *   EMBERLINE_PTYD_LOG_DIR  directory for raw session logs (disabled when unset)
 *   EMBERLINE_PTYD_REQUIRE_LOCK  `1`: refuse spawn and exec until the socket's directory is locked
 *   EMBERLINE_PTYD_CANNOT_LOCK  `1`: started as another user than root; hello says the lock is impossible
 *   EMBERLINE_PTYD_READY_FD  a file descriptor to write `ready <dev> <ino>` to once listening, then close
 */
import { closeSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtydServer } from './server.js';

export function defaultSocketPath(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(base, 'emberline', 'ptyd.sock');
}

const log = (message: string) => process.stderr.write(`[ptyd] ${new Date().toISOString()} ${message}\n`);

const server = new PtydServer({
  socketPath: process.env.EMBERLINE_PTYD_SOCKET ?? defaultSocketPath(),
  logDir: process.env.EMBERLINE_PTYD_LOG_DIR || undefined,
  log,
  requireLock: process.env.EMBERLINE_PTYD_REQUIRE_LOCK === '1',
  cannotLock: process.env.EMBERLINE_PTYD_CANNOT_LOCK === '1',
});

/**
 * Tells the runner's entrypoint that ptyd listens, and which socket is its own: the entrypoint locks
 * the socket's directory only for that socket, never just because some socket has the name.
 */
function signalReady(): void {
  const fd = Number(process.env.EMBERLINE_PTYD_READY_FD);
  const id = server.socketIdentity;
  if (!Number.isInteger(fd) || fd < 3 || !id) return;
  try {
    writeSync(fd, `ready ${id.dev} ${id.ino}\n`);
    closeSync(fd);
  } catch (error) {
    // Nobody waits for it: the entrypoint gave up, and stops the container.
    log(`could not signal readiness: ${(error as Error).message}`);
    process.exit(1);
  }
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}, shutting down`);
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server.listen().then(signalReady, (error: unknown) => {
  log(`failed to start: ${(error as Error).message}`);
  process.exit(1);
});
