#!/usr/bin/env node
/**
 * ptyd entrypoint.
 *
 * Env:
 *   EMBERLINE_PTYD_SOCKET   socket path (default $XDG_RUNTIME_DIR/emberline/ptyd.sock or <tmp>/emberline/ptyd.sock)
 *   EMBERLINE_PTYD_LOG_DIR  directory for raw session logs (disabled when unset)
 *   EMBERLINE_PTYD_MODE     `runner` (default) or `ops`
 *   EMBERLINE_PTYD_DROP_TO  runner mode: the user sessions and commands run as (unset in the dev stack)
 *   EMBERLINE_PTYD_SERVICE_USERS  runner mode: comma-separated users a `spawn` or `exec` may name as `runAs`
 *   EMBERLINE_PTYD_REQUIRE_ISOLATION  `1`: refuse spawn and exec while the runner is not secured
 */
import os from 'node:os';
import path from 'node:path';
import { PtydMode } from '@emberline/protocol';
import { PtydServer } from './server.js';

export function defaultSocketPath(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(base, 'emberline', 'ptyd.sock');
}

const log = (message: string) => process.stderr.write(`[ptyd] ${new Date().toISOString()} ${message}\n`);

// An unknown mode is a mistake in the compose file or entrypoint: refused, never taken for one.
const mode = PtydMode.safeParse(process.env.EMBERLINE_PTYD_MODE || 'runner');
if (!mode.success) {
  log(`unknown EMBERLINE_PTYD_MODE ${JSON.stringify(process.env.EMBERLINE_PTYD_MODE)}: use runner or ops`);
  process.exit(1);
}

const server = new PtydServer({
  socketPath: process.env.EMBERLINE_PTYD_SOCKET ?? defaultSocketPath(),
  logDir: process.env.EMBERLINE_PTYD_LOG_DIR || undefined,
  log,
  mode: mode.data,
  dropTo: process.env.EMBERLINE_PTYD_DROP_TO || undefined,
  serviceUsers: (process.env.EMBERLINE_PTYD_SERVICE_USERS ?? '')
    .split(',')
    .map((user) => user.trim())
    .filter(Boolean),
  requireIsolation: process.env.EMBERLINE_PTYD_REQUIRE_ISOLATION === '1',
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
