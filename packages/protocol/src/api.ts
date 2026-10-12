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

/** Mirrors `AgentState` in @emberline/adapter-sdk. */
export const RunState = z.enum(['starting', 'working', 'waiting_input', 'rate_limited', 'done', 'failed']);
export type RunState = z.infer<typeof RunState>;

/** Claude Code `--permission-mode`. `bypassPermissions` is only sane inside the isolated runner. */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const Run = z.object({
  id: z.string(),
  projectId: z.string(),
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

// --- live events (`/api/events` WebSocket) ----------------------------------

/** Core -> browser push channel. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), run: Run }),
  z.object({ type: z.literal('run_removed'), id: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
