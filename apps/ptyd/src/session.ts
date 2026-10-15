import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { PtydParsedParams, ScreenSnapshot, SessionInfo } from '@emberline/protocol';
import serializePkg from '@xterm/addon-serialize';
import headlessPkg from '@xterm/headless';
import nodePty, { type IPty } from 'node-pty';

// Both xterm packages ship CommonJS bundles; destructure from the default export.
const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;
type HeadlessTerminal = InstanceType<typeof Terminal>;
type Serializer = InstanceType<typeof SerializeAddon>;

/** Environment variables inherited from ptyd; everything else must be passed explicitly. */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'];

export interface SessionConfig {
  /** Directory for raw output logs; logging is disabled when omitted. */
  logDir?: string;
  maxLogBytes?: number;
  /** Scrollback lines kept by the headless terminal. */
  scrollback?: number;
}

export interface SessionListener {
  onOutput(data: string): void;
  onExit(exitCode: number | null, signal: number | null): void;
}

export const DEFAULT_SNAPSHOT_SCROLLBACK = 1000;

/**
 * One PTY process plus a headless terminal mirroring its screen.
 *
 * Output is fanned out to listeners only after the headless terminal has parsed it, so a
 * snapshot taken at subscription time and the events that follow never overlap or leave gaps.
 */
export class PtySession {
  readonly id: string;
  readonly createdAt = new Date().toISOString();
  private readonly proc: IPty;
  private readonly term: HeadlessTerminal;
  private readonly serializer: Serializer;
  private readonly listeners = new Set<SessionListener>();
  private readonly log?: RotatingLog;
  private readonly spawnParams: PtydParsedParams<'spawn'>;
  private status: SessionInfo['status'] = 'running';
  private exitCode: number | null = null;
  private signal: number | null = null;
  private disposed = false;
  private readonly flushWaiters = new Set<{ reject: (error: Error) => void }>();

  constructor(id: string, params: PtydParsedParams<'spawn'>, config: SessionConfig = {}) {
    this.id = id;
    this.spawnParams = params;

    this.term = new Terminal({
      cols: params.cols,
      rows: params.rows,
      scrollback: config.scrollback ?? 5000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    // The addon is typed against @xterm/xterm but works with the headless terminal.
    this.term.loadAddon(this.serializer as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);

    if (config.logDir) {
      this.log = new RotatingLog(path.join(config.logDir, `${id}.log`), config.maxLogBytes ?? 8 * 1024 * 1024);
    }

    this.proc = nodePty.spawn(params.file, params.args, {
      name: 'xterm-256color',
      cols: params.cols,
      rows: params.rows,
      cwd: params.cwd,
      env: { ...pickBaseEnv(), ...params.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    this.proc.onData((data) => {
      this.log?.write(data);
      if (this.disposed) return;
      this.term.write(data, () => {
        for (const listener of this.listeners) listener.onOutput(data);
      });
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.status = 'exited';
      this.exitCode = exitCode;
      this.signal = signal ?? null;
      const notify = () => {
        for (const listener of this.listeners) listener.onExit(this.exitCode, this.signal);
      };
      // Flush pending output first so listeners see every byte before the exit event.
      if (this.disposed) notify();
      else this.term.write('', notify);
    });
  }

  get running(): boolean {
    return this.status === 'running';
  }

  info(): SessionInfo {
    return {
      id: this.id,
      pid: this.proc.pid,
      file: this.spawnParams.file,
      args: this.spawnParams.args,
      cwd: this.spawnParams.cwd,
      cols: this.term.cols,
      rows: this.term.rows,
      createdAt: this.createdAt,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.signal,
      meta: this.spawnParams.meta,
    };
  }

  /**
   * Resolves once the emulator has processed everything written so far. Rejects when the session
   * is disposed first: xterm drops pending write callbacks on dispose, which used to leave
   * attach/snapshot requests unanswered forever (B21).
   */
  private flushed(): Promise<void> {
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      const waiter = { reject };
      this.flushWaiters.add(waiter);
      this.term.write('', () => {
        this.flushWaiters.delete(waiter);
        resolve();
      });
    });
  }

  /** Registers a listener and returns the screen state at that exact point in the stream. */
  async subscribe(listener: SessionListener): Promise<{ snapshot: ScreenSnapshot; unsubscribe: () => void }> {
    await this.flushed();
    const snapshot = this.serialize(DEFAULT_SNAPSHOT_SCROLLBACK);
    this.listeners.add(listener);
    return { snapshot, unsubscribe: () => this.listeners.delete(listener) };
  }

  async snapshot(scrollback = DEFAULT_SNAPSHOT_SCROLLBACK): Promise<ScreenSnapshot> {
    await this.flushed();
    return this.serialize(scrollback);
  }

  write(data: string): void {
    if (!this.running) throw new Error(`session ${this.id} has exited`);
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    this.assertNotDisposed();
    this.term.resize(cols, rows);
    if (this.running) this.proc.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (this.running) this.proc.kill(signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.kill();
    this.disposed = true;
    for (const waiter of this.flushWaiters) waiter.reject(new Error(`session ${this.id} was removed`));
    this.flushWaiters.clear();
    this.listeners.clear();
    this.term.dispose();
    this.log?.close();
  }

  private serialize(scrollback: number): ScreenSnapshot {
    return { data: this.serializer.serialize({ scrollback }), cols: this.term.cols, rows: this.term.rows };
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error(`session ${this.id} is disposed`);
  }
}

export function pickBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Append-only log with a single rotation (`<file>.1`) once it exceeds `maxBytes`. */
class RotatingLog {
  private stream: WriteStream;
  private bytes: number;

  constructor(
    private readonly file: string,
    private readonly maxBytes: number,
  ) {
    this.bytes = existsSync(file) ? statSync(file).size : 0;
    this.stream = createWriteStream(file, { flags: 'a' });
    this.stream.on('error', () => {
      // Logging is best-effort and must never take a session down.
    });
  }

  write(data: string): void {
    const size = Buffer.byteLength(data);
    if (this.bytes + size > this.maxBytes) this.rotate();
    this.stream.write(data);
    this.bytes += size;
  }

  close(): void {
    this.stream.end();
  }

  private rotate(): void {
    this.stream.end();
    try {
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // Ignore: worst case we keep appending to the current file.
    }
    this.stream = createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', () => {});
    this.bytes = 0;
  }
}
