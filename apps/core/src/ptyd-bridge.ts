import { EventEmitter } from 'node:events';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { PtydClient } from '@emberline/ptyd/client';
import { RUNNER_NOT_REACHABLE, unavailable } from './errors.js';

export type PtydStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Whether only root can add, remove or rename entries in the directory of ptyd's socket. Agents run
 * as ptyd's own user, so the socket's owner and mode prove nothing; but in a directory that is
 * root's and writable by root alone, the socket is the one ptyd bound and no agent can put its own
 * listener in its place (the runner's entrypoint locks the directory once ptyd listens).
 */
export async function socketDirGuarded(socketPath: string): Promise<boolean> {
  try {
    const dir = await lstat(path.dirname(socketPath));
    return dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

interface BridgeEvents {
  status: [status: PtydStatus];
}

/**
 * Keeps a control connection to ptyd alive (reconnecting with backoff) and hands out
 * dedicated viewer connections for terminal WebSockets.
 *
 * Each viewer gets its own socket so ptyd's per-connection attach ordering
 * (snapshot first, then output) is preserved without any fan-out logic in core.
 */
export class PtydBridge extends EventEmitter<BridgeEvents> {
  private client?: PtydClient;
  private stopped = false;
  private _status: PtydStatus = 'connecting';
  private wake?: () => void;
  private _protocolVersion: number | null = null;
  private _ptraceScope: number | null | undefined = undefined;
  private _socketGuarded: boolean | null = null;

  constructor(private readonly socketPath: string) {
    super();
  }

  get status(): PtydStatus {
    return this._status;
  }

  /** ptyd protocol version of the connected runner (1 = before the handshake existed). */
  get protocolVersion(): number | null {
    return this._protocolVersion;
  }

  /** The runner host's Yama `ptrace_scope` (null: no Yama), undefined while the runner has not said. */
  get ptraceScope(): number | null | undefined {
    return this._ptraceScope;
  }

  /** Whether the socket core last connected to sat in a directory agents cannot change ({@link socketDirGuarded}). */
  get socketGuarded(): boolean | null {
    return this._socketGuarded;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
    this.client?.close();
  }

  /** Control client for list/spawn/kill. Throws 503 while ptyd is unreachable. */
  get(): PtydClient {
    if (!this.client || this.client.isClosed) {
      throw unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
    }
    return this.client;
  }

  /** A fresh connection owned by the caller (close it when done). */
  async openViewer(): Promise<PtydClient> {
    try {
      return await PtydClient.connect(this.socketPath);
    } catch {
      throw unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
    }
  }

  /** Resolves once connected (or rejects after `timeoutMs`); used by tests and startup. */
  waitUntilConnected(timeoutMs = 5_000): Promise<void> {
    if (this._status === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('status', onStatus);
        reject(new Error('timed out waiting for ptyd'));
      }, timeoutMs);
      const onStatus = (status: PtydStatus) => {
        if (status !== 'connected') return;
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve();
      };
      this.on('status', onStatus);
    });
  }

  private setStatus(status: PtydStatus): void {
    if (status === this._status) return;
    this._status = status;
    this.emit('status', status);
  }

  private async loop(): Promise<void> {
    let delay = 250;
    while (!this.stopped) {
      try {
        const guarded = await socketDirGuarded(this.socketPath);
        const client = await PtydClient.connect(this.socketPath);
        this._socketGuarded = guarded;
        if (this.stopped) {
          client.close();
          break;
        }
        this.client = client;
        delay = 250;
        const hello = await client.hello().catch(() => null);
        this._protocolVersion = hello?.protocolVersion ?? 1;
        this._ptraceScope = hello?.ptraceScope;
        this.setStatus('connected');
        await new Promise<void>((resolve) => client.once('close', resolve));
      } catch {
        // Not reachable yet; retry below.
      }
      this.client = undefined;
      if (this.stopped) break;
      this.setStatus('disconnected');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
