import { spawn } from 'node:child_process';
import { MAX_EXEC_OUTPUT_BYTES, type PtydResult } from '@emberline/protocol';
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
  timeoutMs?: number;
  maxOutputBytes?: number;
  encoding?: 'utf8' | 'base64';
}

export type ExecResult = PtydResult<'exec'>;
export type CommandExecutor = (request: ExecRequest) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

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
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const call = ptyd.get().exec({
      file: request.file,
      args: request.args,
      cwd: request.cwd,
      env: request.env ?? {},
      timeoutMs,
      maxOutputBytes: Math.min(request.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES, MAX_EXEC_OUTPUT_BYTES),
      encoding: request.encoding ?? 'utf8',
    });
    // ptyd enforces the timeout; this only guards against a reply that never comes.
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`runner exec of ${request.file} did not answer`)), timeoutMs + 15_000);
    });
    try {
      return await Promise.race([call, guard]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Runs commands in this process's container. Only for tests and local development tools. */
export const localCommandExecutor: CommandExecutor = (request) =>
  new Promise((resolve) => {
    const max = request.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
    const child = spawn(request.file, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
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
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString(request.encoding === 'base64' ? 'base64' : 'utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
      });
    };
    child.on('error', (error) => {
      err.push(Buffer.from(`${error.message}\n`));
      finish(127, null);
    });
    child.on('close', finish);
  });

/** Error shaped like `execFile`'s: carries the exit code and both output streams. */
export class CommandFailedError extends Error {
  constructor(
    readonly request: ExecRequest,
    readonly result: ExecResult,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const why = result.timedOut
      ? `timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
      : result.truncated
        ? 'output exceeded the size limit'
        : `exited with code ${result.exitCode ?? result.signal}`;
    super(`${request.file} ${request.args.slice(0, 4).join(' ')} ${why}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`);
    this.name = 'CommandFailedError';
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
