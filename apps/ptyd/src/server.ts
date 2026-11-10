import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  type PtydErrorCode,
  type PtydEvent,
  type PtydMethod,
  type PtydMode,
  type PtydParsedParams,
  type PtydResponse,
  type PtydResult,
  PTYD_PROTOCOL_VERSION,
  PtydRequest,
  ptydMethods,
} from '@emberline/protocol';
import { z } from 'zod';
import { wrapForUser } from './drop.js';
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
  /** `runner` (default): the agents' container. `ops`: core's own commands, out of the agents' reach. */
  mode?: PtydMode;
  /**
   * Runner mode: the user every session and command runs as (the agents'); unset in the dev stack.
   * Ignored in ops mode, which runs everything as itself.
   */
  dropTo?: string;
  /** Runner mode: the service users a `spawn` or `exec` may name as `runAs` (default none). */
  serviceUsers?: string[];
  /**
   * Runner mode: refuse `spawn` and `exec` while ptyd is not {@link PtydServer.secured} (set by the
   * runner's entrypoint). An agent that could reach ptyd's user could run anything as core's commands.
   */
  requireIsolation?: boolean;
  /** Where users are looked up (tests). */
  passwdFile?: string;
  /** Whether a process can be started as `user` ({@link probeDrop}; tests replace it). */
  probeDrop?: (user: string) => boolean;
}

/**
 * Whether ptyd can start a process as `user`, asked once before ptyd calls itself secured: it starts
 * `id -u` exactly as it starts sessions and commands, and the drop works when that prints the user's
 * uid. Anything else (setpriv missing, a capability it needs but ptyd lacks, no such user) is a no.
 */
export function probeDrop(user: string): boolean {
  const uid = lookupUid(user);
  if (uid === undefined) return false;
  const { file, args } = wrapForUser('/usr/bin/id', ['-u'], user);
  const run = spawnSync(file, args, {
    encoding: 'utf8',
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return run.status === 0 && run.stdout.trim() === String(uid);
}

/** The uid of `user` in a passwd file, or undefined when it has none. */
export function lookupUid(user: string, file = '/etc/passwd'): number | undefined {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [name, , uid] = line.split(':');
      if (name === user && uid !== undefined && /^\d+$/.test(uid)) return Number(uid);
    }
  } catch {
    // No passwd file: no such user.
  }
  return undefined;
}

/**
 * The host's Yama `ptrace_scope`, or null without Yama. Where agents run as ptyd's own user (a runner
 * that is not secured), with 0 any of them may attach to ptyd (or write its memory) and run whatever
 * it likes as every command core sends; 1 and up allow tracing only a process's own descendants, and
 * ptyd is no agent's.
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
  private readonly mode: PtydMode;
  private readonly serviceUsers: ReadonlySet<string>;
  /** Whom sessions and commands run as unless they name a service user: runner mode only. */
  private readonly dropTo: string | undefined;
  /** The probe's answer, asked once: whether a user can be dropped to does not change. */
  private dropWorks?: boolean;

  constructor(private readonly options: PtydServerOptions) {
    this.ptraceScope = readPtraceScope(options.ptraceScopeFile);
    this.mode = options.mode ?? 'runner';
    this.serviceUsers = new Set(options.serviceUsers ?? []);
    this.dropTo = this.mode === 'runner' ? options.dropTo : undefined;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  /** Agents cannot reach this ptyd ({@link isolationProblem} has nothing to say). */
  get secured(): boolean {
    return this.isolationProblem() === null;
  }

  /**
   * Why agents could reach this ptyd, or null when they cannot. An `ops` ptyd runs where agents have
   * no process. A runner ptyd must run as a user of its own and start everything as the agents' user
   * (`dropTo`), with its socket in a directory it owns and nobody else may write, so no agent can put
   * a listener in the socket's place. Read on every ask: the directory is checked as it is now.
   */
  isolationProblem(): string | null {
    if (this.mode === 'ops') return null;
    const { dropTo } = this;
    if (!dropTo) return 'it has no user to start sessions as (EMBERLINE_PTYD_DROP_TO)';
    const target = lookupUid(dropTo, this.options.passwdFile);
    if (target === undefined) return `the user ${dropTo} does not exist`;
    const own = process.getuid?.();
    if (own === undefined || own === target) return `it runs as ${dropTo} itself`;
    const dir = path.dirname(this.options.socketPath);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.uid !== own || (st.mode & 0o022) !== 0)
        return `its socket's directory ${dir} is not its own, or others may write it`;
    } catch {
      return `its socket's directory ${dir} does not exist`;
    }
    this.dropWorks ??= (this.options.probeDrop ?? probeDrop)(dropTo);
    if (!this.dropWorks) return `it cannot start processes as ${dropTo}`;
    return null;
  }

  /**
   * Before a `spawn` or `exec`: refused in a runner that must be isolated and is not, or for a `runAs`
   * that is not one of the runner's service users.
   */
  private assertMayStart(runAs: string | undefined): void {
    if (this.mode === 'runner' && this.options.requireIsolation) {
      const problem = this.isolationProblem();
      if (problem) throw new PtydError('not_isolated', `the runner starts nothing: ${problem}`);
    }
    if (runAs === undefined) return;
    if (this.mode === 'ops') throw new PtydError('bad_request', 'runAs is for the runner only');
    if (!this.serviceUsers.has(runAs))
      throw new PtydError('bad_request', `runAs ${runAs} is not a service user of this runner`);
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
    this.options.log?.(`ptyd listening on ${socketPath} (${this.mode} mode)`);
    if (this.mode === 'ops' && this.options.dropTo)
      this.options.log?.(
        `ignoring the user to drop to (${this.options.dropTo}): ops runs everything as itself`,
      );
    const problem = this.isolationProblem();
    if (problem)
      this.options.log?.(
        `not isolated from the agents: ${problem}${this.options.requireIsolation ? '; refusing to start sessions and commands' : ''}`,
      );
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
      this.assertMayStart(params.runAs);
      const id = params.id ?? randomUUID();
      if (this.sessions.has(id)) throw new PtydError('conflict', `session ${id} already exists`);
      if (!existsSync(params.cwd) || !statSync(params.cwd).isDirectory()) {
        throw new PtydError('bad_request', `cwd does not exist: ${params.cwd}`);
      }
      // `meta.noLog`: keep no on-disk log of this session (an import clone may show a token a server
      // echoes). The live terminal still streams; nothing is written to the log directory.
      const config = params.meta.noLog ? { ...this.options, logDir: undefined } : this.options;
      const session = new PtySession(id, params, config, params.runAs ?? this.dropTo);
      this.sessions.set(id, session);
      this.options.log?.(`spawned ${id} (pid ${session.info().pid}): ${params.file}`);
      return session.info();
    },
    hello: () => ({
      protocolVersion: PTYD_PROTOCOL_VERSION,
      ptraceScope: this.ptraceScope,
      mode: this.mode,
      secured: this.secured,
    }),
    list: () => ({ sessions: [...this.sessions.values()].map((s) => s.info()) }),
    exec: async (_conn, params) => {
      this.assertMayStart(params.runAs);
      const { execId } = params;
      if (execId && this.execs.has(execId))
        throw new PtydError('conflict', `exec ${execId} is already running`);
      try {
        const result = await runExec(
          params,
          pickBaseEnv(),
          (cancel) => {
            if (!execId) return;
            if (cancel) this.execs.set(execId, cancel);
            else this.execs.delete(execId);
          },
          params.runAs ?? this.dropTo,
        );
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
