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

// --- projects & AI factory metadata -----------------------------------------

/** Specialized AI Coding Factory agent personas. */
export const AgentPersona = z.enum([
  'product_owner',
  'architect',
  'ui_ux',
  'coder',
  'dba',
  'qa',
  'security',
]);
export type AgentPersona = z.infer<typeof AgentPersona>;

export const ProjectAppType = z.enum([
  'web_saas',
  'fullstack',
  'api_service',
  'cli_tool',
  'mobile_desktop',
  'library',
  'custom',
]);
export type ProjectAppType = z.infer<typeof ProjectAppType>;

export const ProjectTechStack = z.object({
  language: z.string().max(100).default(''),
  frontend: z.string().max(100).default(''),
  backend: z.string().max(100).default(''),
  database: z.string().max(100).default(''),
  styling: z.string().max(100).default(''),
  testing: z.string().max(100).default(''),
});
export type ProjectTechStack = z.infer<typeof ProjectTechStack>;

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
  appType: ProjectAppType,
  description: z.string(),
  techStack: ProjectTechStack.nullable(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(['manual', 'wizard']).default('manual'),
  repoUrl: RepoUrl.optional().or(z.literal('').transform(() => undefined)),
  defaultBranch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .max(200)
    .default('main'),
  appType: ProjectAppType.default('custom'),
  description: z.string().trim().max(4000).default(''),
  techStack: ProjectTechStack.optional(),
  architectureNotes: z.string().trim().max(20_000).optional(),
  referenceDocs: z.string().trim().max(40_000).optional(),
  initGit: z.boolean().optional(),
  seedStarterTickets: z.boolean().default(false),
});
export type CreateProjectBody = z.input<typeof CreateProjectBody>;

export const CreateProjectResponse = z.object({
  project: Project,
  /** Terminal running `git clone`, when a repo URL was given. */
  terminalId: z.string().nullable(),
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

export const ProjectBlueprintResponse = z.object({
  projectId: z.string(),
  exists: z.boolean(),
  content: z.string(),
  path: z.string(),
});
export type ProjectBlueprintResponse = z.infer<typeof ProjectBlueprintResponse>;

export const UpdateProjectBlueprintBody = z.object({
  content: z.string().max(200_000),
});
export type UpdateProjectBlueprintBody = z.input<typeof UpdateProjectBlueprintBody>;

export const ActiveProjectPreference = z.object({
  activeProjectId: z.string().nullable(),
});
export type ActiveProjectPreference = z.infer<typeof ActiveProjectPreference>;

export const ProjectRecommendation = z.object({
  id: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  category: z.enum(['blueprint', 'backlog', 'execution', 'qa', 'review']),
  title: z.string(),
  description: z.string(),
  persona: AgentPersona,
  actionLabel: z.string(),
  actionType: z.enum(['open_blueprint', 'seed_tickets', 'start_run', 'open_board', 'open_review']),
  prompt: z.string().optional(),
  runId: z.string().optional(),
});
export type ProjectRecommendation = z.infer<typeof ProjectRecommendation>;

/** Claude Code `--permission-mode`. `bypassPermissions` is only sane inside the isolated runner. */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const TaskTemplate = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  persona: AgentPersona,
  permissionMode: PermissionMode,
  titlePlaceholder: z.string(),
  promptTemplate: z.string(),
});
export type TaskTemplate = z.infer<typeof TaskTemplate>;

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

/** Supported CLI coding agent adapters. */
export const AgentId = z.enum(['claude', 'antigravity', 'copilot', 'gemini', 'codex', 'aider']);
export type AgentId = z.infer<typeof AgentId>;

/** Model tiers across Claude (fable/opus/sonnet/haiku), Antigravity (argon/gemini-pro), and Copilot/Codex (gpt-4o). */
export const AgentModelId = z.enum([
  'auto',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'argon',
  'gemini-pro',
  'gpt-4o',
]);
export type AgentModelId = z.infer<typeof AgentModelId>;

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
});
export type Run = z.infer<typeof Run>;

export const CreateRunBody = z.object({
  projectId: z.string().min(1),
  agent: AgentId.default('claude'),
  model: AgentModelId.default('auto'),
  persona: AgentPersona.default('coder'),
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
  persona: AgentPersona,
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
  persona: AgentPersona.default('coder'),
  priority: TicketPriority.default(1),
  status: TicketStatus.default('backlog'),
});
export type CreateTicketBody = z.input<typeof CreateTicketBody>;

export const UpdateTicketBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000),
    persona: AgentPersona,
    priority: TicketPriority,
    status: TicketStatus,
    position: z.number().finite(),
  })
  .partial();
export type UpdateTicketBody = z.input<typeof UpdateTicketBody>;

export const StartTicketBody = z.object({
  permissionMode: PermissionMode.default('default'),
  persona: AgentPersona.optional(),
});
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

// --- per-worktree preview environments (Phase 2.3) --------------------------

export const RunPreviewStatus = z.object({
  runId: z.string(),
  status: z.enum(['stopped', 'running', 'exited']),
  terminalId: z.string().nullable(),
  command: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  detectedCommand: z.string().nullable(),
});
export type RunPreviewStatus = z.infer<typeof RunPreviewStatus>;

export const StartPreviewBody = z.object({
  command: z.string().trim().min(1).max(500).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
});
export type StartPreviewBody = z.input<typeof StartPreviewBody>;

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

// --- project status, worktree sync & interactive demo (Factory F5) ----------

export const WorkspaceDemoTarget = z.object({
  /** 'main' for /workspaces/<slug>, or the runId for a ticket run worktree. */
  id: z.string(),
  kind: z.enum(['main', 'worktree']),
  label: z.string(),
  ticketKey: z.string().nullable(),
  ticketTitle: z.string().nullable(),
  persona: AgentPersona.nullable(),
  runStatus: RunState.nullable(),
  branch: z.string().nullable(),
  workspacePath: z.string(),
  exists: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  topFiles: z.array(z.string()),
  hasPackageJson: z.boolean(),
  hasBuildScript: z.boolean(),
  /** Relative path to the detected playable HTML entrypoint (e.g. 'dist/index.html', 'apps/client/dist/index.html', 'index.html'), or null if not built yet. */
  demoEntryRelPath: z.string().nullable(),
  /** Ready-to-open URL served by core, e.g. `/api/projects/:id/demo/main/` or `/api/projects/:id/demo/:runId/`. */
  demoUrl: z.string().nullable(),
  updatedAt: z.string(),
});
export type WorkspaceDemoTarget = z.infer<typeof WorkspaceDemoTarget>;

export const ProjectStatusSummary = z.object({
  projectId: z.string(),
  workspaceRoot: z.string(),
  hostBindHint: z.string(),
  ticketCounts: z.object({
    total: z.number().int().nonnegative(),
    backlog: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  completionPercent: z.number().int().min(0).max(100),
  activeRunCount: z.number().int().nonnegative(),
  autoChainActive: z.boolean().default(false),
  targets: z.array(WorkspaceDemoTarget),
});
export type ProjectStatusSummary = z.infer<typeof ProjectStatusSummary>;

export const SyncWorktreeBody = z.object({
  runId: z.string().min(1),
});
export type SyncWorktreeBody = z.input<typeof SyncWorktreeBody>;

export const SyncWorktreeResponse = z.object({
  ok: z.boolean(),
  runId: z.string(),
  filesSynced: z.number().int().nonnegative(),
  commitSha: z.string().nullable(),
  summary: z.string(),
});
export type SyncWorktreeResponse = z.infer<typeof SyncWorktreeResponse>;

export const BuildDemoBody = z.object({
  targetId: z.string().default('main'),
});
export type BuildDemoBody = z.input<typeof BuildDemoBody>;

export const BuildDemoResponse = z.object({
  ok: z.boolean(),
  targetId: z.string(),
  demoEntryRelPath: z.string().nullable(),
  demoUrl: z.string().nullable(),
  output: z.string(),
});
export type BuildDemoResponse = z.infer<typeof BuildDemoResponse>;

// --- autonomous factory orchestrator & agent self-task creation (Factory F6) -

export const AgentTicketDraft = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  persona: AgentPersona.default('coder'),
  priority: TicketPriority.default(2),
  preferredAgent: AgentId.optional(),
  preferredModel: AgentModelId.optional(),
});
export type AgentTicketDraft = z.infer<typeof AgentTicketDraft>;

export const AgentCreateTicketsPayload = z.object({
  autoDispatch: z.boolean().default(true),
  tickets: z.array(AgentTicketDraft).min(1).max(20),
});
export type AgentCreateTicketsPayload = z.input<typeof AgentCreateTicketsPayload>;

export const FactoryRequestBody = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  leadPersona: AgentPersona.default('product_owner'),
  permissionMode: z
    .preprocess((v) => (v === 'auto' ? 'acceptEdits' : v), PermissionMode)
    .default('acceptEdits'),
  autoDispatch: z.boolean().default(true),
});
export type FactoryRequestBody = z.input<typeof FactoryRequestBody>;

export const FactoryRequestResponse = z.object({
  ticket: Ticket,
  run: Run,
});
export type FactoryRequestResponse = z.infer<typeof FactoryRequestResponse>;

// --- unified factory settings, theme, code explorer, checkpoints & browser (F7-F11) ---

export const ThemeMode = z.enum(['dark', 'light']);
export type ThemeMode = z.infer<typeof ThemeMode>;

export const PersonaAgentMap = z.object({
  product_owner: AgentId.default('claude'),
  architect: AgentId.default('claude'),
  ui_ux: AgentId.default('claude'),
  coder: AgentId.default('claude'),
  dba: AgentId.default('claude'),
  qa: AgentId.default('claude'),
  security: AgentId.default('claude'),
});
export type PersonaAgentMap = z.infer<typeof PersonaAgentMap>;

export const PersonaModelMap = z.object({
  product_owner: AgentModelId.default('fable'),
  architect: AgentModelId.default('fable'),
  ui_ux: AgentModelId.default('argon'),
  coder: AgentModelId.default('opus'),
  dba: AgentModelId.default('opus'),
  qa: AgentModelId.default('sonnet'),
  security: AgentModelId.default('opus'),
});
export type PersonaModelMap = z.infer<typeof PersonaModelMap>;

export const FactorySettings = z.object({
  theme: ThemeMode.default('dark'),
  defaultAgent: AgentId.default('claude'),
  personaAgents: PersonaAgentMap,
  personaModels: PersonaModelMap.default({
    product_owner: 'fable',
    architect: 'fable',
    ui_ux: 'argon',
    coder: 'opus',
    dba: 'opus',
    qa: 'sonnet',
    security: 'opus',
  }),
  quotaAutoDowngrade: z.boolean().default(true),
  autoPickupReady: z.boolean().default(true),
  autoPickupBacklog: z.boolean().default(false),
  autoSyncToMain: z.boolean().default(true),
  selfHealingBuildGate: z.boolean().default(true),
  autoMoveToDone: z.boolean().default(true),
  anthropicKeyConfigured: z.boolean().default(false),
  openaiKeyConfigured: z.boolean().default(false),
  geminiKeyConfigured: z.boolean().default(false),
});
export type FactorySettings = z.infer<typeof FactorySettings>;

export const UpdateFactorySettingsBody = z
  .object({
    theme: ThemeMode,
    defaultAgent: AgentId,
    personaAgents: PersonaAgentMap.partial(),
    personaModels: PersonaModelMap.partial(),
    quotaAutoDowngrade: z.boolean(),
    autoPickupReady: z.boolean(),
    autoPickupBacklog: z.boolean(),
    autoSyncToMain: z.boolean(),
    selfHealingBuildGate: z.boolean(),
    autoMoveToDone: z.boolean(),
    anthropicApiKey: z.string().trim().max(500).nullable(),
    openaiApiKey: z.string().trim().max(500).nullable(),
    geminiApiKey: z.string().trim().max(500).nullable(),
  })
  .partial();
export type UpdateFactorySettingsBody = z.input<typeof UpdateFactorySettingsBody>;

export const WorkspaceFileEntry = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['file', 'directory']),
  sizeBytes: z.number().int().nonnegative(),
  mtime: z.string(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

export const WorkspaceFileListResponse = z.object({
  targetId: z.string(),
  workspacePath: z.string(),
  entries: z.array(WorkspaceFileEntry),
});
export type WorkspaceFileListResponse = z.infer<typeof WorkspaceFileListResponse>;

export const WorkspaceFileContentResponse = z.object({
  targetId: z.string(),
  path: z.string(),
  content: z.string(),
  binary: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});
export type WorkspaceFileContentResponse = z.infer<typeof WorkspaceFileContentResponse>;

export const WriteWorkspaceFileBody = z.object({
  targetId: z.string().default('main'),
  path: z.string().trim().min(1).max(1024),
  content: z.string().max(2_000_000),
});
export type WriteWorkspaceFileBody = z.input<typeof WriteWorkspaceFileBody>;

export const DeleteWorkspaceFileBody = z.object({
  targetId: z.string().default('main'),
  path: z.string().trim().min(1).max(1024),
});
export type DeleteWorkspaceFileBody = z.input<typeof DeleteWorkspaceFileBody>;

export const ProjectCheckpoint = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  author: z.string(),
  createdAt: z.string(),
});
export type ProjectCheckpoint = z.infer<typeof ProjectCheckpoint>;

export const RollbackCheckpointBody = z.object({
  sha: z.string().trim().min(4).max(64),
});
export type RollbackCheckpointBody = z.input<typeof RollbackCheckpointBody>;

export const BrowserTabInfo = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
});
export type BrowserTabInfo = z.infer<typeof BrowserTabInfo>;

export const BrowserConsoleEntry = z.object({
  level: z.enum(['log', 'info', 'warn', 'error']),
  text: z.string(),
  timestamp: z.string(),
});
export type BrowserConsoleEntry = z.infer<typeof BrowserConsoleEntry>;

export const BrowserAgentAction = z.object({
  id: z.number(),
  runId: z.string(),
  runTitle: z.string().nullable(),
  persona: AgentPersona,
  toolName: z.string(),
  summary: z.string(),
  timestamp: z.string(),
});
export type BrowserAgentAction = z.infer<typeof BrowserAgentAction>;

export const BrowserViewportSnapshot = z.object({
  available: z.boolean(),
  source: z.enum(['cdp_live', 'x11', 'headless_browser', 'none']),
  targetUrl: z.string().nullable(),
  pageTitle: z.string().nullable().optional(),
  activeTabId: z.string().nullable().optional(),
  tabs: z.array(BrowserTabInfo).optional(),
  consoleLogs: z.array(BrowserConsoleEntry).optional(),
  agentActions: z.array(BrowserAgentAction).optional(),
  agentActive: z.boolean().optional(),
  playtestActive: z.boolean().optional(),
  imageDataUrl: z.string().nullable(),
  capturedAt: z.string(),
  message: z.string().nullable(),
});
export type BrowserViewportSnapshot = z.infer<typeof BrowserViewportSnapshot>;

export const BrowserActionBody = z.object({
  action: z.enum([
    'navigate',
    'reload',
    'back',
    'forward',
    'click',
    'type',
    'key',
    'select_tab',
    'new_tab',
    'close_tab',
    'start_playtest',
    'stop_playtest',
  ]),
  url: z.string().optional(),
  tabId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.enum(['left', 'right']).optional(),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  key: z.string().optional(),
  targetId: z.string().optional(),
});
export type BrowserActionBody = z.input<typeof BrowserActionBody>;

// --- Claude OAuth usage & token telemetry (5h / 7d windows + token counts) ---

export const ClaudeTokenBucket = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
});
export type ClaudeTokenBucket = z.infer<typeof ClaudeTokenBucket>;

export const ClaudeUsageWindow = z.object({
  utilizationPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
  severity: z.string().default('normal'),
});
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

export const ClaudeUsageTelemetry = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  subscriptionType: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
  fiveHour: ClaudeUsageWindow.nullable(),
  sevenDay: ClaudeUsageWindow.nullable(),
  extraUsage: z
    .object({
      enabled: z.boolean(),
      usedUsd: z.number(),
      limitUsd: z.number(),
      utilizationPercent: z.number(),
      disabledReason: z.string().nullable(),
    })
    .nullable(),
  hourlyTokens: ClaudeTokenBucket,
  dailyTokens: ClaudeTokenBucket,
  weeklyTokens: ClaudeTokenBucket,
  updatedAt: z.string(),
});
export type ClaudeUsageTelemetry = z.infer<typeof ClaudeUsageTelemetry>;

// --- Interactive Roadmap, Milestones & AI Brainstorming Studio --------------

export const RoadmapCategory = z.enum([
  'feature',
  'ui_ux',
  'architecture',
  'performance',
  'qa_security',
]);
export type RoadmapCategory = z.infer<typeof RoadmapCategory>;

export const RoadmapItemStatus = z.enum(['idea', 'planned', 'in_progress', 'done']);
export type RoadmapItemStatus = z.infer<typeof RoadmapItemStatus>;

export const RoadmapItem = z.object({
  id: z.string(),
  milestoneId: z.string(),
  title: z.string(),
  description: z.string(),
  category: RoadmapCategory.default('feature'),
  persona: AgentPersona.default('coder'),
  preferredAgent: AgentId.default('claude'),
  preferredModel: AgentModelId.default('auto'),
  priority: TicketPriority.default(2),
  status: RoadmapItemStatus.default('planned'),
  ticketId: z.string().nullable().default(null),
  ticketKey: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type RoadmapItem = z.infer<typeof RoadmapItem>;

export const RoadmapMilestone = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  description: z.string().default(''),
  status: z.enum(['planned', 'active', 'completed']).default('planned'),
  items: z.array(RoadmapItem).default([]),
});
export type RoadmapMilestone = z.infer<typeof RoadmapMilestone>;

export const BrainstormSuggestion = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  implementationPrompt: z.string(),
  category: RoadmapCategory,
  impact: z.enum(['high', 'medium', 'low']).default('high'),
  effort: z.enum(['small', 'medium', 'large']).default('medium'),
  persona: AgentPersona,
  preferredAgent: AgentId,
  preferredModel: AgentModelId,
  suggestedMilestoneCode: z.string().default('M2'),
});
export type BrainstormSuggestion = z.infer<typeof BrainstormSuggestion>;

export const ProjectRoadmapState = z.object({
  projectId: z.string(),
  visionSummary: z.string(),
  totalItems: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(),
  completionPercent: z.number().int().min(0).max(100),
  milestones: z.array(RoadmapMilestone),
  suggestions: z.array(BrainstormSuggestion),
  updatedAt: z.string(),
});
export type ProjectRoadmapState = z.infer<typeof ProjectRoadmapState>;

export const CreateMilestoneBody = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
});
export type CreateMilestoneBody = z.input<typeof CreateMilestoneBody>;

export const CreateRoadmapItemBody = z.object({
  milestoneId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).default(''),
  category: RoadmapCategory.default('feature'),
  persona: AgentPersona.default('coder'),
  preferredAgent: AgentId.default('claude'),
  preferredModel: AgentModelId.default('auto'),
  priority: TicketPriority.default(2),
  status: RoadmapItemStatus.default('planned'),
});
export type CreateRoadmapItemBody = z.input<typeof CreateRoadmapItemBody>;

export const UpdateRoadmapItemBody = z
  .object({
    milestoneId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000),
    category: RoadmapCategory,
    persona: AgentPersona,
    preferredAgent: AgentId,
    preferredModel: AgentModelId,
    priority: TicketPriority,
    status: RoadmapItemStatus,
  })
  .partial();
export type UpdateRoadmapItemBody = z.input<typeof UpdateRoadmapItemBody>;

export const BrainstormRequestBody = z.object({
  focus: z.string().trim().max(2000).default(''),
  mode: z.enum(['instant', 'agent']).default('instant'),
  leadPersona: AgentPersona.default('product_owner'),
});
export type BrainstormRequestBody = z.input<typeof BrainstormRequestBody>;

export const BrainstormResponse = z.object({
  roadmap: ProjectRoadmapState,
  agentRun: Run.nullable().default(null),
});
export type BrainstormResponse = z.infer<typeof BrainstormResponse>;

export const DispatchRoadmapItemsBody = z.object({
  itemIds: z.array(z.string()).default([]),
  suggestionIds: z.array(z.string()).default([]),
  targetMilestoneId: z.string().optional(),
  autoStart: z.boolean().default(true),
});
export type DispatchRoadmapItemsBody = z.input<typeof DispatchRoadmapItemsBody>;

export const DispatchRoadmapItemsResponse = z.object({
  roadmap: ProjectRoadmapState,
  createdTickets: z.array(Ticket),
  startedRun: Run.nullable().default(null),
});
export type DispatchRoadmapItemsResponse = z.infer<typeof DispatchRoadmapItemsResponse>;

