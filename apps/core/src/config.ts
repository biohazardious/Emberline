import { isIP } from 'node:net';
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
   * Extra host names core answers to besides IP literals, `localhost` and the hook URL's host,
   * normalised by `normalizeHostName` (lower case, no port, no trailing dot); `*` disables the
   * Host check.
   */
  allowedHosts: string[];
  /** Claude Code transcripts (runner home, mounted read-only); only paths under it are read. */
  transcriptsDir: string;
  /**
   * The isolated Docker engine (compose profile `docker`, `tcp://docker:2376`, mutual TLS) that runs
   * and worktree.yml commands get as `DOCKER_HOST` while it answers. Unset: no Docker.
   */
  dockerHost?: string;
  /**
   * Directory in the runner with the engine's client certificate (`ca.pem`, `cert.pem`, `key.pem`),
   * mounted read-only from the engine's `docker-client-certs` volume; sent as `DOCKER_CERT_PATH`.
   */
  dockerCertPath: string;
  /**
   * Host ports published for previews (compose.yaml): the runner's for command previews, the
   * `docker` service's for compose previews. Disjoint, so the two never claim the same port.
   */
  previewPorts: { runner: PortRange; docker: PortRange };
}

/** Inclusive TCP port range. */
export interface PortRange {
  first: number;
  last: number;
}

export const DEFAULT_DOCKER_CERT_PATH = '/run/emberline-docker-certs';

export const DEFAULT_PREVIEW_PORTS: CoreConfig['previewPorts'] = {
  runner: { first: 4300, last: 4324 },
  docker: { first: 4325, last: 4349 },
};

/** `4300-4324` or a single port `4300` (1-65535, first <= last); null otherwise. */
export function parsePortRange(raw: string): PortRange | null {
  const match = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(raw);
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  if (first < 1 || last > 65_535 || first > last) return null;
  return { first, last };
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
    allowedHosts: parseAllowedHosts(env.EMBERLINE_ALLOWED_HOSTS ?? '').hosts,
    transcriptsDir: env.EMBERLINE_TRANSCRIPTS_DIR ?? '/home/node/.claude/projects',
    dockerHost: env.EMBERLINE_DOCKER_HOST?.trim() || undefined,
    dockerCertPath: env.EMBERLINE_DOCKER_CERT_PATH?.trim() || DEFAULT_DOCKER_CERT_PATH,
    previewPorts: {
      runner: parsePortRange(env.EMBERLINE_PREVIEW_PORTS_RUNNER ?? '') ?? DEFAULT_PREVIEW_PORTS.runner,
      docker: parsePortRange(env.EMBERLINE_PREVIEW_PORTS_DOCKER ?? '') ?? DEFAULT_PREVIEW_PORTS.docker,
    },
  };
}

/** Whether the runner's and the docker service's preview ranges share a port (compose cannot publish both). */
export function previewPortRangesOverlap({ runner, docker }: CoreConfig['previewPorts']): boolean {
  return runner.first <= docker.last && docker.first <= runner.last;
}

/** Preview port variables that are set but not a port range; core logs them and uses the default. */
export function invalidPreviewPortVars(env: NodeJS.ProcessEnv): string[] {
  return (['EMBERLINE_PREVIEW_PORTS_RUNNER', 'EMBERLINE_PREVIEW_PORTS_DOCKER'] as const).filter(
    (name) => (env[name] ?? '').trim() !== '' && parsePortRange(env[name]!) === null,
  );
}

const HOST_LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOST_NAME = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

/**
 * `EMBERLINE_ALLOWED_HOSTS` (comma list) as host names. An entry pasted as a URL
 * (`https://name:8443/path`) is reduced to its host name; one that still is not a host name, an IP
 * address or `*` lands in `ignored`, which core logs as a warning at startup.
 */
export function parseAllowedHosts(raw: string): { hosts: string[]; ignored: string[] } {
  const hosts: string[] = [];
  const ignored: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const authority = trimmed
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/[/?#].*$/, '')
      .replace(/^.*@/, '');
    const name = normalizeHostName(authority);
    if (name === '*' || isIP(name) || HOST_NAME.test(name)) hosts.push(name);
    else ignored.push(trimmed);
  }
  return { hosts, ignored };
}

/** Lower-case host name of a Host header value or list entry: no port, no IPv6 brackets, no trailing dot. */
export function normalizeHostName(host: string): string {
  let name = host.trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    return end === -1 ? name : name.slice(1, end);
  }
  if (name.indexOf(':') === name.lastIndexOf(':')) name = name.replace(/:\d*$/, '');
  return name.replace(/\.$/, '');
}
