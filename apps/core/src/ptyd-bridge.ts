import { EventEmitter } from 'node:events';
import { PtydClient } from '@emberline/ptyd/client';
import { unavailable } from './errors.js';

export type PtydStatus = 'connecting' | 'connected' | 'disconnected';

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
      throw unavailable('ptyd_unavailable', 'the runner (ptyd) is not reachable');
    }
    return this.client;
  }

  /** A fresh connection owned by the caller (close it when done). */
  async openViewer(): Promise<PtydClient> {
    try {
      return await PtydClient.connect(this.socketPath);
    } catch {
      throw unavailable('ptyd_unavailable', 'the runner (ptyd) is not reachable');
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
        const client = await PtydClient.connect(this.socketPath);
        if (this.stopped) {
          client.close();
          break;
        }
        this.client = client;
        delay = 250;
        this._protocolVersion = await client.hello().then(
          (res) => res.protocolVersion,
          () => 1,
        );
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
