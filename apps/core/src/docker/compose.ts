/**
 * Compose previews (worktree.yml v2): the `docker compose` command lines Emberline runs in the
 * runner against the Docker engine sidecar, the port override, and parsing of what compose prints.
 *
 * Where the override lives: nowhere on disk. The project's compose file sits in the worktree, which
 * the agent edits; anything Emberline wrote next to it (or anywhere the runner user can write, which
 * is also the agent's user) could be changed between writing and `up`. So the override goes to
 * compose on stdin (`-f -`) from an environment variable of the one `sh` process that runs compose
 * (ptyd `exec` has no stdin). The project name is always `-p emberline-<run8>-preview` from the run
 * id: a `name:` in the compose file or `COMPOSE_PROJECT_NAME` in the worktree's `.env` cannot pick it.
 */
import { COMPOSE_SERVICE_NAME } from '@emberline/protocol';
import { clipText, stripControlChars } from '../text/control-chars.js';

/** Variable that carries the override YAML to the `sh -c` wrapper (see {@link composeShell}). */
export const COMPOSE_OVERRIDE_ENV = 'EMBERLINE_COMPOSE_OVERRIDE';
/** At most this much of `docker compose logs` reaches the API. */
export const COMPOSE_LOGS_MAX_CHARS = 2000;
export const COMPOSE_LOGS_TAIL_LINES = 200;

/** `docker compose -p <project> -f <file>`: the project's own file, relative to the worktree. */
function base(project: string, file: string): string[] {
  return ['compose', '-p', project, '-f', file];
}

/**
 * Lists the services of the project's compose file, in every profile (to reset the host ports of
 * every one, whichever profiles the preview service's dependencies are in).
 */
export function composeServicesArgs(project: string, file: string): string[] {
  return [...base(project, file), '--profile', '*', 'config', '--services'];
}

/** What compose prints when a published host port is taken in the engine. */
export function isPortConflict(output: string): boolean {
  return /port is already allocated|address already in use/i.test(output);
}

/** Builds and starts `service` (and what it depends on) with the override from stdin. */
export function composeUpArgs(project: string, file: string, service: string): string[] {
  return [...base(project, file), '-f', '-', 'up', '-d', '--build', '--', service];
}

/**
 * Every container of the project, one JSON object per line (compose ≥ 2.21) or one array (older).
 * By project name only, like `logs` and `down`: status keeps working when the file changed.
 */
export function composePsArgs(project: string): string[] {
  return ['compose', '-p', project, 'ps', '--all', '--format', 'json'];
}

/** The last lines of one service's output, or (no `service`) of every service in the project. */
export function composeLogsArgs(project: string, service?: string): string[] {
  return ['compose', '-p', project, 'logs', '--no-color', '--tail', String(COMPOSE_LOGS_TAIL_LINES), ...(service ? ['--', service] : [])];
}

/**
 * Stops the project's containers. Only the project name, no file: it works when the agent deleted or
 * broke the compose file. `volumes` (cleanup) also removes its named volumes, `images` (cleanup) the
 * images it built (`--rmi local`: those without a tag of their own; pulled images stay).
 */
export function composeDownArgs(project: string, { volumes = false, images = false }: { volumes?: boolean; images?: boolean } = {}): string[] {
  return ['compose', '-p', project, 'down', ...(volumes ? ['-v'] : []), ...(images ? ['--rmi', 'local'] : []), '--remove-orphans'];
}

/**
 * Runs `docker <args>` with the override on stdin. The override never appears in the command line,
 * only in {@link COMPOSE_OVERRIDE_ENV}.
 */
export function composeShell(args: string[]): { file: string; args: string[] } {
  return { file: 'sh', args: ['-c', `printf '%s' "$${COMPOSE_OVERRIDE_ENV}" | exec docker "$@"`, 'sh', ...args] };
}

/**
 * The override: the preview service publishes exactly `<hostPort>:<port>` (`!override` drops the
 * project's own fixed host ports), and every other service publishes none (`!reset`), so two runs'
 * projects never claim the same port in the engine. No service keeps a fixed `container_name`
 * either: two runs' previews of the same file would collide on it. Names are JSON-quoted (valid YAML
 * keys).
 */
export function composeOverrideYaml(opts: { service: string; port: number; hostPort: number; services: readonly string[] }): string {
  const lines = ['services:'];
  for (const name of new Set([...opts.services, opts.service])) {
    lines.push(`  ${JSON.stringify(name)}:`);
    lines.push(
      name === opts.service
        ? `    ports: !override [${JSON.stringify(`${opts.hostPort}:${opts.port}`)}]`
        : '    ports: !reset []',
    );
    lines.push('    container_name: !reset null');
  }
  return `${lines.join('\n')}\n`;
}

/** Service names from `config --services`, one per line; anything that is not a name is dropped. */
export function parseComposeServices(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => COMPOSE_SERVICE_NAME.test(line));
}

export interface ComposeContainer {
  service: string;
  state: string;
  health: string;
  exitCode: number | null;
}

/** `ps --format json`: NDJSON (compose ≥ 2.21, v5 included) or one JSON array (older); bad lines skipped. */
export function parseComposePs(stdout: string): ComposeContainer[] {
  const text = stdout.trim();
  if (text === '') return [];
  const rows: unknown[] = [];
  const take = (value: unknown) => (Array.isArray(value) ? rows.push(...value) : rows.push(value));
  try {
    take(JSON.parse(text));
  } catch {
    for (const line of text.split('\n')) {
      try {
        take(JSON.parse(line));
      } catch {
        // not JSON: compose warnings go to stderr, but be lenient
      }
    }
  }
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const r = row as Record<string, unknown>;
    if (typeof r.Service !== 'string') return [];
    return [
      {
        service: r.Service,
        state: typeof r.State === 'string' ? r.State.toLowerCase() : '',
        health: typeof r.Health === 'string' ? r.Health.toLowerCase() : '',
        exitCode: typeof r.ExitCode === 'number' ? r.ExitCode : null,
      },
    ];
  });
}

/**
 * The preview service's state: `running` (a container runs and is not unhealthy), `starting`
 * (created or restarting, or health still `starting`), `stopped` (exited or dead), `missing`.
 */
export function composeServiceState(containers: readonly ComposeContainer[], service: string): 'running' | 'starting' | 'stopped' | 'missing' {
  const own = containers.filter((c) => c.service === service);
  if (own.length === 0) return 'missing';
  if (own.some((c) => c.state === 'running' && c.health !== 'starting' && c.health !== 'unhealthy')) return 'running';
  if (own.some((c) => ['created', 'restarting', 'running'].includes(c.state))) return 'starting';
  return 'stopped';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;

/**
 * The end of what the project's containers or build printed, fit for the API: no colour or control
 * sequences, at most {@link COMPOSE_LOGS_MAX_CHARS}. It is untrusted output; callers label it so.
 */
export function composeOutputTail(text: string, max = COMPOSE_LOGS_MAX_CHARS): string {
  const clean = stripControlChars(text.replace(ANSI, '').replace(/\r\n?/g, '\n')).trimEnd();
  if (clean.length <= max) return clean;
  return `…${clipText(clean.slice(clean.length - (max - 1)), max - 1)}`;
}

/** An HTTP status from `curl -w %{http_code}`: any real status means the server answers. */
export function answeredHttp(stdout: string): boolean {
  const code = Number(stdout.trim());
  return Number.isInteger(code) && code >= 100 && code <= 599;
}

/**
 * The engine's name on the compose network (`docker` from `tcp://docker:2376`): a published preview
 * port answers there from the runner, the same port the host publishes.
 */
export function engineHostName(dockerHost: string): string {
  try {
    return new URL(dockerHost.replace(/^tcp:/i, 'http:')).hostname || 'docker';
  } catch {
    return 'docker';
  }
}

/** Every compose project the engine knows, running or not (the GC sweep). */
export function composeLsArgs(): string[] {
  return ['compose', 'ls', '-a', '--format', 'json'];
}

/**
 * Every container of every compose project in the engine, one JSON object per line (the Docker
 * page groups them by their `com.docker.compose.project` label).
 */
export function dockerPsArgs(): string[] {
  return ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{json .}}'];
}

/** The engine's disk use (images, containers, volumes, build cache), one JSON object per line. */
export function systemDfArgs(): string[] {
  return ['system', 'df', '--format', '{{json .}}'];
}

/** Project names from `compose ls --format json` (one array); anything else gives none. */
export function parseComposeLs(stdout: string): string[] {
  try {
    const rows: unknown = JSON.parse(stdout.trim() || '[]');
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const name = row && typeof row === 'object' ? (row as Record<string, unknown>).Name : undefined;
      return typeof name === 'string' ? [name] : [];
    });
  } catch {
    return [];
  }
}

/**
 * The compose projects Emberline names (engine.ts): `emberline-<id8>` (a run's or its worktree's),
 * `emberline-<id8>-preview`, `emberline-main-<project id8>` and `emberline-main-<project id8>-preview`.
 * The GC sweep never touches any other.
 */
export function isEmberlineComposeProject(name: string): boolean {
  return /^emberline-(?:[0-9a-f]{8}|main-[0-9a-f]{8})(?:-preview)?$/.test(name);
}

/** Dangling images older than 72 h (daily, from the GC sweep). */
export function imagePruneArgs(): string[] {
  return ['image', 'prune', '-f', '--filter', 'until=72h'];
}

/** Build cache older than 72 h (daily, with the image prune). */
export function builderPruneArgs(): string[] {
  return ['builder', 'prune', '-f', '--filter', 'until=72h'];
}

/**
 * Image of the throwaway container that hands a worktree's files back (pulled once), pinned by its
 * index digest (from `docker buildx imagetools inspect busybox:1.37.0`).
 */
export const RECLAIM_IMAGE = 'busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e';

/**
 * Hands every file under `dir` back to the runner user so the worktree can be removed. The engine is
 * rootless: its containers' root is the runner's uid, every other container user a sub-uid that the
 * runner cannot delete (a database directory, say). In a throwaway container, root can chown them.
 * No network. `dir` must be absolute and free of `,` (it goes into `--mount`).
 */
export function reclaimArgs(dir: string): string[] {
  if (!dir.startsWith('/') || dir.includes(',')) throw new Error(`not a path the engine can mount: ${dir}`);
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--mount',
    `type=bind,source=${dir},target=/w`,
    RECLAIM_IMAGE,
    'sh',
    '-c',
    'chown -R 0:0 /w && chmod -R u+rwX /w',
  ];
}
