import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { AgentState } from '@emberline/adapter-sdk';
import { buildLaunchSpec, CLAUDE_ADAPTER_ID, nextStateFromHook, stateAfterExit } from '@emberline/adapter-claude';
import {
  type CreateRunBody,
  CreateRunBody as CreateRunBodySchema,
  type HookEnvelope,
  type Run,
  type RunDetail,
  type RunEvent,
  type RunState,
} from '@emberline/protocol';
import { asc, desc, eq, isNull } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { projects, runEvents, runs } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import { prepareWorkspace } from './git.js';

type RunRow = typeof runs.$inferSelect;
type EventSource = RunEvent['source'];

interface RunServiceEvents {
  run: [run: Run];
  removed: [id: string];
}

const RECONCILE_INTERVAL_MS = 3_000;
const MAX_EVENTS_IN_DETAIL = 200;
/** Hook payload fields worth keeping; tool inputs/outputs can be huge and are dropped. */
const PAYLOAD_KEYS = ['session_id', 'tool_name', 'notification_type', 'message', 'source', 'reason', 'prompt'];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const toRun = (row: RunRow): Run => ({
  id: row.id,
  projectId: row.projectId,
  agent: row.agent,
  state: row.state as RunState,
  prompt: row.prompt,
  permissionMode: row.permissionMode as Run['permissionMode'],
  branch: row.branch,
  worktreePath: row.worktreePath,
  terminalId: row.ptydSessionId,
  agentSessionId: row.agentSessionId,
  lastEvent: row.lastEvent,
  stateChangedAt: row.stateChangedAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
});

function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    const value = payload[key];
    if (typeof value === 'string') summary[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  return summary;
}

/**
 * Owns the run lifecycle: worktree + agent spawn, hook ingestion (the primary state signal),
 * and reconciliation with ptyd (process exits, runner restarts).
 */
export class RunService extends EventEmitter<RunServiceEvents> {
  private timer?: NodeJS.Timeout;
  private reconciling = false;

  constructor(
    private readonly db: Db,
    private readonly config: CoreConfig,
    private readonly ptyd: PtydBridge,
  ) {
    super();
  }

  /** Starts periodic reconciliation with ptyd. */
  startReconciler(): void {
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  list(): Run[] {
    return this.db.select().from(runs).orderBy(desc(runs.createdAt)).all().map(toRun);
  }

  get(id: string): RunDetail {
    const row = this.row(id);
    const events = this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(desc(runEvents.id))
      .limit(MAX_EVENTS_IN_DETAIL)
      .all()
      .reverse()
      .map(
        (e): RunEvent => ({
          id: e.id,
          runId: e.runId,
          ts: e.ts.toISOString(),
          source: e.source as EventSource,
          type: e.type,
          state: (e.state as RunState | null) ?? null,
          payload: e.payload ?? null,
        }),
      );
    return { ...toRun(row), events };
  }

  async create(input: CreateRunBody): Promise<Run> {
    const body = CreateRunBodySchema.parse(input);
    const project = this.db.select().from(projects).where(eq(projects.id, body.projectId)).get();
    if (!project) throw notFound('no such project');
    const ptyd = this.ptyd.get(); // fail fast (503) before touching git

    const id = randomUUID();
    const short = id.slice(0, 8);
    const workspace = await prepareWorkspace(
      project.path,
      path.join(this.config.workspacesDir, '.worktrees', project.slug, short),
      `emberline/run-${short}`,
    );

    const hookToken = randomBytes(32).toString('base64url');
    const now = new Date();
    this.db
      .insert(runs)
      .values({
        id,
        projectId: project.id,
        agent: CLAUDE_ADAPTER_ID,
        state: 'starting',
        prompt: body.prompt,
        permissionMode: body.permissionMode,
        branch: workspace.branch,
        worktreePath: workspace.path,
        hookTokenHash: sha256(hookToken),
        stateChangedAt: now,
        createdAt: now,
      })
      .run();

    const spec = buildLaunchSpec({
      runId: id,
      hookToken,
      coreUrl: this.config.hookUrl,
      claudeCommand: this.config.claudeCommand,
      hookCommand: this.config.hookCommand,
      permissionMode: body.permissionMode,
      prompt: body.prompt || undefined,
    });

    try {
      const session = await ptyd.spawn({
        file: spec.file,
        args: spec.args,
        cwd: workspace.path,
        env: spec.env,
        meta: { kind: 'agent', runId: id, projectId: project.id, title: `Claude · ${project.name}` },
      });
      return this.record(id, { source: 'system', type: 'spawned', patch: { ptydSessionId: session.id } });
    } catch (error) {
      this.record(id, {
        source: 'system',
        type: 'spawn_failed',
        state: 'failed',
        payload: { message: (error as Error).message },
        patch: { endedAt: new Date() },
      });
      throw error;
    }
  }

  /** Applies a hook forwarded by `emberline-hook`. The per-run token is the only credential. */
  ingestHook(envelope: HookEnvelope, token: string | undefined): Run {
    const row = this.db.select().from(runs).where(eq(runs.id, envelope.runId)).get();
    if (!row || !token || !tokenMatches(token, row.hookTokenHash)) {
      throw new HttpError(401, 'unauthorized', 'invalid hook token');
    }
    const payload = envelope.payload as Record<string, unknown>;
    const patch: Partial<RunRow> = {};
    if (typeof payload.session_id === 'string' && payload.session_id !== row.agentSessionId) {
      patch.agentSessionId = payload.session_id;
    }
    if (typeof payload.transcript_path === 'string' && payload.transcript_path !== row.transcriptPath) {
      patch.transcriptPath = payload.transcript_path;
    }
    return this.record(row.id, {
      source: 'hook',
      type: envelope.event,
      state: nextStateFromHook(row.state as AgentState, envelope.event, envelope.payload),
      payload: summarizePayload(payload),
      patch,
    });
  }

  /** Terminates the agent process; reconciliation then records the final state. */
  async stop(id: string): Promise<Run> {
    const row = this.row(id);
    if (row.ptydSessionId && !row.endedAt) {
      await this.ptyd
        .get()
        .kill(row.ptydSessionId)
        .catch(() => {
          // Already exited; reconcile will notice.
        });
    }
    const run = this.record(id, { source: 'user', type: 'stop_requested' });
    void this.reconcile();
    return run;
  }

  /** Forgets the run and its terminal. The worktree and branch are kept on purpose. */
  async remove(id: string): Promise<void> {
    const row = this.row(id);
    if (row.ptydSessionId) {
      await this.ptyd
        .get()
        .remove(row.ptydSessionId)
        .catch((error: { code?: string }) => {
          if (error.code !== 'not_found') throw error;
        });
    }
    this.db.delete(runs).where(eq(runs.id, id)).run();
    this.emit('removed', id);
  }

  /** Records process exits and sessions that vanished (runner restart) for unfinished runs. */
  async reconcile(): Promise<void> {
    if (this.reconciling || this.ptyd.status !== 'connected') return;
    this.reconciling = true;
    try {
      const open = this.db.select().from(runs).where(isNull(runs.endedAt)).orderBy(asc(runs.createdAt)).all();
      if (open.length === 0) return;
      const { sessions } = await this.ptyd.get().list();
      const byId = new Map(sessions.map((s) => [s.id, s]));
      for (const row of open) {
        if (!row.ptydSessionId) continue; // still spawning
        const session = byId.get(row.ptydSessionId);
        if (session?.status === 'running') continue;
        const exitCode = session ? session.exitCode : null;
        this.record(row.id, {
          source: 'system',
          type: session ? 'process_exited' : 'session_lost',
          state: stateAfterExit(row.state as AgentState, exitCode),
          payload: session ? { exitCode, signal: session.signal } : {},
          patch: { endedAt: new Date() },
        });
      }
    } catch {
      // ptyd went away mid-call; next tick retries.
    } finally {
      this.reconciling = false;
    }
  }

  private row(id: string): RunRow {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) throw notFound('no such run');
    return row;
  }

  /** Appends an event, applies the state change + patch atomically, and broadcasts the run. */
  private record(
    id: string,
    event: { source: EventSource; type: string; state?: AgentState; payload?: unknown; patch?: Partial<RunRow> },
  ): Run {
    const now = new Date();
    const updated = this.db.transaction((tx) => {
      const current = tx.select().from(runs).where(eq(runs.id, id)).get();
      if (!current) throw notFound('no such run');
      const changed = event.state !== undefined && event.state !== current.state;
      tx.insert(runEvents)
        .values({
          runId: id,
          ts: now,
          source: event.source,
          type: event.type,
          state: changed ? event.state : null,
          payload: event.payload ?? null,
        })
        .run();
      const set: Partial<RunRow> = { ...event.patch, lastEvent: event.type };
      if (changed) Object.assign(set, { state: event.state, stateChangedAt: now });
      return tx.update(runs).set(set).where(eq(runs.id, id)).returning().get();
    });
    const run = toRun(updated);
    this.emit('run', run);
    return run;
  }
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
