import { spawn } from 'node:child_process';
import { MAX_EXEC_OUTPUT_BYTES, PTYD_MIN_PROTOCOL_VERSION, type PtydResult } from '@emberline/protocol';
import { PtydClientError } from '@emberline/ptyd/client';
import { HttpError, unavailable } from './errors.js';
import { redactCapabilityUrls, withoutUrlCredentials } from './git-gateway/redact-text.js';
import type { PtydBridge } from './ptyd-bridge.js';

/**
 * Every process core starts for a workspace (git, package installs, builds, tests) runs through
 * this module. In production the executor is the runner (ptyd `exec`), so nothing an agent wrote
 * — hooks, package scripts, git config — ever executes in the core container (S6). Tests install
 * a local executor (see `vitest.setup.ts`).
 */
export interface ExecRequest {
  file: string;
  args: string[];
  cwd: string;
  /** Extra variables only; core's own environment is never forwarded. */
  env?: Record<string, string>;
  /**
   * false: the command gets only `env`, none of the runner's base environment (ptyd protocol 4; an
   * older runner ignores it, and the variables in `env` still win over its base). See {@link systemCommand}.
   */
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  encoding?: 'utf8' | 'base64';
  /** Lets {@link cancelCommand} stop this command while it runs (unique while it runs). */
  execId?: string;
}

/**
 * The runner's root-owned system directories. The runner's own PATH starts with directories the
 * agents' user owns (/opt/ai-tools/bin is the runner-tools volume), so a `git`, `ssh` or `cp` planted
 * there would run in place of the real one. A command core relies on is therefore started by its
 * absolute path ({@link RUNNER_BIN}), and whatever it starts in turn is looked up here only.
 */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The runner image's own binaries (root-owned, 755) that core runs for itself. */
export const RUNNER_BIN = {
  git: '/usr/bin/git',
  ssh: '/usr/bin/ssh',
  sh: '/usr/bin/sh',
  bash: '/usr/bin/bash',
  rm: '/usr/bin/rm',
  cp: '/usr/bin/cp',
  head: '/usr/bin/head',
  curl: '/usr/bin/curl',
  mktemp: '/usr/bin/mktemp',
  node: '/usr/local/bin/node',
  docker: '/usr/local/bin/docker',
} as const;

/**
 * A command core relies on (git, the merge's file steps, its probes): started by its absolute path,
 * with only the variables given plus {@link SYSTEM_PATH}, and nothing from the runner's environment.
 * Agents' and projects' own commands are not run this way: they keep the runner's PATH.
 */
export function systemCommand(request: ExecRequest): ExecRequest {
  if (!request.file.startsWith('/'))
    throw new Error(`a system command needs an absolute path: ${request.file}`);
  return { ...request, env: { ...request.env, PATH: SYSTEM_PATH }, inheritEnv: false };
}

/**
 * The Docker CLI's own settings on every command core runs with it ({@link dockerCommand}). Agents
 * can write the runner user's `~/.docker`: a `cli-plugins/docker-compose` or `docker-buildx` there
 * would run in place of the image's, its `config.json` sets proxies for every build and container,
 * and a builder defined in `buildx/instances` (one named `default` too) takes every build. So the CLI
 * gets the runner image's own directories, which are root's: an empty config directory (only the
 * plugins in /usr/local/lib/docker/cli-plugins run, no config applies) and a buildx directory whose
 * builders and defaults are empty and fixed; buildx may write only its lock, activity times and build
 * records there. No home: nothing else of the runner user's is read. A runner image without these
 * directories (before 0.6.1) gets a fresh private one for each build or prune (see composeShell).
 */
export const DOCKER_CLI_ENV: Readonly<Record<string, string>> = {
  HOME: '/nonexistent',
  DOCKER_CONFIG: '/opt/emberline/docker/config',
  BUILDX_CONFIG: '/opt/emberline/docker/buildx',
};

/** A Docker CLI command of core's (the CLI itself, or the image's `sh` that runs it): a {@link systemCommand} with {@link DOCKER_CLI_ENV}. */
export function dockerCommand(request: ExecRequest): ExecRequest {
  return systemCommand({ ...request, env: { ...request.env, ...DOCKER_CLI_ENV } });
}

export type ExecResult = PtydResult<'exec'>;
export type CommandExecutor = (request: ExecRequest) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
/** First ptyd protocol with the `exec` method. */
const EXEC_PROTOCOL_VERSION = 2;
/** First ptyd protocol with `execId` and `execCancel`. */
const CANCEL_PROTOCOL_VERSION = 3;

/** Stops a running command by its `execId`; resolves whether one was running. */
export type CommandCanceller = (execId: string) => Promise<boolean>;

let canceller: CommandCanceller = async () => false;

export function setCommandCanceller(next: CommandCanceller): void {
  canceller = next;
}

/** Kills the command started with this `execId` (its whole process group); never throws. */
export function cancelCommand(execId: string): Promise<boolean> {
  return canceller(execId).catch(() => false);
}

/** Cancels through ptyd `execCancel`; an older runner cannot, and its command runs to its timeout. */
export function ptydCommandCanceller(ptyd: PtydBridge): CommandCanceller {
  return async (execId) => {
    if ((ptyd.protocolVersion ?? 0) < CANCEL_PROTOCOL_VERSION) return false;
    return (await ptyd.get().execCancel(execId)).cancelled;
  };
}

let executor: CommandExecutor = () =>
  Promise.reject(new Error('command execution is not configured; core runs commands in the runner'));

export function setCommandExecutor(next: CommandExecutor): void {
  executor = next;
}

export function execCommand(request: ExecRequest): Promise<ExecResult> {
  return executor(request);
}

/** Runs commands in the runner container through ptyd. */
export function ptydCommandExecutor(ptyd: PtydBridge): CommandExecutor {
  return async (request) => {
    const client = ptyd.get();
    if ((ptyd.protocolVersion ?? 0) < EXEC_PROTOCOL_VERSION) {
      throw unavailable(
        'runner_outdated',
        `the runner image is older than core (ptyd protocol ${ptyd.protocolVersion} < ${PTYD_MIN_PROTOCOL_VERSION}); rebuild it with \`make up\``,
      );
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const call = client.exec({
      file: request.file,
      args: request.args,
      cwd: request.cwd,
      env: request.env ?? {},
      timeoutMs,
      maxOutputBytes: Math.min(request.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES, MAX_EXEC_OUTPUT_BYTES),
      encoding: request.encoding ?? 'utf8',
      ...(request.inheritEnv === false ? { inheritEnv: false } : {}),
      ...(request.execId && (ptyd.protocolVersion ?? 0) >= CANCEL_PROTOCOL_VERSION
        ? { execId: request.execId }
        : {}),
    });
    // ptyd enforces the timeout; this only guards against a reply that never comes. It is a timeout
    // like the client's own (isRunnerTimeout), whichever of the two fires first.
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const message = `runner exec of ${request.file} did not answer`;
        const error = unavailable('ptyd_unavailable', message);
        error.cause = new PtydClientError('timeout', message);
        reject(error);
      }, timeoutMs + 15_000);
    });
    try {
      return await Promise.race([call, guard]);
    } finally {
      clearTimeout(timer);
    }
  };
}

const localExecs = new Map<string, () => void>();

/** Cancels a command of {@link localCommandExecutor}. Only for tests and local development tools. */
export const localCommandCanceller: CommandCanceller = async (execId) => {
  const cancel = localExecs.get(execId);
  if (!cancel) return false;
  localExecs.delete(execId);
  cancel();
  return true;
};

/** Runs commands in this process's container. Only for tests and local development tools. */
export const localCommandExecutor: CommandExecutor = (request) =>
  new Promise((resolve) => {
    const max = request.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
    const child = spawn(request.file, request.args, {
      cwd: request.cwd,
      // As ptyd does: `inheritEnv: false` gets only the variables given.
      env: request.inheritEnv === false ? { ...request.env } : { ...process.env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, as in ptyd: a timeout or a cancel also kills what the command started.
      detached: true,
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    let cancelled = false;
    if (request.execId) {
      localExecs.set(request.execId, () => {
        cancelled = true;
        killGroup();
      });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (outSize + chunk.length > max) truncated = true;
      else out.push(chunk);
      outSize += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errSize + chunk.length > max) truncated = true;
      else err.push(chunk);
      errSize += chunk.length;
    });
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (request.execId) localExecs.delete(request.execId);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString(request.encoding === 'base64' ? 'base64' : 'utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
        ...(cancelled ? { cancelled: true } : {}),
      });
    };
    child.on('error', (error) => {
      err.push(Buffer.from(`${error.message}\n`));
      finish(127, null);
    });
    child.on('close', finish);
  });

/**
 * Whether a command failed because the runner could not run it (not reachable, too old, the
 * connection dropped or never answered), not because the command itself failed. Follows `cause`.
 */
export function isRunnerUnavailable(error: unknown): boolean {
  return runnerUnavailableCause(error) !== undefined;
}

/**
 * The error along `cause` that says the runner could not run the command (see
 * {@link isRunnerUnavailable}), the most specific one anywhere in the chain: a 503 that the runner
 * is too old, else a 503 that it is not reachable, else the first dropped or unanswered connection.
 */
export function runnerUnavailableCause(error: unknown): Error | undefined {
  let unreachable: Error | undefined;
  let connection: Error | undefined;
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof HttpError && e.statusCode === 503 && e.code === 'runner_outdated') return e;
    if (e instanceof HttpError && e.statusCode === 503 && e.code === 'ptyd_unavailable') unreachable ??= e;
    if (e instanceof PtydClientError && (e.code === 'disconnected' || e.code === 'timeout')) connection ??= e;
  }
  return unreachable ?? connection;
}

/**
 * A runner that did not answer in time (ptyd `timeout`): it may still be connected, so no reconnect
 * need follow.
 */
export function isRunnerTimeout(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof PtydClientError && e.code === 'timeout') return true;
  }
  return false;
}

/** Error shaped like `execFile`'s: carries the exit code and both output streams. */
export class CommandFailedError extends Error {
  declare readonly request: ExecRequest;
  declare readonly result: ExecResult;
  declare readonly stdout: string;
  declare readonly stderr: string;

  /**
   * The message names the command and its first output, without an address's credentials or a
   * capability (it may be logged or shown). The command line, its environment and its raw output
   * stay on the error, but not enumerable: an error logged whole (pino lists an error's own
   * enumerable fields) never carries them.
   */
  constructor(
    request: ExecRequest,
    result: ExecResult,
    readonly code: number | null,
    stdout: string,
    stderr: string,
  ) {
    const why = result.timedOut
      ? `timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
      : result.truncated
        ? 'output exceeded the size limit'
        : `exited with code ${result.exitCode ?? result.signal}`;
    const shown = (text: string) => redactCapabilityUrls(withoutUrlCredentials(text));
    super(
      `${request.file} ${shown(request.args.slice(0, 4).join(' '))} ${why}${stderr.trim() ? `: ${shown(stderr.trim()).slice(0, 500)}` : ''}`,
    );
    this.name = 'CommandFailedError';
    for (const [key, value] of Object.entries({ request, result, stdout, stderr }))
      Object.defineProperty(this, key, { value, enumerable: false, writable: false, configurable: true });
  }
}

/**
 * Drop-in for `promisify(execFile)`: resolves with stdout/stderr on exit code 0, rejects with a
 * {@link CommandFailedError} (exit code, stdout, stderr) otherwise, on timeout or on truncation.
 */
export async function execFileChecked(request: ExecRequest): Promise<{ stdout: string; stderr: string }> {
  const result = await execCommand(request);
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new CommandFailedError(request, result, result.exitCode, result.stdout, result.stderr);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
