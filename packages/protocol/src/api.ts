/** Public REST + WebSocket API contracts shared by core and web. */
import { z } from 'zod';

// --- common -----------------------------------------------------------------

/** Every mutating API request must carry this header (CSRF defence, see core auth). */
export const CSRF_HEADER = 'x-emberline-csrf';

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SystemStatus = z.object({
  version: z.string(),
  ptyd: z.enum(['connecting', 'connected', 'disconnected']),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

// --- auth -------------------------------------------------------------------

export const AuthState = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthState = z.infer<typeof AuthState>;

export const MIN_PASSWORD_LENGTH = 10;

export const SetupBody = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH).max(1024) });
export type SetupBody = z.infer<typeof SetupBody>;

export const LoginBody = z.object({ password: z.string().min(1).max(1024) });
export type LoginBody = z.infer<typeof LoginBody>;

// --- projects ---------------------------------------------------------------

/** https://, ssh:// or scp-style git@host:path. Never starts with "-" (no git option injection). */
const RepoUrl = z
  .string()
  .trim()
  .max(2048)
  .regex(/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/, 'must be an https://, ssh:// or git@ URL');

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  repoUrl: z.string().nullable(),
  defaultBranch: z.string(),
  path: z.string(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  repoUrl: RepoUrl.optional().or(z.literal('').transform(() => undefined)),
  defaultBranch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .max(200)
    .default('main'),
});
export type CreateProjectBody = z.input<typeof CreateProjectBody>;

export const CreateProjectResponse = z.object({
  project: Project,
  /** Terminal running `git clone`, when a repo URL was given. */
  terminalId: z.string().nullable(),
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

// --- terminals --------------------------------------------------------------

export const TerminalKind = z.enum(['shell', 'claude', 'clone', 'agent']);
export type TerminalKind = z.infer<typeof TerminalKind>;

export const TerminalInfo = z.object({
  id: z.string(),
  title: z.string(),
  kind: TerminalKind,
  projectId: z.string().nullable(),
  /** Set when the terminal hosts an agent run. */
  runId: z.string().nullable(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const CreateTerminalBody = z.object({
  kind: z.enum(['shell', 'claude']).default('shell'),
  projectId: z.string().optional(),
});
export type CreateTerminalBody = z.input<typeof CreateTerminalBody>;

const Cols = z.number().int().min(2).max(1000);
const Rows = z.number().int().min(2).max(500);

/** Browser -> core over `/api/terminals/:id/ws`. */
export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({ type: z.literal('resize'), cols: Cols, rows: Rows }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

/** Core -> browser. The first message is always `snapshot`. */
export const TerminalServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    data: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
    status: z.enum(['running', 'exited']),
  }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable(), signal: z.number().int().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;

// --- runs -------------------------------------------------------------------

/**
 * Mirrors `AgentState` in @emberline/adapter-sdk. `queued` waits for a free slot (and quota);
 * `rate_limited` waits for the usage window to reset.
 */
export const RunState = z.enum(['queued', 'starting', 'working', 'waiting_input', 'rate_limited', 'done', 'failed']);
export type RunState = z.infer<typeof RunState>;

/** Claude Code `--permission-mode`. `bypassPermissions` is only sane inside the isolated runner. */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const Run = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Ticket this run works on; null for ad-hoc runs. */
  ticketId: z.string().nullable(),
  /** Display title (e.g. "DP-1 Fix login" for ticket runs); null for ad-hoc runs. */
  title: z.string().nullable(),
  agent: z.string(),
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
});
export type Run = z.infer<typeof Run>;

export const CreateRunBody = z.object({
  projectId: z.string().min(1),
  prompt: z.string().trim().max(20_000).default(''),
  permissionMode: PermissionMode.default('default'),
});
export type CreateRunBody = z.input<typeof CreateRunBody>;

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

export const RunDetail = Run.extend({ events: z.array(RunEvent) });
export type RunDetail = z.infer<typeof RunDetail>;

/** Continue a rate-limited or ended run; defaults to a generic "continue" prompt. */
export const ResumeRunBody = z.object({ text: z.string().trim().max(20_000).optional() });
export type ResumeRunBody = z.input<typeof ResumeRunBody>;

// --- quota scheduler --------------------------------------------------------

/** How the reset time of an exhausted window was determined. */
export const ResetSource = z.enum(['hook', 'screen', 'probe']);
export type ResetSource = z.infer<typeof ResetSource>;

export const QuotaWindow = z.object({
  id: z.string(),
  exhaustedAt: z.string(),
  /** When the usage window resets; null while unknown (probing). */
  resetsAt: z.string().nullable(),
  /** When the scheduler resumes work (reset + jitter, or the next probe). */
  resumeAt: z.string(),
  resetSource: ResetSource,
  /** The limit message as shown by the CLI. */
  message: z.string().nullable(),
  resumedAt: z.string().nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const MAX_CONCURRENCY = 8;

export const SchedulerState = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(MAX_CONCURRENCY),
  /** Runs currently holding a slot (starting / working). */
  busy: z.number().int(),
  queued: z.number().int(),
  rateLimited: z.number().int(),
  /** The exhausted window while dispatch is paused; null when quota is available. */
  window: QuotaWindow.nullable(),
});
export type SchedulerState = z.infer<typeof SchedulerState>;

export const UpdateSchedulerBody = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(MAX_CONCURRENCY),
});
export type UpdateSchedulerBody = z.input<typeof UpdateSchedulerBody>;

// --- tickets / board --------------------------------------------------------

/**
 * Board columns. A ticket with an active run sits in `in_progress` and shows the run's live
 * state (working / needs you / failed); `queued` arrives with the quota scheduler (M5).
 */
export const TicketStatus = z.enum(['backlog', 'ready', 'in_progress', 'review', 'done']);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** 0 = low ... 3 = urgent. */
export const TicketPriority = z.number().int().min(0).max(3);

export const Ticket = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Human key, e.g. "EMB-12"; stable once assigned. */
  key: z.string(),
  title: z.string(),
  body: z.string(),
  status: TicketStatus,
  priority: TicketPriority,
  /** Sort order inside a column (ascending). */
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const CreateTicketBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  priority: TicketPriority.default(1),
  status: TicketStatus.default('backlog'),
});
export type CreateTicketBody = z.input<typeof CreateTicketBody>;

export const UpdateTicketBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000),
    priority: TicketPriority,
    status: TicketStatus,
    position: z.number().finite(),
  })
  .partial();
export type UpdateTicketBody = z.input<typeof UpdateTicketBody>;

export const StartTicketBody = z.object({ permissionMode: PermissionMode.default('default') });
export type StartTicketBody = z.input<typeof StartTicketBody>;

/** Follow-up prompt typed into the ticket's live run. */
export const TicketPromptBody = z.object({ text: z.string().trim().min(1).max(20_000) });
export type TicketPromptBody = z.input<typeof TicketPromptBody>;

// --- review: git diff, commit/push & artifacts (M6) -------------------------

/**
 * `branch` compares the working tree against the merge-base with the project's default branch.
 * `unstaged` is working tree vs index (including untracked files); `staged` is index vs HEAD.
 */
export const DiffScope = z.enum(['branch', 'unstaged', 'staged']);
export type DiffScope = z.infer<typeof DiffScope>;

export const DiffFileStatus = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']);
export type DiffFileStatus = z.infer<typeof DiffFileStatus>;

export const DiffFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: DiffFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  staged: z.boolean(),
  unstaged: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const RunDiffSummary = z.object({
  runId: z.string(),
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
  baseBranch: z.string(),
  headSha: z.string().nullable(),
  aheadCount: z.number().int().nonnegative(),
  clean: z.boolean(),
  hasRemote: z.boolean(),
  scope: DiffScope,
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  files: z.array(DiffFile),
});
export type RunDiffSummary = z.infer<typeof RunDiffSummary>;

export const RunFileDiff = z.object({
  path: z.string(),
  scope: DiffScope,
  status: DiffFileStatus,
  binary: z.boolean(),
  original: z.string(),
  modified: z.string(),
  patch: z.string(),
});
export type RunFileDiff = z.infer<typeof RunFileDiff>;

export const GitStageBody = z.object({
  paths: z.array(z.string().min(1).max(1024)).max(500).optional(),
  all: z.boolean().default(false),
  unstage: z.boolean().default(false),
});
export type GitStageBody = z.input<typeof GitStageBody>;

export const GitCommitBody = z.object({
  message: z.string().trim().min(1).max(4_000),
  stageAll: z.boolean().default(true),
});
export type GitCommitBody = z.input<typeof GitCommitBody>;

export const GitCommitResponse = z.object({
  sha: z.string(),
  branch: z.string().nullable(),
  summary: z.string(),
});
export type GitCommitResponse = z.infer<typeof GitCommitResponse>;

export const GitPushResponse = z.object({
  branch: z.string(),
  remote: z.string(),
  output: z.string(),
});
export type GitPushResponse = z.infer<typeof GitPushResponse>;

export const ArtifactKind = z.enum(['image', 'trace', 'log', 'document', 'file']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const RunArtifact = z.object({
  path: z.string(),
  name: z.string(),
  kind: ArtifactKind,
  sizeBytes: z.number().int().nonnegative(),
  mtime: z.string(),
});
export type RunArtifact = z.infer<typeof RunArtifact>;

export const PruneWorktreeResponse = z.object({
  runId: z.string(),
  worktreePath: z.string(),
  removed: z.boolean(),
});
export type PruneWorktreeResponse = z.infer<typeof PruneWorktreeResponse>;

// --- notifications (ntfy / webhook) -----------------------------------------

export const NotificationProvider = z.enum(['ntfy', 'webhook']);
export type NotificationProvider = z.infer<typeof NotificationProvider>;

export const NotificationSettings = z.object({
  enabled: z.boolean(),
  provider: NotificationProvider,
  /** Target URL (e.g. https://ntfy.sh/my-emberline-topic or Discord/Slack/generic webhook URL). */
  url: z.string(),
  /** Optional Bearer token (for private ntfy servers or authenticated webhooks). */
  token: z.string().nullable(),
  onRateLimited: z.boolean(),
  onQuotaResumed: z.boolean(),
  onWaitingInput: z.boolean(),
  onRunFinished: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const UpdateNotificationSettingsBody = z
  .object({
    enabled: z.boolean(),
    provider: NotificationProvider,
    url: z.string().trim().max(1000),
    token: z.string().trim().max(500).nullable(),
    onRateLimited: z.boolean(),
    onQuotaResumed: z.boolean(),
    onWaitingInput: z.boolean(),
    onRunFinished: z.boolean(),
  })
  .partial();
export type UpdateNotificationSettingsBody = z.input<typeof UpdateNotificationSettingsBody>;

export const TestNotificationResponse = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type TestNotificationResponse = z.infer<typeof TestNotificationResponse>;

// --- forge integration (GitHub / GitLab / Gitea PR & MR) --------------------

export const ForgeProvider = z.enum(['github', 'gitlab', 'gitea']);
export type ForgeProvider = z.infer<typeof ForgeProvider>;

export const ForgeProviderPreference = z.enum(['auto', 'github', 'gitlab', 'gitea']);
export type ForgeProviderPreference = z.infer<typeof ForgeProviderPreference>;

export const ForgeSettings = z.object({
  provider: ForgeProviderPreference,
  /** Optional custom API base URL for self-hosted GitLab / Gitea / GitHub Enterprise. */
  apiUrl: z.string().nullable(),
  /** True when a Personal Access Token is stored in core (token itself is masked on GET). */
  tokenConfigured: z.boolean(),
});
export type ForgeSettings = z.infer<typeof ForgeSettings>;

export const UpdateForgeSettingsBody = z
  .object({
    provider: ForgeProviderPreference,
    apiUrl: z.string().trim().max(1000).nullable(),
    /** Pass null or empty string to clear, or a new PAT to replace. */
    token: z.string().trim().max(500).nullable(),
  })
  .partial();
export type UpdateForgeSettingsBody = z.input<typeof UpdateForgeSettingsBody>;

export const ForgeCiStatus = z.enum(['pending', 'success', 'failure', 'unknown']);
export type ForgeCiStatus = z.infer<typeof ForgeCiStatus>;

export const ForgePullRequest = z.object({
  provider: ForgeProvider,
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  ciStatus: ForgeCiStatus,
});
export type ForgePullRequest = z.infer<typeof ForgePullRequest>;

export const RunForgeStatus = z.object({
  provider: ForgeProvider.nullable(),
  repoPath: z.string().nullable(),
  repoWebUrl: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string(),
  compareUrl: z.string().nullable(),
  tokenConfigured: z.boolean(),
  pullRequest: ForgePullRequest.nullable(),
});
export type RunForgeStatus = z.infer<typeof RunForgeStatus>;

export const CreatePullRequestBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(30_000).optional(),
  baseBranch: z.string().trim().min(1).max(200).optional(),
  draft: z.boolean().default(false),
  /** Push the run branch to `origin` before creating the PR/MR. */
  pushFirst: z.boolean().default(true),
});
export type CreatePullRequestBody = z.infer<typeof CreatePullRequestBody>;

// --- scheduled / cron agent jobs (Phase 2.2) --------------------------------

export const ScheduledJob = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  cronExpr: z.string(),
  prompt: z.string(),
  permissionMode: PermissionMode,
  enabled: z.boolean(),
  lastRunId: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
  createdAt: z.string(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const CreateScheduledJobBody = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  cronExpr: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  permissionMode: PermissionMode.default('acceptEdits'),
  enabled: z.boolean().default(true),
});
export type CreateScheduledJobBody = z.input<typeof CreateScheduledJobBody>;

export const UpdateScheduledJobBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    cronExpr: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(20_000),
    permissionMode: PermissionMode,
    enabled: z.boolean(),
  })
  .partial();
export type UpdateScheduledJobBody = z.input<typeof UpdateScheduledJobBody>;

// --- live events (`/api/events` WebSocket) ----------------------------------

/** Core -> browser push channel. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), run: Run }),
  z.object({ type: z.literal('run_removed'), id: z.string() }),
  z.object({ type: z.literal('ticket'), ticket: Ticket }),
  z.object({ type: z.literal('ticket_removed'), id: z.string(), projectId: z.string() }),
  z.object({ type: z.literal('scheduler'), scheduler: SchedulerState }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;



