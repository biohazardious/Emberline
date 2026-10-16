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
  /** Absolute host path of the workspaces volume, when known; only used to show host paths. */
  workspacesHostDir: string | undefined;
  /** Set the `Secure` cookie flag; enable when served over HTTPS. */
  secureCookies: boolean;
  /** Honour X-Forwarded-* headers from a reverse proxy. */
  trustProxy: boolean;
  sessionTtlMs: number;
  logLevel: string;
  /** Core base URL as reachable from the runner (hooks post here). */
  hookUrl: string;
  /** `emberline-hook` executable inside the runner. */
  hookCommand: string;
  /** Claude Code executable inside the runner. */
  claudeCommand: string;
  /** IANA zone for limit reset times printed without one (should match the runner's TZ). */
  timeZone: string;
  /**
   * One-time token that first-run setup requires. When unset, core generates one per boot and
   * prints it to its log while no password exists.
   */
  setupToken?: string;
  /**
   * Extra host names (lower case, no port) core answers to besides IP literals, `localhost` and the
   * hook URL's host; `*` disables the Host check.
   */
  allowedHosts: string[];
  /** Claude Code transcripts (runner home, mounted read-only); only paths under it are read. */
  transcriptsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const port = Number(env.EMBERLINE_PORT ?? 7420);
  return {
    host: env.EMBERLINE_HOST ?? '127.0.0.1',
    port,
    dataDir: env.EMBERLINE_DATA_DIR ?? path.resolve('data'),
    webDir: env.EMBERLINE_WEB_DIR || undefined,
    ptydSocket: env.EMBERLINE_PTYD_SOCKET ?? '/run/emberline/ptyd.sock',
    workspacesDir: env.EMBERLINE_WORKSPACES_DIR ?? '/workspaces',
    workspacesHostDir: env.EMBERLINE_WORKSPACES_HOST_DIR?.startsWith('/') ? env.EMBERLINE_WORKSPACES_HOST_DIR : undefined,
    secureCookies: env.EMBERLINE_SECURE_COOKIES === 'true',
    trustProxy: env.EMBERLINE_TRUST_PROXY === 'true',
    sessionTtlMs: Number(env.EMBERLINE_SESSION_TTL_DAYS ?? 30) * 86_400_000,
    logLevel: env.EMBERLINE_LOG_LEVEL ?? 'info',
    hookUrl: env.EMBERLINE_HOOK_URL ?? `http://127.0.0.1:${port}`,
    hookCommand: env.EMBERLINE_HOOK_COMMAND ?? 'emberline-hook',
    claudeCommand: env.EMBERLINE_CLAUDE_COMMAND ?? 'claude',
    timeZone: env.EMBERLINE_TIMEZONE || env.TZ || 'UTC',
    setupToken: env.EMBERLINE_SETUP_TOKEN?.trim() || undefined,
    allowedHosts: (env.EMBERLINE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean),
    transcriptsDir: env.EMBERLINE_TRANSCRIPTS_DIR ?? '/home/node/.claude/projects',
  };
}
