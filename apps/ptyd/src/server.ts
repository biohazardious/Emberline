import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  type PtydErrorCode,
  type PtydEvent,
  type PtydMethod,
  type PtydParsedParams,
  type PtydResponse,
  type PtydResult,
  PTYD_PROTOCOL_VERSION,
  PtydRequest,
  ptydMethods,
} from '@emberline/protocol';
import { z } from 'zod';
import { encodeFrame, FrameDecoder } from './framing.js';
import { ExecCwdError, runExec } from './exec.js';
import { PtySession, pickBaseEnv, type SessionConfig } from './session.js';

/** Clients that let this much output pile up unread are disconnected. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

export interface PtydServerOptions extends SessionConfig {
  socketPath: string;
  log?: (message: string) => void;
  /** Where the kernel's Yama ptrace setting is read (tests). */
  ptraceScopeFile?: string;
  /**
   * The runner's entrypoint locks the socket's directory once ptyd listens (EMBERLINE_PTYD_REQUIRE_LOCK):
   * until it is root's and writable by root alone, with ptyd's own socket at the path, `spawn` and
   * `exec` are refused. Agents share ptyd's user; one started before the lock could replace the socket.
   */
  requireLock?: boolean;
  /** The runner runs as another user than root and cannot lock the directory (hello says so). */
  cannotLock?: boolean;
}

/** A path's device and inode, as `stat -c '%d %i'` prints them. */
export interface SocketIdentity {
  dev: number;
  ino: number;
}

/**
 * The host's Yama `ptrace_scope`, or null without Yama. Agents run as ptyd's own user: with 0, any of
 * them may attach to ptyd (or write its memory) and run whatever it likes as every command core
 * sends; 1 and up allow tracing only a process's own descendants, and ptyd is no agent's.
 */
export function readPtraceScope(file = '/proc/sys/kernel/yama/ptrace_scope'): number | null {
  try {
    const value = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export class PtydError extends Error {
  constructor(
    readonly code: PtydErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PtydError';
  }
}

interface Connection {
  socket: net.Socket;
  /** sessionId -> unsubscribe */
  attachments: Map<string, () => void>;
  /** sessionId -> number of the latest attach request; an older one finishing late is dropped (B22). */
  attachSeq: Map<string, number>;
}

type Handler<M extends PtydMethod> = (
  conn: Connection,
  params: PtydParsedParams<M>,
) => PtydResult<M> | Promise<PtydResult<M>>;

export class PtydServer {
  private readonly sessions = new Map<string, PtySession>();
  /** Cancellers of running `exec` calls that carry an `execId`. */
  private readonly execs = new Map<string, () => void>();
  private readonly connections = new Set<Connection>();
  private server?: net.Server;
  /** Read once at start: a kernel setting of the host, the same for the container's life. */
  private readonly ptraceScope: number | null;
  /** The socket this ptyd bound, read right after the bind (see {@link requireLock}). */
  private bound?: SocketIdentity;
  private locked = false;

  constructor(private readonly options: PtydServerOptions) {
    this.ptraceScope = readPtraceScope(options.ptraceScopeFile);
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  /** The device and inode of the socket ptyd bound (for the entrypoint's readiness check). */
  get socketIdentity(): SocketIdentity | undefined {
    return this.bound;
  }

  /**
   * Whether the socket's directory is locked: a real directory of root's that only root can write,
   * with the socket ptyd bound still at the path. Once locked, only root could undo it, so it is kept.
   */
  isLocked(): boolean {
    if (this.locked) return true;
    if (!this.bound) return false;
    try {
      const dir = lstatSync(path.dirname(this.options.socketPath));
      const sock = lstatSync(this.options.socketPath);
      this.locked =
        dir.isDirectory() &&
        dir.uid === 0 &&
        (dir.mode & 0o022) === 0 &&
        sock.isSocket() &&
        sock.dev === this.bound.dev &&
        sock.ino === this.bound.ino;
    } catch {
      return false;
    }
    return this.locked;
  }

  private assertLocked(): void {
    if (this.options.requireLock && !this.isLocked())
      throw new PtydError(
        'not_secured',
        "the runner has not locked its service's socket yet: nothing starts until it has",
      );
  }

  async listen(): Promise<void> {
    const { socketPath, logDir } = this.options;
    await prepareSocketPath(socketPath);
    if (logDir) await mkdir(logDir, { recursive: true, mode: 0o700 });

    const server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    const sock = lstatSync(socketPath);
    this.bound = { dev: sock.dev, ino: sock.ino };
    this.server = server;
    this.options.log?.(`ptyd listening on ${socketPath}`);
  }

  /** Stops accepting clients. Sessions are killed unless `keepSessions` is set (tests only). */
  async close({ keepSessions = false } = {}): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    if (!keepSessions) {
      for (const session of this.sessions.values()) session.dispose();
      this.sessions.clear();
    }
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.options.socketPath).catch(() => {});
  }

  private onConnection(socket: net.Socket): void {
    const conn: Connection = { socket, attachments: new Map(), attachSeq: new Map() };
    this.connections.add(conn);
    const decoder = new FrameDecoder();

    socket.on('data', (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        this.options.log?.(`dropping client: ${(error as Error).message}`);
        socket.destroy();
        return;
      }
      for (const message of messages) void this.handle(conn, message);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const unsubscribe of conn.attachments.values()) unsubscribe();
      conn.attachments.clear();
      this.connections.delete(conn);
    });
  }

  private async handle(conn: Connection, raw: unknown): Promise<void> {
    const parsed = PtydRequest.safeParse(raw);
    if (!parsed.success) {
      const id = typeof (raw as { id?: unknown })?.id === 'number' ? (raw as { id: number }).id : 0;
      this.respondError(conn, id, 'bad_request', z.prettifyError(parsed.error));
      return;
    }
    const { id, method } = parsed.data;
    const params = ptydMethods[method].params.safeParse(parsed.data.params ?? {});
    if (!params.success) {
      this.respondError(conn, id, 'bad_request', z.prettifyError(params.error));
      return;
    }

    try {
      if (method === 'attach') {
        // Attach replies from inside the subscription callback (see attach()).
        await this.attach(conn, id, params.data as PtydParsedParams<'attach'>);
        return;
      }
      const handler = this.handlers[method] as Handler<PtydMethod>;
      const result = await handler(conn, params.data);
      this.send(conn, { type: 'response', id, ok: true, result } satisfies PtydResponse);
    } catch (error) {
      const code = error instanceof PtydError ? error.code : 'internal';
      this.respondError(conn, id, code, (error as Error).message);
    }
  }

  private readonly handlers: { [M in Exclude<PtydMethod, 'attach'>]: Handler<M> } = {
    spawn: (_conn, params) => {
      this.assertLocked();
      const id = params.id ?? randomUUID();
      if (this.sessions.has(id)) throw new PtydError('conflict', `session ${id} already exists`);
      if (!existsSync(params.cwd) || !statSync(params.cwd).isDirectory()) {
        throw new PtydError('bad_request', `cwd does not exist: ${params.cwd}`);
      }
      // `meta.noLog`: keep no on-disk log of this session (an import clone may show a token a server
      // echoes). The live terminal still streams; nothing is written to the log directory.
      const config = params.meta.noLog ? { ...this.options, logDir: undefined } : this.options;
      const session = new PtySession(id, params, config);
      this.sessions.set(id, session);
      this.options.log?.(`spawned ${id} (pid ${session.info().pid}): ${params.file}`);
      return session.info();
    },
    hello: () => ({
      protocolVersion: PTYD_PROTOCOL_VERSION,
      ptraceScope: this.ptraceScope,
      ...(this.options.cannotLock
        ? { lock: 'impossible' as const }
        : this.options.requireLock
          ? { lock: this.isLocked() ? ('locked' as const) : ('pending' as const) }
          : {}),
    }),
    list: () => ({ sessions: [...this.sessions.values()].map((s) => s.info()) }),
    exec: async (_conn, params) => {
      this.assertLocked();
      const { execId } = params;
      if (execId && this.execs.has(execId))
        throw new PtydError('conflict', `exec ${execId} is already running`);
      try {
        const result = await runExec(params, pickBaseEnv(), (cancel) => {
          if (!execId) return;
          if (cancel) this.execs.set(execId, cancel);
          else this.execs.delete(execId);
        });
        this.options.log?.(
          `exec ${params.file} ${params.args.slice(0, 3).join(' ')} -> ${result.timedOut ? 'timeout' : (result.exitCode ?? result.signal)}`,
        );
        return result;
      } catch (error) {
        if (error instanceof ExecCwdError) throw new PtydError('bad_request', error.message);
        throw error;
      }
    },
    execCancel: (_conn, { execId }) => {
      const cancel = this.execs.get(execId);
      if (!cancel) return { cancelled: false };
      this.execs.delete(execId);
      cancel();
      return { cancelled: true };
    },
    detach: (conn, { sessionId }) => {
      conn.attachments.get(sessionId)?.();
      conn.attachments.delete(sessionId);
      return {};
    },
    write: (_conn, { sessionId, data }) => {
      const session = this.get(sessionId);
      if (!session.running) throw new PtydError('conflict', `session ${sessionId} has exited`);
      session.write(data);
      return {};
    },
    resize: (_conn, { sessionId, cols, rows }) => {
      this.get(sessionId).resize(cols, rows);
      return {};
    },
    snapshot: (_conn, { sessionId, scrollback }) => this.get(sessionId).snapshot(scrollback),
    kill: (_conn, { sessionId, signal }) => {
      this.get(sessionId).kill(signal);
      return {};
    },
    remove: (_conn, { sessionId }) => {
      const session = this.get(sessionId);
      for (const conn of this.connections) {
        conn.attachments.get(sessionId)?.();
        conn.attachments.delete(sessionId);
      }
      session.dispose();
      this.sessions.delete(sessionId);
      this.options.log?.(`removed ${sessionId}`);
      return {};
    },
  };

  /**
   * The response is written synchronously inside the subscription callback, before any
   * output event for this session can be sent, so clients always get the snapshot first.
   */
  private async attach(
    conn: Connection,
    id: number,
    { sessionId }: PtydParsedParams<'attach'>,
  ): Promise<void> {
    const session = this.get(sessionId);
    conn.attachments.get(sessionId)?.();
    conn.attachments.delete(sessionId);
    const seq = (conn.attachSeq.get(sessionId) ?? 0) + 1;
    conn.attachSeq.set(sessionId, seq);

    let ready = false;
    const pending: PtydEvent[] = [];
    const emit = (event: PtydEvent) => (ready ? this.send(conn, event) : pending.push(event));

    const { snapshot, unsubscribe } = await session.subscribe({
      onOutput: (data) => emit({ type: 'event', event: 'output', sessionId, data }),
      onExit: (exitCode, signal) => emit({ type: 'event', event: 'exit', sessionId, exitCode, signal }),
    });
    // The client went away, or attached again, while we waited for the snapshot.
    if (conn.socket.destroyed || conn.attachSeq.get(sessionId) !== seq) {
      unsubscribe();
      if (!conn.socket.destroyed) {
        this.send(conn, { type: 'response', id, ok: true, result: { session: session.info(), snapshot } });
      }
      return;
    }
    conn.attachments.set(sessionId, unsubscribe);
    const result: PtydResult<'attach'> = { session: session.info(), snapshot };
    this.send(conn, { type: 'response', id, ok: true, result } satisfies PtydResponse);
    ready = true;
    for (const event of pending) this.send(conn, event);
  }

  private get(sessionId: string): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new PtydError('not_found', `no such session: ${sessionId}`);
    return session;
  }

  private respondError(conn: Connection, id: number, code: PtydErrorCode, message: string): void {
    this.send(conn, { type: 'response', id, ok: false, error: { code, message } } satisfies PtydResponse);
  }

  private send(conn: Connection, message: PtydResponse | PtydEvent): void {
    const { socket } = conn;
    if (socket.destroyed) return;
    socket.write(encodeFrame(message));
    if (socket.writableLength > MAX_BUFFERED_BYTES) {
      this.options.log?.('dropping slow client (output backlog too large)');
      socket.destroy();
    }
  }
}

/** Ensures the socket directory exists and removes a stale socket left by a crashed ptyd. */
async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (!existsSync(socketPath)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (alive) throw new Error(`another ptyd is already listening on ${socketPath}`);
  await unlink(socketPath);
}
