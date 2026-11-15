/** API contracts: runs. */
import { z } from 'zod';
import { AgentPersona, PermissionMode } from './projects.js';
import { MODEL_ID_RE } from './model-catalog.js';

export * from './model-catalog.js';
export * from './provider-registry.js';

/** A run's prompt limit (CreateRunBody): a ticket prompt with its context, a successor's with the handoff context. */
export const RUN_PROMPT_MAX = 20_000;

/**
 * Mirrors `AgentState` in @emberline/adapter-sdk. `queued` waits for a free slot (and quota);
 * `rate_limited` waits for the usage window to reset.
 */
export const RunState = z.enum([
  'queued',
  'starting',
  'working',
  'waiting_input',
  'rate_limited',
  'done',
  'failed',
]);
export type RunState = z.infer<typeof RunState>;

/** Supported CLI coding agent adapters. */
export const AgentId = z.enum(['claude', 'antigravity', 'copilot', 'codex', 'aider']);
export type AgentId = z.infer<typeof AgentId>;

/**
 * A run row keeps the agent it ran on as a plain string, and an older core may have stored one that
 * is gone now (Gemini CLI). Every lookup keyed by a run's agent checks it here first.
 */
export function isKnownAgent(agent: string): agent is AgentId {
  return AgentId.safeParse(agent).success;
}

/** A model id: `auto` or a CLI-reported id. The pattern keeps ids safe to pass as one shell word. */
export const AgentModelId = z.union([z.literal('auto'), z.string().regex(MODEL_ID_RE)]);
export type AgentModelId = string;

/** Capability tier and 1-5 star rank for the multi-provider model matrix. */
export const ModelCapabilityTier = z.enum(['high', 'medium', 'low']);
export type ModelCapabilityTier = z.infer<typeof ModelCapabilityTier>;

/** Formats a star rating string like `★★★★★` for a 1-5 rank. */
export function formatRankStars(rank: number): string {
  const filled = Math.max(1, Math.min(5, Math.round(rank)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

export const RunTelemetry = z.object({
  runId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  durationSec: z.number().int().nonnegative(),
  isEstimated: z.boolean(),
});
export type RunTelemetry = z.infer<typeof RunTelemetry>;

/** Why a run needs a person, in the order core checks them (apps/core/src/runs/attention.ts). */
export const RunAttentionReason = z.enum([
  'question',
  'permission',
  'stalled',
  'held',
  'blocked',
  'failed',
  'rate_limited',
]);
export type RunAttentionReason = z.infer<typeof RunAttentionReason>;

export const RunAttention = z.object({
  reason: RunAttentionReason,
  /** The question/permission message, hold label, blockers joined or failure reason. */
  detail: z.string().nullable(),
  /** ISO time of the triggering event. */
  since: z.string(),
  /** `${runId}:${reason}:${eventId}`: the same for every read of the same occurrence. */
  occurrence: z.string(),
});
export type RunAttention = z.infer<typeof RunAttention>;

/** Labels of the pipeline notes that hold a finished run for a person (HOLD_EVENTS, minus the nudge). */
export const HOLD_LABELS: Readonly<Record<string, string>> = {
  merge_failed: 'Merge failed',
  secret_guard_blocked: 'Secret found in the diff',
  slop_guard_blocked: 'Quality guard blocked',
  critic_blocked: 'Code audit asked for changes',
  build_gate_error: 'Build checks could not run',
  build_gate_failed: 'Build checks failed',
  completion_missing: 'No completion signal',
  completion_blocked: 'Blocked',
  review_blocked: 'Blocking review comments',
  no_changes: 'Finished without changes',
  pipeline_interrupted: 'Checks cut off by an update',
};

/** The first line of the worktree.yml check's `build_gate_failed` note (`output`), before the errors. */
export const WORKTREE_YML_INVALID = '.emberline/worktree.yml is not valid:';
/** What the worktree-commands check's note (`output`) says it asks for, in every release that wrote one. */
const WORKTREE_COMMANDS_ASK =
  'this ticket asks for the setup, build, lint and test commands and the preview service';

/**
 * Which worktree check a `build_gate_failed` note is about; null for an ordinary failed build and
 * other notes. Notes from before 0.5.0 named no check: those are told apart by their output.
 */
export function worktreeCheckOf(type: string, payload: unknown): 'worktree_yml' | 'worktree_commands' | null {
  if (type !== 'build_gate_failed') return null;
  const p = (payload ?? null) as { check?: unknown; output?: unknown } | null;
  if (p?.check === 'worktree_yml' || p?.check === 'worktree_commands') return p.check;
  if (p?.check !== undefined || typeof p?.output !== 'string') return null;
  if (p.output.startsWith(WORKTREE_YML_INVALID)) return 'worktree_yml';
  if (p.output.includes(WORKTREE_COMMANDS_ASK)) return 'worktree_commands';
  return null;
}

/** A hold's label: the worktree config checks (both are `build_gate_failed` notes) have their own; every other hold uses HOLD_LABELS. */
export function holdLabelOf(type: string, payload: unknown): string {
  const check = worktreeCheckOf(type, payload);
  if (check === 'worktree_yml') return 'Worktree config is not valid';
  if (check === 'worktree_commands') return 'Worktree commands are missing';
  return HOLD_LABELS[type] ?? 'Held for review';
}

/** One way out of a hold, best first (apps/core/src/runs/recovery.ts). */
export const RecoverySuggestion = z.object({
  /** Stable per kind, e.g. `resolve_conflicts`. */
  id: z.string(),
  kind: z.enum(['prompt', 'discard', 'merge', 'manual', 'open_review']),
  /** Button text. */
  label: z.string(),
  /** One line under the button. */
  detail: z.string().nullable(),
  /** Kind `prompt`: the prefilled, editable text for the agent. */
  prompt: z.string().nullable(),
  /** Files the suggestion is about (conflicts, for `manual`). */
  files: z.array(z.string()),
  /** Kind `manual`: copyable git commands. */
  commands: z.array(z.string()),
});
export type RecoverySuggestion = z.infer<typeof RecoverySuggestion>;

/** How a recovery prompt reaches an agent: the run's own session, a successor on the same branch, or not at all. */
export const RecoveryDelivery = z.enum(['session', 'successor', 'none']);
export type RecoveryDelivery = z.infer<typeof RecoveryDelivery>;

/** Why a held run is held and what a person can do about it (`GET /api/runs/:id/recovery`). */
export const RunRecovery = z.object({
  /** The hold note's type (HOLD_EVENTS); not shown to people. */
  hold: z.string(),
  /** HOLD_LABELS text. */
  label: z.string(),
  /** One plain sentence. */
  why: z.string(),
  delivery: RecoveryDelivery,
  /** At most three, best first. */
  suggestions: z.array(RecoverySuggestion).max(3),
});
export type RunRecovery = z.infer<typeof RunRecovery>;

/** Recovery suggestions that are a form for the person to fill in (an empty answer), never sent as they are. */
export const NEEDS_PERSON_INPUT: ReadonlySet<string> = new Set(['answer_blockers']);

/** `POST /api/runs/:id/recover`: the prompt to deliver. */
export const RecoverRequest = z.object({ text: z.string().trim().min(1).max(RUN_PROMPT_MAX) });
export type RecoverRequest = z.input<typeof RecoverRequest>;

export const Run = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Ticket this run works on; null for ad-hoc runs. */
  ticketId: z.string().nullable(),
  /** Display title (e.g. "DP-1 Fix login" for ticket runs); null for ad-hoc runs. */
  title: z.string().nullable(),
  agent: z.string(),
  persona: AgentPersona,
  state: RunState,
  prompt: z.string(),
  permissionMode: PermissionMode,
  /** Null when the project is not a git repository (the run works in the project directory). */
  branch: z.string().nullable(),
  worktreePath: z.string(),
  terminalId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  /** Last hook / system event type, for display. */
  lastEvent: z.string().nullable(),
  stateChangedAt: z.string(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  /** True when an ended run can be continued with `claude --resume` (a session id is known). */
  resumable: z.boolean(),
  /** The user stopped this run; it ended as `failed` (or `done` if its work was finished) and never resumes. */
  cancelled: z.boolean(),
  /**
   * Set while the run waits (as `rate_limited`) to retry a turn that died on a temporary provider
   * error: the attempt number (1-based), the most attempts made and when it retries.
   */
  autoRetry: z
    .object({ attempt: z.number().int(), max: z.number().int(), at: z.string() })
    .nullable()
    .optional(),
  /** Model the run was started with; null on runs from before 0.2.0 without a route tag. */
  model: z.string().nullable().default(null),
  credential: z.enum(['login', 'api_key', 'credits']).default('login'),
  /** The run's fallback chain (snapshot at enqueue) and the step it is on. */
  routes: z
    .array(
      z.object({ agent: z.string(), model: z.string(), credential: z.enum(['login', 'api_key', 'credits']) }),
    )
    .default([]),
  routeIndex: z.number().int().default(0),
  /** Run this one continues after a handoff, and the run that took over from this one. */
  predecessorRunId: z.string().nullable().default(null),
  handedOffTo: z.string().nullable().default(null),
  /** What the run needs from a person, or null; computed by core per read. */
  attention: RunAttention.nullable().default(null),
  /** Done, its ticket waits in Review and nothing holds it. */
  reviewReady: z.boolean().default(false),
  /** Token & tool execution telemetry (no monetary pricing). */
  telemetry: RunTelemetry.optional(),
});
export type Run = z.infer<typeof Run>;

/** Where a recovery prompt went; `run` is the run that got it (the successor when continued). */
export const RecoverResponse = z.object({
  delivery: z.enum(['session', 'successor']),
  run: Run,
});
export type RecoverResponse = z.infer<typeof RecoverResponse>;

export const CreateRunBody = z.object({
  projectId: z.string().min(1),
  agent: AgentId.default('claude'),
  model: AgentModelId.default('auto'),
  persona: AgentPersona.default('coder'),
  prompt: z.string().trim().max(RUN_PROMPT_MAX).default(''),
  permissionMode: PermissionMode.default('default'),
});
export type CreateRunBody = z.input<typeof CreateRunBody>;

export const HandoffBody = z.object({
  route: z.object({
    agent: AgentId,
    model: AgentModelId,
    credential: z.enum(['login', 'api_key', 'credits']).default('login'),
  }),
});
export type HandoffBody = z.input<typeof HandoffBody>;

export const RunEvent = z.object({
  id: z.number().int(),
  runId: z.string(),
  ts: z.string(),
  source: z.enum(['hook', 'transcript', 'screen', 'user', 'system']),
  type: z.string(),
  state: RunState.nullable(),
  payload: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const RunDetail = Run.extend({
  events: z.array(RunEvent),
  /** The agent's last answer in full (from the transcript when the hook copy was truncated). */
  finalMessage: z.string().nullable().default(null),
  /** The terminal's last screen, kept when its session closed; null while it is still open. */
  lastScreen: z.string().nullable().default(null),
  /** The run's work was merged into main (by the factory or a person) at least once. */
  mergedIntoMain: z.boolean().optional(),
});
export type RunDetail = z.infer<typeof RunDetail>;

/** Continue a rate-limited or ended run; defaults to a generic "continue" prompt. */
export const ResumeRunBody = z.object({ text: z.string().trim().max(20_000).optional() });
export type ResumeRunBody = z.input<typeof ResumeRunBody>;

export const PruneWorktreeBody = z.object({
  /** Remove the worktree even when it holds uncommitted changes or commits not in the default branch. */
  force: z.boolean().default(false),
});
export type PruneWorktreeBody = z.input<typeof PruneWorktreeBody>;

export const GarbageCollectRunsBody = z.object({
  projectId: z.string().min(1).optional(),
  /** Number of most-recent completed runs to retain (0 = purge all completed/failed runs). */
  keepRecent: z.number().int().min(0).max(500).default(0),
  /** Whether to also delete failed runs. Defaults to true. */
  includeFailed: z.boolean().default(true),
  /** Whether to prune git worktrees of removed runs. Defaults to true. */
  pruneWorktrees: z.boolean().default(true),
});
export type GarbageCollectRunsBody = z.input<typeof GarbageCollectRunsBody>;

export const GarbageCollectRunsResponse = z.object({
  removedRuns: z.number().int(),
  closedSessions: z.number().int(),
  prunedWorktrees: z.number().int(),
  /**
   * Finished runs whose worktree (and run row) were kept because removing it could lose work.
   * `archive_pending`: its build outputs could not be archived within the request's time budget.
   * `teardown_running`: its worktree.yml teardown outlasted the request's time budget; the worktree
   * is pruned and the run removed in the background once it ends.
   * `prune_running`: a prune of its worktree was running; the prune removes the worktree, and the next
   * clean-up removes the run.
   */
  keptWorktrees: z
    .array(
      z.object({
        runId: z.string(),
        reason: z.enum([
          'uncommitted_changes',
          'unmerged_commits',
          'in_review',
          'archive_pending',
          'teardown_running',
          'prune_running',
        ]),
      }),
    )
    .default([]),
  remainingRuns: z.number().int(),
});
export type GarbageCollectRunsResponse = z.infer<typeof GarbageCollectRunsResponse>;
