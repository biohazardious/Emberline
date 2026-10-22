import {
  CreateTerminalBody,
  type SessionInfo,
  TerminalClientMessage,
  type TerminalInfo,
  TerminalKind,
  type TerminalServerMessage,
} from '@emberline/protocol';
import type { PtydClient } from '@emberline/ptyd/client';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { projects } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { CoreDeps } from '../server.js';
import { PRE_READY_CAP, sendBounded, TERMINAL_SEND_CAP } from './ws-send.js';

export const toTerminal = (s: SessionInfo): TerminalInfo => ({
  id: s.id,
  title: s.meta.title ?? [s.file, ...s.args].join(' '),
  kind: TerminalKind.safeParse(s.meta.kind).data ?? 'shell',
  projectId: s.meta.projectId ?? null,
  runId: s.meta.runId ?? null,
  status: s.status,
  exitCode: s.exitCode,
  createdAt: s.createdAt,
});

const COMMANDS = {
  shell: { file: '/bin/bash', args: ['-l'], label: 'Shell' },
  claude: { file: 'claude', args: [], label: 'Claude' },
} as const;

export function registerTerminalRoutes(app: FastifyInstance, { db, config, ptyd }: CoreDeps): void {
  app.get('/api/terminals', async (): Promise<TerminalInfo[]> => {
    const { sessions } = await ptyd.get().list();
    return sessions.map(toTerminal).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.post('/api/terminals', async (request, reply): Promise<TerminalInfo> => {
    const body = CreateTerminalBody.parse(request.body ?? {});
    let cwd = config.workspacesDir;
    let scope = 'workspaces';
    if (body.projectId) {
      const project = db.select().from(projects).where(eq(projects.id, body.projectId)).get();
      if (!project) throw notFound('no such project');
      cwd = project.path;
      scope = project.name;
    }
    const command = COMMANDS[body.kind];
    const session = await ptyd.get().spawn({
      file: command.file,
      args: [...command.args],
      cwd,
      meta: {
        kind: body.kind,
        title: `${command.label} · ${scope}`,
        ...(body.projectId ? { projectId: body.projectId } : {}),
      },
    });
    reply.code(201);
    return toTerminal(session);
  });

  app.delete<{ Params: { id: string } }>('/api/terminals/:id', async (request) => {
    await ptyd.get().remove(request.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/terminals/:id/ws', { websocket: true }, (socket, request) => {
    attachTerminal(socket, request.params.id, ptyd, (message) => request.log.warn(message));
  });
}

/**
 * Pipes one browser WebSocket to one ptyd viewer connection.
 *
 * Listeners are attached synchronously (messages arriving during the async attach are queued),
 * and output that ptyd delivers right behind the attach response is held back until the
 * snapshot has been sent, so the browser always sees: snapshot, then output.
 */
export function attachTerminal(
  socket: WebSocket,
  sessionId: string,
  ptyd: CoreDeps['ptyd'],
  warn: (m: string) => void,
) {
  let viewer: PtydClient | undefined;
  let closed = false;
  let ready = false;
  const queuedInput: TerminalClientMessage[] = [];
  const heldOutput: TerminalServerMessage[] = [];
  let heldBytes = 0;

  const send = (message: TerminalServerMessage) => sendBounded(socket, message, TERMINAL_SEND_CAP);
  // Holding is capped rather than trimmed: a trimmed stream would corrupt the screen, so past the
  // cap the socket is closed and the browser reconnects to a fresh snapshot.
  const overflow = () => {
    heldOutput.length = 0;
    queuedInput.length = 0;
    socket.close(1013, 'attach too slow');
  };
  const emit = (message: TerminalServerMessage) => {
    if (ready) return void send(message);
    if (closed) return;
    heldBytes += message.type === 'output' ? message.data.length : 64;
    if (heldBytes > PRE_READY_CAP) overflow();
    else heldOutput.push(message);
  };
  const apply = (message: TerminalClientMessage) => {
    if (!viewer) return;
    const op =
      message.type === 'input'
        ? viewer.write(sessionId, message.data)
        : viewer.resize(sessionId, message.cols, message.rows);
    op.catch(() => {
      // Session exited or was removed; the exit event / close tells the browser.
    });
  };

  socket.on('message', (raw) => {
    let parsed: TerminalClientMessage;
    try {
      parsed = TerminalClientMessage.parse(JSON.parse(String(raw)));
    } catch {
      return;
    }
    if (ready) return apply(parsed);
    if (closed) return;
    heldBytes += parsed.type === 'input' ? parsed.data.length : 64;
    if (heldBytes > PRE_READY_CAP) overflow();
    else queuedInput.push(parsed);
  });
  socket.on('close', () => {
    closed = true;
    viewer?.close();
  });

  void (async () => {
    try {
      viewer = await ptyd.openViewer();
      viewer.on('output', (id, data) => id === sessionId && emit({ type: 'output', data }));
      viewer.on(
        'exit',
        (id, exitCode, signal) => id === sessionId && emit({ type: 'exit', exitCode, signal }),
      );
      viewer.on('close', () => !closed && socket.close(1011, 'runner disconnected'));

      const { session, snapshot } = await viewer.attach(sessionId);
      if (closed) {
        viewer.close();
        return;
      }
      send({
        type: 'snapshot',
        data: snapshot.data,
        cols: snapshot.cols,
        rows: snapshot.rows,
        status: session.status,
      });
      ready = true;
      for (const message of heldOutput.splice(0)) send(message);
      for (const message of queuedInput.splice(0)) apply(message);
    } catch (error) {
      const message = (error as Error).message;
      warn(`terminal ${sessionId}: ${message}`);
      send({ type: 'error', message });
      socket.close(1011, 'attach failed');
      viewer?.close();
    }
  })();
}
