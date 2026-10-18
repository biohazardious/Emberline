import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { PtydParsedParams, PtydResult } from '@emberline/protocol';

/**
 * Runs one command to completion without a terminal. Used by core for git and build steps so
 * that nothing from an agent's workspace ever executes in the core container.
 */
export function runExec(
  params: PtydParsedParams<'exec'>,
  baseEnv: Record<string, string>,
  /** Called with a canceller once the process runs (for `execCancel`), and with null when it ended. */
  onCancellable?: (cancel: (() => void) | null) => void,
): Promise<PtydResult<'exec'>> {
  if (!existsSync(params.cwd) || !statSync(params.cwd).isDirectory()) {
    return Promise.reject(new ExecCwdError(`cwd does not exist: ${params.cwd}`));
  }
  return new Promise((resolve) => {
    const child = spawn(params.file, params.args, {
      cwd: params.cwd,
      env: { ...baseEnv, ...params.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout also kills what the command started (npm -> node).
      detached: true,
    });
    const stdout = new Capped(params.maxOutputBytes);
    const stderr = new Capped(params.maxOutputBytes);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, params.timeoutMs);
    onCancellable?.(() => {
      cancelled = true;
      killGroup();
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onCancellable?.(null);
      resolve({
        exitCode,
        signal,
        stdout: stdout.read().toString(params.encoding === 'base64' ? 'base64' : 'utf8'),
        stderr: stderr.read().toString('utf8'),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        ...(cancelled ? { cancelled: true } : {}),
      });
    };
    child.on('error', (error) => {
      stderr.push(Buffer.from(`${error.message}\n`));
      finish(127, null);
    });
    child.on('close', finish);
  });
}

export class ExecCwdError extends Error {}

class Capped {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  read(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
