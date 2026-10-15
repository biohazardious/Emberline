import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
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
  private readonly connections = new Set<Connection>();
  private server?: net.Server;

  constructor(private readonly options: PtydServerOptions) {}

  get socketPath(): string {
    return this.options.socketPath;
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
      const id = params.id ?? randomUUID();
      if (this.sessions.has(id)) throw new PtydError('conflict', `session ${id} already exists`);
      if (!existsSync(params.cwd) || !statSync(params.cwd).isDirectory()) {
        throw new PtydError('bad_request', `cwd does not exist: ${params.cwd}`);
      }
      const session = new PtySession(id, params, this.options);
      this.sessions.set(id, session);
      this.options.log?.(`spawned ${id} (pid ${session.info().pid}): ${params.file}`);
      return session.info();
    },
    hello: () => ({ protocolVersion: PTYD_PROTOCOL_VERSION }),
    list: () => ({ sessions: [...this.sessions.values()].map((s) => s.info()) }),
    exec: async (_conn, params) => {
      try {
        const result = await runExec(params, pickBaseEnv());
        this.options.log?.(
          `exec ${params.file} ${params.args.slice(0, 3).join(' ')} -> ${result.timedOut ? 'timeout' : (result.exitCode ?? result.signal)}`,
        );
        return result;
      } catch (error) {
        if (error instanceof ExecCwdError) throw new PtydError('bad_request', error.message);
        throw error;
      }
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
  private async attach(conn: Connection, id: number, { sessionId }: PtydParsedParams<'attach'>): Promise<void> {
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
