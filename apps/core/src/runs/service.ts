import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AgentState } from '@emberline/adapter-sdk';
import {
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
  type AgentModelId,
  type AgentPersona,
  type BrowserAgentAction,
  type CreateRunBody,
  CreateRunBody as CreateRunBodySchema,
  type DiffScope,
  type GarbageCollectRunsBody,
  GarbageCollectRunsBody as GarbageCollectRunsBodySchema,
  type GarbageCollectRunsResponse,
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
  type RunTelemetry,
  type StartPreviewBody,
  StartPreviewBody as StartPreviewBodySchema,
  type ProjectUsageDay,
} from '@emberline/protocol';
import { and, asc, desc, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { projects, runEvents, runs, tickets } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { ensureRunnerBrowserDaemon } from '../factory/browser-daemon.js';
import {
  getFactorySettings,
  getProviderEnvFromSettings,
  resolveAgentForPersona,
  resolveMcpServersForPersona,
  resolveModelForPersona,
  resolveSkillPluginPromptForPersona,
} from '../factory/service.js';
import { auditWorktreeSlop } from '../factory/slop-guard.js';
import { AGENT_DEMO_TOKEN_TTL_MS, DemoTokens, demoBasePath } from '../demo-token.js';
import type { PtydBridge } from '../ptyd-bridge.js';
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
  worktreeHasUncommittedWork,
} from './git.js';
import { providerAdapter } from './providers.js';
import { isAcceptableTranscriptPath, readTranscriptUsage } from './transcript-usage.js';

type RunRow = typeof runs.$inferSelect;
type EventSource = RunEvent['source'];

interface RunServiceEvents {
  /** `stateChanged` is true when this update moved the run to a new state. */
  run: [run: Run, stateChanged: boolean];
  removed: [id: string];
  /** A hook put the run into `rate_limited`; `info` is what the hook revealed about the limit. */
  rateLimited: [run: Run, info: RateLimitInfo | undefined];
}

/** Extra context when a run is started for a ticket or specialized background job. */
export interface RunOrigin {
  ticketId?: string;
  /** Branch name to use (made unique if taken). */
  branch?: string;
  title?: string;
}

/** Delay between pasting a prompt and pressing Enter, so the TUI has consumed the paste. */
const SUBMIT_DELAY_MS = 150;

const RECONCILE_INTERVAL_MS = 3_000;
const AUTO_GC_INTERVAL_MS = 60_000;
/**
 * An agent idling at its prompt after finishing is closed after this long. Sessions that can be
 * resumed (`claude --resume`) close soon; CLIs without a session id would lose follow-ups, so they
 * stay open much longer (B19).
 */
const IDLE_DONE_RESUMABLE_TTL_MS = 2 * 60_000;
const IDLE_DONE_NON_RESUMABLE_TTL_MS = 30 * 60_000;
const AUTO_GC_KEEP_RECENT_PER_PROJECT = 10;
/** A run still `starting` without a terminal after this long lost its spawn (e.g. core restarted). */
const STARTING_WATCHDOG_MS = 3 * 60_000;
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
  resumable: row.endedAt !== null && row.agentSessionId !== null && row.cancelledAt === null,
  cancelled: row.cancelledAt !== null,
});

function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    const value = payload[key];
    if (typeof value === 'string') summary[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  if (
    typeof payload.tool_name === 'string' &&
    payload.tool_name.startsWith('mcp__playwright__') &&
    payload.tool_input &&
    typeof payload.tool_input === 'object'
  ) {
    const input = payload.tool_input as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['url', 'element', 'text', 'key', 'filename', 'ref']) {
      if (typeof input[k] === 'string' && input[k]) {
        parts.push(`${k}: ${input[k]}`);
      }
    }
    const text = parts.length > 0 ? parts.join(' · ') : JSON.stringify(input);
    summary.tool_input_summary = text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } else if (
    payload.tool_name === 'Bash' &&
    payload.tool_input &&
    typeof payload.tool_input === 'object'
  ) {
    const input = payload.tool_input as Record<string, unknown>;
    const cmd = typeof input.command === 'string' ? input.command : '';
    if (/(?:playwright|chromium|chrome|e2e|bot\.tmp)/i.test(cmd)) {
      summary.tool_input_summary = cmd.length > 240 ? `${cmd.slice(0, 240)}…` : cmd;
    }
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
  private lastAutoGcAt = 0;
  private readonly demoTokens: DemoTokens;

  constructor(
    private readonly db: Db,
    private readonly config: CoreConfig,
    private readonly ptyd: PtydBridge,
  ) {
    super();
    this.setMaxListeners(0); // one listener per open UI socket
    this.demoTokens = new DemoTokens(db);
  }

  /** Starts periodic reconciliation with ptyd. */
  startReconciler(): void {
    this.failOrphanedSpawns();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /**
   * Runs left `starting` without a terminal hold a concurrency slot but are invisible to
   * reconciliation. At boot no spawn can be in flight, so all of them are orphans; later only the
   * ones older than {@link STARTING_WATCHDOG_MS}.
   */
  private failOrphanedSpawns(olderThanMs = 0): void {
    const cutoff = Date.now() - olderThanMs;
    const stuck = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.state, 'starting'), isNull(runs.ptydSessionId), isNull(runs.endedAt)))
      .all()
      .filter((row) => row.stateChangedAt.getTime() <= cutoff);
    for (const row of stuck) {
      this.record(row.id, {
        source: 'system',
        type: 'spawn_lost',
        state: 'failed',
        payload: { reason: 'the agent never got a terminal' },
        patch: { endedAt: new Date() },
      });
    }
  }

  list(): Run[] {
    const rows = this.db.select().from(runs).orderBy(desc(runs.createdAt)).all();
    if (rows.length === 0) return [];
    // Counted in SQL (indexed by type, run) instead of loading every tool event into memory (B15).
    const toolCountByRun = new Map(
      this.db
        .select({ runId: runEvents.runId, n: sql<number>`count(*)` })
        .from(runEvents)
        .where(eq(runEvents.type, 'PreToolUse'))
        .groupBy(runEvents.runId)
        .all()
        .map((row) => [row.runId, row.n]),
    );
    return rows.map((row) => ({
      ...toRun(row),
      telemetry: this.computeTelemetryForRow(row, toolCountByRun.get(row.id) ?? 0),
    }));
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
    const toolCalls = events.filter((e) => e.type === 'PreToolUse').length;
    return {
      ...toRun(row),
      telemetry: this.computeTelemetryForRow(row, toolCalls),
      events,
    };
  }

  getTelemetry(id: string): RunTelemetry {
    const row = this.row(id);
    const toolCalls = this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, id), eq(runEvents.type, 'PreToolUse')))
      .all().length;
    return this.computeTelemetryForRow(row, toolCalls);
  }

  /**
   * Token, tool and time usage of a project's runs over the last `days` days, bucketed by local
   * date in core's time zone (oldest first, empty days included).
   */
  usageByDay(projectId: string, days: number): ProjectUsageDay[] {
    const dateOf = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const buckets = new Map<string, ProjectUsageDay>();
    for (let i = days - 1; i >= 0; i--) {
      const date = dateOf(new Date(Date.now() - i * 86_400_000));
      buckets.set(date, {
        date,
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        toolCalls: 0,
        durationSec: 0,
        estimatedRuns: 0,
      });
    }
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), gte(runs.createdAt, since)))
      .all();
    for (const row of rows) {
      const bucket = buckets.get(dateOf(row.createdAt));
      if (!bucket) continue;
      const telemetry = this.getTelemetry(row.id);
      bucket.runs += 1;
      bucket.inputTokens += telemetry.inputTokens;
      bucket.outputTokens += telemetry.outputTokens;
      bucket.cachedTokens += telemetry.cachedTokens;
      bucket.toolCalls += telemetry.toolCalls;
      bucket.durationSec += telemetry.durationSec;
      if (telemetry.isEstimated) bucket.estimatedRuns += 1;
    }
    return [...buckets.values()];
  }

  private computeTelemetryForRow(row: RunRow, toolCalls: number): RunTelemetry {
    const endMs = row.endedAt ? row.endedAt.getTime() : Date.now();
    const durationSec = Math.max(0, Math.round((endMs - row.createdAt.getTime()) / 1000));

    const usage = row.transcriptPath ? readTranscriptUsage(row.transcriptPath, this.config.transcriptsDir) : null;
    if (usage && usage.inputTokens + usage.outputTokens > 0) {
      return {
        runId: row.id,
        ...usage,
        totalTokens: usage.inputTokens + usage.outputTokens + usage.cachedTokens,
        toolCalls,
        durationSec,
        isEstimated: false,
      };
    }

    if (row.state === 'queued') {
      return {
        runId: row.id,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        durationSec: 0,
        isEstimated: true,
      };
    }

    const promptTokens = Math.max(40, Math.ceil((row.prompt?.length ?? 0) / 4));
    const inputTokens = promptTokens + 920 + toolCalls * 760;
    const outputTokens = (row.state === 'done' ? 640 : 260) + toolCalls * 290;
    return {
      runId: row.id,
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      totalTokens: inputTokens + outputTokens,
      toolCalls,
      durationSec,
      isEstimated: true,
    };
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
    const promptRouteMatch = /\[Preferred Agent:\s*([a-z0-9_-]+)\s*·\s*Model:\s*([a-z0-9_-]+)\]/i.exec(
      body.prompt ?? '',
    );
    const preferredAgentFromPrompt = promptRouteMatch?.[1];
    const resolvedAgent =
      preferredAgentFromPrompt ??
      input.agent ??
      resolveAgentForPersona(this.db, persona) ??
      CLAUDE_ADAPTER_ID;
    const explicitModel =
      (body.model && body.model !== 'auto' ? body.model : undefined) ??
      (promptRouteMatch?.[2] as AgentModelId | undefined);
    const promptWithRoute =
      explicitModel && !/\[Preferred Agent:/i.test(body.prompt)
        ? `${body.prompt}${body.prompt ? '\n\n' : ''}[Preferred Agent: ${resolvedAgent} · Model: ${explicitModel}]`
        : body.prompt;
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
        prompt: promptWithRoute,
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
    if (row.cancelledAt) throw conflict('this run was stopped; start a new run');
    if (row.state === 'queued') return this.launch(id);
    if (row.ptydSessionId && !row.endedAt) {
      await this.typePrompt(row.ptydSessionId, text);
      return this.record(id, { source: 'system', type: 'resumed', state: 'starting', payload: { live: true } });
    }
    if (!row.agentSessionId) {
      if (row.state === 'done') {
        // B19: a finished run's result stands; only this follow-up is impossible.
        this.note(id, 'resume_failed', { reason: 'no session' });
      } else {
        // E.g. rate limited without a session: it can never continue, so end it (or the scheduler retries forever).
        this.record(id, { source: 'system', type: 'resume_failed', state: 'failed', payload: { reason: 'no session' } });
      }
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

  /**
   * The last `lines` non-empty lines of the run's terminal as plain text (escape sequences
   * stripped), for cheap Fleet thumbnails; null when the run has no live terminal.
   */
  async screenText(id: string, lines = 24): Promise<string | null> {
    const screen = await this.screen(id);
    if (screen === undefined) return null;
    return stripVTControlCharacters(screen)
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.trim().length > 0)
      .slice(-lines)
      .join('\n');
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
    const routeTagMatch = /\[Preferred Agent:\s*([a-z0-9_-]+)\s*·\s*Model:\s*([a-z0-9_-]+)\]/i.exec(
      options.prompt ?? row.prompt ?? '',
    );
    const preferredModelFromPrompt = routeTagMatch?.[2] as AgentModelId | undefined;
    const resolvedModel = resolveModelForPersona(this.db, persona, preferredModelFromPrompt);

    const effectivePrompt =
      options.type === 'spawned' ? decoratePromptWithPersona(options.prompt, persona) : options.prompt;

    const extraEnv = getProviderEnvFromSettings(this.db, row.agent);
    const provider = providerAdapter(row.agent);
    // Tests substitute a fake `claude`; the Claude-specific extras need the real CLI.
    const isRealClaude = (this.config.claudeCommand ?? 'claude') === 'claude';
    const { playwrightEnabled, customMcpServers } = resolveMcpServersForPersona(this.db, persona);
    const activeSkillPrompt = isRealClaude ? resolveSkillPluginPromptForPersona(this.db, persona) : '';
    const enablePlaywrightMcp =
      process.env.EMBERLINE_PLAYWRIGHT_MCP === '1' ||
      process.env.EMBERLINE_PLAYWRIGHT_MCP === 'true' ||
      (isRealClaude &&
        playwrightEnabled &&
        process.env.EMBERLINE_PLAYWRIGHT_MCP !== '0' &&
        process.env.EMBERLINE_PLAYWRIGHT_MCP !== 'false');

    if (enablePlaywrightMcp && isRealClaude) {
      await ensureRunnerBrowserDaemon(this.ptyd, path.dirname(this.config.ptydSocket)).catch(
        () => null,
      );
    }

    const demoToken = this.demoTokens.mint({ projectId: row.projectId, targetId: 'main' }, AGENT_DEMO_TOKEN_TTL_MS);
    // hookUrl is how the runner reaches core (`http://core:7420` in compose); localhost is the runner itself.
    const demoUrl = `${this.config.hookUrl}${demoBasePath(demoToken)}`;
    const spec = provider.launch({
      runId: row.id,
      hookToken,
      coreUrl: this.config.hookUrl,
      hookCommand: this.config.hookCommand,
      permissionMode: row.permissionMode as Run['permissionMode'],
      model: provider.claudeNative && !isRealClaude ? 'auto' : resolvedModel,
      prompt: effectivePrompt,
      resumeSessionId: options.resumeSessionId,
      extraEnv,
      claude: {
        command: this.config.claudeCommand,
        playwrightMcp: enablePlaywrightMcp,
        customMcpServers: isRealClaude && Object.keys(customMcpServers).length > 0 ? customMcpServers : undefined,
        extraSystemPrompt: activeSkillPrompt || undefined,
      },
    });

    const personaPrefix =
      persona !== 'coder' && PERSONA_CATALOG[persona] ? `[${PERSONA_CATALOG[persona].shortLabel}] ` : '';
    const modelSuffix = isRealClaude && resolvedModel && resolvedModel !== 'auto' ? ` (${resolvedModel})` : '';
    const hookFile = path.join(path.dirname(this.config.ptydSocket), 'playwright-hook.cjs');
    const playwrightEnv: Record<string, string> =
      enablePlaywrightMcp && isRealClaude
        ? { NODE_OPTIONS: `--require ${hookFile}` }
        : {};
    try {
      const session = await ptyd.spawn({
        file: spec.file,
        args: spec.args,
        cwd: row.worktreePath,
        env: {
          ...spec.env,
          ...extraEnv,
          ...playwrightEnv,
          EMBERLINE_DEMO_URL: demoUrl,
          EMBERLINE_MODEL: resolvedModel,
        },
        meta: {
          kind: 'agent',
          runId: row.id,
          projectId: row.projectId,
          title: `${personaPrefix}${provider.displayName}${modelSuffix} · ${row.title ?? project.name}`,
        },
      });
      const run = this.record(row.id, {
        source: 'system',
        type: options.type,
        payload: options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : undefined,
        patch: { ptydSessionId: session.id },
      });
      if (this.row(row.id).cancelledAt) {
        // Stopped while the terminal was being created: end it now instead of letting it work.
        await ptyd.kill(session.id, 'SIGKILL').catch(() => undefined);
        void this.reconcile();
      }
      return run;
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

  /** Lists recent Playwright MCP and Bash Playwright browser actions across runs for a project. */
  listBrowserAgentActions(projectId: string): {
    actions: BrowserAgentAction[];
    agentActive: boolean;
  } {
    const projectRuns = this.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .orderBy(desc(runs.createdAt))
      .limit(20)
      .all();
    if (projectRuns.length === 0) return { actions: [], agentActive: false };

    const runById = new Map(projectRuns.map((r) => [r.id, r]));
    const actions: BrowserAgentAction[] = [];
    const nowMs = Date.now();
    let agentActive = false;

    for (const r of projectRuns) {
      const evs = this.db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, r.id))
        .orderBy(desc(runEvents.id))
        .limit(80)
        .all();
      for (const e of evs) {
        if (e.type !== 'PreToolUse' && e.type !== 'PostToolUse') continue;
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
        const detail = typeof p.tool_input_summary === 'string' ? p.tool_input_summary : '';
        const isPlaywrightMcp = toolName.startsWith('mcp__playwright__');
        const isPlaywrightBash = toolName === 'Bash' && Boolean(detail);
        if (!isPlaywrightMcp && !isPlaywrightBash) continue;

        const shortTool = isPlaywrightMcp
          ? toolName.replace(/^mcp__playwright__/, '')
          : 'playwright_cli';
        const ageMs = nowMs - e.ts.getTime();
        if (r.state === 'working' && ageMs < 60_000) {
          agentActive = true;
        }
        if (e.type === 'PreToolUse') {
          const runRow = runById.get(r.id);
          actions.push({
            id: e.id,
            runId: r.id,
            runTitle: runRow?.title ?? null,
            persona: (runRow?.persona as AgentPersona) ?? 'coder',
            toolName: shortTool,
            summary: detail ? `${shortTool} (${detail})` : shortTool,
            timestamp: e.ts.toISOString(),
          });
        }
      }
    }

    actions.sort((a, b) => b.id - a.id);
    return {
      actions: actions.slice(0, 25),
      agentActive,
    };
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
    if (
      typeof payload.transcript_path === 'string' &&
      payload.transcript_path !== row.transcriptPath &&
      isAcceptableTranscriptPath(payload.transcript_path, this.config.transcriptsDir)
    ) {
      patch.transcriptPath = payload.transcript_path;
    }
    // A late hook (e.g. SessionEnd after a kill) must not revive an ended or stopped run.
    const next =
      row.endedAt || row.cancelledAt
        ? undefined
        : nextStateFromHook(row.state as AgentState, envelope.event, envelope.payload);
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

  /**
   * Stops a run for good: cancels a queued run, ends a rate-limited one waiting for its window, or
   * terminates the agent process (reconciliation records the end). A stopped run never resumes,
   * and hooks arriving after the stop do not change its state.
   */
  async stop(id: string): Promise<Run> {
    const row = this.row(id);
    const cancelledAt = row.cancelledAt ?? new Date();
    const live = Boolean(row.ptydSessionId && !row.endedAt);
    if (row.state === 'queued' || (!live && row.state === 'rate_limited')) {
      return this.record(id, {
        source: 'user',
        type: 'cancelled',
        state: 'failed',
        patch: { endedAt: row.endedAt ?? new Date(), cancelledAt },
      });
    }
    if (row.endedAt) return toRun(row);
    // Live, or still spawning (no terminal yet): spawnAgent checks the flag once the terminal exists.
    const run = this.record(id, { source: 'user', type: 'stop_requested', patch: { cancelledAt } });
    const sessionId = row.ptydSessionId;
    if (sessionId) {
      await this.ptyd
        .get()
        .kill(sessionId)
        .catch(() => {
          // Already exited; reconcile will notice.
        });
      // Interactive CLI TUIs (e.g. Claude sitting at the `>` prompt) sometimes trap SIGTERM;
      // ensure the PTY is force-killed if it hasn't exited within 1.2s.
      const fallbackTimer = setTimeout(() => {
        try {
          if (this.ptyd.status !== 'connected') return;
          void this.ptyd
            .get()
            .kill(sessionId, 'SIGKILL')
            .catch(() => undefined)
            .finally(() => {
              void this.reconcile();
            });
        } catch {
          // ptyd disconnected or test app closed
        }
      }, 1_200);
      fallbackTimer.unref();
    }
    void this.reconcile();
    return run;
  }

  /** Appends an informational system event (no state change) to a run's timeline. */
  note(id: string, type: string, payload?: unknown): void {
    try {
      this.record(id, { source: 'system', type, payload });
    } catch {
      // The run was removed meanwhile.
    }
  }

  /** The newest run of a ticket whose agent process is still alive, if any. */
  /**
   * The ticket's run that is still in play: its process is alive, or it is rate limited and waiting
   * for the quota window (process gone, resumed by the scheduler later). B11: the latter used to be
   * ignored, so a second run could be started on the same ticket.
   */
  activeRunForTicket(ticketId: string): Run | undefined {
    const row = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.ticketId, ticketId),
          or(isNull(runs.endedAt), and(eq(runs.state, 'rate_limited'), isNull(runs.cancelledAt))),
        ),
      )
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
    if (row.cancelledAt) throw conflict('this run was stopped; start a new run');
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
    const fSettings = getFactorySettings(this.db);
    if (fSettings.secretGuardGate && row.worktreePath) {
      const report = await auditWorktreeSlop({
        runId: id,
        workspacePath: row.worktreePath,
      }).catch(() => null);
      if (report && !report.secretGuardPassed) {
        const secretIssues = report.issues.filter((i) => i.category === 'secret_leak');
        const first = secretIssues[0];
        throw conflict(
          `Pre-Commit Secret Guard blocked commit (${report.secretLeakCount} secret leak(s) detected)${
            first ? ` — ${first.file}:${first.line}: ${first.message}` : ''
          }`,
        );
      }
    }
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

  /**
   * A stable port per run (3100-3899), moved to the next free one when another running preview
   * already holds it (B16: two runs could hash to the same port).
   */
  private async allocatePreviewPort(runId: string): Promise<number> {
    let hash = 0;
    for (let i = 0; i < runId.length; i++) {
      hash = (hash * 31 + runId.charCodeAt(i)) >>> 0;
    }
    const { sessions } = await this.ptyd.get().list();
    const taken = new Set(
      sessions
        .filter((s) => s.status === 'running' && s.meta.previewPort && s.meta.runId !== runId)
        .map((s) => Number(s.meta.previewPort)),
    );
    for (let i = 0; i < 800; i++) {
      const port = 3100 + ((hash + i) % 800);
      if (!taken.has(port)) return port;
    }
    throw conflict('no free preview port in 3100-3899');
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
    const port = body.port ?? (await this.allocatePreviewPort(id));
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
        previewPort: String(port),
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

  /** Forgets the run, its terminal and its preview server. The worktree and branch are kept on purpose. */
  async remove(id: string): Promise<void> {
    const row = this.row(id);
    // B16: GC and project deletion go through here; a preview server must not outlive its run.
    if (this.ptyd.status === 'connected') {
      const { sessions } = await this.ptyd
        .get()
        .list()
        .catch(() => ({ sessions: [] as { id: string; meta: Record<string, string> }[] }));
      for (const s of sessions.filter((x) => x.meta.runId === id && x.meta.previewPort)) {
        await this.ptyd
          .get()
          .remove(s.id)
          .catch(() => undefined);
      }
    }
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

  /**
   * Garbage-collects completed/failed runs, closes lingering PTY sessions, and optionally prunes
   * their `.worktrees` directories so Fleet Multiplexer and disk stay clean.
   */
  async garbageCollect(rawInput?: GarbageCollectRunsBody): Promise<GarbageCollectRunsResponse> {
    const body = GarbageCollectRunsBodySchema.parse(rawInput ?? {});
    await this.reconcile();

    let closedSessions = 0;
    let prunedWorktrees = 0;
    let removedRuns = 0;

    // 1. Ensure any run already in `done` or `failed` state with an open or attached PTY session is closed & detached.
    const allRuns = this.db.select().from(runs).orderBy(desc(runs.createdAt)).all();
    const scopedRuns = body.projectId ? allRuns.filter((r) => r.projectId === body.projectId) : allRuns;

    for (const row of scopedRuns) {
      const isFinished = Boolean(row.endedAt) || row.state === 'done' || row.state === 'failed';
      if (!isFinished) continue;
      if (row.ptydSessionId && this.ptyd.status === 'connected') {
        await this.ptyd
          .get()
          .remove(row.ptydSessionId)
          .then(() => {
            closedSessions += 1;
          })
          .catch(() => undefined);
      }
      if (!row.endedAt || row.ptydSessionId) {
        const updated = this.db
          .update(runs)
          .set({
            endedAt: row.endedAt ?? new Date(),
            ptydSessionId: null,
          })
          .where(eq(runs.id, row.id))
          .returning()
          .get();
        if (updated) {
          this.emit('run', toRun(updated), false);
        }
      }
    }

    // 2. Also remove any exited orphaned sessions in ptyd
    if (this.ptyd.status === 'connected') {
      try {
        const { sessions } = await this.ptyd.get().list();
        for (const s of sessions) {
          if (s.status === 'exited' && (!body.projectId || s.meta.projectId === body.projectId)) {
            await this.ptyd
              .get()
              .remove(s.id)
              .then(() => {
                closedSessions += 1;
              })
              .catch(() => undefined);
          }
        }
      } catch {
        // ignore ptyd errors
      }
    }

    // 3. Group finished runs per project and remove runs beyond `keepRecent`
    const refreshedRuns = this.db.select().from(runs).orderBy(desc(runs.createdAt)).all();
    const projectMap = new Map(
      this.db
        .select()
        .from(projects)
        .all()
        .map((p) => [p.id, p]),
    );

    const byProject = new Map<string, RunRow[]>();
    for (const row of refreshedRuns) {
      if (body.projectId && row.projectId !== body.projectId) continue;
      const isCandidate =
        row.state === 'done' ||
        (body.includeFailed && row.state === 'failed') ||
        (Boolean(row.endedAt) && (row.state === 'done' || body.includeFailed));
      if (!isCandidate) continue;
      const list = byProject.get(row.projectId) ?? [];
      list.push(row);
      byProject.set(row.projectId, list);
    }

    for (const [projId, list] of byProject.entries()) {
      const toRemove = list.slice(body.keepRecent);
      const proj = projectMap.get(projId);
      for (const row of toRemove) {
        if (await this.mustKeepForReview(row, proj?.path)) continue;
        if (body.pruneWorktrees && proj && row.worktreePath && row.worktreePath !== proj.path) {
          const removedWt = await pruneWorktree(proj.path, row.worktreePath).catch(() => false);
          if (removedWt) prunedWorktrees += 1;
        }
        await this.remove(row.id).catch(() => undefined);
        removedRuns += 1;
      }
    }

    const remainingRuns = this.db
      .select()
      .from(runs)
      .all()
      .filter((r) => !body.projectId || r.projectId === body.projectId).length;

    return {
      removedRuns,
      closedSessions,
      prunedWorktrees,
      remainingRuns,
    };
  }

  /** Records process exits and sessions that vanished (runner restart) for unfinished runs. */
  async reconcile(): Promise<void> {
    if (this.reconciling || this.ptyd.status !== 'connected') return;
    this.reconciling = true;
    try {
      this.failOrphanedSpawns(STARTING_WATCHDOG_MS);
      const open = this.db.select().from(runs).where(isNull(runs.endedAt)).orderBy(asc(runs.createdAt)).all();
      const attached = this.db
        .select()
        .from(runs)
        .where(isNotNull(runs.ptydSessionId))
        .orderBy(asc(runs.createdAt))
        .all();
      if (open.length === 0 && attached.length === 0) return;
      const { sessions } = await this.ptyd.get().list();
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const nowMs = Date.now();

      for (const row of open) {
        if (!row.ptydSessionId) {
          if (row.state === 'done' || row.state === 'failed') {
            const updated = this.db
              .update(runs)
              .set({ endedAt: new Date() })
              .where(eq(runs.id, row.id))
              .returning()
              .get();
            if (updated) this.emit('run', toRun(updated), false);
          }
          continue; // still spawning or queued
        }
        const session = byId.get(row.ptydSessionId);
        if (session?.status === 'running') {
          // If an interactive CLI finished its turn (`state === 'done'`) and has been sitting idle
          // for over its idle TTL without any follow-up prompt, close & dispose its PTY
          // so it never lingers as a zombie process in Fleet Multiplexer.
          const idleTtl = row.agentSessionId ? IDLE_DONE_RESUMABLE_TTL_MS : IDLE_DONE_NON_RESUMABLE_TTL_MS;
          if (row.state === 'done' && nowMs - row.stateChangedAt.getTime() > idleTtl) {
            await this.ptyd
              .get()
              .remove(row.ptydSessionId)
              .catch(() => undefined);
            byId.delete(row.ptydSessionId);
            this.record(row.id, {
              source: 'system',
              type: 'idle_session_closed',
              state: 'done',
              patch: { endedAt: new Date(), ptydSessionId: null },
            });
          }
          continue;
        }
        const exitCode = session ? session.exitCode : null;
        const nextAfterExit: AgentState = row.cancelledAt
          ? row.state === 'done'
            ? 'done'
            : 'failed'
          : stateAfterExit(row.state as AgentState, exitCode);
        let exitMessage: string | undefined;
        if (session && nextAfterExit === 'failed' && !row.cancelledAt) {
          try {
            const snap = await this.ptyd.get().snapshot(row.ptydSessionId, 40);
            const cleaned = stripVTControlCharacters(snap.data ?? '')
              .replace(/\r/g, '\n')
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(-6)
              .join(' · ');
            if (cleaned) {
              exitMessage = cleaned.slice(0, 480);
            }
          } catch {
            // ignore snapshot errors
          }
        }
        if (session) {
          await this.ptyd
            .get()
            .remove(row.ptydSessionId)
            .catch(() => undefined);
          byId.delete(row.ptydSessionId);
        }
        this.record(row.id, {
          source: 'system',
          type: row.cancelledAt ? 'cancelled' : session ? 'process_exited' : 'session_lost',
          state: nextAfterExit,
          payload: session
            ? {
                exitCode,
                signal: session.signal,
                ...(exitMessage ? { message: exitMessage } : {}),
              }
            : {},
          patch: { endedAt: new Date(), ptydSessionId: null },
        });
      }
      for (const row of attached) {
        if (!row.endedAt || !row.ptydSessionId) continue;
        if (byId.has(row.ptydSessionId)) {
          await this.ptyd
            .get()
            .remove(row.ptydSessionId)
            .catch(() => undefined);
          byId.delete(row.ptydSessionId);
        }
        const updated = this.db
          .update(runs)
          .set({ ptydSessionId: null })
          .where(eq(runs.id, row.id))
          .returning()
          .get();
        if (updated) {
          this.emit('run', toRun(updated), false);
        }
      }

      // Periodic background garbage collection of old completed runs & worktrees
      if (nowMs - this.lastAutoGcAt > AUTO_GC_INTERVAL_MS) {
        this.lastAutoGcAt = nowMs;
        const allFinished = this.db
          .select()
          .from(runs)
          .where(isNotNull(runs.endedAt))
          .orderBy(desc(runs.createdAt))
          .all();
        const projectMap = new Map(
          this.db
            .select()
            .from(projects)
            .all()
            .map((p) => [p.id, p]),
        );
        const byProj = new Map<string, RunRow[]>();
        for (const r of allFinished) {
          if (r.state !== 'done' && r.state !== 'failed') continue;
          const arr = byProj.get(r.projectId) ?? [];
          arr.push(r);
          byProj.set(r.projectId, arr);
        }
        for (const [projId, arr] of byProj.entries()) {
          if (arr.length <= AUTO_GC_KEEP_RECENT_PER_PROJECT) continue;
          const proj = projectMap.get(projId);
          for (const stale of arr.slice(AUTO_GC_KEEP_RECENT_PER_PROJECT)) {
            if (await this.mustKeepForReview(stale, proj?.path)) continue;
            if (proj && stale.worktreePath && stale.worktreePath !== proj.path) {
              await pruneWorktree(proj.path, stale.worktreePath).catch(() => undefined);
            }
            await this.remove(stale.id).catch(() => undefined);
          }
        }
      }
    } catch {
      // ptyd went away mid-call; next tick retries.
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Garbage collection never deletes work a human still has to look at: runs of tickets that are
   * not `done` yet (e.g. in Review after a refused merge) and worktrees with uncommitted changes.
   */
  private async mustKeepForReview(row: RunRow, projectPath: string | undefined): Promise<boolean> {
    if (row.ticketId) {
      const ticket = this.db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, row.ticketId)).get();
      if (ticket && ticket.status !== 'done') return true;
    }
    if (row.worktreePath && row.worktreePath !== projectPath) {
      return worktreeHasUncommittedWork(row.worktreePath);
    }
    return false;
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
