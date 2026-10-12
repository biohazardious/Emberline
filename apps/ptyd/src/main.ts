#!/usr/bin/env node
/**
 * ptyd entrypoint.
 *
 * Env:
 *   EMBERLINE_PTYD_SOCKET   socket path (default $XDG_RUNTIME_DIR/emberline/ptyd.sock or <tmp>/emberline/ptyd.sock)
 *   EMBERLINE_PTYD_LOG_DIR  directory for raw session logs (disabled when unset)
 */
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
});

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

server.listen().catch((error: unknown) => {
  log(`failed to start: ${(error as Error).message}`);
  process.exit(1);
});
