/**
 * Core entrypoint.
 *
 * Env:
 *   EMBERLINE_HOST  bind address (default 127.0.0.1; use 0.0.0.0 inside Docker)
 *   EMBERLINE_PORT  port (default 7420)
 */
import { buildServer } from './server.js';

const host = process.env.EMBERLINE_HOST ?? '127.0.0.1';
const port = Number(process.env.EMBERLINE_PORT ?? 7420);

const app = buildServer(
  { logger: { level: process.env.EMBERLINE_LOG_LEVEL ?? 'info' } },
  { webDir: process.env.EMBERLINE_WEB_DIR },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
