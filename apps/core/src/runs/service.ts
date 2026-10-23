import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { isPermissionNotification, type AgentState } from '@emberline/adapter-sdk';
import {
  CONTINUE_PROMPT,
  decoratePromptWithPersona,
  headlessModeProblem,
  nextStateFromHook,
  PERSONA_CATALOG,
  type RateLimitInfo,
  rateLimitFromHook,
  stateAfterExit,
  transientErrorFromHook,
} from '@emberline/adapter-claude';
import {
  type AgentId,
  AgentPreviewBody,
  type AgentPreviewResponse,
  type AgentModelId,
  type AgentPersona,
  type BrowserAgentAction,
  type CreateRunBody,
  type Credential,
  CreateRunBody as CreateRunBodySchema,
  type DiffScope,
  COMPOSE_SERVICE_NAME,
  type DockerCleanupResponse,
  type DockerOverview,
  type DockerProjectActionResponse,
  type DockerProjectLogsResponse,
  type GarbageCollectRunsBody,
  GarbageCollectRunsBody as GarbageCollectRunsBodySchema,
  type GarbageCollectRunsResponse,
  type GitCommitBody,
  type GitCommitResponse,
  type GitPushResponse,
  type GitStageBody,
  type HookEnvelope,
  type PermissionMode,
  PROVIDER_RUNTIME,
  type PruneWorktreeBody,
  PruneWorktreeBody as PruneWorktreeBodySchema,
  type PruneWorktreeResponse,
  type Route,
  type Run,
  type RunArtifact,
  type RunBuildOutput,
  type RunBuildOutputsResponse,
  type RunDetail,
  type RunDiffSummary,
  type RunEvent,
  type RunFileDiff,
  type RunPreviewStatus,
  type RunState,
  sameRoute,
  type RunTelemetry,
  type StartPreviewBody,
  StartPreviewBody as StartPreviewBodySchema,
  type ProjectUsageDay,
  TicketCompleteBody,
  type TicketCompletion,
  isComposeService,
  type WorktreeComposeService,
  DOCKER_ENGINE_NOT_ANSWERED_TEXT,
  DOCKER_ENGINE_UNREACHABLE_HINT,
  dockerEngineOffText,
  withHint,
  type AskUserQuestionSummary,
} from '@emberline/protocol';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { CoreConfig } from '../config.js';
import {
  composeDownArgs,
  composeLogsArgs,
  engineHostName,
  isEmberlineComposeProject,
} from '../docker/compose.js';
import {
  CLEANUP_DOWN,
  type ComposePreviewTiming,
  composeDown,
  composeProjects,
  composeServiceStatus,
  DEFAULT_COMPOSE_PREVIEW_TIMING,
  dockerQuery,
  pruneImages,
  reclaimFiles,
  runComposePreview,
  settlesWithin,
} from '../docker/compose-preview.js';
import {
  composeProjectName,
  DOCKER_PROMPT_PARAGRAPH,
  DockerEngine,
  mainComposeProjectName,
  previewComposeProjectName,
} from '../docker/engine.js';
import {
  buildDockerProjects,
  composeProjectsInUse,
  gatherDockerInventory,
  type OwnershipFacts,
  type OwnershipRun,
  resolveDockerOwner,
} from '../docker/inventory.js';
import { composeEngineOffMessage, composePreviewLabel, MainPreviews } from './main-preview.js';
import { previewUrl } from './preview-url.js';
import { type AttentionFacts, attachAttention, loadAttentionFacts } from './attention.js';
import type { Db } from '../db/index.js';
import { projects, runEvents, runs, tickets } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { accountForGitRemote, gitCredentialForRemote } from '../forge/account-store.js';
import { execGitFile } from '../git-exec.js';
import { GitGateway } from '../git-gateway/gateway.js';
import { stripControlChars } from '../text/control-chars.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { BuildOutputArchive } from '../outputs/archive.js';
import { openFileUnder, realDirUnder, streamOpenedFile } from '../outputs/safe-fs.js';
import { mainWorkspaceBranch } from '../factory/merge.js';
import { ensureRunnerBrowserDaemon } from '../factory/browser-daemon.js';
import {
  BROWSER_AGENT_WINDOW_MS,
  type BrowserAgentActivity,
  browserAgentActivity,
} from './browser-agents.js';
import {
  effectiveFactorySettings,
  getFactorySettings,
  defaultCredentialFor,
  getProviderEnvFromSettings,
  resolveMcpServersForPersona,
  resolveModelForPersona,
  resolveRunRoutes,
  resolveSkillPluginPromptForPersona,
} from '../factory/service.js';
import { auditWorktreeSlop } from '../factory/slop-guard.js';
import { DemoTokens } from '../demo-token.js';
import { agentDemoUrl } from '../factory/demo-target.js';
import { AGENT_PREVIEW_COOLDOWN_MS, AGENT_PREVIEW_WAIT_MS, agentPreview } from './agent-preview.js';
import { resolveBrowserUrl, runnerPreviewUrl } from './browser-url.js';
import { askUserQuestionOf, openPicker } from './question.js';
import { PreviewFramingCache } from './preview-framing.js';
import type { PtydBridge } from '../ptyd-bridge.js';
import {
  commitWorktree,
  git,
  inspectDiff,
  inspectFileDiff,
  hashWorktreeFile,
  reviewFileHashes,
  readReviewSide,
  listBuildOutputs,
  listWorktreeArtifacts,
  prepareWorkspace,
  pruneWorktree,
  pushWorktreeBranch,
  readWorktreeArtifact,
  resolveSafeWorktreePath,
  stageWorktreeFiles,
  worktreeHasUncommittedWork,
  worktreeHasUnmergedCommits,
  worktreeHeadSha,
} from './git.js';
import {
  buildHandoffPrompt,
  type HandoffPromptInput,
  successorPrompt,
  summarizeRecentTools,
} from './handoff.js';
import { latestDoneEventId } from './hold-outcome.js';
import { HOLD_ENDING_EVENTS, HOLD_EVENTS } from './hold-events.js';
import { providerAdapter } from './providers.js';
import { detectPreviewCommand } from './preview-command.js';
import { cancelCommand } from '../command-exec.js';
import {
  copyIntoWorktree,
  type CopyOutcome,
  notIgnoredPaths,
  runWorktreeCommand,
  SETUP_TIMEOUT_MS,
  SETUP_TOTAL_MS,
  setupFailurePrefix,
  setupSkippedPrefix,
  TEARDOWN_TIMEOUT_MS,
  unignoredSecretsNote,
} from '../worktree-config/lifecycle.js';
import { approvedPreviewService, loadApprovedWorktreeConfig } from '../worktree-config/load.js';
import { currentRoute as routeOfRow, parseRouteTag, ROUTE_TAG, runModel, runRoutes } from './route.js';
import {
  isAcceptableTranscriptPath,
  readLastAssistantText,
  readTranscriptUsage,
} from './transcript-usage.js';

type RunRow = typeof runs.$inferSelect;
/** The part of a pino/fastify logger the run service uses. */
export interface RunServiceLogger {
  warn(obj: object, msg: string): void;
}
/** A project delete waits this long at most for worktree.yml teardowns. */
export const PROJECT_DELETE_TEARDOWN_BUDGET_MS = 30_000;
/** A per-run prune or a manual GC waits this long in all for teardowns; the rest finish in the background. */
export const REQUEST_TEARDOWN_BUDGET_MS = 60_000;
/** The GC sweep of the Docker engine's compose projects runs this often. */
export const DOCKER_GC_INTERVAL_MS = 30 * 60_000;
/** The first sweep runs this long after start (leftovers from before a restart), then every 30 min. */
export const DOCKER_GC_FIRST_DELAY_MS = 60_000;
/** A sweep takes down at most this many leftover compose projects; the next sweep takes the rest. */
export const DOCKER_GC_MAX_DOWNS = 10;
/** Dangling images (older than 72 h) are pruned at most this often. */
const DOCKER_IMAGE_PRUNE_INTERVAL_MS = 24 * 3_600_000;
/** A cleanup runs this many `compose down` at a time (each is capped at 2 min). */
const COMPOSE_DOWN_CONCURRENCY = 4;
interface StopPreviewOptions {
  /** Also remove the preview project's volumes and built images (CLEANUP_DOWN). */
  volumes?: boolean;
  /** Told about the preview project's `down` when the stop ran one. */
  onDown?: (project: string, down: Awaited<ReturnType<typeof composeDown>>) => void;
}
/** The id a run's setup commands run under, so a stop can kill the one that runs. */
const setupExecId = (runId: string) => `setup-${runId}`;
/** A copy entry left out whole because it is over the copy caps. */
const overCopyCap = (entry: CopyOutcome) =>
  entry.status === 'skipped' &&
  /^(more than \d+ files and directories|larger than \d+ MB)$/.test(entry.reason ?? '');
type EventSource = RunEvent['source'];

interface RunServiceEvents {
  /** `stateChanged` is true when this update moved the run to a new state. */
  run: [run: Run, stateChanged: boolean];
  removed: [id: string];
  /** A hook put the run into `rate_limited`; `info` is what the hook revealed about the limit. */
  rateLimited: [run: Run, info: RateLimitInfo | undefined];
  /** {@link RunService.note} added an informational event to the run's timeline. */
  note: [run: Run, type: string, payload: unknown];
  /**
   * {@link RunService.sendPrompt} typed a prompt into the live session and the run has not changed
   * state since: the agent is about to take it. Not emitted when the CLI took it and stopped again
   * before the prompt was recorded; those state changes decided (`run` events) then.
   */
  prompted: [run: Run];
}

/** Extra context when a run is started for a ticket or specialized background job. */
export interface RunOrigin {
  ticketId?: string;
  /** Branch name to use (made unique if taken). */
  branch?: string;
  title?: string;
  /** Continue in an existing worktree (quota handoff) instead of creating one. */
  worktree?: { path: string; branch: string | null };
  /** Explicit chain and position (handoff); otherwise taken from the persona settings. */
  routes?: Route[];
  routeIndex?: number;
  /** Nobody watches this run (cron job or factory dispatch); recorded on its `queued` event. */
  unattended?: 'cron' | 'factory';
  /** The run this one takes over from. */
  predecessor?: { id: string; handoffCount: number };
}

/** Delay between pasting a prompt and pressing Enter, so the TUI has consumed the paste. */
const SUBMIT_DELAY_MS = 150;

const RECONCILE_INTERVAL_MS = 3_000;
const AUTO_GC_INTERVAL_MS = 60_000;
const EVENT_PRUNE_INTERVAL_MS = 5 * 60_000;
/** Newest `run_events` rows kept per run; older ones are pruned (R11). */
export const MAX_EVENTS_PER_RUN = 5000;
/**
 * Event kinds that logic reads back later, so pruning never removes them: the one `last_screen`
 * snapshot, the `queued` event (unattended origin, queued prompts), the completion signal, its
 * tool's check-in and the turn boundary it is checked against (`ticket_complete`,
 * `completion_tool_ready`, `UserPromptSubmit`), one-shot markers
 * (`auto_nudged`, `session_lost`, `tickets_imported`), the preview start/stop the status reads, the pipeline hold/merge notes (HOLD_EVENTS,
 * HOLD_ENDING_EVENTS, `conflict_resolution_requested`), `pr_created`, the issue write-back records, and the watchdog outcomes.
 */
export const PRUNE_PROTECTED_EVENT_TYPES = [
  'last_screen',
  'queued',
  'ticket_complete',
  // The run's agent has the tool; the completion gate applies only then.
  'completion_tool_ready',
  // The turn boundary latestCompletion compares the signal with.
  'UserPromptSubmit',
  'auto_nudged',
  'session_lost',
  // Tickets the run's tickets file created: a later pass of a run without changes is not empty.
  'tickets_imported',
  ...HOLD_EVENTS,
  ...HOLD_ENDING_EVENTS,
  // The person's merge past open blocking comments; kept like the merge note.
  'review_blocking_overridden',
  // Blocking feedback a fresh run carried: the merge gate counts it until a person verifies.
  'review_carried_blocking',
  // ...and the person's check that ends it.
  'review_carried_verified',
  'conflict_resolution_requested',
  'pr_created',
  // The issue write-back reads these back so a comment or a close never repeats.
  'issue_commented',
  'issue_closed',
  'issue_close_failed',
  'issue_close_skipped',
  'stall_detected',
  'waiting_input_timeout',
  // previewStatus reads the latest of these.
  'preview_started',
  'preview_stopped',
  'preview_ready',
  'preview_failed',
  // launch reads the setup a fresh worktree still needs.
  'worktree_setup_pending',
  // The first prompt's note on copied secrets (launch can come long after enqueue), and what a copy skipped.
  'worktree_copied',
  'worktree_copy_skipped',
  // A respawn: the session runs a one-shot CLI (exitsAfterTurn), whose typed input would be lost.
  'respawning',
];
type PreviewKind = RunPreviewStatus['kind'];

/** What `preview_started` carries: both kinds have `port`; compose adds where it runs. */
interface PreviewPayload {
  kind?: PreviewKind;
  terminalId?: string;
  command?: string;
  port?: number;
  /** Older events stored the URL; it is now built per request. */
  url?: string;
  project?: string;
  file?: string;
  service?: string;
  containerPort?: number;
  /** Why this is not the configured preview (a missing compose file). */
  note?: string;
}

/** A compose preview's background start (`up` and the readiness checks). */
interface ComposeJob {
  execId: string;
  /** Set by a stop or a newer start: the job records nothing more. */
  cancelled: boolean;
  /** The stop stopped waiting for it: when it settles, its project is taken down once more. */
  abandoned: boolean;
  generation: number;
  project: string;
  /** Settles when the job ended (never rejects). */
  done: Promise<void>;
}

/** Events that never become a run's `lastEvent`. */
const BOOKKEEPING_EVENT_TYPES = new Set([
  'last_screen',
  'completion_tool_ready',
  // The issue write-back reports on the run; it is not something the run did.
  'issue_commented',
  'issue_comment_failed',
  'issue_closed',
  'issue_close_failed',
  // A compose preview's background start ended; the run did nothing.
  'preview_ready',
  'preview_failed',
  // A person stopped or removed the run's compose project on the Docker page.
  'docker_project_stopped',
  'docker_project_removed',
]);
/** Runs pruned per pass, so the first pass on a big database cannot block the event loop for long; the rest follow on the next reconcile. */
const PRUNE_RUNS_PER_PASS = 10;
/**
 * An agent idling at its prompt after finishing is closed after this long. Sessions that can be
 * resumed (`claude --resume`) close soon; CLIs without a session id would lose follow-ups, so they
 * stay open much longer (B19).
 */
const IDLE_DONE_RESUMABLE_TTL_MS = 2 * 60_000;
const IDLE_DONE_NON_RESUMABLE_TTL_MS = 30 * 60_000;
const AUTO_GC_KEEP_RECENT_PER_PROJECT = 10;
/** Time all pre-prune archive passes of one auto-GC pass may take together. */
export const AUTO_GC_ARCHIVE_BUDGET_MS = 60_000;
/** Auto-GC keeps retrying a run whose outputs fail to archive this long (from the first failure), then prunes. */
const AUTO_GC_ARCHIVE_RETRY_MS = 24 * 3_600_000;
/** With less budget left than this, auto-GC stops and prunes the rest on its next pass. */
const AUTO_GC_MIN_ARCHIVE_MS = 5_000;
/**
 * Time all pre-prune archive passes of one manual GC (or "Clean up worktrees") request may take
 * together; runs not archived by then keep their worktree and row, reported as `archive_pending`.
 */
export const MANUAL_GC_ARCHIVE_BUDGET_MS = 60_000;

type KeptWorktreeReason = GarbageCollectRunsResponse['keptWorktrees'][number]['reason'];
/** Auto-GC re-runs git on a kept worktree whose HEAD has not moved at most this often. */
const KEPT_WORKTREE_RECHECK_MS = 10 * 60_000;
/** A run still `starting` without a terminal after this long lost its spawn (e.g. core restarted). */
const STARTING_WATCHDOG_MS = 3 * 60_000;
/**
 * An unattended run waiting this long on a permission prompt, or since it was found stalled, is
 * stopped as failed (R6).
 */
export const WAITING_INPUT_TIMEOUT_MS = 30 * 60_000;
/**
 * A `working` run, or a `starting` one with a terminal (e.g. a live resume whose CONTINUE produced no
 * hook), with no hook and an unchanged screen this long is taken as stalled (a missed hook, a hung
 * CLI): it becomes `waiting_input`, which frees its slot and pages the user (R7).
 */
export const STALL_WATCHDOG_MS = 20 * 60_000;
/** Whole minutes of a duration, for user-facing copy. */
export const minutesOf = (ms: number) => Math.round(ms / 60_000);
/** How often the stall watchdog looks at a working run's screen. */
const STALL_SCREEN_SAMPLE_MS = 60_000;
/** Screen lines hashed by the stall watchdog. */
const STALL_SCREEN_LINES = 50;
/**
 * States in which the CLI sits at its prompt, so text typed by Emberline itself (CONTINUE, nudges,
 * gate follow-ups) is read as the next turn. A rate-limited turn has ended on its limit.
 */
const IDLE_STATES: ReadonlySet<string> = new Set<RunState>(['waiting_input', 'done', 'rate_limited']);
/** 409 `session_closing`: a one-shot CLI is in its turn or exiting after it; a prompt respawns it once gone. */
const SESSION_CLOSING = 'The agent is finishing its turn; try again in a moment.';
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

/** The agent's own words are kept in full (within reason); other payload strings stay short. */
const LONG_PAYLOAD_KEYS = new Set(['last_assistant_message', 'prompt', 'message']);
const LONG_PAYLOAD_MAX = 20_000;
const PAYLOAD_MAX = 2_000;
const TOOL_INPUT_SUMMARY_MAX = 2_000;
/** Scrollback lines kept as a run's last screen when its terminal closes. */
const LAST_SCREEN_LINES = 200;
const LAST_SCREEN_MAX = 64 * 1024;

/**
 * Waits before each automatic retry of a turn that died on a temporary provider error (503,
 * overloaded, network). After the last one the run is left for the user as before.
 */
export const AUTO_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

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
  // A handed-off run's work continues in its successor; resuming it is refused.
  resumable:
    row.endedAt !== null &&
    row.agentSessionId !== null &&
    row.cancelledAt === null &&
    row.handedOffTo === null,
  cancelled: row.cancelledAt !== null,
  autoRetry:
    row.state === 'rate_limited' && row.autoRetryAt
      ? { attempt: row.autoRetryCount, max: AUTO_RETRY_DELAYS_MS.length, at: row.autoRetryAt.toISOString() }
      : null,
  model: runModel(row),
  credential: row.credential as Run['credential'],
  routes: runRoutes(row),
  routeIndex: row.routeIndex,
  predecessorRunId: row.predecessorRunId,
  handedOffTo: row.handedOffTo,
  attention: null,
  reviewReady: false,
});

function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    const value = payload[key];
    if (typeof value === 'string')
      summary[key] = clip(value, LONG_PAYLOAD_KEYS.has(key) ? LONG_PAYLOAD_MAX : PAYLOAD_MAX);
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
    summary.tool_input_summary = clip(text, TOOL_INPUT_SUMMARY_MAX);
  } else if (payload.tool_name === 'Bash' && payload.tool_input && typeof payload.tool_input === 'object') {
    const input = payload.tool_input as Record<string, unknown>;
    const cmd = typeof input.command === 'string' ? input.command : '';
    if (/(?:playwright|chromium|chrome|e2e|bot\.tmp)/i.test(cmd)) {
      summary.tool_input_summary = clip(cmd, TOOL_INPUT_SUMMARY_MAX);
    }
  }
  if (payload.tool_name === 'AskUserQuestion') {
    const ask = askUserQuestionOf(payload.tool_input);
    if (ask) summary.ask_user_question = ask;
  }
  return summary;
}

/** A run that is live, or parked on a quota limit and still going to resume (not cancelled). */
const runStillActive = () =>
  or(isNull(runs.endedAt), and(eq(runs.state, 'rate_limited'), isNull(runs.cancelledAt)));

/** The pipeline's own stop of a finished factory step: the only cancel a successor may continue. */
export const FINISHED_STEP_STOP = 'factory_step_finished';

/** Whether a hold note keeps the run in front of a person (a `completion_blocked` hold reads as `blocked`). */
export const isHeldRun = (run: Pick<Run, 'attention'>): boolean =>
  run.attention?.reason === 'held' || run.attention?.reason === 'blocked';

export interface HandOffOptions {
  reason: string;
  source: 'system' | 'user';
  automatic: boolean;
  /** Follows the handoff context in the successor's prompt (a person's recovery prompt). */
  extraPrompt?: string;
  /** Also continue a cancelled run, when it is a held run the pipeline's finished-step stop alone cancelled. */
  allowSystemFinishedCancel?: boolean;
}

/** Why a run cannot be handed off right now, if it cannot. `continuesHeld`: its cancel does not count. */
function handoffBlocker(row: RunRow, continuesHeld = false): string | undefined {
  if (row.cancelledAt && !continuesHeld) return 'this run was stopped';
  if (row.handedOffTo) return 'this run was already handed off';
  if (row.state === 'queued' || row.state === 'starting' || row.state === 'working')
    return `a ${row.state} run cannot be handed off`;
  return undefined;
}

/** A push failure about access (no credentials, refused), not about the branch. */
const ACCESS_FAILURE =
  /could not read (username|password)|authentication|permission denied|access denied|not authorized|\b40[13]\b/i;

/** Said after a failed run push when the project has no connected repository but an account covers its origin. */
export const CONNECT_FOR_ACCOUNT =
  "Connect this project's repository in Project settings → Repository to push with a forge account.";

/**
 * Owns the run lifecycle: worktree + agent spawn, hook ingestion (the primary state signal),
 * and reconciliation with ptyd (process exits, runner restarts).
 */
export class RunService extends EventEmitter<RunServiceEvents> {
  private timer?: NodeJS.Timeout;
  /** The reconcile pass running now; resolves (never rejects) when it ends. */
  private reconcilePass: Promise<void> | null = null;
  private lastAutoGcAt = 0;
  private lastEventPruneAt = 0;
  /** Auto-GC's last verdict on a kept worktree, by run id: the HEAD it saw and when. */
  private readonly keptWorktreeChecks = new Map<
    string,
    { head: string | null; reason: KeptWorktreeReason; checkedAt: number }
  >();
  private readonly handoffLock = new KeyedMutex();
  /** Per run: typing a prompt into its session (and recording it) and closing the session never interleave. */
  private readonly sessionLock = new KeyedMutex();
  private readonly demoTokens: DemoTokens;
  /** Archived build outputs; passes run when a run ends a turn or fails, and before any worktree prune. */
  readonly outputs: BuildOutputArchive;
  /** Stall watchdog per working (or starting) run: the screen hash, since when it is unchanged, when it was last read. */
  private readonly stallWatch = new Map<string, { hash: string | null; since: number; sampledAt: number }>();
  /**
   * Runs whose worktree.yml setup is running (in the runner) before their agent is spawned. They are
   * `starting` without a terminal on purpose, so the starting watchdog leaves them alone.
   */
  private readonly settingUp = new Set<string>();
  /** Runs whose completion pipeline (settle wait, checks, merge) is going; counted, passes can overlap. */
  private readonly pipelineBusyRuns = new Map<string, number>();
  /** Runs whose worktree auto-GC is tearing down in the background before it prunes it. */
  private readonly tearingDown = new Set<string>();
  /** How long a request waits for worktree.yml teardowns (overridable in tests). */
  readonly teardownBudgets = {
    request: REQUEST_TEARDOWN_BUDGET_MS,
    projectDelete: PROJECT_DELETE_TEARDOWN_BUDGET_MS,
  };
  /** Background teardown-then-prune jobs by worktree path, so a project delete can wait for them. */
  private readonly teardownJobs = new Map<string, Promise<void>>();
  private log?: RunServiceLogger;
  /**
   * The Docker engine sidecar (on unless `EMBERLINE_DOCKER_ENGINE=0`); runs and worktree.yml commands use it while
   * it answers.
   */
  readonly docker: DockerEngine;
  /** Compose previews' background starts by run id (cancelled by a stop or a new start). */
  private readonly composeJobs = new Map<string, ComposeJob>();
  /** One preview start or stop per run at a time. */
  private readonly previewRunLock = new KeyedMutex();
  /** Counts each run's preview starts, so a late cleanup never touches a newer start. */
  private readonly previewGenerations = new Map<string, number>();
  /** Port allocation and the `preview_started` record happen together, so two starts never share a port. */
  private readonly previewPortLock = new KeyedMutex();
  /** How long compose previews may build and take to answer (shortened in tests; main previews too). */
  composePreviewTiming: ComposePreviewTiming = { ...DEFAULT_COMPOSE_PREVIEW_TIMING };
  /** How long the agent's `preview` tool waits for a container preview to come up (tests shorten it). */
  agentPreviewWaitMs = AGENT_PREVIEW_WAIT_MS;
  /** At most one start per run from the `preview` tool in this long (tests shorten it). */
  agentPreviewCooldownMs = AGENT_PREVIEW_COOLDOWN_MS;
  /** When the `preview` tool last started each run's preview (ms epoch). */
  private readonly agentPreviewStarts = new Map<string, number>();
  /** The container previews of projects' main workspaces; they share the preview port allocator. */
  readonly mainPreviews: MainPreviews;
  /** Framing probes of the running previews (main and runs), one per start. */
  readonly framing = new PreviewFramingCache();
  /** Emberline's git with a forge account: the runner's git talks to it, core adds the credential. */
  readonly gitGateway: GitGateway;
  private dockerGcFirst?: NodeJS.Timeout;
  private dockerGcTimer?: NodeJS.Timeout;
  /** Unsubscribes the reconcile of interrupted main previews from the engine's changes (startReconciler). */
  private offDockerChange?: () => void;
  private dockerSweeping = false;
  private lastImagePruneAt = 0;
  /** The last image prune that succeeded (0 = none yet). */
  private lastImagePruneOkAt = 0;
  /** The last sweep that listed the engine, and what it removed (the Docker page shows them). */
  private lastDockerSweep: { at: number; removed: string[] } | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: CoreConfig,
    private readonly ptyd: PtydBridge,
    docker?: DockerEngine,
  ) {
    super();
    this.docker =
      docker ??
      new DockerEngine(config.dockerHost, {
        certPath: config.dockerCertPath,
        cwd: config.workspacesDir,
        switchedOff: config.dockerEngineSwitchedOff,
      });
    this.setMaxListeners(0); // one listener per open UI socket
    this.gitGateway = new GitGateway({
      baseUrl: config.gitGatewayUrl ?? config.hookUrl,
      runnerHosts: config.runnerHosts ?? ['runner'],
      containerNetworks: config.containerNetworks ?? [],
    });
    this.demoTokens = new DemoTokens(db);
    this.mainPreviews = new MainPreviews({
      db,
      config,
      docker: this.docker,
      envForMain: (projectId) => this.dockerEnvForMain(projectId),
      withPorts: (fn) => this.previewPortLock.run('ports', fn),
      allocatePort: (projectId, exclude) => this.allocateMainPreviewPort(projectId, exclude),
      timing: () => this.composePreviewTiming,
      framing: this.framing,
      log: () => this.log,
    });
    this.outputs = new BuildOutputArchive(db, config, {
      note: (runId, type, payload) => this.note(runId, type, payload),
    });
    // End of a turn (`done`) or of the run (`failed`): archive in the background; nothing waits for it.
    this.on('run', (run, stateChanged) => {
      if (stateChanged && (run.state === 'done' || run.state === 'failed')) this.outputs.archiveSoon(run.id);
    });
  }

  /** Where background failures (teardown) are logged besides their run event. */
  setLogger(log: RunServiceLogger): void {
    this.log = log;
  }

  /** Starts periodic reconciliation with ptyd. */
  startReconciler(): void {
    this.cancelOrphanedSetups(this.failOrphanedSpawns());
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.timer.unref();
    // Main previews whose start a restart cut short: running if the engine has them, else down and failed;
    // and those stored running whose containers vanished (an engine reset): down and failed, port free.
    // A pass the engine was down for is left alone, so it runs again whenever the engine turns available.
    void this.mainPreviews.reconcileInterrupted().catch(() => undefined);
    this.offDockerChange ??= this.docker.addChangeListener((status) => {
      if (status.available) void this.mainPreviews.reconcileInterrupted().catch(() => undefined);
    });
    if (this.docker.host) {
      this.dockerGcFirst = setTimeout(() => void this.sweepDockerProjects(), DOCKER_GC_FIRST_DELAY_MS);
      this.dockerGcFirst.unref();
      this.dockerGcTimer = setInterval(() => void this.sweepDockerProjects(), DOCKER_GC_INTERVAL_MS);
      this.dockerGcTimer.unref();
    }
  }

  dispose(): void {
    this.gitGateway.dispose();
    this.offDockerChange?.();
    this.offDockerChange = undefined;
    clearInterval(this.timer);
    clearTimeout(this.dockerGcFirst);
    clearInterval(this.dockerGcTimer);
  }

  /**
   * Runs left `starting` without a terminal hold a concurrency slot but are invisible to
   * reconciliation. At boot no spawn can be in flight, so all of them are orphans; later only the
   * ones older than {@link STARTING_WATCHDOG_MS}.
   */
  private failOrphanedSpawns(olderThanMs = 0): RunRow[] {
    const cutoff = Date.now() - olderThanMs;
    const stuck = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.state, 'starting'), isNull(runs.ptydSessionId), isNull(runs.endedAt)))
      .all()
      .filter((row) => row.stateChangedAt.getTime() <= cutoff && !this.settingUp.has(row.id));
    for (const row of stuck) {
      this.record(row.id, {
        source: 'system',
        type: 'spawn_lost',
        state: 'failed',
        payload: { reason: 'the agent never got a terminal' },
        patch: { endedAt: new Date() },
      });
    }
    return stuck;
  }

  /**
   * At boot: a worktree setup the previous core process started may still run in the runner. Its
   * command is killed once the runner is connected (ptyd protocol 3+; an older runner lets it run
   * until it ends or times out).
   */
  private cancelOrphanedSetups(lost: RunRow[]): void {
    const execIds = lost
      .filter(
        (row) =>
          this.db
            .select({ id: runEvents.id })
            .from(runEvents)
            .where(and(eq(runEvents.runId, row.id), eq(runEvents.type, 'worktree_setup_started')))
            .limit(1)
            .get() !== undefined,
      )
      .map((row) => setupExecId(row.id));
    if (execIds.length === 0) return;
    const cancel = () => {
      for (const execId of execIds) void cancelCommand(execId);
    };
    if (this.ptyd.status === 'connected') {
      cancel();
      return;
    }
    const onStatus = (status: string) => {
      if (status !== 'connected') return;
      this.ptyd.off('status', onStatus);
      cancel();
    };
    this.ptyd.on('status', onStatus);
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
    return this.withAttention(
      rows.map((row) => ({
        ...toRun(row),
        telemetry: this.computeTelemetryForRow(row, toolCountByRun.get(row.id) ?? 0),
      })),
    );
  }

  /** The events behind attention for these runs, in a fixed number of statements (see attention.ts). */
  loadAttentionFacts(ids: string[]): Map<string, AttentionFacts> {
    return loadAttentionFacts(this.db, ids);
  }

  /** `attention` and `reviewReady` of the given runs, from one batched load of their events. */
  withAttention(list: Run[]): Run[] {
    return attachAttention(this.db, list, (ids) => this.loadAttentionFacts(ids));
  }

  private readonly attentionMemo = new WeakMap<Run, Run>();

  /**
   * The run of an in-process `run` event with its attention (those payloads carry none). Memoised on
   * the emitted object, so every listener of one emit shares a single computation.
   */
  attentionOf(run: Run): Run {
    let hit = this.attentionMemo.get(run);
    if (!hit) {
      hit = this.withAttention([run])[0] as Run;
      this.attentionMemo.set(run, hit);
    }
    return hit;
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
      .map((e): RunEvent => ({
        id: e.id,
        runId: e.runId,
        ts: e.ts.toISOString(),
        source: e.source as EventSource,
        type: e.type,
        state: (e.state as RunState | null) ?? null,
        // The saved screen travels once, as `lastScreen`, not with every timeline entry.
        payload: e.type === 'last_screen' ? {} : (e.payload ?? null),
      }));
    const toolCalls = events.filter((e) => e.type === 'PreToolUse').length;
    const [withAttention] = this.withAttention([
      { ...toRun(row), telemetry: this.computeTelemetryForRow(row, toolCalls) },
    ]);
    return {
      ...(withAttention as Run),
      events,
      finalMessage: this.finalMessage(row),
      lastScreen: this.lastScreen(id),
    };
  }

  /**
   * The agent's last answer: the newest Stop hook message, or the transcript's last assistant
   * message when that copy is missing or was truncated (runs recorded before the limits were raised).
   */
  private finalMessage(row: RunRow): string | null {
    const stop = this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, row.id), eq(runEvents.type, 'Stop')))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    const payload = (stop?.payload ?? null) as { last_assistant_message?: unknown } | null;
    const fromHook =
      typeof payload?.last_assistant_message === 'string' ? payload.last_assistant_message : null;
    if (fromHook && !fromHook.endsWith('…')) return fromHook;
    const fromTranscript = row.transcriptPath
      ? readLastAssistantText(row.transcriptPath, this.config.transcriptsDir)
      : null;
    return fromTranscript ?? fromHook;
  }

  private lastScreen(runId: string): string | null {
    const event = this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'last_screen')))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    const screen = (event?.payload as { screen?: unknown } | null)?.screen;
    return typeof screen === 'string' ? screen : null;
  }

  /**
   * Keeps the last screen of an agent terminal as a run event before ptyd forgets the session, so
   * the agent's closing output stays readable after the terminal is gone.
   */
  private async saveLastScreen(runId: string, sessionId: string): Promise<void> {
    try {
      const snap = await this.ptyd.get().snapshot(sessionId, LAST_SCREEN_LINES);
      const lines = stripVTControlCharacters(snap.data ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trimEnd());
      while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
      const screen = lines.join('\n').slice(-LAST_SCREEN_MAX);
      if (screen.trim()) this.record(runId, { source: 'system', type: 'last_screen', payload: { screen } });
    } catch {
      // Snapshot unavailable (session already gone): nothing to keep.
    }
  }

  /** Saves the last screen, removes the ptyd session and ends the run as resumable (no cancel). */
  private async closeIdleSession(
    runId: string,
    sessionId: string,
    payload?: { reason: string },
  ): Promise<Run> {
    await this.saveLastScreen(runId, sessionId);
    await this.ptyd
      .get()
      .remove(sessionId)
      .catch(() => undefined);
    return this.record(runId, {
      source: 'system',
      type: 'idle_session_closed',
      state: 'done',
      payload,
      patch: { endedAt: new Date(), ptydSessionId: null },
    });
  }

  /**
   * Closes the session of a run the pipeline held for a person: the run ends but stays resumable
   * (not cancelled), so a later prompt respawns the agent. No-op when the run already ended, and when
   * its turn is no longer the finished one: a person prompted it since (typed, or already taken by
   * the CLI), so the agent is about to work again.
   */
  async closeHeldSession(id: string): Promise<Run> {
    return this.sessionLock.run(id, async () => {
      const row = this.row(id);
      const promptedSince = this.promptSentSince(id, latestDoneEventId(this.db, id));
      if (row.endedAt || !row.ptydSessionId || row.state !== 'done' || promptedSince) return this.getRun(id);
      return this.closeIdleSession(id, row.ptydSessionId, { reason: 'held' });
    });
  }

  /**
   * When the newest prompt typed into the run's session after the event `afterId` was sent; such a
   * prompt's `UserPromptSubmit` hook may not have arrived yet. Undefined when there is none.
   */
  private promptSentSince(runId: string, afterId: number | undefined): Date | undefined {
    return this.db
      .select({ ts: runEvents.ts })
      .from(runEvents)
      .where(
        and(eq(runEvents.runId, runId), eq(runEvents.type, 'prompt_sent'), gt(runEvents.id, afterId ?? 0)),
      )
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get()?.ts;
  }

  /** Id of the run's latest state change (an event records `state` only when it changed it). */
  private latestStateEventId(runId: string): number | undefined {
    return this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), isNotNull(runEvents.state)))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get()?.id;
  }

  /**
   * Whether the run's CLI exits once its turn is done: a headless CLI (not Claude Code) started with
   * a prompt (`-p`, `exec`, `--message`), as every respawn is. Text typed into it is lost.
   */
  private exitsAfterTurn(row: RunRow): boolean {
    if (providerAdapter(row.agent).claudeNative) return false;
    return row.prompt.trim() !== '' || this.hasEvent(row.id, 'respawning');
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
      new Intl.DateTimeFormat('en-CA', {
        timeZone: this.config.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
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

    const usage = row.transcriptPath
      ? readTranscriptUsage(row.transcriptPath, this.config.transcriptsDir)
      : null;
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
    return this.withAttention([toRun(this.row(id))])[0] as Run;
  }

  /** The route the run uses now (a legacy run's model comes from its prompt's route tag). */
  currentRoute(id: string): Route {
    return routeOfRow(this.row(id));
  }

  /**
   * Refuses (409 `headless_needs_auto`) a new run whose first lane is a headless CLI in a mode that
   * would ask. Callers that change state before {@link enqueue} check first; a lane picked later (a
   * fallback, a handoff) is checked when it spawns.
   */
  assertStartable(input: CreateRunBody, origin?: RunOrigin): void {
    if (origin?.routes) return;
    const body = CreateRunBodySchema.parse(input);
    const { route, prompt } = this.startRoute(input, body, origin);
    this.refuseHeadlessAsk(route.agent, body.permissionMode, prompt);
  }

  private refuseHeadlessAsk(agent: string, mode: PermissionMode, prompt: string): void {
    const problem = headlessModeProblem(agent, mode, prompt.length > 0);
    if (problem) throw conflict(problem, 'headless_needs_auto');
  }

  /** A new run's persona, lane chain, starting lane and prompt (without its route tag). */
  private startRoute(
    input: CreateRunBody,
    body: ReturnType<typeof CreateRunBodySchema.parse>,
    origin?: RunOrigin,
  ): { persona: AgentPersona; routes: Route[]; routeIndex: number; route: Route; prompt: string } {
    const persona = body.persona ?? 'coder';
    const tag = parseRouteTag(body.prompt ?? '');
    const explicitAgent = tag?.agent ?? input.agent;
    const explicitModel = (body.model && body.model !== 'auto' ? body.model : undefined) ?? tag?.model;
    // An agent picked by hand (no tag) runs only there.
    const resolved = (): Route[] => {
      const chain = resolveRunRoutes(
        this.db,
        persona,
        explicitAgent || explicitModel ? { agent: explicitAgent, model: explicitModel } : undefined,
      );
      return input.agent && !tag ? chain.slice(0, 1) : chain;
    };
    const routes = origin?.routes ?? resolved();
    const routeIndex = origin?.routeIndex ?? 0;
    const route = routes[routeIndex] ?? routes[0]!;
    const prompt = (body.prompt ?? '').replaceAll(new RegExp(ROUTE_TAG.source, 'gi'), '').trim();
    return { persona, routes, routeIndex, route, prompt };
  }

  /**
   * Prepares the worktree and records the run as `queued`. Nothing is spawned yet; the
   * scheduler calls {@link launch} once a slot and quota are available.
   */
  async enqueue(input: CreateRunBody, origin?: RunOrigin): Promise<Run> {
    const body = CreateRunBodySchema.parse(input);
    const project = this.db.select().from(projects).where(eq(projects.id, body.projectId)).get();
    if (!project) throw notFound('no such project');
    const { persona, routes, routeIndex, route, prompt } = this.startRoute(input, body, origin);
    // Before the worktree exists, so a refused start leaves nothing behind.
    if (!origin?.routes) this.refuseHeadlessAsk(route.agent, body.permissionMode, prompt);
    this.ptyd.get(); // fail fast (503) before touching git

    const id = randomUUID();
    const short = id.slice(0, 8);
    const workspace =
      origin?.worktree ??
      (await prepareWorkspace(
        project.path,
        path.join(this.config.workspacesDir, '.worktrees', project.slug, short),
        origin?.branch ?? `emberline/run-${short}`,
      ));
    // A fresh worktree (not in place, not a shared one) gets the approved worktree.yml's lifecycle:
    // `copy` now, before the run exists for the scheduler; `setup` at launch (spawnAgent).
    const lifecycle =
      !origin?.worktree && workspace.path !== project.path
        ? loadApprovedWorktreeConfig(this.db, project.id)
        : null;
    const copied =
      lifecycle && lifecycle.config.copy.length > 0
        ? await copyIntoWorktree(
            { trustedBase: this.config.workspacesDir, mainPath: project.path, worktreePath: workspace.path },
            lifecycle.config.copy,
          ).catch((error: unknown): CopyOutcome[] =>
            lifecycle.config.copy.map((entry) => ({
              path: entry.path,
              mode: entry.mode,
              status: 'skipped' as const,
              reason: `copy failed: ${(error as Error).message.slice(0, 200)}`,
            })),
          )
        : null;
    // Copied files git would not ignore could be committed by the agent (a copied `.env`, say).
    const notIgnored = copied
      ? await notIgnoredPaths(
          workspace.path,
          copied.filter((c) => c.status !== 'skipped').flatMap((c) => [c.path, ...(c.secrets ?? [])]),
        ).catch(() => null)
      : null;

    const now = new Date();
    this.db
      .insert(runs)
      .values({
        id,
        projectId: project.id,
        ticketId: origin?.ticketId ?? null,
        agent: route.agent,
        model: route.model,
        credential: route.credential,
        routes,
        routeIndex,
        predecessorRunId: origin?.predecessor?.id ?? null,
        handoffCount: origin?.predecessor ? origin.predecessor.handoffCount : 0,
        persona,
        state: 'queued',
        prompt,
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
    // Synchronous with the insert: no dispatch can launch the run before its setup is on record.
    if (lifecycle && copied) {
      this.note(id, 'worktree_copied', {
        sha256: lifecycle.sha256,
        entries: copied,
        ...(notIgnored ? { notIgnored } : {}),
      });
      for (const entry of copied.filter(overCopyCap)) {
        this.note(id, 'worktree_copy_skipped', { path: entry.path, reason: entry.reason });
      }
    }
    if (lifecycle && lifecycle.config.setup.length > 0) {
      this.note(id, 'worktree_setup_pending', { sha256: lifecycle.sha256, setup: lifecycle.config.setup });
    }
    return this.record(id, {
      source: 'system',
      type: 'queued',
      state: 'queued',
      ...(origin?.unattended ? { payload: { unattended: origin.unattended } } : {}),
    });
  }

  /** Whether no one watches the run: started by a cron job or a factory dispatch (its `queued` event says so). */
  unattendedOrigin(id: string): 'cron' | 'factory' | undefined {
    const event = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, id), eq(runEvents.type, 'queued')))
      .orderBy(asc(runEvents.id))
      .limit(1)
      .get();
    const origin = (event?.payload as { unattended?: unknown } | null | undefined)?.unattended;
    return origin === 'cron' || origin === 'factory' ? origin : undefined;
  }

  /**
   * Why a `waiting_input` run waits, if it is on a permission prompt or was found stalled (R6). Read
   * from the event that moved it into its current state and the hooks after it, not from
   * `lastEvent`: notes such as `auto_nudged` or `prompt_sent` overwrite that without changing state.
   */
  private waitingReason(id: string): 'Notification' | 'stall_detected' | undefined {
    const entered = this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, id), isNotNull(runEvents.state)))
      .orderBy(desc(runEvents.id))
      .limit(1)
      .get();
    if (!entered) return undefined;
    const reason = this.db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, id),
          gte(runEvents.id, entered.id),
          inArray(runEvents.type, ['Notification', 'stall_detected']),
        ),
      )
      .orderBy(asc(runEvents.id))
      .limit(1)
      .get();
    return reason?.type === 'Notification' || reason?.type === 'stall_detected' ? reason.type : undefined;
  }

  /** Whether the run already has an event of this type (e.g. a one-shot nudge that was sent). */
  /** The run's open AskUserQuestion picker, if any (see {@link openPicker}). */
  private openPicker(id: string): AskUserQuestionSummary | null {
    return openPicker(
      this.db
        .select({ type: runEvents.type, payload: runEvents.payload })
        .from(runEvents)
        .where(eq(runEvents.runId, id))
        .orderBy(desc(runEvents.id))
        .limit(200)
        .all(),
    );
  }

  hasEvent(id: string, type: string): boolean {
    return Boolean(
      this.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, id), eq(runEvents.type, type)))
        .limit(1)
        .get(),
    );
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
    let row = this.row(id);
    if (row.cancelledAt) throw conflict('this run was stopped; start a new run');
    if (row.handedOffTo)
      throw conflict(`this run was handed off to run ${row.handedOffTo.slice(0, 8)}; continue that one`);
    if (this.settingUp.has(id))
      throw conflict('the worktree is still being set up; the agent starts once setup is done');
    // A pending automatic retry is taken now (by the scheduler or the user's own resume).
    if (row.autoRetryAt) this.db.update(runs).set({ autoRetryAt: null }).where(eq(runs.id, id)).run();
    if (row.state === 'queued') return this.launch(id);
    row = await this.afterOneShotExit(row);
    if (row.ptydSessionId && !row.endedAt) {
      // Typed into a CLI that is starting or mid-turn, it would be taken as part of that turn (R9).
      if (!IDLE_STATES.has(row.state))
        throw conflict(`the agent is ${row.state}; continue it once it is waiting`);
      if (this.exitsAfterTurn(row)) throw conflict(SESSION_CLOSING, 'session_closing');
      const live = await this.sessionLock.run(id, async () => {
        const current = this.row(id);
        // A held run's close got there first: the agent is respawned below instead.
        if (!current.ptydSessionId || current.endedAt) return null;
        await this.typePrompt(current.ptydSessionId, text);
        return this.record(id, {
          source: 'system',
          type: 'resumed',
          state: 'starting',
          payload: { live: true },
        });
      });
      if (live) return live;
      row = this.row(id);
    }
    const mode = PROVIDER_RUNTIME[row.agent as AgentId]?.resumeMode ?? 'session';
    if (!row.agentSessionId && mode === 'session') {
      if (row.state === 'done') {
        // B19: a finished run's result stands; only this follow-up is impossible.
        this.note(id, 'resume_failed', { reason: 'no session' });
      } else {
        // E.g. rate limited without a session: it can never continue, so end it (or the scheduler retries forever).
        this.record(id, {
          source: 'system',
          type: 'resume_failed',
          state: 'failed',
          payload: { reason: 'no session' },
        });
      }
      throw conflict('this run has no agent session to resume; start a new run');
    }
    const previous = row.ptydSessionId;
    // Providers without session resume start a new conversation: it gets the handoff context first,
    // then the text (a bare "continue" adds nothing to it).
    let respawnPrompt = text;
    if (mode === 'fresh') {
      const context = buildHandoffPrompt(await this.handoffContext(row, 'the session ended', true));
      respawnPrompt = text === CONTINUE_PROMPT ? context : `${context}\n\n${text}`;
    }
    const run = await this.spawnAgent(row, {
      prompt: respawnPrompt,
      resumeSessionId: mode === 'fresh' ? undefined : (row.agentSessionId ?? undefined),
      type: 'resumed',
    });
    if (previous) {
      // The exited terminal is superseded by the new one.
      await this.ptyd
        .get()
        .remove(previous)
        .catch(() => undefined);
    }
    return run;
  }

  /**
   * Ends `id` and continues its work as a new run on `route`, in the same worktree and branch, with
   * a prompt that hands over what was done. The successor is inserted first, so every listener that
   * sees the predecessor turn `done` also sees `handedOffTo` and does not treat it as finished work.
   */
  async handOff(id: string, route: Route, opts: HandOffOptions): Promise<Run> {
    // One handoff per run at a time: the guards are re-read inside the lock, so a second caller sees `handedOffTo`.
    return this.handoffLock.run(id, () => this.handOffLocked(id, route, opts));
  }

  private async handOffLocked(id: string, route: Route, opts: HandOffOptions): Promise<Run> {
    const continuesHeld = () =>
      Boolean(opts.allowSystemFinishedCancel) && this.continuesInSuccessor(this.getRun(id));
    const row = this.row(id);
    const blocked = handoffBlocker(row, continuesHeld());
    if (blocked) throw conflict(blocked);
    const routes = [...runRoutes(row)];
    let routeIndex = routes.findIndex((r) => sameRoute(r, route));
    if (routeIndex < 0) {
      routes.push(route);
      routeIndex = routes.length - 1;
    }
    // Within the run prompt limit: the person's text whole, the context shortened (400 when it cannot fit).
    const prompt = successorPrompt(
      await this.handoffContext(row, opts.reason, false),
      opts.extraPrompt?.trim() ?? '',
    );
    // A person's handoff to a headless lane that would ask is refused before the run is retired; an
    // automatic one is checked when the successor spawns, as before (no mode is raised).
    if (opts.source === 'user')
      this.refuseHeadlessAsk(route.agent, row.permissionMode as PermissionMode, prompt);
    // A stop or a resume may have landed while the context was built: re-read before creating the
    // successor, so no orphan successor is left and the kill below reaches the current terminal.
    const current = this.row(id);
    const changed =
      handoffBlocker(current, continuesHeld()) ??
      (current.state !== row.state ? `the run is ${current.state} now` : undefined);
    if (changed) throw conflict(changed);
    const successor = await this.enqueue(
      {
        projectId: row.projectId,
        prompt,
        persona: row.persona as AgentPersona,
        permissionMode: row.permissionMode as Run['permissionMode'],
      },
      {
        ticketId: row.ticketId ?? undefined,
        title: row.title ?? undefined,
        worktree: { path: row.worktreePath, branch: row.branch },
        routes,
        routeIndex,
        predecessor: { id: row.id, handoffCount: row.handoffCount + (opts.automatic ? 1 : 0) },
        unattended: this.unattendedOrigin(row.id),
      },
    );
    this.note(successor.id, 'handoff_from', {
      fromRunId: row.id,
      reason: opts.reason,
      message: `Took over from ${row.agent} (${runModel(row) ?? 'auto'}): ${opts.reason}`,
    });
    const latest = this.row(id);
    const sessionId = latest.ptydSessionId && !latest.endedAt ? latest.ptydSessionId : null;
    this.record(row.id, {
      source: opts.source,
      type: 'handed_off',
      state: 'done',
      payload: {
        toRunId: successor.id,
        route,
        reason: opts.reason,
        message: `Handed off to ${route.agent} (${route.model}): ${opts.reason}`,
      },
      patch: { endedAt: latest.endedAt ?? new Date(), handedOffTo: successor.id, autoRetryAt: null },
    });
    if (sessionId) {
      await this.ptyd
        .get()
        .kill(sessionId)
        .catch(() => undefined);
    }
    return this.getRun(successor.id);
  }

  /**
   * Whether a held run continues in a successor on its worktree: it was cancelled by the pipeline's
   * finished-step stop alone (before held runs stayed resumable), was not handed off, and its worktree
   * still exists. A person's stop stays final.
   */
  continuesInSuccessor(run: Run): boolean {
    return (
      isHeldRun(run) &&
      run.cancelled &&
      !run.handedOffTo &&
      Boolean(run.worktreePath) &&
      existsSync(run.worktreePath) &&
      this.cancelledOnlyByFinishedStep(run.id)
    );
  }

  /**
   * Whether the run was cancelled by the pipeline's finished-step stop alone. Only stop decisions
   * count: every `stop_requested`, and a `cancelled` that carries a reason or came from a person
   * (stop() of a queued or setting-up run). Reconcile's `cancelled` that only notes the exit
   * (`{exitCode, signal}`, source system) follows a stop_requested and decides nothing.
   */
  cancelledOnlyByFinishedStep(runId: string): boolean {
    const decisions = this.db
      .select({ type: runEvents.type, source: runEvents.source, payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), inArray(runEvents.type, ['stop_requested', 'cancelled'])))
      .all()
      .map((e) => ({ ...e, reason: (e.payload as { reason?: unknown } | null)?.reason }))
      .filter((e) => e.type === 'stop_requested' || e.source !== 'system' || e.reason !== undefined);
    return (
      decisions.length > 0 && decisions.every((e) => e.source === 'system' && e.reason === FINISHED_STEP_STOP)
    );
  }

  /** Re-points a queued run at another route of its own chain (the scheduler's fallback for new runs). */
  bindRoute(id: string, routeIndex: number): Run {
    const row = this.row(id);
    if (row.state !== 'queued') throw conflict(`run is ${row.state}, not queued`);
    if (row.cancelledAt) throw conflict('this run was stopped');
    const route = runRoutes(row)[routeIndex];
    if (!route) throw conflict('no such route');
    return this.record(id, {
      source: 'system',
      type: 'route_bound',
      payload: {
        route,
        routeIndex,
        message: `Starting on ${route.agent} (${route.model}) because the first route is out of quota`,
      },
      patch: { agent: route.agent, model: route.model, credential: route.credential, routeIndex },
    });
  }

  /** Ticket, last answer, worktree state and recent tool calls for a handoff prompt. */
  private async handoffContext(row: RunRow, reason: string, sameAgent: boolean): Promise<HandoffPromptInput> {
    const ticket = row.ticketId
      ? this.db.select().from(tickets).where(eq(tickets.id, row.ticketId)).get()
      : undefined;
    const [gitStatus, diffStat] = await Promise.all([
      git(row.worktreePath, ['status', '--short']).catch(() => ''),
      git(row.worktreePath, ['diff', '--stat', 'HEAD']).catch(() => ''),
    ]);
    const toolEvents = this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, row.id), eq(runEvents.type, 'PreToolUse')))
      .orderBy(desc(runEvents.id))
      .limit(20)
      .all()
      .reverse();
    const recentTools = summarizeRecentTools(
      toolEvents.map((e) => {
        const p = (e.payload ?? {}) as {
          tool_name?: unknown;
          tool_input_summary?: unknown;
          message?: unknown;
        };
        const detail =
          typeof p.tool_input_summary === 'string'
            ? p.tool_input_summary
            : typeof p.message === 'string'
              ? p.message
              : '';
        return { name: typeof p.tool_name === 'string' ? p.tool_name : 'tool', detail: detail.slice(0, 200) };
      }),
    );
    return {
      ticket: ticket
        ? {
            key: ticket.key,
            title: ticket.title,
            body: ticket.body.replace(new RegExp(ROUTE_TAG.source, 'gi'), '').trim(),
          }
        : null,
      originalPrompt: row.prompt,
      from: { agent: row.agent, model: runModel(row) },
      reason,
      finalMessage: this.finalMessage(row),
      gitStatus,
      diffStat,
      recentTools,
      sameAgent,
    };
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
    // Without a login Claude Code would sit at its sign-in screen in the run's terminal, which looks
    // like a hang. Say so instead (the tests' fake CLI needs no login).
    if (row.agent === 'claude' && (this.config.claudeCommand ?? 'claude') === 'claude') {
      const auth = getFactorySettings(this.db).providerAuth?.claude;
      if (auth && !auth.authenticated) {
        const message =
          'Claude Code is not signed in. Log in under Settings → Multi-Agent & Model Matrix (CLI OAuth Login) or add an Anthropic API key there, then start the run again.';
        return this.record(row.id, {
          source: 'system',
          type: 'agent_not_signed_in',
          state: 'failed',
          payload: { reason: 'not_signed_in', message },
          patch: { endedAt: new Date() },
        });
      }
    }
    // Enqueue refuses this for the first lane; a lane picked later (a fallback, a handoff) or a run
    // from before that check would deny every command that needs approval, without telling anyone.
    const headless = headlessModeProblem(
      row.agent,
      row.permissionMode as PermissionMode,
      Boolean(options.prompt),
    );
    if (headless) {
      // A finished run's result stands; only this follow-up is refused.
      if (row.state === 'done') throw conflict(headless, 'headless_needs_auto');
      return this.record(row.id, {
        source: 'system',
        type: 'headless_needs_auto',
        state: 'failed',
        payload: { reason: 'headless_needs_auto', message: headless },
        patch: { endedAt: row.endedAt ?? new Date() },
      });
    }
    this.ptyd.get(); // fail fast (503) before the run is marked
    const hookToken = randomBytes(32).toString('base64url');
    // Mark as starting first so concurrent ticks never launch the same run twice.
    const starting = this.record(row.id, {
      source: 'system',
      type: options.type === 'spawned' ? 'launching' : 'respawning',
      state: 'starting',
      patch: { hookTokenHash: sha256(hookToken), endedAt: null },
    });

    // A fresh worktree's approved setup runs first, in the background: the caller (the scheduler's
    // dispatch, an API request) is not held for it, and the run stays `starting` meanwhile.
    const setup = options.type === 'spawned' ? this.pendingSetup(row.id) : null;
    if (setup) {
      this.settingUp.add(row.id);
      void this.setUpThenSpawn(row, project, options, hookToken, setup);
      return starting;
    }
    return this.spawnTerminal(
      row,
      project,
      options,
      hookToken,
      options.type === 'spawned' ? this.copyNote(row.id) : undefined,
    );
  }

  /** The first-prompt line about copied secrets git would not ignore, if any. */
  private copyNote(runId: string): string | undefined {
    const event = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'worktree_copied')))
      .orderBy(asc(runEvents.id))
      .limit(1)
      .get();
    const notIgnored = (event?.payload as { notIgnored?: unknown } | null | undefined)?.notIgnored;
    if (!Array.isArray(notIgnored)) return undefined;
    return unignoredSecretsNote(notIgnored.filter((p): p is string => typeof p === 'string')) ?? undefined;
  }

  /** The setup commands recorded at enqueue for a fresh worktree, if any. */
  private pendingSetup(runId: string): string[] | null {
    const event = this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'worktree_setup_pending')))
      .orderBy(asc(runEvents.id))
      .limit(1)
      .get();
    const setup = (event?.payload as { setup?: unknown } | null | undefined)?.setup;
    return Array.isArray(setup) && setup.length > 0 && setup.every((c) => typeof c === 'string')
      ? (setup as string[])
      : null;
  }

  /** Whether the run is still the one to set up: not stopped, ended or handed off meanwhile. */
  private setupGoesOn(runId: string): boolean {
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    return Boolean(row && row.state === 'starting' && !row.endedAt && !row.cancelledAt && !row.handedOffTo);
  }

  /**
   * Runs each setup command in order in the runner (10 min each), then spawns the agent. A failure
   * stops the setup but not the run: its first prompt says what failed. Never throws.
   */
  private async setUpThenSpawn(
    row: RunRow,
    project: typeof projects.$inferSelect,
    options: { prompt?: string; resumeSessionId?: string; type: 'spawned' | 'resumed' },
    hookToken: string,
    setup: string[],
  ): Promise<void> {
    try {
      let promptPrefix: string | undefined;
      this.note(row.id, 'worktree_setup_started', { commands: setup });
      const dockerEnv = await this.dockerEnvFor(row);
      const startedAt = Date.now();
      const deadline = startedAt + SETUP_TOTAL_MS;
      for (const [index, command] of setup.entries()) {
        if (!this.setupGoesOn(row.id)) return;
        const left = deadline - Date.now();
        if (left <= 0) {
          const skipped = setup.slice(index);
          this.note(row.id, 'worktree_setup_skipped', {
            commands: skipped,
            reason: `the whole setup may take ${SETUP_TOTAL_MS / 60_000} min`,
          });
          promptPrefix = setupSkippedPrefix(skipped);
          break;
        }
        const outcome = await runWorktreeCommand(
          command,
          row.worktreePath,
          Math.min(SETUP_TIMEOUT_MS, left),
          setupExecId(row.id),
          dockerEnv,
        );
        // Stopped meanwhile (its command was killed): nothing failed, and no agent starts.
        if (outcome.cancelled || !this.setupGoesOn(row.id)) return;
        if (!outcome.ok) {
          this.note(row.id, 'worktree_setup_failed', {
            command,
            exitCode: outcome.exitCode,
            tail: outcome.tail,
          });
          promptPrefix = setupFailurePrefix(outcome);
          break;
        }
      }
      if (!promptPrefix)
        this.note(row.id, 'worktree_setup_finished', {
          commands: setup.length,
          durationMs: Date.now() - startedAt,
        });
      if (!this.setupGoesOn(row.id)) return;
      const note = this.copyNote(row.id);
      const prefix = promptPrefix && note ? `${promptPrefix}\n\n${note}` : (promptPrefix ?? note);
      await this.spawnTerminal(this.row(row.id), project, options, hookToken, prefix);
    } catch (error) {
      // spawnTerminal records its own spawn failures; anything else ends the run here, not in 3 min.
      const current = this.db.select().from(runs).where(eq(runs.id, row.id)).get();
      if (current && !current.endedAt && !current.ptydSessionId) {
        this.record(row.id, {
          source: 'system',
          type: 'spawn_failed',
          state: 'failed',
          payload: { message: (error as Error).message },
          patch: { endedAt: new Date() },
        });
      }
    } finally {
      this.settingUp.delete(row.id);
    }
  }

  /** Spawns the agent's terminal for a run already marked `starting`. */
  private async spawnTerminal(
    row: RunRow,
    project: typeof projects.$inferSelect,
    options: { prompt?: string; resumeSessionId?: string; type: 'spawned' | 'resumed' },
    hookToken: string,
    promptPrefix?: string,
  ): Promise<Run> {
    const ptyd = this.ptyd.get();
    const persona = (row.persona as AgentPersona) ?? 'coder';
    const resolvedModel = (runModel(row) ??
      resolveModelForPersona(this.db, persona, undefined, row.agent as AgentId)) as AgentModelId;

    const dockerEnv = await this.dockerEnvFor(row);
    const personaPrompt =
      options.type === 'spawned' ? decoratePromptWithPersona(options.prompt, persona) : options.prompt;
    // A fresh start with a task learns about the Docker engine once; a resumed session already knows.
    const decorated =
      personaPrompt && options.type === 'spawned' && dockerEnv.DOCKER_HOST
        ? `${personaPrompt}\n\n${DOCKER_PROMPT_PARAGRAPH}`
        : personaPrompt;
    // A failed worktree setup leads the first prompt, so the agent fixes it as part of the ticket.
    const effectivePrompt = promptPrefix
      ? decorated
        ? `${promptPrefix}\n\n${decorated}`
        : promptPrefix
      : decorated;

    // A pre-0.2.0 row has no stored route: it gets the key it would have got then.
    const credential =
      row.routes.length === 0
        ? defaultCredentialFor(this.db, row.agent as AgentId)
        : (row.credential as Credential);
    const extraEnv = getProviderEnvFromSettings(this.db, row.agent, credential);
    // Antigravity AI credits are a setting in agy's shared settings.json; the CLI seed writes it per run.
    if (row.agent === 'antigravity')
      extraEnv.EMBERLINE_USE_CREDITS = row.credential === 'credits' ? '1' : '0';
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
      await ensureRunnerBrowserDaemon(this.ptyd, path.dirname(this.config.ptydSocket)).catch(() => null);
    }

    // The run's own worktree, never main: a QA run checks its own work. hookUrl is how the runner
    // reaches core (`http://core:7420` in compose); localhost is the runner itself.
    const demoUrl = agentDemoUrl(this.config, this.demoTokens, row.projectId, row.id);
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
        // Only a fresh start carries the ticket prompt; a resumed session already has the instruction.
        ticketRun: options.type === 'spawned' && !!row.ticketId,
        customMcpServers:
          isRealClaude && Object.keys(customMcpServers).length > 0 ? customMcpServers : undefined,
        extraSystemPrompt: activeSkillPrompt || undefined,
      },
    });

    const personaPrefix =
      persona !== 'coder' && PERSONA_CATALOG[persona] ? `[${PERSONA_CATALOG[persona].shortLabel}] ` : '';
    const modelSuffix =
      isRealClaude && resolvedModel && resolvedModel !== 'auto' ? ` (${resolvedModel})` : '';
    const hookFile = path.join(path.dirname(this.config.ptydSocket), 'playwright-hook.cjs');
    const playwrightEnv: Record<string, string> =
      enablePlaywrightMcp && isRealClaude ? { NODE_OPTIONS: `--require ${hookFile}` } : {};
    try {
      const session = await ptyd.spawn({
        file: spec.file,
        args: spec.args,
        cwd: row.worktreePath,
        env: {
          ...spec.env,
          ...extraEnv,
          ...playwrightEnv,
          ...dockerEnv,
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
      const after = this.row(row.id);
      if (after.cancelledAt || after.handedOffTo) {
        // Stopped or handed off while the terminal was being created: end it now instead of letting it work.
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

        const shortTool = isPlaywrightMcp ? toolName.replace(/^mcp__playwright__/, '') : 'playwright_cli';
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

  /**
   * Projects whose agent is using a browser now (a working run with a browser tool call in the last
   * minute), each with the URL its agent navigated to last. The Live Browser follows an agent's tab
   * only while exactly one project has one (core cannot tell which tab another project's agent
   * drives in the shared Chromium), and prefers the tab at that URL.
   */
  browserAgentActivity(now = Date.now()): Map<string, BrowserAgentActivity> {
    const since = new Date(now - BROWSER_AGENT_WINDOW_MS);
    const rows = this.db
      .select({ projectId: runs.projectId, payload: runEvents.payload, ts: runEvents.ts })
      .from(runEvents)
      .innerJoin(runs, eq(runs.id, runEvents.runId))
      .where(and(eq(runs.state, 'working'), eq(runEvents.type, 'PreToolUse'), gte(runEvents.ts, since)))
      .all();
    return browserAgentActivity(
      rows.map((r) => {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        return {
          projectId: r.projectId,
          toolName: typeof p.tool_name === 'string' ? p.tool_name : '',
          detail: typeof p.tool_input_summary === 'string' ? p.tool_input_summary : '',
          at: r.ts.getTime(),
        };
      }),
      now,
    );
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
    const live = !row.endedAt && !row.cancelledAt;
    // The agent is alive: the stall watchdog starts over.
    if (live) this.stallWatch.delete(row.id);
    // The run's agent and model decide how its limit messages read and which quota pool they hit.
    const limitCtx = { agent: row.agent, model: runModel(row) };
    let next = live
      ? nextStateFromHook(row.state as AgentState, envelope.event, envelope.payload, limitCtx)
      : undefined;
    // A temporary provider error: wait as `rate_limited` (no slot, no quota window) and let the
    // scheduler retry the turn, a few times with growing delays.
    const transient = live ? transientErrorFromHook(envelope.event, envelope.payload, limitCtx) : undefined;
    let retry: { attempt: number; at: Date } | undefined;
    if (transient && row.autoRetryCount < AUTO_RETRY_DELAYS_MS.length) {
      const attempt = row.autoRetryCount + 1;
      retry = { attempt, at: new Date(Date.now() + (AUTO_RETRY_DELAYS_MS[attempt - 1] ?? 0)) };
      next = row.state === 'rate_limited' ? undefined : 'rate_limited';
      patch.autoRetryCount = attempt;
      patch.autoRetryAt = retry.at;
    } else if (envelope.event === 'Stop' && (row.autoRetryCount > 0 || row.autoRetryAt)) {
      // The turn finished: later errors get their full set of retries again.
      patch.autoRetryCount = 0;
      patch.autoRetryAt = null;
    }
    const summary = summarizePayload(payload);
    // Claude's open question picker raises a permission prompt: the Notification carries the picker's
    // questions, so attention shows it as the agent's question rather than a permission.
    if (envelope.event === 'Notification' && isPermissionNotification(payload)) {
      const ask = this.openPicker(row.id);
      if (ask) summary.ask_user_question = ask;
    }
    const run = this.record(row.id, {
      source: 'hook',
      type: envelope.event,
      state: next,
      payload: summary,
      patch,
    });
    if (retry && transient) {
      const max = AUTO_RETRY_DELAYS_MS.length;
      const minutes = Math.round((retry.at.getTime() - Date.now()) / 60_000);
      this.note(row.id, 'retry_scheduled', {
        attempt: retry.attempt,
        max,
        retryAt: retry.at.toISOString(),
        reason: transient.message,
        message: `Temporary provider error; retrying in ${minutes} min (attempt ${retry.attempt}/${max}): ${transient.message}`,
      });
      return this.getRun(row.id);
    }
    if (transient) {
      this.note(row.id, 'retry_gave_up', {
        attempts: row.autoRetryCount,
        reason: transient.message,
        message: `Gave up after ${row.autoRetryCount} automatic retries: ${transient.message}`,
      });
    }
    if (next === 'rate_limited') {
      this.emit(
        'rateLimited',
        run,
        rateLimitFromHook(envelope.event, envelope.payload, new Date(), this.config.timeZone, limitCtx),
      );
    }
    return run;
  }

  /**
   * Stops a run for good: cancels a queued run, ends a rate-limited one waiting for its window, or
   * terminates the agent process (reconciliation records the end). A stopped run never resumes,
   * and hooks arriving after the stop do not change its state.
   */
  async stop(id: string, opts: { source?: 'user' | 'system'; reason?: string } = {}): Promise<Run> {
    const source = opts.source ?? 'user';
    const reasonPayload = opts.reason ? { reason: opts.reason } : undefined;
    const row = this.row(id);
    const cancelledAt = row.cancelledAt ?? new Date();
    const live = Boolean(row.ptydSessionId && !row.endedAt);
    if (row.state === 'queued' || (!live && row.state === 'rate_limited')) {
      return this.record(id, {
        source,
        type: 'cancelled',
        state: 'failed',
        payload: reasonPayload,
        patch: { endedAt: row.endedAt ?? new Date(), cancelledAt },
      });
    }
    if (row.endedAt) return this.withAttention([toRun(row)])[0] as Run;
    if (this.settingUp.has(id) && !row.ptydSessionId) {
      // Still in worktree setup: no agent to stop yet. The running setup command is killed (on a
      // runner older than ptyd protocol 3 it runs out); the setup then ends without spawning.
      const stopped = this.record(id, {
        source,
        type: 'cancelled',
        state: 'failed',
        payload: reasonPayload,
        patch: { endedAt: new Date(), cancelledAt },
      });
      await cancelCommand(setupExecId(id));
      return stopped;
    }
    // Live, or still spawning (no terminal yet): spawnAgent checks the flag once the terminal exists.
    const run = this.record(id, {
      source,
      type: 'stop_requested',
      payload: reasonPayload,
      patch: { cancelledAt },
    });
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

  /**
   * The agent's `ticket_complete` call. Same credential as hooks. Recorded as a protected run event
   * and, for a ticket run, as the ticket's completion (latest wins).
   */
  recordCompletion(runId: string, token: string | undefined, input: TicketCompleteBody): void {
    const row = this.liveRunForAgent(runId, token);
    const body = TicketCompleteBody.parse(input);
    if (row.ticketId) {
      const now = new Date();
      const completion: TicketCompletion = { runId, ...body, at: now.toISOString() };
      this.db.update(tickets).set({ completion, updatedAt: now }).where(eq(tickets.id, row.ticketId)).run();
    }
    // After the ticket row: TicketService broadcasts the ticket on this note.
    this.note(runId, 'ticket_complete', {
      summary: body.summary,
      handoff: body.handoff,
      blockers: body.blockers,
    });
  }

  /**
   * The `emberline-mcp` server's check-in when the agent's CLI starts it: this run's agent has the
   * `ticket_complete` tool, so the completion gate may wait for it. Noted once per run (protected
   * from pruning); a later check-in (a resumed session starts the server again) changes nothing.
   */
  recordCompletionToolReady(runId: string, token: string | undefined): void {
    this.liveRunForAgent(runId, token);
    if (this.hasEvent(runId, 'completion_tool_ready')) return;
    this.note(runId, 'completion_tool_ready');
  }

  /**
   * The agent's `preview` tool: starts the run's own preview if it does not run, waits (bounded by
   * {@link agentPreviewWaitMs}) for a container start to end, and answers the runner-side URL. Same
   * credential as hooks, so a run only ever acts on its own preview.
   */
  async agentPreview(
    runId: string,
    token: string | undefined,
    rawBody: unknown,
  ): Promise<AgentPreviewResponse> {
    const row = this.liveRunForAgent(runId, token);
    const parsed = AgentPreviewBody.safeParse(rawBody ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    return agentPreview(
      {
        status: () => this.previewStatus(row.id),
        start: () => this.startPreview(row.id, {}, undefined, 'hook'),
        pendingStart: () => this.composeJobs.get(row.id)?.done,
        nothingToPreview: () =>
          approvedPreviewService(this.db, row.projectId) ||
          this.detectPreviewCommand(row.projectId, row.worktreePath)
            ? null
            : 'this run has no preview: the approved worktree.yml has no preview service and package.json no dev, start or preview script',
        browserUrl: () =>
          resolveBrowserUrl(
            {
              db: this.db,
              config: this.config,
              runPreviewStatus: (id) => this.previewStatus(id),
              mainPreviews: this.mainPreviews,
              demoTokens: this.demoTokens,
            },
            row.projectId,
            row.id,
          ),
        waitMs: this.agentPreviewWaitMs,
        lastStartAt: () => this.agentPreviewStarts.get(row.id),
        recordStart: (at) =>
          at === undefined ? this.agentPreviewStarts.delete(row.id) : this.agentPreviewStarts.set(row.id, at),
        cooldownMs: this.agentPreviewCooldownMs,
      },
      parsed.data,
    );
  }

  /** The run an agent-side call (hook token) is for: 404 unknown, 401 wrong token, 409 ended. */
  private liveRunForAgent(runId: string, token: string | undefined): RunRow {
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) throw new HttpError(404, 'not_found', 'run not found');
    if (!token || !tokenMatches(token, row.hookTokenHash)) {
      throw new HttpError(401, 'unauthorized', 'invalid hook token');
    }
    if (row.endedAt || row.cancelledAt) throw new HttpError(409, 'run_ended', 'the run has ended');
    return row;
  }

  /**
   * The run's completion signal of the current turn: the newest `ticket_complete` payload, only if
   * it is newer than the run's latest `UserPromptSubmit` (a person's reply or an automatic prompt
   * starts a new turn, which must signal again).
   */
  latestCompletion(runId: string): { summary: string; handoff: string; blockers: string[] } | null {
    const newest = (type: string) =>
      this.db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
        .orderBy(desc(runEvents.id))
        .limit(1)
        .get();
    const signal = newest('ticket_complete');
    if (!signal) return null;
    const prompt = newest('UserPromptSubmit');
    if (prompt && prompt.id > signal.id) return null;
    const p = (signal.payload ?? {}) as { summary?: string; handoff?: string; blockers?: string[] };
    return { summary: p.summary ?? '', handoff: p.handoff ?? '', blockers: p.blockers ?? [] };
  }

  /** Appends an informational system event (no state change) to a run's timeline. */
  note(id: string, type: string, payload?: unknown): void {
    let run: Run;
    try {
      run = this.record(id, { source: 'system', type, payload });
    } catch {
      // The run was removed meanwhile.
      return;
    }
    this.emit('note', run, type, payload);
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
      .where(and(eq(runs.ticketId, ticketId), runStillActive()))
      .orderBy(desc(runs.createdAt))
      .get();
    return row ? (this.withAttention([toRun(row)])[0] as Run) : undefined;
  }

  latestRunForTicket(ticketId: string): Run | undefined {
    const row = this.db
      .select()
      .from(runs)
      .where(eq(runs.ticketId, ticketId))
      .orderBy(desc(runs.createdAt))
      .get();
    return row ? (this.withAttention([toRun(row)])[0] as Run) : undefined;
  }

  /**
   * Types a follow-up prompt into the live agent session and submits it. Multi-line text is
   * sent as a bracketed paste so embedded newlines don't submit early. The resulting
   * `UserPromptSubmit` hook moves the run back to `working`.
   *
   * A CLI that is still starting may drop typed text, so prompts wait until it is ready. A person's
   * prompt during a turn is queued by the CLI; Emberline's own (`automatic`) prompts wait for an
   * idle CLI instead, so they never land in the middle of a turn (R9).
   */
  async sendPrompt(id: string, text: string, opts: { automatic?: boolean } = {}): Promise<Run> {
    // Typed and recorded before a held run's close looks at the session (closeHeldSession, the idle sweep).
    return this.sessionLock.run(id, async () => {
      const row = this.row(id);
      if (!row.ptydSessionId || row.endedAt) throw conflict('the agent session has ended; start a new run');
      if (row.cancelledAt) throw conflict('this run was stopped; start a new run');
      // A one-shot CLI exits after its turn: typed into it, the prompt would be lost with no one told.
      if (this.exitsAfterTurn(row)) throw conflict(SESSION_CLOSING, 'session_closing');
      if (row.state === 'starting')
        throw conflict('the agent is still starting; send your prompt once it is ready');
      if (opts.automatic && !IDLE_STATES.has(row.state))
        throw conflict(`the agent is ${row.state}; not interrupting it`);
      const stateBefore = this.latestStateEventId(id);
      await this.typePrompt(row.ptydSessionId, text);
      const run = this.record(id, { source: 'user', type: 'prompt_sent', payload: { length: text.length } });
      // The CLI may already have taken the prompt and stopped again: its state changes decided then.
      if (this.latestStateEventId(id) === stateBefore) this.emit('prompted', run);
      return run;
    });
  }

  /**
   * A pass that sees the present: one already running may have listed the sessions before the exit
   * that matters, so it is waited out first. A pass someone started meanwhile also began after it.
   */
  private async reconcileNow(): Promise<void> {
    if (this.reconcilePass) await this.reconcilePass;
    if (this.reconcilePass) return this.reconcilePass;
    await this.reconcile();
  }

  /**
   * The run, re-read after a reconcile when its CLI is a one-shot one whose session is still open: it
   * may have finished its turn and be about to exit. Once its exit is noted, a prompt respawns it.
   */
  private async afterOneShotExit(row: RunRow): Promise<RunRow> {
    if (!row.ptydSessionId || row.endedAt || !this.exitsAfterTurn(row)) return row;
    await this.reconcileNow();
    return this.row(row.id);
  }

  /**
   * Marks a run's completion pipeline as going (true) or finished (false; calls are counted). The idle
   * sweep leaves such a run open: the merge may still need the agent to resolve a conflict.
   */
  pipelineBusy(id: string, busy: boolean): void {
    const left = (this.pipelineBusyRuns.get(id) ?? 0) + (busy ? 1 : -1);
    if (left > 0) this.pipelineBusyRuns.set(id, left);
    else this.pipelineBusyRuns.delete(id);
  }

  /**
   * Sends a follow-up prompt to a run: types into the live PTY when running, or respawns
   * `claude --resume` when the process has ended.
   */
  async prompt(id: string, text: string, opts: { automatic?: boolean } = {}): Promise<Run> {
    let row = this.row(id);
    if (row.state === 'queued') throw conflict('the agent has not started yet; it is queued');
    // Also while it respawns for a resume: a second resume would start another agent.
    if (row.state === 'starting')
      throw conflict('the agent is still starting; send your prompt once it is ready');
    row = await this.afterOneShotExit(row);
    if (row.ptydSessionId && !row.endedAt) return this.sendPrompt(id, text, opts);
    if (!row.agentSessionId) throw conflict('no agent session to continue; start a new run');
    return this.resume(id, text);
  }

  /** Raw keys into a live session (an open picker); no paste brackets, no submit. */
  async sendKeys(id: string, keys: string): Promise<void> {
    return this.sessionLock.run(id, async () => {
      const row = this.row(id);
      if (!row.ptydSessionId || row.endedAt) throw conflict('the agent session has ended; start a new run');
      if (row.cancelledAt) throw conflict('this run was stopped; start a new run');
      await this.ptyd.get().write(row.ptydSessionId, keys);
    });
  }

  /**
   * Types `text` into the agent's terminal. Controls are stripped first (newline and tab stay): an
   * ESC or C1 control from the content (agent-controlled build output, paths, code) could otherwise
   * end the bracketed paste and inject keystrokes.
   */
  private async typePrompt(sessionId: string, raw: string): Promise<void> {
    const ptyd = this.ptyd.get();
    const text = stripControlChars(raw.replace(/\r\n?/g, '\n'));
    // Outside a paste a tab would be a keystroke (completion in the CLI): it is typed as a space.
    const input = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text.replace(/\t/g, ' ');
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

  /** Content hash of one file as the diff listing reports it (null when unhashable). */
  async fileHash(id: string, relPath: string): Promise<string | null> {
    const row = this.row(id);
    return hashWorktreeFile(row.worktreePath, this.defaultBranch(row.projectId), relPath);
  }

  /** Branch-diff hashes of the given files that are in the diff (others absent); null when the worktree is gone. */
  async reviewHashes(id: string, relPaths: readonly string[]): Promise<Map<string, string> | null> {
    const row = this.row(id);
    return reviewFileHashes(row.worktreePath, this.defaultBranch(row.projectId), relPaths);
  }

  /** One side of a file (worktree or base branch) for re-anchoring review comments; null when absent, throws when unreadable or over 2 MB. */
  async reviewSide(id: string, relPath: string, side: 'modified' | 'original'): Promise<string | null> {
    const row = this.row(id);
    return readReviewSide(row.worktreePath, this.defaultBranch(row.projectId), relPath, side);
  }

  async stage(id: string, body: GitStageBody): Promise<RunDiffSummary> {
    const row = this.row(id);
    await stageWorktreeFiles(row.worktreePath, body);
    return this.diff(id, 'branch');
  }

  async commit(id: string, body: GitCommitBody): Promise<GitCommitResponse> {
    const row = this.row(id);
    const fSettings = effectiveFactorySettings(this.db, row.projectId);
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
    const project = this.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    // The account goes only to the project's own repository URL, never to an origin an agent set.
    const credential = project?.repoUrl ? gitCredentialForRemote(this.db, project.repoUrl) : null;
    const account =
      credential && project?.repoUrl
        ? { gateway: this.gitGateway, projectId: project.id, url: project.repoUrl, credential }
        : null;
    let res: GitPushResponse;
    try {
      res = await pushWorktreeBranch(
        row.worktreePath,
        row.branch,
        this.defaultBranch(row.projectId),
        account,
      );
    } catch (error) {
      if (!project?.repoUrl && error instanceof HttpError) {
        const origin = await execGitFile(['remote', 'get-url', 'origin'], { cwd: row.worktreePath }).then(
          (r) => r.stdout.trim(),
          () => '',
        );
        if (ACCESS_FAILURE.test(error.message) && origin && accountForGitRemote(this.db, origin)) {
          throw new HttpError(
            error.statusCode,
            error.code,
            `${error.message} ${CONNECT_FOR_ACCOUNT}`,
            error.details,
          );
        }
      }
      throw error;
    }
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

  async buildOutputs(id: string): Promise<RunBuildOutputsResponse> {
    const row = this.row(id);
    const hostRoot = this.config.workspacesHostDir;
    const hostWorktreePath =
      hostRoot && row.worktreePath.startsWith(`${this.config.workspacesDir}/`)
        ? path.join(hostRoot, path.relative(this.config.workspacesDir, row.worktreePath))
        : null;
    return {
      worktreePath: row.worktreePath,
      hostWorktreePath,
      outputs: await this.listOwnBuildOutputs(row.worktreePath),
      archivedCount: this.outputs.archivedCount(id),
    };
  }

  /**
   * listBuildOutputs for a worktree that really is where it should be under the workspaces root;
   * one an agent swapped for a symlink is not walked (nothing is listed).
   */
  private async listOwnBuildOutputs(worktreePath: string): Promise<RunBuildOutput[]> {
    const real = await realDirUnder(this.config.workspacesDir, worktreePath).catch(() => null);
    return real ? listBuildOutputs(worktreePath) : [];
  }

  /**
   * Opens a build output for download; only files the lister reports as deliverables qualify. The
   * file is opened once without following links and streamed from that descriptor, so an agent
   * cannot swap a symlink in after the check (the worktree is agent-writable).
   */
  async openBuildOutput(
    id: string,
    relPath: string,
  ): Promise<{ stream: Readable; fileName: string; size: number }> {
    const row = this.row(id);
    const { rel } = resolveSafeWorktreePath(row.worktreePath, relPath);
    const outputs = await this.listOwnBuildOutputs(row.worktreePath);
    const match = outputs.find((o) => o.path === rel);
    if (!match) throw notFound('no such build output');
    const opened = await openFileUnder(this.config.workspacesDir, row.worktreePath, rel).catch(() => null);
    if (!opened) throw notFound('no such build output');
    return { stream: streamOpenedFile(opened), fileName: match.name, size: opened.size };
  }

  async readArtifact(
    id: string,
    relPath: string,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const row = this.row(id);
    return readWorktreeArtifact(row.worktreePath, relPath);
  }

  /** Another run (e.g. a handoff successor) working in the same worktree. */
  private worktreeSharedWith(row: RunRow, opts: { stillRunning?: boolean } = {}): RunRow | undefined {
    const sharing = and(eq(runs.worktreePath, row.worktreePath), ne(runs.id, row.id));
    return this.db
      .select()
      .from(runs)
      .where(opts.stillRunning ? and(sharing, runStillActive()) : sharing)
      .get();
  }

  /**
   * Prunes the linked git worktree (`/workspaces/.worktrees/...`) for an ended run, keeping
   * the run record and git branch intact. Active runs must be stopped first.
   */
  async pruneWorktree(id: string, rawBody?: PruneWorktreeBody): Promise<PruneWorktreeResponse> {
    const { force } = PruneWorktreeBodySchema.parse(rawBody ?? {});
    let row = this.row(id);
    if (!row.endedAt) {
      await this.reconcile();
      row = this.row(id);
    }
    if (!row.endedAt && row.state !== 'done' && row.state !== 'failed') {
      throw conflict('stop the active run before pruning its worktree');
    }
    if (row.state === 'rate_limited' && !row.cancelledAt) {
      throw conflict('this run is waiting for its quota and will resume in this worktree; stop it first');
    }
    // Only a sharer that is still active blocks a manual prune; two ended runs must not lock each other out.
    const shared = this.worktreeSharedWith(row, { stillRunning: true });
    if (shared) throw conflict(`run ${shared.id.slice(0, 8)} still works in this worktree`);
    const project = this.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project) throw notFound('no such project');
    if (!force && row.worktreePath !== project.path) {
      const found = await this.worktreeWorkReason(row.worktreePath, project);
      if (found) {
        const { reason, branch } = found;
        throw new HttpError(
          409,
          'worktree_has_work',
          reason === 'uncommitted_changes'
            ? 'This worktree has uncommitted changes that pruning would delete.'
            : `This worktree has commits that are not in ${branch ?? 'the main branch'} yet. Merge the branch first, or prune anyway.`,
        );
      }
    }
    // Its teardown runs already (an earlier prune, auto-GC): the prune follows it.
    if (this.tearingDown.has(id))
      return { runId: id, worktreePath: row.worktreePath, removed: false, pending: true };
    // Deliverables in git-ignored build directories exist only here: archive them first.
    if (row.worktreePath !== project.path) await this.outputs.archiveBeforePrune(id);
    const recordPruned = (removed: boolean) => {
      if (removed) {
        this.record(id, {
          source: 'user',
          type: 'worktree_pruned',
          payload: { worktreePath: row.worktreePath },
        });
      }
    };
    if (row.worktreePath !== project.path && this.needsTeardown(project.id, row.worktreePath)) {
      // Teardown commands and compose downs may take minutes: the request waits a bounded time, the rest is background.
      let removed = false;
      const job = this.teardownThenPrune(row, project, (r) => {
        removed = r;
        recordPruned(r);
      });
      const done = await settlesWithin(job, this.teardownBudgets.request);
      return { runId: id, worktreePath: row.worktreePath, removed, ...(done ? {} : { pending: true }) };
    }
    const removed = await this.pruneRunWorktree(project.path, row.worktreePath);
    recordPruned(removed);
    return { runId: id, worktreePath: row.worktreePath, removed };
  }

  /**
   * Teardown, then the worktree's compose projects, then prune, then `after`, as one background job:
   * guarded by `tearingDown` so no other path starts it again, and listed in `teardownJobs` so a
   * project delete can wait for it. Never rejects.
   */
  private teardownThenPrune(
    row: RunRow,
    project: { id: string; path: string },
    after: (removed: boolean) => unknown,
  ): Promise<void> {
    this.tearingDown.add(row.id);
    const job: Promise<void> = this.teardownWorktree(row, project)
      // Best effort: a teardown that throws must not leave the worktree behind.
      .catch(() => undefined)
      .then(() => this.downWorktreeComposeProjects(row))
      .catch(() => undefined)
      .then(() => this.pruneRunWorktree(project.path, row.worktreePath))
      .catch(() => false)
      .then(async (removed) => {
        await after(removed);
      })
      .catch(() => undefined)
      .finally(() => {
        this.tearingDown.delete(row.id);
        if (this.teardownJobs.get(row.worktreePath) === job) this.teardownJobs.delete(row.worktreePath);
      });
    this.teardownJobs.set(row.worktreePath, job);
    return job;
  }

  /**
   * Runs the approved worktree.yml's `teardown` commands in a worktree that is about to be pruned
   * (after its outputs were archived). Best effort, 2 min each: a failure is a run event and the
   * prune goes ahead.
   */
  private async teardownWorktree(row: RunRow, project: { id: string; path: string }): Promise<void> {
    if (!row.worktreePath || row.worktreePath === project.path || !existsSync(row.worktreePath)) return;
    const teardown = loadApprovedWorktreeConfig(this.db, project.id)?.config.teardown ?? [];
    for (const command of teardown) {
      const outcome = await runWorktreeCommand(
        command,
        row.worktreePath,
        TEARDOWN_TIMEOUT_MS,
        undefined,
        await this.dockerEnvFor(row),
      );
      if (!outcome.ok) {
        this.note(row.id, 'worktree_teardown_failed', {
          command,
          exitCode: outcome.exitCode,
          tail: outcome.tail,
        });
        this.log?.warn(
          {
            runId: row.id,
            projectId: project.id,
            command,
            exitCode: outcome.exitCode,
            tail: outcome.tail.slice(-500),
          },
          'worktree.yml teardown command failed; the worktree is pruned anyway',
        );
      }
    }
  }

  /**
   * The Docker client variables and the run's compose project while the engine answers; nothing
   * otherwise. Right after boot it waits (bounded) for the first probe.
   */
  async dockerEnvFor(run: { id: string; worktreePath: string }): Promise<Record<string, string>> {
    await this.docker.ready();
    return this.docker.runEnv(composeProjectName(run.id, run.worktreePath));
  }

  /** The same for Build & Verify on a project's main workspace (project `emberline-main-<id8>`). */
  async dockerEnvForMain(projectId: string): Promise<Record<string, string>> {
    await this.docker.ready();
    return this.docker.runEnv(mainComposeProjectName(projectId));
  }

  /** Whether the approved worktree.yml has teardown commands for this project. */
  private hasTeardown(projectId: string): boolean {
    return (loadApprovedWorktreeConfig(this.db, projectId)?.config.teardown.length ?? 0) > 0;
  }

  /** A prune of this worktree has work before the removal: teardown commands, or the Docker cleanup. */
  private needsTeardown(projectId: string, worktreePath: string): boolean {
    return (this.hasTeardown(projectId) && existsSync(worktreePath)) || Boolean(this.docker.host);
  }

  /**
   * `down -v --rmi local --remove-orphans` for each compose project in `names`, a few at a time, each
   * capped at 2 min. Best effort: a failure is logged, and a `worktree_teardown_failed` note on `noteRunId`.
   */
  private async downComposeProjects(names: Iterable<string>, noteRunId: string | null): Promise<void> {
    const env = this.docker.cliEnv();
    if (!env.DOCKER_HOST) return;
    const queue = [...new Set(names)];
    const worker = async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const down = await composeDown(name, env, CLEANUP_DOWN);
        if (down.ok) continue;
        const command = `docker ${composeDownArgs(name, CLEANUP_DOWN).join(' ')}`;
        if (noteRunId)
          this.note(noteRunId, 'worktree_teardown_failed', {
            command,
            exitCode: down.exitCode,
            tail: down.output,
          });
        this.log?.warn(
          { runId: noteRunId, project: name, output: down.output.slice(-500) },
          'docker compose down failed; the worktree is pruned anyway',
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(COMPOSE_DOWN_CONCURRENCY, queue.length) }, worker));
  }

  /**
   * Before a run worktree is pruned (after its teardown commands): the worktree's compose project
   * (the agent's) and the preview project of every run that works in it, with their volumes. A
   * preview still starting is cancelled first, so it cannot bring containers back.
   */
  private async downWorktreeComposeProjects(row: RunRow): Promise<void> {
    if (!this.docker.host) return;
    await this.docker.ready();
    if (!this.docker.status.available) return;
    const sharing = this.db.select().from(runs).where(eq(runs.worktreePath, row.worktreePath)).all();
    if (!sharing.some((r) => r.id === row.id)) sharing.push(row);
    for (const r of sharing) {
      if (this.composeJobs.has(r.id))
        await this.previewRunLock.run(r.id, () => this.stopRunningPreview(r)).catch(() => undefined);
    }
    await this.downComposeProjects(
      [composeProjectName(row.id, row.worktreePath), ...sharing.map((r) => this.previewProjectOf(r.id))],
      row.id,
    );
    this.recordPreviewsTakenDown(sharing.map((r) => r.id));
  }

  /**
   * After a cleanup took runs' preview projects down: a `preview_stopped` for each run whose last
   * compose preview was still started, so its status says stopped and its port is free again.
   */
  private recordPreviewsTakenDown(runIds: readonly string[]): void {
    for (const id of new Set(runIds)) {
      const last = this.previewEvents(id).find(
        (e) => e.type === 'preview_started' || e.type === 'preview_stopped',
      );
      if (last?.type !== 'preview_started' || (last.payload as PreviewPayload | null)?.kind !== 'compose')
        continue;
      try {
        this.record(id, {
          source: 'system',
          type: 'preview_stopped',
          payload: { reason: 'worktree removed' },
        });
      } catch {
        // The run was removed meanwhile.
      }
    }
  }

  /**
   * Removes a run worktree. The engine is rootless: files its containers wrote as a user other than
   * root belong to a sub-uid the runner user cannot delete; when the removal fails on such files they
   * are handed back through the engine and the removal runs once more.
   */
  private async pruneRunWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
    try {
      return await pruneWorktree(projectPath, worktreePath);
    } catch (error) {
      const inWorktrees = path.resolve(worktreePath).includes(`${path.sep}.worktrees${path.sep}`);
      if (!inWorktrees || path.resolve(worktreePath) === path.resolve(projectPath)) throw error;
      if (!(await this.reclaimEngineFiles(worktreePath))) throw error;
      return pruneWorktree(projectPath, worktreePath);
    }
  }

  /** Hands the files under `dir` back to the runner user through the engine; false when Docker is off or that failed. */
  private async reclaimEngineFiles(dir: string): Promise<boolean> {
    if (!this.docker.host || !existsSync(dir)) return false;
    await this.docker.ready();
    const env = this.docker.cliEnv();
    if (!env.DOCKER_HOST) return false;
    const result = await reclaimFiles(dir, env);
    if (!result.ok)
      this.log?.warn(
        { dir, output: result.output.slice(-500) },
        'could not hand the files back through the Docker engine',
      );
    return result.ok;
  }

  /**
   * `rm -rf dir` for a project delete; when files the engine's containers left block it, they are
   * handed back through the engine first. Never throws.
   */
  async removeTree(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Only Emberline's own directories in the workspaces volume are ever handed back.
      const root = path.resolve(this.config.workspacesDir);
      if (!path.resolve(dir).startsWith(root + path.sep)) return;
      if (await this.reclaimEngineFiles(dir))
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * The GC sweep of the engine (every 30 min): takes down, with their volumes, Emberline's compose
   * projects whose run no longer exists or has ended without a worktree, and the main-workspace
   * projects of deleted projects; at most {@link DOCKER_GC_MAX_DOWNS} per sweep. Once a day it
   * prunes dangling images and build cache older than 72 h (`forcePrune`: now, for "Clean up now"). A project
   * whose name Emberline did not make is never touched.
   */
  async sweepDockerProjects(
    now = Date.now(),
    { forcePrune = false }: { forcePrune?: boolean } = {},
  ): Promise<DockerCleanupResponse> {
    const result: DockerCleanupResponse = { removed: [], listed: false, pruned: false };
    if (!this.docker.host || this.dockerSweeping) return result;
    this.dockerSweeping = true;
    try {
      await this.docker.ready();
      const env = this.docker.cliEnv();
      if (!env.DOCKER_HOST) {
        result.error = 'the Docker engine is not reachable';
        return result;
      }
      const listed = await composeProjects(env);
      if (listed.ok) {
        result.listed = true;
        // Read after the listing: a project listed there belongs to a run that existed before it.
        const inUse = composeProjectsInUse(this.dockerOwnershipFacts());
        const stale = listed.names
          .filter((name) => isEmberlineComposeProject(name) && !inUse.has(name))
          .slice(0, DOCKER_GC_MAX_DOWNS);
        for (const name of stale) {
          const down = await composeDown(name, env, CLEANUP_DOWN);
          if (down.ok) result.removed.push(name);
          else
            this.log?.warn({ project: name, output: down.output.slice(-500) }, 'compose sweep: down failed');
        }
        this.lastDockerSweep = { at: now, removed: [...result.removed] };
      } else {
        result.error = listed.error;
        this.log?.warn(
          { error: listed.error },
          'docker compose ls failed; the compose sweep tries again later',
        );
      }
      // The prune does not need the listing.
      if (forcePrune || now - this.lastImagePruneAt >= DOCKER_IMAGE_PRUNE_INTERVAL_MS) {
        this.lastImagePruneAt = now;
        const prune = await pruneImages(env);
        result.pruned = prune.ok;
        if (prune.ok) this.lastImagePruneOkAt = now;
        if (!prune.ok)
          this.log?.warn({ output: prune.output.slice(-500) }, 'compose sweep: image prune failed');
      }
    } finally {
      this.dockerSweeping = false;
    }
    return result;
  }

  /**
   * What compose project ownership is decided from (docker/inventory.ts): every run with its ticket
   * and whether its worktree still exists, and every project. The sweep's in-use rule reads it too.
   */
  private dockerOwnershipFacts(): OwnershipFacts {
    const rows = this.db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        ticketId: runs.ticketId,
        ticketKey: tickets.key,
        ticketTitle: tickets.title,
        title: runs.title,
        state: runs.state,
        worktreePath: runs.worktreePath,
        createdAt: runs.createdAt,
        endedAt: runs.endedAt,
        cancelledAt: runs.cancelledAt,
      })
      .from(runs)
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .all();
    return {
      projects: this.db.select({ id: projects.id, name: projects.name }).from(projects).all(),
      runs: rows.map((r) => ({
        ...r,
        state: r.state as OwnershipRun['state'],
        createdAt: r.createdAt.getTime(),
        endedAt: r.endedAt?.getTime() ?? null,
        cancelledAt: r.cancelledAt?.getTime() ?? null,
        worktreeExists: Boolean(r.worktreePath && existsSync(r.worktreePath)),
      })),
    };
  }

  /**
   * The Docker page: Emberline's compose projects in the engine with their owners and containers,
   * the engine's disk use and the cleanup state. Never throws on a docker failure: each listing
   * carries its own error.
   */
  async dockerOverview(requestHost?: string): Promise<DockerOverview> {
    const cleanup = {
      lastSweepAt: this.lastDockerSweep ? new Date(this.lastDockerSweep.at).toISOString() : null,
      lastSweepRemoved: this.lastDockerSweep?.removed ?? [],
      lastPruneAt: this.lastImagePruneAt ? new Date(this.lastImagePruneAt).toISOString() : null,
      lastPruneOkAt: this.lastImagePruneOkAt ? new Date(this.lastImagePruneOkAt).toISOString() : null,
      sweeping: this.dockerSweeping,
    };
    const empty = { disk: { rows: [] }, cleanup, projects: [] };
    if (!this.docker.host) return { engine: this.docker.status, ...empty };
    await this.docker.ready();
    // Still waiting for the first answer: say so, never "not reachable".
    if (!this.docker.status.checked)
      return { engine: this.docker.status, ...empty, error: DOCKER_ENGINE_NOT_ANSWERED_TEXT };
    // An engine that came back is listed at this page load, without waiting for the 60 s probe.
    if (!this.docker.status.available) await this.docker.refresh(5_000);
    const unreachable = (): DockerOverview => {
      const why = this.docker.status.error;
      return {
        engine: this.docker.status,
        ...empty,
        error: `the Docker engine is not reachable${why ? `: ${why}` : ''}`,
      };
    };
    const env = this.docker.cliEnv();
    if (!env.DOCKER_HOST) return unreachable();
    const inventory = await gatherDockerInventory(env);
    // Every listing failed: the engine may have gone away since the last probe.
    if (!inventory.ls.ok && !inventory.ps.ok && !inventory.df.ok) {
      await this.docker.refresh(0);
      if (!this.docker.status.available) return unreachable();
    }
    // Read after the listing, like the sweep: a listed project belongs to a run that existed before it.
    // Only the compose preview range is published on the host (by the engine's container); any
    // other port a project publishes stays inside the engine.
    const { first, last } = this.config.previewPorts.docker;
    const listed = buildDockerProjects({
      ls: inventory.ls,
      ps: inventory.ps,
      facts: this.dockerOwnershipFacts(),
      portUrl: (port) => (port >= first && port <= last ? previewUrl(port, requestHost) : null),
    });
    return {
      engine: this.docker.status,
      disk: inventory.df.ok ? { rows: inventory.df.value } : { rows: [], error: inventory.df.error },
      cleanup,
      ...listed,
    };
  }

  /** `down --remove-orphans` (volumes kept) of one of Emberline's compose projects, by a person. */
  stopDockerProject(name: string): Promise<DockerProjectActionResponse> {
    return this.downDockerProject(name, 'stop');
  }

  /** `down -v --rmi local --remove-orphans` (CLEANUP_DOWN) of one of Emberline's compose projects, by a person. */
  removeDockerProject(name: string): Promise<DockerProjectActionResponse> {
    return this.downDockerProject(name, 'remove');
  }

  /**
   * A run's preview project goes through the run's preview stop (`preview_stopped`, the port, the
   * preview lock) and is then taken down under the same lock; any other project is taken down
   * directly. A live agent's project may be stopped too (a runaway container): the answer warns.
   * The owning run gets a `docker_project_stopped`/`_removed` note; its state never changes.
   */
  private async downDockerProject(
    name: string,
    action: 'stop' | 'remove',
  ): Promise<DockerProjectActionResponse> {
    const env = await this.dockerPageEnv(name);
    const owner = resolveDockerOwner(name, this.dockerOwnershipFacts());
    if (action === 'stop' && owner.kind === 'orphan') {
      // A stopped leftover has no containers left, so `compose ls` (and the sweep) no longer sees it,
      // while its volumes stay behind for good.
      throw new HttpError(409, 'docker_leftover', `${name} is a leftover: remove it instead`, {
        hint: 'use Remove: a stopped leftover keeps its volumes and the cleanup can no longer find it',
      });
    }
    const opts = action === 'remove' ? CLEANUP_DOWN : {};
    const down =
      owner.kind === 'main' && owner.preview
        ? await this.mainPreviews.takeDown(owner.projectId, name, env, action)
        : owner.kind === 'preview'
          ? await this.previewRunLock.run(owner.runId, async () => {
              // Only a compose preview that is still started goes through the run's preview stop (which
              // takes the project down itself); no preview, a stopped one or a command preview (a
              // terminal; no `kind` is one too, as in previewStatus) is left alone.
              const last = this.previewEvents(owner.runId).find(
                (e) => e.type === 'preview_started' || e.type === 'preview_stopped',
              );
              if (
                last?.type === 'preview_started' &&
                (last.payload as PreviewPayload | null)?.kind === 'compose'
              ) {
                let taken: Awaited<ReturnType<typeof composeDown>> | undefined;
                await this.stopPreviewHeld(this.row(owner.runId), undefined, {
                  volumes: action === 'remove',
                  onDown: (project, down) => {
                    if (project === name) taken = down;
                  },
                });
                if (taken) return taken;
              }
              return composeDown(name, env, opts);
            })
          : await composeDown(name, env, opts);
    if (!down.ok) {
      throw new HttpError(502, 'docker_failed', `docker compose down failed for ${name}`, {
        output: down.output,
      });
    }
    if (owner.kind === 'agent' || owner.kind === 'preview') {
      try {
        this.record(owner.runId, {
          source: 'user',
          type: action === 'stop' ? 'docker_project_stopped' : 'docker_project_removed',
          payload: { project: name, by: 'person' },
        });
      } catch (error) {
        // A run removed meanwhile is fine; anything else is worth a line in the log.
        if (!(error instanceof HttpError && error.statusCode === 404)) {
          this.log?.warn(
            { runId: owner.runId, project: name, error: (error as Error).message },
            'could not record a Docker page action on its run',
          );
        }
      }
    }
    const warning =
      owner.kind === 'agent' && owner.live
        ? `The agent of ${owner.ticketKey ?? owner.runTitle ?? owner.runId.slice(0, 8)} is running and may be using it.`
        : null;
    return { project: name, action, owner, warning };
  }

  /** The end of `docker compose logs` of a project (one service, or all), sanitised: untrusted output. */
  async dockerProjectLogs(name: string, service?: string): Promise<DockerProjectLogsResponse> {
    if (service !== undefined && !COMPOSE_SERVICE_NAME.test(service))
      throw badRequest('not a compose service name');
    const env = await this.dockerPageEnv(name);
    const logs = await dockerQuery(composeLogsArgs(name, service), env);
    if (!logs.ok)
      throw new HttpError(502, 'docker_failed', `docker compose logs failed (${logs.how})`, {
        output: logs.output,
      });
    return { project: name, service: service ?? null, logs: logs.output };
  }

  /** "Clean up now": the sweep at once, with the image and build cache prune; 409 while one runs. */
  async dockerCleanupNow(): Promise<DockerCleanupResponse> {
    await this.dockerPageEnv(null);
    if (this.dockerSweeping)
      throw conflict('a cleanup is running; try again when it finished', 'docker_sweeping');
    return this.sweepDockerProjects(Date.now(), { forcePrune: true });
  }

  /**
   * The engine's client variables for a Docker page action: 400 for a name Emberline did not make,
   * 409 while the engine is off or does not answer.
   */
  private async dockerPageEnv(name: string | null): Promise<Record<string, string>> {
    if (name !== null && !isEmberlineComposeProject(name))
      throw badRequest('not a compose project Emberline made');
    if (!this.docker.host) {
      // Switched off (EMBERLINE_DOCKER_ENGINE=0) or not configured (an old compose file): the hint says which.
      throw new HttpError(409, 'docker_off', 'the Docker engine is off', {
        hint: dockerEngineOffText(this.docker.status),
      });
    }
    await this.docker.ready();
    const env = this.docker.cliEnv();
    // Enabled but not answering: no turn-on hint; the message carries the turn-off hint for hosts that cannot run it.
    if (!env.DOCKER_HOST) {
      if (!this.docker.status.checked)
        throw new HttpError(409, 'docker_off', DOCKER_ENGINE_NOT_ANSWERED_TEXT);
      const why = this.docker.status.error;
      throw new HttpError(
        409,
        'docker_off',
        withHint(
          `the Docker engine is not reachable${why ? `: ${why}` : ''}`,
          DOCKER_ENGINE_UNREACHABLE_HINT,
        ),
      );
    }
    return env;
  }

  /**
   * Before a project and its `.worktrees/<slug>` go: best-effort teardown in each run worktree that
   * still exists (each once, also when runs share it), next to the background teardowns already
   * running for it. Waits at most `budgetMs`; `settled` resolves once all of them ended (each
   * command is capped), so the caller removes the worktrees only then.
   */
  async teardownProjectWorktrees(
    projectId: string,
    budgetMs = this.teardownBudgets.projectDelete,
  ): Promise<{ finished: boolean; settled: Promise<void> }> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return { finished: true, settled: Promise.resolve() };
    const rows = this.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .orderBy(desc(runs.createdAt))
      .all();
    const inFlight = [...new Set(rows.flatMap((row) => this.teardownJobs.get(row.worktreePath) ?? []))];
    const own = (async () => {
      if (this.hasTeardown(projectId)) {
        const seen = new Set<string>();
        for (const row of rows) {
          // A background job is tearing that one down already.
          if (seen.has(row.worktreePath) || this.tearingDown.has(row.id)) continue;
          seen.add(row.worktreePath);
          this.tearingDown.add(row.id);
          await this.teardownWorktree(row, project)
            .catch(() => undefined)
            .finally(() => this.tearingDown.delete(row.id));
        }
      }
      // Then every compose project the project's runs and its main workspace had.
      if (!this.docker.host) return;
      await this.docker.ready();
      if (!this.docker.status.available) return;
      for (const row of rows) {
        if (this.composeJobs.has(row.id))
          await this.previewRunLock.run(row.id, () => this.stopRunningPreview(row)).catch(() => undefined);
      }
      // Main's container preview: a start still going is cancelled, then it goes with its volumes (CLEANUP_DOWN).
      await this.mainPreviews.removeForProject(projectId).catch(() => undefined);
      await this.downComposeProjects(
        [
          ...rows.flatMap((row) => [
            composeProjectName(row.id, row.worktreePath),
            this.previewProjectOf(row.id),
          ]),
          mainComposeProjectName(projectId),
        ],
        null,
      );
      this.recordPreviewsTakenDown(rows.map((row) => row.id));
    })().catch(() => undefined);
    const settled = Promise.allSettled([own, ...inFlight]).then(() => undefined);
    return { finished: await settlesWithin(settled, budgetMs), settled };
  }

  /** The approved worktree.yml's preview service, else what the workspace's package.json offers. */
  private detectPreviewCommand(projectId: string, worktreePath: string): string | null {
    const service = approvedPreviewService(this.db, projectId);
    if (service && isComposeService(service)) return composePreviewLabel(service);
    return service?.command ?? detectPreviewCommand(worktreePath);
  }

  /**
   * A stable port per run in the kind's published range (`EMBERLINE_PREVIEW_PORTS_RUNNER` for
   * command previews, `_DOCKER` for compose previews), moved to the next free one when another
   * run's preview already holds it (B16), skipping `exclude`. Callers hold `previewPortLock` until
   * they recorded it.
   */
  private async allocatePreviewPort(
    runId: string,
    kind: PreviewKind,
    exclude: ReadonlySet<number> = new Set(),
  ): Promise<number> {
    const taken = this.activeComposePreviewPorts(runId);
    // Main previews hold ports of the docker range too.
    for (const port of this.mainPreviews.reservedPorts()) taken.add(port);
    for (const port of exclude) taken.add(port);
    if (kind === 'command') {
      const { sessions } = await this.ptyd.get().list();
      for (const s of sessions) {
        if (s.status === 'running' && s.meta.previewPort && s.meta.runId !== runId)
          taken.add(Number(s.meta.previewPort));
      }
    }
    return this.freePreviewPort(runId, kind, taken);
  }

  /** The same for a project's main preview (docker range), around every run's compose preview and the other main previews. */
  private async allocateMainPreviewPort(projectId: string, exclude: ReadonlySet<number>): Promise<number> {
    const taken = this.activeComposePreviewPorts(null);
    for (const port of this.mainPreviews.reservedPorts(projectId)) taken.add(port);
    for (const port of exclude) taken.add(port);
    return this.freePreviewPort(`main:${projectId}`, 'compose', taken);
  }

  /** The first port of the kind's range from `key`'s stable start that is not `taken`; 409 when none is. */
  private freePreviewPort(key: string, kind: PreviewKind, taken: ReadonlySet<number>): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    const { first, last } = this.config.previewPorts[kind === 'compose' ? 'docker' : 'runner'];
    const size = last - first + 1;
    for (let i = 0; i < size; i++) {
      const port = first + ((hash + i) % size);
      if (!taken.has(port)) return port;
    }
    throw conflict(`no free preview port in ${first}-${last}; stop another preview`);
  }

  /**
   * Host ports of other runs' compose previews that were started and neither stopped nor failed
   * since (a failed preview's project is taken down before `preview_failed` is recorded), of runs
   * whose worktree still exists (one that is gone cannot run a preview any more).
   */
  private activeComposePreviewPorts(exceptRunId: string | null): Set<number> {
    const rows = this.db
      .select({ runId: runEvents.runId, type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(inArray(runEvents.type, ['preview_started', 'preview_stopped', 'preview_failed']))
      .orderBy(desc(runEvents.id))
      .all();
    const seen = new Set<string>();
    const ports = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.runId)) continue;
      seen.add(row.runId);
      if (row.runId === exceptRunId || row.type !== 'preview_started') continue;
      const p = (row.payload ?? {}) as PreviewPayload;
      if (p.kind !== 'compose' || typeof p.port !== 'number') continue;
      const worktree = this.db
        .select({ path: runs.worktreePath })
        .from(runs)
        .where(eq(runs.id, row.runId))
        .get()?.path;
      if (worktree && existsSync(worktree)) ports.add(p.port);
    }
    return ports;
  }

  /** The newest `preview_started` or `preview_stopped` of a run, newest event first. */
  private previewEvents(id: string) {
    return this.db
      .select()
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, id),
          inArray(runEvents.type, ['preview_started', 'preview_stopped', 'preview_ready', 'preview_failed']),
        ),
      )
      .orderBy(desc(runEvents.id))
      .all();
  }

  /**
   * `requestHost`: the Host the browser used for this API call (already allow-listed); the preview
   * URL uses it unless EMBERLINE_PREVIEW_HOST is set.
   */
  async previewStatus(id: string, requestHost?: string): Promise<RunPreviewStatus> {
    const row = this.row(id);
    const service = approvedPreviewService(this.db, row.projectId);
    const detectedCommand = this.detectPreviewCommand(row.projectId, row.worktreePath);
    const events = this.previewEvents(id);
    const lastIndex = events.findIndex((e) => e.type === 'preview_started' || e.type === 'preview_stopped');
    const lastPreview = lastIndex >= 0 ? events[lastIndex] : undefined;
    const idle: RunPreviewStatus = {
      runId: id,
      status: 'stopped',
      kind: service && isComposeService(service) ? 'compose' : 'command',
      terminalId: null,
      command: null,
      port: null,
      url: null,
      detectedCommand,
      error: null,
      logs: null,
    };
    if (
      !lastPreview ||
      lastPreview.type === 'preview_stopped' ||
      typeof lastPreview.payload !== 'object' ||
      !lastPreview.payload
    ) {
      return idle;
    }

    const p = lastPreview.payload as PreviewPayload;
    const port = typeof p.port === 'number' ? p.port : null;
    const url = port ? previewUrl(port, requestHost) : typeof p.url === 'string' ? p.url : null;
    const command = typeof p.command === 'string' ? p.command : null;

    if (p.kind === 'compose') {
      const base: RunPreviewStatus = { ...idle, kind: 'compose', command, port, url };
      // Outcomes of this start only: events newer than it, newest first.
      const outcome = events
        .slice(0, lastIndex)
        .find((e) => e.type === 'preview_ready' || e.type === 'preview_failed');
      if (outcome?.type === 'preview_failed') {
        const f = (outcome.payload ?? {}) as { error?: string; logs?: string | null };
        return { ...base, status: 'failed', error: f.error ?? 'the preview failed', logs: f.logs ?? null };
      }
      if (!outcome) {
        if (this.composeJobs.has(id)) return { ...base, status: 'starting' };
        return {
          ...base,
          status: 'failed',
          error: 'Emberline restarted before the preview was ready; start it again',
        };
      }
      if (!this.docker.status.available)
        return { ...base, status: 'exited', error: 'the Docker engine is not reachable' };
      const state = await composeServiceStatus({
        project: p.project ?? '',
        service: p.service ?? '',
        env: await this.dockerEnvFor(row),
      });
      if (state === 'running' || state === 'starting' || state === 'unknown') {
        return { ...base, status: 'running', ...(await this.framingOf(id, lastPreview.id, 'compose', port)) };
      }
      return { ...base, status: 'exited', error: `the "${p.service}" container is not running` };
    }

    const terminalId = typeof p.terminalId === 'string' ? p.terminalId : null;
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
      ...idle,
      kind: 'command',
      status,
      terminalId,
      command,
      port,
      url,
      ...(typeof p.note === 'string' ? { note: p.note } : {}),
      ...(status === 'running' ? await this.framingOf(id, lastPreview.id, 'command', port) : {}),
    };
  }

  /** `{ framing }` of a running run preview (probed once per start), nothing without a port. */
  private async framingOf(
    id: string,
    startEventId: number,
    kind: 'compose' | 'command',
    port: number | null,
  ) {
    if (!port) return {};
    return {
      framing: await this.framing.get(
        `run:${id}`,
        String(startEventId),
        runnerPreviewUrl(kind, port, this.config.dockerHost),
      ),
    };
  }

  /** Probes the running preview's headers again. */
  async recheckPreviewFraming(id: string, requestHost?: string): Promise<RunPreviewStatus> {
    this.framing.forget(`run:${id}`);
    return this.previewStatus(id, requestHost);
  }

  /** `source`: who started it, for the timeline (`hook`: the agent's `preview` tool). */
  async startPreview(
    id: string,
    rawBody: unknown,
    requestHost?: string,
    source: EventSource = 'user',
  ): Promise<RunPreviewStatus> {
    const row = this.row(id);
    if (!existsSync(row.worktreePath)) {
      throw conflict('worktree directory does not exist (was it pruned?)');
    }
    const parsed = StartPreviewBodySchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body: StartPreviewBody = parsed.data;
    if (this.tearingDown.has(id))
      throw conflict("this run's worktree is being removed; it cannot start a preview");

    // One start or stop per run at a time: a second start waits, then cancels the first one's job.
    return this.previewRunLock.run(id, async () => {
      const generation = (this.previewGenerations.get(id) ?? 0) + 1;
      this.previewGenerations.set(id, generation);
      const service = approvedPreviewService(this.db, row.projectId);
      let fallback: { command: string; note: string } | undefined;
      if (service && isComposeService(service)) {
        if (existsSync(path.join(row.worktreePath, service.compose.file))) {
          return this.startComposePreview(row, service, generation, requestHost, source);
        }
        // A wizard project before its Deploy ticket added the compose file: preview the dev command.
        const instead = loadApprovedWorktreeConfig(this.db, row.projectId)?.config.services.find(
          (s) => s.command !== undefined,
        );
        const command = instead?.command ?? detectPreviewCommand(row.worktreePath);
        if (!command) {
          throw conflict(
            `${service.compose.file} not found in this worktree, and there is no command to preview instead`,
          );
        }
        fallback = {
          command,
          note: `${service.compose.file} not found yet — previewing ${instead?.name ?? 'the detected dev command'}`,
        };
      }

      // Stop any existing preview first (a terminal, or a compose project from an earlier approval).
      await this.stopRunningPreview(row);

      const detectedCommand = this.detectPreviewCommand(row.projectId, row.worktreePath);
      const command = fallback?.command ?? (body.command?.trim() || detectedCommand || 'npm run dev');
      const { session, port } = await this.previewPortLock.run('ports', async () => {
        const port = body.port ?? (await this.allocatePreviewPort(id, 'command'));
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
          source,
          type: 'preview_started',
          payload: {
            kind: 'command',
            terminalId: session.id,
            command,
            port,
            ...(fallback ? { note: fallback.note } : {}),
          },
        });
        return { session, port };
      });

      return {
        runId: id,
        status: 'running',
        kind: 'command',
        terminalId: session.id,
        command,
        port,
        url: previewUrl(port, requestHost),
        detectedCommand,
        error: null,
        logs: null,
        ...(fallback ? { note: fallback.note } : {}),
      } satisfies RunPreviewStatus;
    });
  }

  /**
   * A compose preview (worktree.yml v2): needs the engine. Allocates a port from the docker range,
   * records the start and runs `up` and the readiness checks in the background under the run's
   * preview project (`emberline-<run8>-preview`); the status says `starting` until they end. A
   * `command` or `port` in the body does not apply.
   */
  private async startComposePreview(
    row: RunRow,
    service: WorktreeComposeService,
    generation: number,
    requestHost?: string,
    source: EventSource = 'user',
  ): Promise<RunPreviewStatus> {
    await this.docker.ready();
    if (!this.docker.status.available || !this.config.dockerHost) {
      throw conflict(composeEngineOffMessage(service.name, this.docker.status));
    }
    await this.stopRunningPreview(row);
    const env = await this.dockerEnvFor(row);
    const project = previewComposeProjectName(row.id);
    const command = composePreviewLabel(service);
    const recordStart = (port: number) =>
      this.record(row.id, {
        source,
        type: 'preview_started',
        payload: {
          kind: 'compose',
          command,
          port,
          project,
          file: service.compose.file,
          service: service.compose.service,
          containerPort: service.compose.port,
        } satisfies PreviewPayload,
      });
    const hostPort = await this.previewPortLock.run('ports', async () => {
      const port = await this.allocatePreviewPort(row.id, 'compose');
      recordStart(port);
      return port;
    });

    const job: ComposeJob = {
      execId: `preview-${row.id}-${randomUUID()}`,
      cancelled: false,
      abandoned: false,
      generation,
      project,
      done: Promise.resolve(),
    };
    const target = {
      worktreePath: row.worktreePath,
      project,
      file: service.compose.file,
      service: service.compose.service,
      containerPort: service.compose.port,
      hostPort,
      engineHost: engineHostName(this.config.dockerHost),
      env,
    };
    const current = () => !job.cancelled && this.composeJobs.get(row.id) === job && this.hasRun(row.id);
    const reallocate = (taken: ReadonlySet<number>) =>
      this.previewPortLock.run('ports', async () => {
        if (!current()) throw new Error('the preview was stopped');
        const port = await this.allocatePreviewPort(row.id, 'compose', taken);
        recordStart(port);
        return port;
      });
    job.done = runComposePreview(target, this.composePreviewTiming, {
      execId: job.execId,
      cancelled: () => job.cancelled,
      reallocate,
    })
      .then(async (outcome) => {
        if (!current()) return;
        if (outcome.ok) {
          this.record(row.id, {
            source: 'system',
            type: 'preview_ready',
            payload: { port: target.hostPort },
          });
          return;
        }
        if (outcome.cancelled) return;
        // Take down what it left (a container that exited, a half-started project) and free its port.
        const down = await composeDown(project, env);
        if (!current()) return;
        this.record(row.id, {
          source: 'system',
          type: 'preview_failed',
          payload: { error: outcome.error, logs: outcome.logs, downOk: down.ok },
        });
        this.log?.warn({ runId: row.id, project, error: outcome.error }, 'compose preview failed');
      })
      .catch(() => undefined)
      .finally(() => {
        // A cancelled job's entry is the stop's to remove (stopRunningPreview), once its down ran.
        if (this.composeJobs.get(row.id) === job && !job.cancelled) this.composeJobs.delete(row.id);
      });
    this.composeJobs.set(row.id, job);
    // A start a stop gave up waiting for may still have created containers: take them down when it
    // settles, unless the run started another preview meanwhile. Under the run's lock, so a newer
    // start cannot begin between that check and the down (a removed run never starts one).
    void job.done
      .then(async () => {
        if (!job.abandoned) return;
        await this.previewRunLock.run(row.id, async () => {
          const generation = this.previewGenerations.get(row.id);
          // No generation: remove() is forgetting the run (only it deletes the entry); take it down with its volumes.
          const gone = !this.hasRun(row.id) || generation === undefined;
          if (!gone && generation !== job.generation) return;
          // A deleted run's preview project is never used again: its volumes and images go too.
          await composeDown(project, env, gone ? CLEANUP_DOWN : {});
        });
      })
      .catch(() => undefined);

    return {
      runId: row.id,
      status: 'starting',
      kind: 'compose',
      terminalId: null,
      command,
      port: hostPort,
      url: previewUrl(hostPort, requestHost),
      detectedCommand: command,
      error: null,
      logs: null,
    };
  }

  private hasRun(id: string): boolean {
    return Boolean(this.db.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).get());
  }

  /**
   * Ends what the run's last preview started: its terminal, or (compose) the background start and
   * the preview project's containers (`down --remove-orphans`, volumes kept). A start still going
   * is cancelled and awaited (bounded, cancelled once more after a short delay) before the `down`.
   * Returns that preview's status. Callers hold `previewRunLock` for the run. `volumes` (the run is
   * being deleted) also removes the preview project's volumes and built images, whether or not it runs.
   */
  private async stopRunningPreview(
    row: RunRow,
    { volumes = false, onDown }: StopPreviewOptions = {},
  ): Promise<RunPreviewStatus> {
    const current = await this.previewStatus(row.id);
    if (current.terminalId) {
      await this.ptyd
        .get()
        .remove(current.terminalId)
        .catch(() => undefined);
    }
    const composeRunning = current.kind === 'compose' && current.status !== 'stopped';
    const job = composeRunning ? this.composeJobs.get(row.id) : undefined;
    if (job) {
      job.cancelled = true;
      const { stopSettleMs, cancelRetryMs } = this.composePreviewTiming;
      await cancelCommand(job.execId);
      let settled = await settlesWithin(job.done, cancelRetryMs);
      if (!settled) {
        await cancelCommand(job.execId);
        settled = await settlesWithin(job.done, Math.max(0, stopSettleMs - cancelRetryMs));
      }
      if (!settled) job.abandoned = true;
    }
    if (composeRunning || volumes) {
      const env = await this.dockerEnvFor(row);
      if (env.DOCKER_HOST) {
        const project = this.previewProjectOf(row.id);
        const down = await composeDown(project, env, volumes ? CLEANUP_DOWN : {});
        onDown?.(project, down);
        if (!down.ok)
          this.log?.warn({ runId: row.id, output: down.output.slice(-500) }, 'compose preview: down failed');
      }
    }
    // Only now, with the containers down: until then the status of a start being stopped reads
    // `starting`, not "Emberline restarted before the preview was ready".
    if (job && this.composeJobs.get(row.id) === job) this.composeJobs.delete(row.id);
    return current;
  }

  /** The compose project the run's last compose preview used (recorded with it). */
  private previewProjectOf(runId: string): string {
    const started = this.previewEvents(runId).find((e) => e.type === 'preview_started');
    const project = (started?.payload as PreviewPayload | null)?.project;
    return typeof project === 'string' && project.startsWith('emberline-')
      ? project
      : previewComposeProjectName(runId);
  }

  async stopPreview(id: string, requestHost?: string): Promise<RunPreviewStatus> {
    const row = this.row(id);
    return this.previewRunLock.run(id, () => this.stopPreviewHeld(row, requestHost));
  }

  /** A person's preview Stop (Review page or Docker page); callers hold `previewRunLock` for the run. */
  private async stopPreviewHeld(
    row: RunRow,
    requestHost?: string,
    opts: StopPreviewOptions = {},
  ): Promise<RunPreviewStatus> {
    const current = await this.stopRunningPreview(row, opts);
    this.record(row.id, {
      source: 'user',
      type: 'preview_stopped',
      payload: { terminalId: current.terminalId },
    });
    return { ...(await this.previewStatus(row.id, requestHost)), detectedCommand: current.detectedCommand };
  }

  /** Forgets the run, its terminal and its preview server. The worktree and branch are kept on purpose. */
  async remove(id: string): Promise<void> {
    const row = this.row(id);
    this.agentPreviewStarts.delete(id);
    this.framing.forget(`run:${id}`);
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
    // ...nor a compose preview's containers, and with the run its preview project's volumes go too.
    const hadComposePreview = this.previewEvents(id).some(
      (e) => e.type === 'preview_started' && (e.payload as PreviewPayload | null)?.kind === 'compose',
    );
    await this.previewRunLock
      .run(id, () => this.stopRunningPreview(row, { volumes: hadComposePreview }))
      .catch(() => undefined);
    this.previewGenerations.delete(id);
    // The run's own containers too, when no other run works in that compose project (a kept
    // worktree is not a reason to keep them; a handoff successor in the same worktree is).
    if (this.docker.host && existsSync(row.worktreePath)) await this.docker.ready();
    if (this.docker.host && existsSync(row.worktreePath) && this.docker.status.available) {
      const agentProject = composeProjectName(row.id, row.worktreePath);
      const shared = this.db
        .select({ id: runs.id, worktreePath: runs.worktreePath })
        .from(runs)
        .where(and(eq(runs.worktreePath, row.worktreePath), ne(runs.id, id)))
        .all()
        .some((r) => composeProjectName(r.id, r.worktreePath) === agentProject);
      if (!shared) await this.downComposeProjects([agentProject], null).catch(() => undefined);
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
    const keptWorktrees: GarbageCollectRunsResponse['keptWorktrees'] = [];

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

    const archiveDeadline = Date.now() + MANUAL_GC_ARCHIVE_BUDGET_MS;
    const teardownDeadline = Date.now() + this.teardownBudgets.request;
    for (const [projId, list] of byProject.entries()) {
      const toRemove = list.slice(body.keepRecent);
      const proj = projectMap.get(projId);
      const branch = toRemove.length > 0 && proj ? await this.mergeTarget(proj) : undefined;
      // A handoff predecessor and its successor share one worktree: report it once, as the newest run.
      const reportedPaths = new Set<string>();
      for (const row of toRemove) {
        // Auto-GC is tearing it down and prunes it itself.
        if (this.tearingDown.has(row.id)) continue;
        const keep = await this.mustKeepForReview(row, proj, { branch });
        if (keep) {
          const shared = row.worktreePath && row.worktreePath !== proj?.path ? row.worktreePath : null;
          if (!shared || !reportedPaths.has(shared)) keptWorktrees.push({ runId: row.id, reason: keep });
          if (shared) reportedPaths.add(shared);
          continue;
        }
        // The run row goes away with or without its worktree: archive first, or its outputs become
        // unreachable. Within one time budget per request; a run it cannot archive in time is kept.
        if (proj && row.worktreePath && row.worktreePath !== proj.path) {
          const budgetLeft = archiveDeadline - Date.now();
          const archived =
            budgetLeft >= AUTO_GC_MIN_ARCHIVE_MS
              ? await this.outputs.archiveBeforePrune(row.id, budgetLeft, { keepOnTimeout: true })
              : 'timeout';
          if (archived === 'timeout') {
            if (!reportedPaths.has(row.worktreePath))
              keptWorktrees.push({ runId: row.id, reason: 'archive_pending' });
            reportedPaths.add(row.worktreePath);
            continue;
          }
        }
        if (
          body.pruneWorktrees &&
          proj &&
          row.worktreePath &&
          row.worktreePath !== proj.path &&
          !this.worktreeSharedWith(row)
        ) {
          if (this.needsTeardown(proj.id, row.worktreePath)) {
            // Teardowns share one time budget per request; one still running prunes (and removes
            // its run) in the background when it ends.
            let removedWt = false;
            const job = this.teardownThenPrune(row, proj, async (r) => {
              removedWt = r;
              await this.remove(row.id).catch(() => undefined);
            });
            if (await settlesWithin(job, teardownDeadline - Date.now())) {
              if (removedWt) prunedWorktrees += 1;
              removedRuns += 1;
            } else {
              keptWorktrees.push({ runId: row.id, reason: 'teardown_running' });
            }
            continue;
          }
          const removedWt = await this.pruneRunWorktree(proj.path, row.worktreePath).catch(() => false);
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
      keptWorktrees,
      remainingRuns,
    };
  }

  /**
   * Stall watchdog (R7): reads a working or starting run's screen at most once a minute and tells whether it has
   * neither changed nor had a hook for {@link STALL_WATCHDOG_MS}. Hooks reset the watch (ingestHook);
   * a core restart starts it over.
   */
  private async stalled(row: RunRow, nowMs: number): Promise<boolean> {
    if (!row.ptydSessionId) return false;
    let watch = this.stallWatch.get(row.id);
    if (!watch) {
      watch = { hash: null, since: nowMs, sampledAt: 0 };
      this.stallWatch.set(row.id, watch);
    }
    if (nowMs - watch.sampledAt < STALL_SCREEN_SAMPLE_MS) return false;
    let hash: string;
    try {
      hash = sha256((await this.ptyd.get().snapshot(row.ptydSessionId, STALL_SCREEN_LINES)).data ?? '');
    } catch {
      return false; // the session is going away; the exit path handles it
    }
    // A hook that arrived while the screen was read started a new watch.
    if (this.stallWatch.get(row.id) !== watch) return false;
    watch.sampledAt = nowMs;
    if (hash !== watch.hash) {
      watch.hash = hash;
      watch.since = nowMs;
      return false;
    }
    return nowMs - watch.since >= STALL_WATCHDOG_MS;
  }

  /** A stalled run waits for the user: its slot is free and the "agent waiting" page goes out. */
  private markStalled(id: string): void {
    this.stallWatch.delete(id);
    // Re-read: the screen was read asynchronously and the run may have moved on meanwhile.
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if ((row?.state !== 'working' && row?.state !== 'starting') || row.endedAt || row.cancelledAt) return;
    this.record(id, {
      source: 'system',
      type: 'stall_detected',
      state: 'waiting_input',
      payload: {
        message: `No agent activity and an unchanged screen for ${minutesOf(STALL_WATCHDOG_MS)} minutes; it may be stuck`,
      },
    });
  }

  /**
   * Keeps the newest MAX_EVENTS_PER_RUN events of each run, the protected kinds, and the state rows
   * that reachedWork / pipelineOutcome read (the first row of each working-or-later state and the
   * latest `done`). One DELETE per run over the cap, at most PRUNE_RUNS_PER_PASS runs per call.
   * Returns whether more runs are left over the cap.
   */
  pruneRunEvents(): boolean {
    const over = this.db
      .select({ runId: runEvents.runId })
      .from(runEvents)
      .groupBy(runEvents.runId)
      .having(sql`count(*) > ${MAX_EVENTS_PER_RUN}`)
      .limit(PRUNE_RUNS_PER_PASS + 1)
      .all();
    for (const { runId } of over.slice(0, PRUNE_RUNS_PER_PASS)) {
      const cutoff = this.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.id))
        .limit(1)
        .offset(MAX_EVENTS_PER_RUN - 1)
        .get();
      if (!cutoff) continue;
      const stateKeepers = this.db
        .select({ id: sql<number>`min(${runEvents.id})` })
        .from(runEvents)
        .where(
          and(eq(runEvents.runId, runId), inArray(runEvents.state, ['working', 'waiting_input', 'done'])),
        )
        .groupBy(runEvents.state)
        .all()
        .map((r) => r.id);
      const lastDone = this.db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.state, 'done')))
        .orderBy(desc(runEvents.id))
        .limit(1)
        .get();
      this.db
        .delete(runEvents)
        .where(
          and(
            eq(runEvents.runId, runId),
            lt(runEvents.id, cutoff.id),
            notInArray(runEvents.type, PRUNE_PROTECTED_EVENT_TYPES),
            notInArray(runEvents.id, [...stateKeepers, ...(lastDone ? [lastDone.id] : [])]),
          ),
        )
        .run();
    }
    return over.length > PRUNE_RUNS_PER_PASS;
  }

  /** Records process exits and sessions that vanished (runner restart) for unfinished runs. */
  async reconcile(): Promise<void> {
    if (this.reconcilePass || this.ptyd.status !== 'connected') return;
    let done!: () => void;
    this.reconcilePass = new Promise<void>((resolve) => (done = resolve));
    try {
      if (Date.now() - this.lastEventPruneAt > EVENT_PRUNE_INTERVAL_MS) {
        this.lastEventPruneAt = Date.now();
        try {
          // More runs over the cap: come back on the next reconcile instead of waiting out the interval.
          if (this.pruneRunEvents()) this.lastEventPruneAt = 0;
        } catch {
          // Pruning is housekeeping; it must never skip the rest of the reconcile.
        }
      }
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
      const watched = new Set<string>();

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
          if (row.state === 'working' || row.state === 'starting') {
            watched.add(row.id);
            if (await this.stalled(row, nowMs)) this.markStalled(row.id);
            continue;
          }
          const waitingOn =
            row.state === 'waiting_input' && nowMs - row.stateChangedAt.getTime() > WAITING_INPUT_TIMEOUT_MS
              ? this.waitingReason(row.id)
              : undefined;
          if (waitingOn && this.unattendedOrigin(row.id)) {
            // Nobody will answer this prompt: free the slot instead of holding it forever.
            await this.saveLastScreen(row.id, row.ptydSessionId);
            await this.ptyd
              .get()
              .remove(row.ptydSessionId)
              .catch(() => undefined);
            byId.delete(row.ptydSessionId);
            this.record(row.id, {
              source: 'system',
              type: 'waiting_input_timeout',
              state: 'failed',
              payload: {
                message:
                  waitingOn === 'stall_detected'
                    ? `An unattended run stalled and nobody looked at it for ${minutesOf(WAITING_INPUT_TIMEOUT_MS)} minutes; it was stopped`
                    : `An unattended run waited on a permission prompt for ${minutesOf(WAITING_INPUT_TIMEOUT_MS)} minutes and was stopped`,
              },
              patch: { endedAt: new Date(), ptydSessionId: null, autoRetryAt: null },
            });
            continue;
          }
          // If an interactive CLI finished its turn (`state === 'done'`) and has been sitting idle
          // for over its idle TTL without any follow-up prompt, close & dispose its PTY
          // so it never lingers as a zombie process in Fleet Multiplexer.
          const idleTtl = row.agentSessionId ? IDLE_DONE_RESUMABLE_TTL_MS : IDLE_DONE_NON_RESUMABLE_TTL_MS;
          if (
            row.state === 'done' &&
            nowMs - row.stateChangedAt.getTime() > idleTtl &&
            !this.pipelineBusyRuns.has(row.id)
          ) {
            const sessionId = row.ptydSessionId;
            // Re-read under the session lock: a prompt typed meanwhile (its hook not here yet) restarts
            // the idle time.
            const closed = await this.sessionLock.run(row.id, async () => {
              const current = this.db.select().from(runs).where(eq(runs.id, row.id)).get();
              if (
                !current ||
                current.endedAt ||
                current.ptydSessionId !== sessionId ||
                current.state !== 'done'
              ) {
                return false;
              }
              const prompted = this.promptSentSince(row.id, latestDoneEventId(this.db, row.id));
              const idleSince = Math.max(current.stateChangedAt.getTime(), prompted?.getTime() ?? 0);
              if (nowMs - idleSince <= idleTtl) return false;
              await this.closeIdleSession(row.id, sessionId);
              return true;
            });
            if (closed) byId.delete(sessionId);
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
          await this.saveLastScreen(row.id, row.ptydSessionId);
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
      for (const runId of this.stallWatch.keys()) {
        if (!watched.has(runId)) this.stallWatch.delete(runId);
      }
      for (const row of attached) {
        if (!row.endedAt || !row.ptydSessionId) continue;
        if (byId.has(row.ptydSessionId)) {
          await this.saveLastScreen(row.id, row.ptydSessionId);
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
        const seen = new Set<string>();
        // Archiving before prunes shares one time budget per auto-GC pass, so reconcile (exits,
        // watchdogs) is never held much longer than that; what is left waits for the next pass.
        const archiveDeadline = Date.now() + AUTO_GC_ARCHIVE_BUDGET_MS;
        autoGc: for (const [projId, arr] of byProj.entries()) {
          if (arr.length <= AUTO_GC_KEEP_RECENT_PER_PROJECT) continue;
          const proj = projectMap.get(projId);
          const branch = proj ? await this.mergeTarget(proj) : undefined;
          for (const stale of arr.slice(AUTO_GC_KEEP_RECENT_PER_PROJECT)) {
            seen.add(stale.id);
            // Archived already; its teardown runs, and the prune follows it.
            if (this.tearingDown.has(stale.id)) continue;
            if (await this.mustKeepForReview(stale, proj, { branch, cached: true })) continue;
            if (
              proj &&
              stale.worktreePath &&
              stale.worktreePath !== proj.path &&
              !this.worktreeSharedWith(stale)
            ) {
              const budgetLeft = archiveDeadline - Date.now();
              if (budgetLeft < AUTO_GC_MIN_ARCHIVE_MS) break autoGc;
              // Nobody waits for auto-GC: a run whose outputs are not safely archived keeps its
              // worktree (and row) and is tried again on the next pass. A copy that keeps failing
              // (a worktree reached through a link, unreadable files) holds it for 24 h at most.
              const archived = await this.outputs.archiveBeforePrune(stale.id, budgetLeft, {
                keepOnTimeout: true,
              });
              if (archived === 'timeout') continue;
              if (archived === 'failed') {
                const firstFailure = this.outputs.firstFailureAt(stale.id);
                if (firstFailure && Date.now() - firstFailure.getTime() < AUTO_GC_ARCHIVE_RETRY_MS) continue;
              }
              if (this.needsTeardown(proj.id, stale.worktreePath)) {
                // Teardown commands (and compose downs) may take minutes: they run beside reconcile, and this worktree is
                // pruned (and its run removed) only once they finished. The guard keeps a later
                // pass from starting them again meanwhile.
                void this.teardownThenPrune(stale, proj, () => this.remove(stale.id));
                continue;
              }
              await this.pruneRunWorktree(proj.path, stale.worktreePath).catch(() => undefined);
            }
            await this.remove(stale.id).catch(() => undefined);
          }
        }
        for (const id of this.keptWorktreeChecks.keys()) {
          if (!seen.has(id)) this.keptWorktreeChecks.delete(id);
        }
      }
    } catch {
      // ptyd went away mid-call; next tick retries.
    } finally {
      this.reconcilePass = null;
      done();
    }
  }

  /**
   * Garbage collection never deletes work a human still has to look at: runs of tickets that are
   * not `done` yet (e.g. in Review after a refused merge), worktrees with uncommitted changes, and
   * worktrees whose branch has commits the default branch does not contain. Returns why, or null.
   */
  private async mustKeepForReview(
    row: RunRow,
    project: { path: string; defaultBranch: string } | undefined,
    /**
     * `branch`: the merge target, resolved once per pass. `cached`: reuse the last verdict on a kept
     * worktree whose HEAD has not moved for up to KEPT_WORKTREE_RECHECK_MS (auto-GC runs every minute).
     */
    opts: { branch?: string; cached?: boolean } = {},
  ): Promise<KeptWorktreeReason | null> {
    if (row.ticketId) {
      const ticket = this.db
        .select({ status: tickets.status })
        .from(tickets)
        .where(eq(tickets.id, row.ticketId))
        .get();
      if (ticket && ticket.status !== 'done') return 'in_review';
    }
    if (row.worktreePath && row.worktreePath !== project?.path) {
      // Without a project the target branch is unknown, so nothing can be proven merged.
      if (!project) return 'unmerged_commits';
      if (!opts.cached) {
        return (await this.worktreeWorkReason(row.worktreePath, project, opts.branch))?.reason ?? null;
      }
      const head = await worktreeHeadSha(row.worktreePath, project.path);
      const last = this.keptWorktreeChecks.get(row.id);
      if (last && last.head === head && Date.now() - last.checkedAt < KEPT_WORKTREE_RECHECK_MS) {
        return last.reason;
      }
      const reason = (await this.worktreeWorkReason(row.worktreePath, project, opts.branch))?.reason ?? null;
      if (reason) this.keptWorktreeChecks.set(row.id, { head, reason, checkedAt: Date.now() });
      else this.keptWorktreeChecks.delete(row.id);
      return reason;
    }
    return null;
  }

  /** The branch runs merge into: the main workspace's current branch, else the project's `defaultBranch`. */
  private async mergeTarget(project: { path: string; defaultBranch: string }): Promise<string> {
    return (await mainWorkspaceBranch(project.path)) ?? project.defaultBranch;
  }

  /**
   * Runs merge into the main workspace's current branch (the project's `defaultBranch` column is
   * only the fallback), so that is what "merged" is measured against. `branch` names it.
   */
  private async worktreeWorkReason(
    worktreePath: string,
    project: { path: string; defaultBranch: string },
    knownBranch?: string,
  ): Promise<{ reason: Exclude<KeptWorktreeReason, 'in_review'>; branch: string } | null> {
    const branch = knownBranch ?? (await this.mergeTarget(project));
    if (await worktreeHasUncommittedWork(worktreePath)) return { reason: 'uncommitted_changes', branch };
    if (await worktreeHasUnmergedCommits(worktreePath, branch)) return { reason: 'unmerged_commits', branch };
    return null;
  }

  private row(id: string): RunRow {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) throw notFound('no such run');
    return row;
  }

  /** Appends an event, applies the state change + patch atomically, and broadcasts the run. */
  private record(
    id: string,
    event: {
      source: EventSource;
      type: string;
      state?: AgentState;
      payload?: unknown;
      patch?: Partial<RunRow>;
    },
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
      // Bookkeeping (a saved screen, the tool check-in) is not something the run did: it does not
      // become its last event (a waiting run's `SessionStart` must stay its last event, for example).
      const set: Partial<RunRow> = {
        ...event.patch,
        lastEvent: BOOKKEEPING_EVENT_TYPES.has(event.type) ? current.lastEvent : event.type,
      };
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
