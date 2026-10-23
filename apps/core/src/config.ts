import { isIP } from 'node:net';
import path from 'node:path';
import { parseCidrList } from './auth/cidr.js';
import { engineHostName } from './docker/compose.js';

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
  /**
   * A session is valid only from the client address that signed in (`request.ip`, which follows
   * `trustProxy`). Default true; `EMBERLINE_SESSION_BIND_IP=false` turns it off.
   */
  sessionBindIp?: boolean;
  /**
   * Host names of Emberline's own containers (compose services `runner`, `docker`): a session cookie
   * that arrives from their addresses is refused. `EMBERLINE_CONTAINER_HOSTS`, comma list; unset: none.
   */
  containerHosts?: string[];
  /** Compose service names of the runner; only their addresses may use the git gateway. EMBERLINE_RUNNER_HOSTS, comma list. */
  runnerHosts?: string[];
  /** EMBERLINE_CONTAINER_NETWORKS: extra CIDR ranges container trust accepts (auth/cidr.ts); invalid entries dropped. */
  containerNetworks?: string[];
  logLevel: string;
  /** Core base URL as reachable from the runner (hooks post here). */
  hookUrl: string;
  /** Base URL the runner reaches core at for the git gateway; EMBERLINE_GIT_GATEWAY_URL, default the hook URL. */
  gitGatewayUrl?: string;
  /** `emberline-hook` executable inside the runner. */
  hookCommand: string;
  /** Claude Code executable inside the runner. */
  claudeCommand: string;
  /** --model for Suggest an answer (EMBERLINE_SUGGEST_MODEL). */
  suggestModel: string;
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
   * The isolated Docker engine (compose service `docker`, `tcp://docker:2376`, mutual TLS) that runs
   * and worktree.yml commands get as `DOCKER_HOST` while it answers. Unset: no Docker, also when
   * `EMBERLINE_DOCKER_ENGINE=0` (the compose files default the host; core alone stays off without one).
   */
  dockerHost?: string;
  /**
   * `EMBERLINE_DOCKER_ENGINE=0`: the user switched the engine off. Without it, a missing host means
   * no engine is configured (a compose file older than 0.3.5, or dev); the texts tell the two apart.
   */
  dockerEngineSwitchedOff?: boolean;
  /** `EMBERLINE_DOCKER_ENGINE` is set to something other than 0 or 1 (the value); core logs it at start. */
  dockerEngineSettingInvalid?: string;
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

function parsableHost(host: string): boolean {
  try {
    return new URL(host.replace(/^tcp:/i, 'http:')).hostname !== '';
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const port = Number(env.EMBERLINE_PORT ?? 7420);
  const engineSetting = env.EMBERLINE_DOCKER_ENGINE?.trim() ?? '';
  const engineOff = engineSetting === '0';
  const host = env.EMBERLINE_DOCKER_HOST?.trim() || undefined;
  // The bundled engine's address: switching the bundled engine off must not switch off an engine of your own.
  // An unparsable host is not the bundled engine (engineHostName would fall back to 'docker' for it).
  const bundled = host !== undefined && parsableHost(host) && engineHostName(host) === 'docker';
  return {
    host: env.EMBERLINE_HOST ?? '127.0.0.1',
    port,
    dataDir: env.EMBERLINE_DATA_DIR ?? path.resolve('data'),
    webDir: env.EMBERLINE_WEB_DIR || undefined,
    ptydSocket: env.EMBERLINE_PTYD_SOCKET ?? '/run/emberline/ptyd.sock',
    workspacesDir: env.EMBERLINE_WORKSPACES_DIR ?? '/workspaces',
    workspacesHostDir: env.EMBERLINE_WORKSPACES_HOST_DIR?.startsWith('/')
      ? env.EMBERLINE_WORKSPACES_HOST_DIR
      : undefined,
    secureCookies: env.EMBERLINE_SECURE_COOKIES === 'true',
    trustProxy: env.EMBERLINE_TRUST_PROXY === 'true',
    sessionTtlMs: Number(env.EMBERLINE_SESSION_TTL_DAYS ?? 30) * 86_400_000,
    sessionBindIp: env.EMBERLINE_SESSION_BIND_IP?.trim().toLowerCase() !== 'false',
    containerHosts: (env.EMBERLINE_CONTAINER_HOSTS ?? 'runner,docker')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    runnerHosts: (env.EMBERLINE_RUNNER_HOSTS ?? 'runner')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    containerNetworks: parseCidrList(env.EMBERLINE_CONTAINER_NETWORKS ?? '').valid,
    logLevel: env.EMBERLINE_LOG_LEVEL ?? 'info',
    hookUrl: env.EMBERLINE_HOOK_URL ?? `http://127.0.0.1:${port}`,
    gitGatewayUrl: env.EMBERLINE_GIT_GATEWAY_URL?.trim() || undefined,
    hookCommand: env.EMBERLINE_HOOK_COMMAND ?? 'emberline-hook',
    claudeCommand: env.EMBERLINE_CLAUDE_COMMAND ?? 'claude',
    suggestModel: env.EMBERLINE_SUGGEST_MODEL?.trim() || 'haiku',
    timeZone: env.EMBERLINE_TIMEZONE || env.TZ || 'UTC',
    setupToken: env.EMBERLINE_SETUP_TOKEN?.trim() || undefined,
    allowedHosts: parseAllowedHosts(env.EMBERLINE_ALLOWED_HOSTS ?? '').hosts,
    transcriptsDir: env.EMBERLINE_TRANSCRIPTS_DIR ?? '/home/node/.claude/projects',
    dockerHost: engineOff && bundled ? undefined : host,
    dockerEngineSwitchedOff: engineOff && (host === undefined || bundled),
    dockerEngineSettingInvalid: ['', '0', '1'].includes(engineSetting) ? undefined : engineSetting,
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
