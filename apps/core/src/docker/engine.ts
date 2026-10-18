/**
 * The opt-in Docker engine sidecar (compose profile `docker`): a rootless dind reachable only on the
 * compose network at `EMBERLINE_DOCKER_HOST`. Core never talks to it directly: like every other
 * command, the probe runs the Docker CLI in the runner (command-exec.ts) with `DOCKER_HOST` set.
 * While the engine answers, runs and worktree.yml commands get `DOCKER_HOST` and a compose project
 * name of their own; when it does not (or is not configured), they get nothing and Docker is off.
 */
import path from 'node:path';
import type { DockerEngineStatus } from '@emberline/protocol';
import { type CommandExecutor, execCommand } from '../command-exec.js';
import { clipText, stripControlChars } from '../text/control-chars.js';

export const DOCKER_PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const ERROR_MAX_CHARS = 300;

/** The one paragraph a run's first prompt gets while the engine is available. */
export const DOCKER_PROMPT_PARAGRAPH =
  'An isolated Docker engine is available for this run (DOCKER_HOST is set). Use compose project name ' +
  '$EMBERLINE_COMPOSE_PROJECT (`docker compose -p "$EMBERLINE_COMPOSE_PROJECT" …`), don\'t publish fixed host ' +
  'ports, and stop what you started when you finish; Emberline wires previews and removes the project when the ' +
  'worktree is pruned.';

/**
 * The compose project of a run: `emberline-<first 8 of the run id>`. A run in a worktree Emberline
 * created (`<workspaces>/.worktrees/<slug>/<id8>`) uses the id of the run that created it, so a
 * handoff successor in the same worktree keeps working on (and cleans up) the same project.
 */
export function composeProjectName(runId: string, worktreePath?: string): string {
  let id8 = runId.slice(0, 8);
  if (worktreePath) {
    const owner = path.basename(worktreePath);
    if (/^[0-9a-f]{8}$/i.test(owner) && path.basename(path.dirname(path.dirname(worktreePath))) === '.worktrees') id8 = owner;
  }
  return `emberline-${id8.toLowerCase()}`;
}

export interface DockerEngineOptions {
  /** How the CLI runs; the runner (ptyd exec) by default. */
  exec?: CommandExecutor;
  /** Working directory of the probe in the runner. */
  cwd?: string;
  /** Called when `available`, `version` or `error` changed after a probe. */
  onChange?: (status: DockerEngineStatus) => void;
}

export class DockerEngine {
  private current: DockerEngineStatus;
  private inFlight?: Promise<DockerEngineStatus>;
  private timer?: NodeJS.Timeout;

  constructor(
    /** `EMBERLINE_DOCKER_HOST`; undefined = Docker is off. */
    readonly host: string | undefined,
    private readonly options: DockerEngineOptions = {},
  ) {
    this.current = { enabled: Boolean(host), available: false, version: null };
  }

  /** The last probe's result (unavailable until the first probe answered). */
  get status(): DockerEngineStatus {
    return { ...this.current };
  }

  /** Probes now and then every {@link DOCKER_PROBE_INTERVAL_MS}; does nothing without a host. */
  start(): void {
    if (!this.host || this.timer) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), DOCKER_PROBE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs `docker version` in the runner; concurrent callers share one probe. Never throws. */
  probe(): Promise<DockerEngineStatus> {
    if (!this.host) return Promise.resolve(this.status);
    this.inFlight ??= this.runProbe(this.host).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * `DOCKER_HOST` and `EMBERLINE_COMPOSE_PROJECT` for an agent or a worktree.yml command while the
   * engine is available; nothing otherwise.
   */
  runEnv(composeProject: string): Record<string, string> {
    if (!this.host || !this.current.available) return {};
    return { DOCKER_HOST: this.host, EMBERLINE_COMPOSE_PROJECT: composeProject };
  }

  private async runProbe(host: string): Promise<DockerEngineStatus> {
    const next = await this.ask(host);
    const before = this.current;
    this.current = next;
    if (before.available !== next.available || before.version !== next.version || before.error !== next.error) {
      this.options.onChange?.(this.status);
    }
    return this.status;
  }

  private async ask(host: string): Promise<DockerEngineStatus> {
    const off = (error: string): DockerEngineStatus => ({ enabled: true, available: false, version: null, error: clean(error) });
    try {
      const result = await (this.options.exec ?? execCommand)({
        file: 'docker',
        args: ['version', '--format', '{{json .Server.Version}}'],
        cwd: this.options.cwd ?? '/',
        env: { DOCKER_HOST: host },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (result.exitCode === 127 && /ENOENT|not found/.test(result.stderr)) {
        return off('the runner image has no Docker CLI; rebuild it (make up-docker)');
      }
      if (result.timedOut) return off(`no answer from ${host} within ${PROBE_TIMEOUT_MS / 1000} s`);
      if (result.exitCode !== 0) return off(result.stderr || result.stdout || `docker version exited with ${result.exitCode}`);
      let version: unknown;
      try {
        version = JSON.parse(result.stdout.trim());
      } catch {
        version = null;
      }
      if (typeof version !== 'string' || version === '') return off('unexpected `docker version` output');
      return { enabled: true, available: true, version: clean(version) };
    } catch (error) {
      return off((error as Error).message);
    }
  }
}

/** One line of CLI output fit for the API and the UI: no control characters, at most 300 chars. */
function clean(text: string): string {
  return clipText(stripControlChars(text.replace(/\s+/g, ' '), '').trim(), ERROR_MAX_CHARS);
}
