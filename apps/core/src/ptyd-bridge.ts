import { EventEmitter } from 'node:events';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { PTYD_MIN_PROTOCOL_VERSION } from '@emberline/protocol';
import { PtydClient } from '@emberline/ptyd/client';
import {
  type HttpError,
  RUNNER_NOT_REACHABLE,
  runnerNotSecured,
  runnerOutdated,
  unavailable,
} from './errors.js';

export type PtydStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Whether only root can add, remove or rename entries in the directory of ptyd's socket. Agents run
 * as ptyd's own user, so the socket's owner and mode prove nothing; but in a directory that is
 * root's and writable by root alone, the socket is the one ptyd bound and no agent can put its own
 * listener in its place (the runner's entrypoint locks the directory once ptyd listens).
 */
export function socketDirGuardedSync(socketPath: string): boolean {
  try {
    const dir = lstatSync(path.dirname(socketPath));
    return dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

export async function socketDirGuarded(socketPath: string): Promise<boolean> {
  return socketDirGuardedSync(socketPath);
}

/** A runner older than this core: it needs a security update before core uses it (fail closed). */
export const isOutdatedRunner = (protocolVersion: number | null | undefined): boolean =>
  (protocolVersion ?? 0) < PTYD_MIN_PROTOCOL_VERSION;

/** The ptyd methods that start or feed something in the runner: refused on a runner core does not trust. */
const STARTING_METHODS = new Set<PropertyKey>(['spawn', 'exec', 'write']);

/**
 * The client as an outdated or not secured runner may be used: reading `hello`, the session list
 * and screens, attaching, resizing, stopping and removing what already runs, but never starting a
 * process or typing into one (`spawn`, `exec`, `write` reject with `refusal`).
 */
function refusingStarts(client: PtydClient, refusal: () => HttpError): PtydClient {
  return new Proxy(client, {
    get(target, prop) {
      if (STARTING_METHODS.has(prop)) return () => Promise.reject(refusal());
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
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
  private readonly requireSecured: boolean;

  /**
   * `requireSecured`: start nothing in a current runner whose socket's directory is not locked
   * ({@link unsecured}); off for the dev stack and tests, whose ptyd runs without the entrypoint.
   */
  constructor(
    private readonly socketPath: string,
    { requireSecured = false }: { requireSecured?: boolean } = {},
  ) {
    super();
    this.requireSecured = requireSecured;
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

  /** The connected runner is older than this core ({@link isOutdatedRunner}): nothing may start in it. */
  get outdated(): boolean {
    return this.client !== undefined && isOutdatedRunner(this.protocolVersion);
  }

  /**
   * Whether the connected runner's socket sits in a directory agents cannot change
   * ({@link socketDirGuarded}); null while not connected. Read again until it holds: the runner locks
   * the directory just after ptyd listens, and only root could unlock it again.
   */
  get socketGuarded(): boolean | null {
    if (!this.client) return this._socketGuarded;
    if (!this._socketGuarded) this._socketGuarded = socketDirGuardedSync(this.socketPath);
    return this._socketGuarded;
  }

  /**
   * A current runner whose socket is not locked (its start has not finished, or it runs with a
   * compose `user:` and cannot lock it): an agent could stand in for ptyd, so nothing starts in it.
   */
  get unsecured(): boolean {
    return this.client !== undefined && this.requireSecured && !this.outdated && this.socketGuarded === false;
  }

  /** Why nothing may start in the connected runner now, if anything forbids it. */
  private refusal(): HttpError | undefined {
    if (this.outdated) return runnerOutdated();
    if (this.unsecured) return runnerNotSecured();
    return undefined;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
    this.client?.close();
  }

  /**
   * Control client for list/spawn/kill. Throws 503 while ptyd is unreachable; on an outdated or not
   * secured runner its `spawn`, `exec` and `write` reject with why ({@link refusingStarts}).
   */
  get(): PtydClient {
    if (!this.client || this.client.isClosed) {
      throw unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
    }
    const refusal = this.refusal();
    return refusal ? refusingStarts(this.client, () => this.refusal() ?? refusal) : this.client;
  }

  /** Throws 503 unless something may start in the runner now: reachable, current and secured. */
  assertCanStart(): void {
    this.get();
    const refusal = this.refusal();
    if (refusal) throw refusal;
  }

  /**
   * A fresh connection owned by the caller (close it when done). Refused while the bridge itself is
   * not connected (it may be reconnecting to a runner it has not checked yet). The viewer says `hello`
   * itself, and is held to its own answer and to the bridge's checks as {@link get} is: on a runner
   * that is outdated or not secured, it can watch but never type.
   */
  async openViewer(): Promise<PtydClient> {
    if (!this.client || this.client.isClosed) throw unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
    let viewer: PtydClient;
    let version: number;
    try {
      viewer = await PtydClient.connect(this.socketPath);
    } catch {
      throw unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
    }
    try {
      version = (await viewer.hello()).protocolVersion;
    } catch {
      viewer.close();
      throw unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
    }
    if (isOutdatedRunner(version)) return refusingStarts(viewer, runnerOutdated);
    const refusal = this.refusal();
    return refusal ? refusingStarts(viewer, () => this.refusal() ?? refusal) : viewer;
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
        delay = 250;
        // Handed out only once its protocol is known, so nothing starts in an outdated runner.
        const hello = await client.hello().catch(() => null);
        this._protocolVersion = hello?.protocolVersion ?? 1;
        this._ptraceScope = hello?.ptraceScope;
        this.client = client;
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
