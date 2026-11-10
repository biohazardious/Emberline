import { EventEmitter } from 'node:events';
import { PTYD_MIN_PROTOCOL_VERSION, type PtydMode } from '@emberline/protocol';
import { PtydClient } from '@emberline/ptyd/client';
import {
  type HttpError,
  opsMissing,
  RUNNER_NOT_REACHABLE,
  runnerNotSecured,
  runnerOutdated,
  unavailable,
} from './errors.js';

/** How long core may go without reaching a ptyd before it says so (longer than a restart takes). */
export const NOT_ANSWERING_AFTER_MS = 10_000;

/**
 * Why core cannot use the runner while it cannot reach it ({@link PtydBridge.startProblem}):
 * `not_answering` once that has lasted longer than a restart takes ({@link NOT_ANSWERING_AFTER_MS}).
 */
export type RunnerStartProblem = 'not_answering';

export type PtydStatus = 'connecting' | 'connected' | 'disconnected';

/** A runner older than this core: it needs a security update before core uses it (fail closed). */
export const isOutdatedRunner = (protocolVersion: number | null | undefined): boolean =>
  (protocolVersion ?? 0) < PTYD_MIN_PROTOCOL_VERSION;

/** The ptyd methods that start or feed something in the runner: refused on a runner core does not trust. */
const STARTING_METHODS = new Set<PropertyKey>(['spawn', 'exec', 'write']);

/**
 * The client as an outdated or not secured runner may be used, or any runner while the ops service
 * is missing: reading `hello`, the session list and screens, attaching, resizing, stopping and
 * removing what already runs, but never starting a process or typing into one (`spawn`, `exec`,
 * `write` reject with `refusal`).
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

export interface PtydBridgeOptions {
  /**
   * Which ptyd this is: the runner's (`runner`, beside the agents) or the `ops` container's (core's
   * own commands). A ptyd whose `hello` names the other mode is not used: it counts as missing.
   */
  mode?: PtydMode;
  /**
   * Start nothing in a current ptyd whose `hello` does not say `secured` ({@link unsecured}); off for
   * the dev stack and tests, whose ptyd runs as the agents' user.
   */
  requireSecured?: boolean;
  /**
   * The runner's bridge only: the ops bridge (null: none, the dev stack). While it is missing
   * ({@link PtydBridge.available} false), nothing starts in the runner either: core starts nothing anywhere.
   */
  ops?: PtydBridge | null;
}

/**
 * Keeps a control connection to ptyd alive (reconnecting with backoff) and hands out
 * dedicated viewer connections for terminal WebSockets.
 *
 * Each viewer gets its own socket so ptyd's per-connection attach ordering
 * (snapshot first, then output) is preserved without any fan-out logic in core.
 *
 * Core has two: the runner's (agents, terminals, workspace commands) and the ops container's (core's
 * own commands and the import clone). The ops one says every refusal as `ops_missing`.
 */
export class PtydBridge extends EventEmitter<BridgeEvents> {
  private client?: PtydClient;
  private stopped = false;
  private _status: PtydStatus = 'connecting';
  private wake?: () => void;
  private _protocolVersion: number | null = null;
  private _ptraceScope: number | null | undefined = undefined;
  readonly mode: PtydMode;
  private readonly requireSecured: boolean;
  private readonly ops: PtydBridge | null;
  /** What the connected ptyd's `hello` says of itself (`secured`); undefined before it has said. */
  private _reportsSecured: boolean | undefined;
  /** The mode the socket last answered with when it was not {@link mode}; null once it answers right. */
  private _foundMode: PtydMode | null = null;
  /** Since when core has not been connected (Date.now()); null while connected or before start(). */
  private downSince: number | null = null;

  constructor(
    private readonly socketPath: string,
    { mode = 'runner', requireSecured = false, ops = null }: PtydBridgeOptions = {},
  ) {
    super();
    this.mode = mode;
    this.requireSecured = requireSecured;
    this.ops = ops;
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

  /** What the connected ptyd says of itself (`hello` `secured`); undefined when not connected or it does not say. */
  get secured(): boolean | undefined {
    return this.client ? this._reportsSecured : undefined;
  }

  /**
   * The mode a ptyd on this socket answered with when it was not this bridge's: core does not use it
   * (a swapped socket or a `command:` of the wrong service). Null otherwise.
   */
  get foundMode(): PtydMode | null {
    return this._foundMode;
  }

  /** The connected runner is older than this core ({@link isOutdatedRunner}): nothing may start in it. */
  get outdated(): boolean {
    return this.client !== undefined && isOutdatedRunner(this.protocolVersion);
  }

  /**
   * A current ptyd that does not say it is secured (`hello` `secured`): it runs as the agents' own
   * user, or cannot start what it runs as them, so an agent could reach it. Nothing starts in it.
   */
  get unsecured(): boolean {
    return (
      this.client !== undefined && this.requireSecured && !this.outdated && this._reportsSecured !== true
    );
  }

  /**
   * Why core cannot use the runner though core cannot reach it: it has not answered for longer than a
   * restart takes (stopped, crashing, or started with a compose `user:`, which stops it at once).
   */
  get startProblem(): RunnerStartProblem | null {
    if (this.client) return null;
    return this.downSince !== null && Date.now() - this.downSince >= NOT_ANSWERING_AFTER_MS
      ? 'not_answering'
      : null;
  }

  /** Whether something may start here now: connected, current, secured, and (the runner) ops there. */
  get available(): boolean {
    return this.client !== undefined && !this.client.isClosed && this.startRefusal() === undefined;
  }

  /** The runner's bridge: `ops_missing` while the ops bridge is missing. */
  private opsRefusal(): HttpError | undefined {
    return this.ops && !this.ops.available ? opsMissing() : undefined;
  }

  /**
   * Why nothing may start in the connected ptyd now, if anything forbids it: the ops service is
   * missing (the runner's), or the ptyd is outdated or not secured. The ops bridge says each as `ops_missing`.
   */
  startRefusal(): HttpError | undefined {
    const gated = this.opsRefusal();
    if (gated) return gated;
    const own = this.outdated ? runnerOutdated() : this.unsecured ? runnerNotSecured() : undefined;
    return own && this.mode === 'ops' ? opsMissing() : own;
  }

  /** Not reachable: the runner's is `ptyd_unavailable`, the ops one's `ops_missing`. */
  private unreachable(): HttpError {
    return this.mode === 'ops' ? opsMissing() : unavailable('ptyd_unavailable', RUNNER_NOT_REACHABLE);
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
   * Control client for list/spawn/kill. Throws 503 while ptyd is unreachable; when something forbids
   * starting ({@link startRefusal}) its `spawn`, `exec` and `write` reject with why ({@link refusingStarts}).
   */
  get(): PtydClient {
    if (!this.client || this.client.isClosed) throw this.unreachable();
    const refusal = this.startRefusal();
    return refusal ? refusingStarts(this.client, () => this.startRefusal() ?? refusal) : this.client;
  }

  /**
   * Throws 503 unless something may start here now: reachable, current and secured, and for the
   * runner the ops service there (that refusal comes first: it is what to fix).
   */
  assertCanStart(): void {
    const gated = this.opsRefusal();
    if (gated) throw gated;
    this.get();
    const refusal = this.startRefusal();
    if (refusal) throw refusal;
  }

  /**
   * A fresh connection owned by the caller (close it when done). Refused while the bridge itself is
   * not connected (it may be reconnecting to a ptyd it has not checked yet). The viewer says `hello`
   * itself, and is held to its own answer and to the bridge's checks as {@link get} is: on a ptyd
   * that is outdated, not secured or of the other mode, it can watch but never type.
   */
  async openViewer(): Promise<PtydClient> {
    if (!this.client || this.client.isClosed) throw this.unreachable();
    let viewer: PtydClient;
    let hello: Awaited<ReturnType<PtydClient['hello']>>;
    try {
      viewer = await PtydClient.connect(this.socketPath);
    } catch {
      throw this.unreachable();
    }
    try {
      hello = await viewer.hello();
    } catch {
      viewer.close();
      throw this.unreachable();
    }
    if (isOutdatedRunner(hello.protocolVersion))
      return refusingStarts(viewer, this.mode === 'ops' ? opsMissing : runnerOutdated);
    if (hello.mode !== this.mode) {
      viewer.close();
      throw this.unreachable();
    }
    const refusal = this.startRefusal();
    return refusal ? refusingStarts(viewer, () => this.startRefusal() ?? refusal) : viewer;
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
        const client = await PtydClient.connect(this.socketPath);
        if (this.stopped) {
          client.close();
          break;
        }
        delay = 250;
        // Handed out only once its protocol and mode are known, so nothing starts in an outdated
        // ptyd, and a ptyd of the other mode is never used.
        const hello = await client.hello().catch(() => null);
        const version = hello?.protocolVersion ?? 1;
        if (!isOutdatedRunner(version) && hello?.mode !== this.mode) {
          this._foundMode = hello?.mode ?? null;
          client.close();
          throw new Error(`ptyd answers in ${hello?.mode ?? 'no'} mode`);
        }
        this._foundMode = null;
        this._protocolVersion = version;
        this._ptraceScope = hello?.ptraceScope;
        this._reportsSecured = hello?.secured;
        this.client = client;
        this.setStatus('connected');
        await new Promise<void>((resolve) => client.once('close', resolve));
      } catch {
        // Not reachable yet, or not the ptyd this bridge is for; retry below.
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

/** The bridge core's own work uses: the ops container's, or the runner's without one (the dev stack). */
export const opsBridgeOf = (deps: { ptyd: PtydBridge; opsPtyd?: PtydBridge }): PtydBridge =>
  deps.opsPtyd ?? deps.ptyd;
