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
  runnerStarting,
  unavailable,
} from './errors.js';

/**
 * How long a connected runner may take to lock its socket before core says it is not secured. Its
 * entrypoint locks it milliseconds after ptyd listens; until then core starts nothing either way, and
 * says the runner is starting.
 */
export const SECURE_GRACE_MS = 10_000;

/**
 * Why core cannot use the runner while it cannot reach it ({@link PtydBridge.startProblem}):
 * `not_answering` once that has lasted longer than a restart takes ({@link SECURE_GRACE_MS}).
 */
export type RunnerStartProblem = 'not_answering';

/** What core says about a connected runner's socket lock ({@link PtydBridge.lockState}). */
export type RunnerLockState = 'secured' | 'starting' | 'not_secured';

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
  private _lockHint: 'pending' | 'locked' | 'impossible' | undefined;
  /** When the current connection was handed out (Date.now()). */
  private connectedAt = 0;
  /** Since when core has not been connected (Date.now()); null while connected or before start(). */
  private downSince: number | null = null;

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

  /**
   * For what core shows: a connected runner whose socket is not locked is `starting` for
   * {@link SECURE_GRACE_MS} after core connected, unless the runner itself says it cannot lock it
   * (`hello` lock `impossible`); then, or after that, it is `not_secured`. Nothing starts in either.
   */
  get lockState(): RunnerLockState {
    if (!this.unsecured) return 'secured';
    if (this._lockHint === 'impossible') return 'not_secured';
    return Date.now() - this.connectedAt < SECURE_GRACE_MS ? 'starting' : 'not_secured';
  }

  /**
   * Why the runner cannot be used though core cannot reach it: it has not answered for longer than a
   * restart takes. Core cannot tell a stopped runner from one that cannot start (a compose `user:` on
   * a socket folder an earlier start locked), so the hint names both (the not-answering hint in errors.ts).
   */
  get startProblem(): RunnerStartProblem | null {
    if (this.client) return null;
    return this.downSince !== null && Date.now() - this.downSince >= SECURE_GRACE_MS ? 'not_answering' : null;
  }

  /** Why nothing may start in the connected runner now, if anything forbids it. */
  private refusal(): HttpError | undefined {
    if (this.outdated) return runnerOutdated();
    if (this.unsecured) return this.lockState === 'starting' ? runnerStarting() : runnerNotSecured();
    return undefined;
  }

  start(): void {
    this.downSince = Date.now();
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
    if (status === 'connected') this.downSince = null;
    else this.downSince ??= Date.now();
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
        this._lockHint = hello?.lock;
        this.connectedAt = Date.now();
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
