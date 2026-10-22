import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  type PtydErrorCode,
  type PtydMethod,
  type PtydParams,
  type PtydResult,
  PtydServerMessage,
  ptydMethods,
} from '@emberline/protocol';
import { encodeFrame, FrameDecoder } from './framing.js';

/** Answers normally take milliseconds; this only bounds requests that would otherwise hang. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class PtydClientError extends Error {
  constructor(
    readonly code: PtydErrorCode | 'disconnected' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'PtydClientError';
  }
}

interface ClientEvents {
  output: [sessionId: string, data: string];
  exit: [sessionId: string, exitCode: number | null, signal: number | null];
  close: [];
}

interface Pending {
  method: PtydMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface ConnectOptions {
  /** Total attempts before giving up (default 1 = no retry). */
  attempts?: number;
  /** Delay between attempts in ms, doubled each retry up to 5s. */
  retryDelayMs?: number;
}

/**
 * Typed client for the ptyd socket. Reconnect policy (which sessions to re-attach) is the
 * caller's responsibility; `connect` only retries the initial connection.
 */
export class PtydClient extends EventEmitter<ClientEvents> {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly socket: net.Socket) {
    super();
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      try {
        for (const message of decoder.push(chunk)) this.onMessage(message);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.onClose());
  }

  static async connect(socketPath: string, options: ConnectOptions = {}): Promise<PtydClient> {
    const attempts = Math.max(1, options.attempts ?? 1);
    let delay = options.retryDelayMs ?? 250;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const socket = await connectSocket(socketPath);
        return new PtydClient(socket);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 5_000);
        }
      }
    }
    throw lastError;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Sends one request. It rejects with `timeout` when no answer arrives in time, so a request ptyd
   * never answers cannot stall its caller (e.g. core's reconcile loop) forever (B21).
   */
  request<M extends PtydMethod>(
    method: M,
    params: PtydParams<M>,
    { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<PtydResult<M>> {
    if (this.closed) return Promise.reject(new PtydClientError('disconnected', 'ptyd connection is closed'));
    const id = this.nextId++;
    return new Promise<PtydResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new PtydClientError('timeout', `ptyd did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          clearTimeout(timer);
          fn(value);
        };
      this.pending.set(id, {
        method,
        resolve: settle(resolve as (value: unknown) => void),
        reject: settle(reject),
      });
      this.socket.write(encodeFrame({ type: 'request', id, method, params }));
    });
  }

  spawn(params: PtydParams<'spawn'>) {
    return this.request('spawn', params);
  }
  hello() {
    return this.request('hello', {});
  }
  list() {
    return this.request('list', {});
  }
  attach(sessionId: string) {
    return this.request('attach', { sessionId });
  }
  detach(sessionId: string) {
    return this.request('detach', { sessionId });
  }
  write(sessionId: string, data: string) {
    return this.request('write', { sessionId, data });
  }
  resize(sessionId: string, cols: number, rows: number) {
    return this.request('resize', { sessionId, cols, rows });
  }
  snapshot(sessionId: string, scrollback?: number) {
    return this.request('snapshot', { sessionId, scrollback });
  }
  kill(sessionId: string, signal?: string) {
    return this.request('kill', { sessionId, signal });
  }
  remove(sessionId: string) {
    return this.request('remove', { sessionId });
  }
  exec(params: PtydParams<'exec'>) {
    // ptyd enforces the command's own timeout; allow for it plus transfer.
    return this.request('exec', params, { timeoutMs: (params.timeoutMs ?? 60_000) + 15_000 });
  }
  execCancel(execId: string) {
    return this.request('execCancel', { execId });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private onMessage(raw: unknown): void {
    const parsed = PtydServerMessage.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === 'event') {
      if (message.event === 'output') this.emit('output', message.sessionId, message.data);
      else this.emit('exit', message.sessionId, message.exitCode, message.signal);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (!message.ok) {
      pending.reject(new PtydClientError(message.error.code, message.error.message));
      return;
    }
    const result = ptydMethods[pending.method].result.safeParse(message.result);
    if (result.success) pending.resolve(result.data);
    else pending.reject(new PtydClientError('internal', `invalid ${pending.method} result from ptyd`));
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new PtydClientError('disconnected', 'ptyd connection closed'));
    }
    this.pending.clear();
    this.emit('close');
  }
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}
