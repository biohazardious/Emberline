/**
 * The Docker engine sidecar (compose service `docker`, on unless `EMBERLINE_DOCKER_ENGINE=0`): a rootless dind on the compose network
 * at `EMBERLINE_DOCKER_HOST` whose API requires mutual TLS. Only the runner holds the client
 * certificate (read-only mount at `dockerCertPath`). Core never talks to the engine directly: like
 * every other command, the probe runs the Docker CLI in the runner (command-exec.ts). While the
 * engine answers, runs and worktree.yml commands get the client variables (`DOCKER_HOST`,
 * `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`) and a compose project name of their own; when it does
 * not (or is not configured), they get nothing and Docker is off.
 */
import path from 'node:path';
import type { DockerEngineStatus } from '@emberline/protocol';
import { type CommandExecutor, execCommand, RUNNER_BIN, SYSTEM_PATH } from '../command-exec.js';
import { DEFAULT_DOCKER_CERT_PATH } from '../config.js';
import { clipText, stripControlChars } from '../text/control-chars.js';

export const DOCKER_PROBE_INTERVAL_MS = 60_000;
/** A spawn right after boot waits this long at most for the first probe. */
export const DOCKER_READY_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 15_000;
const ERROR_MAX_CHARS = 300;

/** The one paragraph a run's first prompt gets while the engine is available. */
export const DOCKER_PROMPT_PARAGRAPH =
  'An isolated Docker engine is available for this run (DOCKER_HOST is set). Use compose project name ' +
  '$EMBERLINE_COMPOSE_PROJECT (`docker compose -p "$EMBERLINE_COMPOSE_PROJECT" …`), don\'t publish fixed host ' +
  'ports, and stop what you started when you finish; Emberline wires previews and removes the project when the ' +
  "worktree is pruned. Don't set `container_name` or a fixed volume or network `name:`: runs share this engine, " +
  'and fixed names collide between them.';

/**
 * The compose project of a run: `emberline-<first 8 of the run id>`. A run in a worktree Emberline
 * created (`<workspaces>/.worktrees/<slug>/<id8>`) uses the id of the run that created it, so a
 * handoff successor in the same worktree keeps working on (and cleans up) the same project.
 */
export function composeProjectName(runId: string, worktreePath?: string): string {
  let id8 = runId.slice(0, 8);
  if (worktreePath) {
    const owner = path.basename(worktreePath);
    if (
      /^[0-9a-f]{8}$/i.test(owner) &&
      path.basename(path.dirname(path.dirname(worktreePath))) === '.worktrees'
    )
      id8 = owner;
  }
  return `emberline-${id8.toLowerCase()}`;
}

/**
 * The compose project of a run's preview: `emberline-<first 8 of the run's own id>-preview`. Apart
 * from the agent's project, so stopping a preview never removes what the agent runs, and keyed by
 * the run itself, so a handoff successor sharing the worktree has a preview of its own.
 */
export function previewComposeProjectName(runId: string): string {
  return `emberline-${runId.slice(0, 8).toLowerCase()}-preview`;
}

/**
 * The compose project of Build & Verify on a project's main workspace:
 * `emberline-main-<first 8 of the project id>`, apart from every run's project.
 */
export function mainComposeProjectName(projectId: string): string {
  return `emberline-main-${projectId.slice(0, 8).toLowerCase()}`;
}

/**
 * The compose project of a project's main workspace container preview:
 * `emberline-main-<first 8 of the project id>-preview`, apart from Build & Verify's, so stopping the
 * preview never removes what a Build & Verify started (and the other way round).
 */
export function mainPreviewComposeProjectName(projectId: string): string {
  return `${mainComposeProjectName(projectId)}-preview`;
}

export interface DockerEngineOptions {
  /** Client certificate directory in the runner (`DOCKER_CERT_PATH`). */
  certPath?: string;
  /** How the CLI runs; the runner (ptyd exec) by default. */
  exec?: CommandExecutor;
  /** Working directory of the probe in the runner. */
  cwd?: string;
  /** Called when `available`, `version` or `error` changed after a probe. */
  onChange?: (status: DockerEngineStatus) => void;
  /** Without a host: `EMBERLINE_DOCKER_ENGINE=0` switched it off (else no engine is configured). */
  switchedOff?: boolean;
}

export class DockerEngine {
  private current: DockerEngineStatus;
  private inFlight?: Promise<DockerEngineStatus>;
  private checkedAt = 0;
  private timer?: NodeJS.Timeout;
  private readonly listeners = new Set<(status: DockerEngineStatus) => void>();

  constructor(
    /** `EMBERLINE_DOCKER_HOST`; undefined = Docker is off. */
    readonly host: string | undefined,
    private readonly options: DockerEngineOptions = {},
  ) {
    this.current = host
      ? { enabled: true, checked: false, available: false, version: null }
      : {
          enabled: false,
          checked: false,
          available: false,
          version: null,
          reason: options.switchedOff ? 'switched_off' : 'not_configured',
        };
  }

  /**
   * Resolves once the first probe answered, or after `timeoutMs`: a run spawned right after boot
   * gets Docker if the engine is there instead of losing it to the race. Starts a probe if none ran.
   */
  async ready(timeoutMs = DOCKER_READY_TIMEOUT_MS): Promise<void> {
    if (!this.host || this.current.checked) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.probe(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
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

  /** Also called when `available`, `version` or `error` changed after a probe; returns the unsubscribe. */
  addChangeListener(listener: (status: DockerEngineStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probes again when the last answer is older than `maxAgeMs` (0 = always); concurrent callers share one probe. */
  async refresh(maxAgeMs: number): Promise<void> {
    // maxAgeMs 0 means always (the clock may not have moved since the last answer).
    if (maxAgeMs <= 0 || Date.now() - this.checkedAt > maxAgeMs) await this.probe();
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
    return { ...this.clientEnv(this.host), EMBERLINE_COMPOSE_PROJECT: composeProject };
  }

  /** The client variables alone (no compose project) while the engine is available; nothing otherwise. */
  cliEnv(): Record<string, string> {
    if (!this.host || !this.current.available) return {};
    return this.clientEnv(this.host);
  }

  /** What the Docker CLI needs to reach the engine: its address and the client certificate. */
  private clientEnv(host: string): Record<string, string> {
    return {
      DOCKER_HOST: host,
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: this.options.certPath ?? DEFAULT_DOCKER_CERT_PATH,
    };
  }

  private async runProbe(host: string): Promise<DockerEngineStatus> {
    const next = await this.ask(host);
    this.checkedAt = Date.now();
    const before = this.current;
    this.current = next;
    if (
      before.available !== next.available ||
      before.version !== next.version ||
      before.error !== next.error
    ) {
      this.options.onChange?.(this.status);
      for (const listener of this.listeners) listener(this.status);
    }
    return this.status;
  }

  private async ask(host: string): Promise<DockerEngineStatus> {
    const off = (error: string): DockerEngineStatus => ({
      enabled: true,
      checked: true,
      available: false,
      version: null,
      error: clean(error),
    });
    try {
      const result = await (this.options.exec ?? execCommand)({
        file: RUNNER_BIN.docker,
        args: ['version', '--format', '{{json .Server.Version}}'],
        cwd: this.options.cwd ?? '/',
        env: { ...this.clientEnv(host), PATH: SYSTEM_PATH },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (result.exitCode === 127 && /ENOENT|not found/.test(result.stderr)) {
        return off('the runner image has no Docker CLI; rebuild it (make up)');
      }
      if (result.timedOut) return off(`no answer from ${host} within ${PROBE_TIMEOUT_MS / 1000} s`);
      if (result.exitCode !== 0)
        return off(result.stderr || result.stdout || `docker version exited with ${result.exitCode}`);
      let version: unknown;
      try {
        version = JSON.parse(result.stdout.trim());
      } catch {
        version = null;
      }
      if (typeof version !== 'string' || version === '') return off('unexpected `docker version` output');
      return { enabled: true, checked: true, available: true, version: clean(version) };
    } catch (error) {
      return off((error as Error).message);
    }
  }
}

/** One line of CLI output fit for the API and the UI: no control characters, at most 300 chars. */
function clean(text: string): string {
  return clipText(stripControlChars(text.replace(/\s+/g, ' '), '').trim(), ERROR_MAX_CHARS);
}
