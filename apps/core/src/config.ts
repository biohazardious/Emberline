import path from 'node:path';

export interface CoreConfig {
  host: string;
  port: number;
  /** SQLite database and other persistent state. */
  dataDir: string;
  /** Built web UI, served by core when set (production image). */
  webDir?: string;
  ptydSocket: string;
  /** Shared with the runner container at the same path. */
  workspacesDir: string;
  /** Set the `Secure` cookie flag; enable when served over HTTPS. */
  secureCookies: boolean;
  /** Honour X-Forwarded-* headers from a reverse proxy. */
  trustProxy: boolean;
  sessionTtlMs: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  return {
    host: env.EMBERLINE_HOST ?? '127.0.0.1',
    port: Number(env.EMBERLINE_PORT ?? 7420),
    dataDir: env.EMBERLINE_DATA_DIR ?? path.resolve('data'),
    webDir: env.EMBERLINE_WEB_DIR || undefined,
    ptydSocket: env.EMBERLINE_PTYD_SOCKET ?? '/run/emberline/ptyd.sock',
    workspacesDir: env.EMBERLINE_WORKSPACES_DIR ?? '/workspaces',
    secureCookies: env.EMBERLINE_SECURE_COOKIES === 'true',
    trustProxy: env.EMBERLINE_TRUST_PROXY === 'true',
    sessionTtlMs: Number(env.EMBERLINE_SESSION_TTL_DAYS ?? 30) * 86_400_000,
    logLevel: env.EMBERLINE_LOG_LEVEL ?? 'info',
  };
}
