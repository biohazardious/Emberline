import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentState } from '@emberline/adapter-sdk';
import {
  buildLaunchSpec,
  buildSecondaryCliLaunchSpec,
  CLAUDE_ADAPTER_ID,
  CONTINUE_PROMPT,
  decoratePromptWithPersona,
  nextStateFromHook,
  PERSONA_CATALOG,
  type RateLimitInfo,
  rateLimitFromHook,
  stateAfterExit,
} from '@emberline/adapter-claude';
import {
  type AgentPersona,
  type CreateRunBody,
  CreateRunBody as CreateRunBodySchema,
  type DiffScope,
  type GitCommitBody,
  type GitCommitResponse,
  type GitPushResponse,
  type GitStageBody,
  type HookEnvelope,
  type PruneWorktreeResponse,
  type Run,
  type RunArtifact,
  type RunDetail,
  type RunDiffSummary,
  type RunEvent,
  type RunFileDiff,
  type RunPreviewStatus,
  type RunState,
  type StartPreviewBody,
  StartPreviewBody as StartPreviewBodySchema,
} from '@emberline/protocol';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { projects, runEvents, runs } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import { getProviderEnvFromSettings, resolveAgentForPersona } from '../factory/service.js';
import {
  commitWorktree,
  inspectDiff,
  inspectFileDiff,
  listWorktreeArtifacts,
  prepareWorkspace,
  pruneWorktree,
  pushWorktreeBranch,
  readWorktreeArtifact,
  stageWorktreeFiles,
} from './git.js';

type RunRow = typeof runs.$inferSelect;
type EventSource = RunEvent['source'];

interface RunServiceEvents {
  /** `stateChanged` is true when this update moved the run to a new state. */
  run: [run: Run, stateChanged: boolean];
  removed: [id: string];
  /** A hook put the run into `rate_limited`; `info` is what the hook revealed about the limit. */
  rateLimited: [run: Run, info: RateLimitInfo | undefined];
}

/** Extra context when a run is started for a ticket. */
export interface RunOrigin {
  ticketId: string;
  /** Branch name to use (made unique if taken). */
  branch: string;
  title: string;
}

/** Delay between pasting a prompt and pressing Enter, so the TUI has consumed the paste. */
const SUBMIT_DELAY_MS = 150;

const RECONCILE_INTERVAL_MS = 3_000;
const MAX_EVENTS_IN_DETAIL = 200;
/** Hook payload fields worth keeping; tool inputs/outputs can be huge and are dropped. */
const PAYLOAD_KEYS = [
  'session_id',
  'tool_name',
  'notification_type',
  'message',
  'source',
  'reason',
  'prompt',
  'error',
  'error_details',
  'last_assistant_message',
];

/** Scrollback lines read when looking for a limit banner on screen. */
const SCREEN_SCROLLBACK = 200;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const toRun = (row: RunRow): Run => ({
  id: row.id,
  projectId: row.projectId,
  ticketId: row.ticketId,
  title: row.title,
  agent: row.agent,
  persona: (row.persona as AgentPersona) ?? 'coder',
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
  resumable: row.endedAt !== null && row.agentSessionId !== null,
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
    this.setMaxListeners(0); // one listener per open UI socket
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

  /** Plain run (no slot/quota checks); `queued` until {@link launch}. The scheduler owns dispatch. */
  getRun(id: string): Run {
    return toRun(this.row(id));
  }

  /**
   * Prepares the worktree and records the run as `queued`. Nothing is spawned yet; the
   * scheduler calls {@link launch} once a slot and quota are available.
   */
  async enqueue(input: CreateRunBody, origin?: RunOrigin): Promise<Run> {
    const body = CreateRunBodySchema.parse(input);
    const project = this.db.select().from(projects).where(eq(projects.id, body.projectId)).get();
    if (!project) throw notFound('no such project');
    this.ptyd.get(); // fail fast (503) before touching git

    const id = randomUUID();
    const short = id.slice(0, 8);
    const workspace = await prepareWorkspace(
      project.path,
      path.join(this.config.workspacesDir, '.worktrees', project.slug, short),
      origin?.branch ?? `emberline/run-${short}`,
    );

    const persona = body.persona ?? 'coder';
    const resolvedAgent = input.agent ?? resolveAgentForPersona(this.db, persona) ?? CLAUDE_ADAPTER_ID;
    const now = new Date();
    this.db
      .insert(runs)
      .values({
        id,
        projectId: project.id,
        ticketId: origin?.ticketId ?? null,
        agent: resolvedAgent,
        persona,
        state: 'queued',
        prompt: body.prompt,
        permissionMode: body.permissionMode,
        branch: workspace.branch,
        worktreePath: workspace.path,
        title: origin?.title ?? null,
        // Replaced with the real token's hash at launch; nothing can authenticate before that.
        hookTokenHash: sha256(randomBytes(32).toString('base64url')),
        stateChangedAt: now,
        createdAt: now,
      })
      .run();
    return this.record(id, { source: 'system', type: 'queued', state: 'queued' });
  }

  /** Spawns a queued run's agent with its initial prompt. */
  async launch(id: string): Promise<Run> {
    const row = this.row(id);
    if (row.state !== 'queued') throw conflict(`run is ${row.state}, not queued`);
    return this.spawnAgent(row, { prompt: row.prompt || undefined, type: 'spawned' });
  }

  /**
   * Continues a run after a limit reset (or on the user's request): types `text` into the live
   * session, or respawns `claude --resume <session>` in the same worktree when the process is
   * gone. The run counts as `starting` until the agent's next hook arrives.
   */
  async resume(id: string, text: string = CONTINUE_PROMPT): Promise<Run> {
    const row = this.row(id);
    if (row.state === 'queued') return this.launch(id);
    if (row.ptydSessionId && !row.endedAt) {
      await this.typePrompt(row.ptydSessionId, text);
      return this.record(id, { source: 'system', type: 'resumed', state: 'starting', payload: { live: true } });
    }
    if (!row.agentSessionId) {
      this.record(id, { source: 'system', type: 'resume_failed', state: 'failed', payload: { reason: 'no session' } });
      throw conflict('this run has no agent session to resume; start a new run');
    }
    const previous = row.ptydSessionId;
    const run = await this.spawnAgent(row, { prompt: text, resumeSessionId: row.agentSessionId, type: 'resumed' });
    if (previous) {
      // The exited terminal is superseded by the new one.
      await this.ptyd
        .get()
        .remove(previous)
        .catch(() => undefined);
    }
    return run;
  }

  /** Visible screen + recent scrollback of a run's terminal (serialized ANSI), if it has one. */
  async screen(id: string): Promise<string | undefined> {
    const row = this.row(id);
    if (!row.ptydSessionId || this.ptyd.status !== 'connected') return undefined;
    try {
      return (await this.ptyd.get().snapshot(row.ptydSessionId, SCREEN_SCROLLBACK)).data;
    } catch {
      return undefined;
    }
  }

  private async spawnAgent(
    row: RunRow,
    options: { prompt?: string; resumeSessionId?: string; type: 'spawned' | 'resumed' },
  ): Promise<Run> {
    const project = this.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project) throw notFound('no such project');
    const ptyd = this.ptyd.get();
    const hookToken = randomBytes(32).toString('base64url');
    // Mark as starting first so concurrent ticks never launch the same run twice.
    this.record(row.id, {
      source: 'system',
      type: options.type === 'spawned' ? 'launching' : 'respawning',
      state: 'starting',
      patch: { hookTokenHash: sha256(hookToken), endedAt: null },
    });

    const persona = (row.persona as AgentPersona) ?? 'coder';
    const effectivePrompt =
      options.type === 'spawned' ? decoratePromptWithPersona(options.prompt, persona) : options.prompt;

    const extraEnv = getProviderEnvFromSettings(this.db);
    const isSecondary = row.agent === 'gemini' || row.agent === 'codex' || row.agent === 'aider';
    const spec = isSecondary
      ? buildSecondaryCliLaunchSpec({
          agent: row.agent as 'gemini' | 'codex' | 'aider',
          runId: row.id,
          hookToken,
          coreUrl: this.config.hookUrl,
          hookCommand: this.config.hookCommand,
          permissionMode: row.permissionMode as Run['permissionMode'],
          prompt: effectivePrompt,
          extraEnv,
        })
      : buildLaunchSpec({
          runId: row.id,
          hookToken,
          coreUrl: this.config.hookUrl,
          claudeCommand: this.config.claudeCommand,
          hookCommand: this.config.hookCommand,
          permissionMode: row.permissionMode as Run['permissionMode'],
          prompt: effectivePrompt,
          resumeSessionId: options.resumeSessionId,
          playwrightMcp:
            process.env.EMBERLINE_PLAYWRIGHT_MCP === '1' || process.env.EMBERLINE_PLAYWRIGHT_MCP === 'true',
        });

    const agentLabel =
      row.agent === 'gemini'
        ? 'Gemini'
        : row.agent === 'codex'
          ? 'Codex'
          : row.agent === 'aider'
            ? 'Aider'
            : 'Claude';
    const personaPrefix =
      persona !== 'coder' && PERSONA_CATALOG[persona] ? `[${PERSONA_CATALOG[persona].shortLabel}] ` : '';
    try {
      const session = await ptyd.spawn({
        file: spec.file,
        args: spec.args,
        cwd: row.worktreePath,
        env: { ...spec.env, ...extraEnv },
        meta: {
          kind: 'agent',
          runId: row.id,
          projectId: row.projectId,
          title: `${personaPrefix}${agentLabel} · ${row.title ?? project.name}`,
        },
      });
      return this.record(row.id, {
        source: 'system',
        type: options.type,
        payload: options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : undefined,
        patch: { ptydSessionId: session.id },
      });
    } catch (error) {
      this.record(row.id, {
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
    const next = nextStateFromHook(row.state as AgentState, envelope.event, envelope.payload);
    const run = this.record(row.id, {
      source: 'hook',
      type: envelope.event,
      state: next,
      payload: summarizePayload(payload),
      patch,
    });
    if (next === 'rate_limited') {
      this.emit('rateLimited', run, rateLimitFromHook(envelope.event, envelope.payload, new Date(), this.config.timeZone));
    }
    return run;
  }

  /** Terminates the agent process (or cancels a queued run); reconciliation records the end. */
  async stop(id: string): Promise<Run> {
    const row = this.row(id);
    if (row.state === 'queued') {
      return this.record(id, { source: 'user', type: 'cancelled', state: 'failed', patch: { endedAt: new Date() } });
    }
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

  /** The newest run of a ticket whose agent process is still alive, if any. */
  activeRunForTicket(ticketId: string): Run | undefined {
    const row = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.ticketId, ticketId), isNull(runs.endedAt)))
      .orderBy(desc(runs.createdAt))
      .get();
    return row ? toRun(row) : undefined;
  }

  latestRunForTicket(ticketId: string): Run | undefined {
    const row = this.db.select().from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.createdAt)).get();
    return row ? toRun(row) : undefined;
  }

  /**
   * Types a follow-up prompt into the live agent session and submits it. Multi-line text is
   * sent as a bracketed paste so embedded newlines don't submit early. The resulting
   * `UserPromptSubmit` hook moves the run back to `working`.
   */
  async sendPrompt(id: string, text: string): Promise<Run> {
    const row = this.row(id);
    if (!row.ptydSessionId || row.endedAt) throw conflict('the agent session has ended; start a new run');
    await this.typePrompt(row.ptydSessionId, text);
    return this.record(id, { source: 'user', type: 'prompt_sent', payload: { length: text.length } });
  }

  /**
   * Sends a follow-up prompt to a run: types into the live PTY when running, or respawns
   * `claude --resume` when the process has ended.
   */
  async prompt(id: string, text: string): Promise<Run> {
    const row = this.row(id);
    if (row.state === 'queued') throw conflict('the agent has not started yet; it is queued');
    if (row.ptydSessionId && !row.endedAt) return this.sendPrompt(id, text);
    if (!row.agentSessionId) throw conflict('no agent session to continue; start a new run');
    return this.resume(id, text);
  }

  private async typePrompt(sessionId: string, text: string): Promise<void> {
    const ptyd = this.ptyd.get();
    const input = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    await ptyd.write(sessionId, input);
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    await ptyd.write(sessionId, '\r');
  }

  private defaultBranch(projectId: string): string {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return project?.defaultBranch ?? 'main';
  }

  async diff(id: string, scope: DiffScope = 'branch'): Promise<RunDiffSummary> {
    const row = this.row(id);
    return inspectDiff(row.worktreePath, this.defaultBranch(row.projectId), scope, row.id, row.branch);
  }

  async fileDiff(id: string, relPath: string, scope: DiffScope = 'branch'): Promise<RunFileDiff> {
    const row = this.row(id);
    return inspectFileDiff(row.worktreePath, this.defaultBranch(row.projectId), scope, relPath);
  }

  async stage(id: string, body: GitStageBody): Promise<RunDiffSummary> {
    const row = this.row(id);
    await stageWorktreeFiles(row.worktreePath, body);
    return this.diff(id, 'branch');
  }

  async commit(id: string, body: GitCommitBody): Promise<GitCommitResponse> {
    const row = this.row(id);
    const res = await commitWorktree(row.worktreePath, row.branch, body);
    this.record(id, {
      source: 'user',
      type: 'committed',
      payload: { sha: res.sha, message: body.message.slice(0, 200) },
    });
    return res;
  }

  async push(id: string): Promise<GitPushResponse> {
    const row = this.row(id);
    const res = await pushWorktreeBranch(row.worktreePath, row.branch, this.defaultBranch(row.projectId));
    this.record(id, {
      source: 'user',
      type: 'pushed',
      payload: { branch: res.branch, remote: res.remote },
    });
    return res;
  }

  async artifacts(id: string): Promise<RunArtifact[]> {
    const row = this.row(id);
    return listWorktreeArtifacts(row.worktreePath, this.defaultBranch(row.projectId));
  }

  async readArtifact(
    id: string,
    relPath: string,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const row = this.row(id);
    return readWorktreeArtifact(row.worktreePath, relPath);
  }

  /**
   * Prunes the linked git worktree (`/workspaces/.worktrees/...`) for an ended run, keeping
   * the run record and git branch intact. Active runs must be stopped first.
   */
  async pruneWorktree(id: string): Promise<PruneWorktreeResponse> {
    let row = this.row(id);
    if (!row.endedAt) {
      await this.reconcile();
      row = this.row(id);
    }
    if (!row.endedAt && row.state !== 'done' && row.state !== 'failed') {
      throw conflict('stop the active run before pruning its worktree');
    }
    const project = this.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project) throw notFound('no such project');
    const removed = await pruneWorktree(project.path, row.worktreePath);
    if (removed) {
      this.record(id, {
        source: 'user',
        type: 'worktree_pruned',
        payload: { worktreePath: row.worktreePath },
      });
    }
    return { runId: id, worktreePath: row.worktreePath, removed };
  }

  private detectPreviewCommand(worktreePath: string): string | null {
    const pkgFile = path.join(worktreePath, 'package.json');
    if (!existsSync(pkgFile)) return null;
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const hasPnpmLock = existsSync(path.join(worktreePath, 'pnpm-lock.yaml'));
      const runner = hasPnpmLock ? 'pnpm' : 'npm run';
      if (pkg.scripts?.dev) return `${runner} dev`;
      if (pkg.scripts?.start) return `${runner} start`;
      if (pkg.scripts?.preview) return `${runner} preview`;
    } catch {
      // ignore invalid package.json
    }
    return null;
  }

  private defaultPreviewPort(runId: string): number {
    let hash = 0;
    for (let i = 0; i < runId.length; i++) {
      hash = (hash * 31 + runId.charCodeAt(i)) >>> 0;
    }
    return 3100 + (hash % 800);
  }

  async previewStatus(id: string): Promise<RunPreviewStatus> {
    const row = this.row(id);
    const detectedCommand = this.detectPreviewCommand(row.worktreePath);
    const events = this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(desc(runEvents.id))
      .all();
    const lastPreview = events.find((e) => e.type === 'preview_started' || e.type === 'preview_stopped');
    if (!lastPreview || lastPreview.type === 'preview_stopped' || typeof lastPreview.payload !== 'object' || !lastPreview.payload) {
      return {
        runId: id,
        status: 'stopped',
        terminalId: null,
        command: null,
        port: null,
        url: null,
        detectedCommand,
      };
    }

    const p = lastPreview.payload as { terminalId?: string; command?: string; port?: number; url?: string };
    const terminalId = typeof p.terminalId === 'string' ? p.terminalId : null;
    const command = typeof p.command === 'string' ? p.command : null;
    const port = typeof p.port === 'number' ? p.port : null;
    const url = typeof p.url === 'string' ? p.url : port ? `http://localhost:${port}` : null;

    let status: RunPreviewStatus['status'] = 'exited';
    if (terminalId && this.ptyd.status === 'connected') {
      try {
        const { sessions } = await this.ptyd.get().list();
        const found = sessions.find((s) => s.id === terminalId);
        if (found?.status === 'running') status = 'running';
      } catch {
        // fallback to exited
      }
    }

    return {
      runId: id,
      status,
      terminalId,
      command,
      port,
      url,
      detectedCommand,
    };
  }

  async startPreview(id: string, rawBody: unknown): Promise<RunPreviewStatus> {
    const row = this.row(id);
    if (!existsSync(row.worktreePath)) {
      throw conflict('worktree directory does not exist (was it pruned?)');
    }
    const parsed = StartPreviewBodySchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body: StartPreviewBody = parsed.data;

    // Stop any existing preview session first
    const current = await this.previewStatus(id);
    if (current.terminalId) {
      await this.ptyd
        .get()
        .remove(current.terminalId)
        .catch(() => undefined);
    }

    const detectedCommand = this.detectPreviewCommand(row.worktreePath);
    const command = body.command?.trim() || detectedCommand || 'npm run dev';
    const port = body.port ?? this.defaultPreviewPort(id);
    const hostBase = process.env.EMBERLINE_PREVIEW_HOST?.trim() || 'http://localhost';
    const url = `${hostBase.replace(/\/+$/, '')}:${port}`;

    const session = await this.ptyd.get().spawn({
      file: 'sh',
      args: ['-c', command],
      cwd: row.worktreePath,
      env: {
        PORT: String(port),
        HOST: '0.0.0.0',
      },
      meta: {
        kind: 'shell',
        runId: row.id,
        projectId: row.projectId,
        title: `Preview :${port} · ${row.branch ?? row.id.slice(0, 8)}`,
      },
    });

    this.record(id, {
      source: 'user',
      type: 'preview_started',
      payload: {
        terminalId: session.id,
        command,
        port,
        url,
      },
    });

    return {
      runId: id,
      status: 'running',
      terminalId: session.id,
      command,
      port,
      url,
      detectedCommand,
    };
  }

  async stopPreview(id: string): Promise<RunPreviewStatus> {
    const current = await this.previewStatus(id);
    if (current.terminalId) {
      await this.ptyd
        .get()
        .remove(current.terminalId)
        .catch(() => undefined);
    }
    this.record(id, {
      source: 'user',
      type: 'preview_stopped',
      payload: { terminalId: current.terminalId },
    });
    return {
      runId: id,
      status: 'stopped',
      terminalId: null,
      command: null,
      port: null,
      url: null,
      detectedCommand: current.detectedCommand,
    };
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
    let changed = false;
    const updated = this.db.transaction((tx) => {
      const current = tx.select().from(runs).where(eq(runs.id, id)).get();
      if (!current) throw notFound('no such run');
      changed = event.state !== undefined && event.state !== current.state;
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
    this.emit('run', run, changed);
    return run;
  }
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
