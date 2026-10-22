/** API contracts: unified factory settings, theme, code explorer, checkpoints & browser (F7-F11). */
import { z } from 'zod';
import { AgentPersona } from './projects.js';
import { TerminalInfo } from './terminals.js';
import { AgentId, AgentModelId } from './runs.js';
import { PersonaRouteMap, QuotaPolicy } from './routing.js';

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
  ui_ux: AgentModelId.default('opus'),
  coder: AgentModelId.default('opus'),
  dba: AgentModelId.default('opus'),
  qa: AgentModelId.default('sonnet'),
  security: AgentModelId.default('opus'),
});
export type PersonaModelMap = z.infer<typeof PersonaModelMap>;

export const ProviderAuthStatus = z.object({
  authenticated: z.boolean(),
  method: z.enum(['oauth_cli', 'api_key', 'host_auth', 'none']),
  label: z.string(),
  cliInstalled: z.boolean().default(true),
  loginCommandHint: z.string(),
  warning: z.string().optional(),
});
export type ProviderAuthStatus = z.infer<typeof ProviderAuthStatus>;

export const ProviderAuthStatusMap = z.object({
  claude: ProviderAuthStatus,
  antigravity: ProviderAuthStatus,
  gemini: ProviderAuthStatus,
  codex: ProviderAuthStatus,
  copilot: ProviderAuthStatus,
  aider: ProviderAuthStatus,
});
export type ProviderAuthStatusMap = z.infer<typeof ProviderAuthStatusMap>;

export const McpServerTransport = z.enum(['stdio', 'sse', 'http']);
export type McpServerTransport = z.infer<typeof McpServerTransport>;

export const McpServerEntry = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
  icon: z.string().max(16).default('🔌'),
  transport: McpServerTransport.default('stdio'),
  command: z.string().max(300).default(''),
  args: z.array(z.string()).default([]),
  url: z.string().max(500).nullable().default(null),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(false),
  builtIn: z.boolean().default(false),
  /** Empty array means available to ALL personas; non-empty restricts to selected personas. */
  personas: z.array(AgentPersona).default([]),
});
export type McpServerEntry = z.infer<typeof McpServerEntry>;

export const SkillPluginCategory = z.enum([
  'ui_ux',
  'architecture',
  'security',
  'qa',
  'workflow',
  'custom',
]);
export type SkillPluginCategory = z.infer<typeof SkillPluginCategory>;

export const SkillPluginEntry = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
  icon: z.string().max(16).default('🧩'),
  category: SkillPluginCategory.default('workflow'),
  instructions: z.string().min(1).max(10_000),
  enabled: z.boolean().default(true),
  builtIn: z.boolean().default(false),
  /** Empty array means injected for ALL personas; non-empty restricts to selected personas. */
  personas: z.array(AgentPersona).default([]),
});
export type SkillPluginEntry = z.infer<typeof SkillPluginEntry>;

export const DEFAULT_MCP_SERVERS: McpServerEntry[] = [
  {
    id: 'playwright',
    name: 'Playwright Live Browser (CDP)',
    description:
      'Connects agents to the shared Chromium CDP instance (127.0.0.1:9222) for live visual QA, DOM snapshots, and interactive click/type testing.',
    icon: '🌐',
    transport: 'stdio',
    command: 'playwright-mcp',
    args: ['--cdp-endpoint', 'http://127.0.0.1:9222', '--output-dir', './artifacts'],
    url: null,
    env: {},
    enabled: true,
    builtIn: true,
    personas: ['ui_ux', 'qa', 'coder'],
  },
  {
    id: 'context7',
    name: 'Context7 Live Library Docs',
    description:
      'Fetches up-to-date, version-accurate official documentation and code examples for npm/PyPI/Crate packages to eliminate hallucinated APIs.',
    icon: '📚',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    url: null,
    env: {},
    enabled: false,
    builtIn: true,
    personas: ['architect', 'coder', 'ui_ux', 'dba'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking & Deep Planner',
    description:
      'Provides structured multi-step reasoning and hypothesis revision tools for complex system architecture and root-cause debugging.',
    icon: '🧠',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    url: null,
    env: {},
    enabled: false,
    builtIn: true,
    personas: ['product_owner', 'architect', 'security'],
  },
  {
    id: 'filesystem-inspector',
    name: 'MCP Workspace & Reference Inspector',
    description:
      'Structured MCP filesystem operations for reading reference specifications, schemas, and multi-directory project layouts.',
    icon: '📂',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    url: null,
    env: {},
    enabled: false,
    builtIn: true,
    personas: [],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL Schema & Query Inspector',
    description:
      'Allows DBA and Backend agents to inspect live PostgreSQL schemas, indexes, and explain plans via DATABASE_URL.',
    icon: '🐘',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    url: null,
    env: {},
    enabled: false,
    builtIn: true,
    personas: ['dba', 'coder'],
  },
  {
    id: 'github',
    name: 'GitHub Repository & PR MCP',
    description:
      'Queries GitHub issues, pull requests, workflow runs, and code search via GITHUB_PERSONAL_ACCESS_TOKEN.',
    icon: '🐙',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    url: null,
    env: {},
    enabled: false,
    builtIn: true,
    personas: ['product_owner', 'architect', 'qa'],
  },
];

export const DEFAULT_SKILL_PLUGINS: SkillPluginEntry[] = [
  {
    id: 'modern-ui-craft',
    name: 'High-Craft UI & Design Systems Skill',
    description:
      'Enforces intentional design tokens, tabular numerals, keyboard navigation, responsive density, and bans generic AI purple-gradient templates.',
    icon: '🎨',
    category: 'ui_ux',
    instructions:
      'DESIGN SYSTEM SKILL: Build interfaces with Linear/Raycast/Stripe-level craft. Always reuse existing CSS custom properties (`var(--...)`), support keyboard shortcuts/focus rings, align numeric columns with `font-variant-numeric: tabular-nums`, and design explicit empty, loading, and error states.',
    enabled: true,
    builtIn: true,
    personas: ['ui_ux', 'coder'],
  },
  {
    id: 'strict-typescript-zod',
    name: 'Strict Type-Safety & Boundary Validation Skill',
    description:
      'Mandates end-to-end type inference, Zod schema validation at API/IO boundaries, discriminated unions, and zero `any` casts.',
    icon: '🛡️',
    category: 'architecture',
    instructions:
      'STRICT TYPE-SAFETY SKILL: Validate all external inputs (HTTP bodies, query params, JSON files, env vars) with Zod schemas or explicit type guards at the boundary. Prefer discriminated unions for state machines and never use `any` or `@ts-ignore`.',
    enabled: true,
    builtIn: true,
    personas: ['architect', 'coder', 'dba'],
  },
  {
    id: 'owasp-security-hardening',
    name: 'OWASP & Secret-Zero Security Skill',
    description:
      'Enforces parameterized queries, path-traversal prevention, CSRF/auth checks, and blocks hardcoded credentials.',
    icon: '🔒',
    category: 'security',
    instructions:
      'SECURITY HARDENING SKILL: Never hardcode secrets or tokens. Always normalize and validate file paths against the workspace root to prevent path traversal, use parameterized queries, and sanitize untrusted HTML/Markdown before rendering.',
    enabled: true,
    builtIn: true,
    personas: ['security', 'coder', 'dba'],
  },
  {
    id: 'playwright-visual-qa',
    name: 'Playwright Live Browser Verification Skill',
    description:
      'Guides QA and UI engineers to verify rendered DOM states, console errors, and interactive flows in the live browser.',
    icon: '🧪',
    category: 'qa',
    instructions:
      'LIVE BROWSER QA SKILL: After building the project, verify both unit/integration tests and the rendered UI. Check browser console logs for runtime errors or unhandled promise rejections before marking work complete.',
    enabled: true,
    builtIn: true,
    personas: ['qa', 'ui_ux'],
  },
];

export const FactorySettings = z.object({
  theme: ThemeMode.default('dark'),
  defaultAgent: AgentId.default('claude'),
  enabledProviders: z.array(AgentId).default(['claude']),
  /**
   * The admin accepted that Google does not support Antigravity consumer logins inside third-party
   * tools and may suspend the account. Required to enable Antigravity; installs that already had it
   * enabled keep running without it.
   */
  antigravityTermsAcknowledged: z.boolean().default(false),
  /** @deprecated derived from personaRoutes[p][0] */
  personaAgents: PersonaAgentMap,
  /** @deprecated derived from personaRoutes[p][0] */
  personaModels: PersonaModelMap.default({
    product_owner: 'fable',
    architect: 'fable',
    ui_ux: 'opus',
    coder: 'opus',
    dba: 'opus',
    qa: 'sonnet',
    security: 'opus',
  }),
  /** Per persona: the route to use first and the fallbacks after it. */
  personaRoutes: PersonaRouteMap,
  quotaPolicy: QuotaPolicy.default({ newRuns: 'wait', inFlight: 'wait' }),
  autoPickupReady: z.boolean().default(true),
  autoPickupBacklog: z.boolean().default(false),
  autoSyncToMain: z.boolean().default(true),
  selfHealingBuildGate: z.boolean().default(true),
  antiSlopGate: z.boolean().default(true),
  secretGuardGate: z.boolean().default(true),
  crossProviderCritic: z.boolean().default(false),
  autoMoveToDone: z.boolean().default(true),
  /**
   * Guardrails against runaway factories (S16): how many generations of agent-created tickets
   * may follow a human ticket, and how many runs auto-dispatch may start per project per 24 h
   * (0 = unlimited).
   */
  maxTicketDepth: z.number().int().min(1).max(10).default(3),
  maxAutoRunsPerProjectPerDay: z.number().int().min(0).max(1000).default(40),
  /** Tickets of one project that may run at the same time. */
  maxParallelTicketsPerProject: z.number().int().min(1).max(4).default(2),
  /** Archive quota for run build outputs, per project, in GB. */
  buildOutputsQuotaGb: z.number().min(0.5).max(1000).default(5),
  /** A Claude factory run moves its ticket on only after the agent called `ticket_complete`. */
  requireCompletionSignal: z.boolean().default(true),
  mcpServers: z.array(McpServerEntry).default(DEFAULT_MCP_SERVERS),
  skillPlugins: z.array(SkillPluginEntry).default(DEFAULT_SKILL_PLUGINS),
  anthropicKeyConfigured: z.boolean().default(false),
  openaiKeyConfigured: z.boolean().default(false),
  geminiKeyConfigured: z.boolean().default(false),
  /** Keys saved in Settings (not from the environment): only these make an API-key route usable. */
  anthropicKeyStored: z.boolean().default(false),
  openaiKeyStored: z.boolean().default(false),
  geminiKeyStored: z.boolean().default(false),
  providerAuth: ProviderAuthStatusMap.optional(),
});
export type FactorySettings = z.infer<typeof FactorySettings>;

export const ProviderLoginBody = z.object({
  provider: AgentId,
});
export type ProviderLoginBody = z.input<typeof ProviderLoginBody>;

export const ProviderLoginResponse = z.object({
  provider: AgentId,
  terminal: TerminalInfo,
  command: z.string(),
  instructions: z.string(),
});
export type ProviderLoginResponse = z.infer<typeof ProviderLoginResponse>;

export const UpdateFactorySettingsBody = z
  .object({
    theme: ThemeMode,
    defaultAgent: AgentId,
    enabledProviders: z.array(AgentId).min(1),
    antigravityTermsAcknowledged: z.boolean(),
    personaAgents: PersonaAgentMap.partial(),
    personaModels: PersonaModelMap.partial(),
    personaRoutes: PersonaRouteMap.partial(),
    quotaPolicy: QuotaPolicy.partial(),
    autoPickupReady: z.boolean(),
    autoPickupBacklog: z.boolean(),
    autoSyncToMain: z.boolean(),
    selfHealingBuildGate: z.boolean(),
    antiSlopGate: z.boolean(),
    secretGuardGate: z.boolean(),
    crossProviderCritic: z.boolean(),
    autoMoveToDone: z.boolean(),
    maxTicketDepth: z.number().int().min(1).max(10),
    maxAutoRunsPerProjectPerDay: z.number().int().min(0).max(1000),
    maxParallelTicketsPerProject: z.number().int().min(1).max(4),
    buildOutputsQuotaGb: z.number().min(0.5).max(1000),
    requireCompletionSignal: z.boolean(),
    mcpServers: z.array(McpServerEntry),
    skillPlugins: z.array(SkillPluginEntry),
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

export const UploadWorkspaceFileItem = z.object({
  path: z.string().trim().min(1).max(1024),
  dataBase64: z.string().min(0),
});
export type UploadWorkspaceFileItem = z.infer<typeof UploadWorkspaceFileItem>;

export const UploadWorkspaceFilesBody = z.object({
  targetId: z.string().default('main'),
  files: z.array(UploadWorkspaceFileItem).min(1).max(50),
});
export type UploadWorkspaceFilesBody = z.input<typeof UploadWorkspaceFilesBody>;

export const UploadWorkspaceFilesResponse = z.object({
  targetId: z.string(),
  uploadedPaths: z.array(z.string()),
});
export type UploadWorkspaceFilesResponse = z.infer<typeof UploadWorkspaceFilesResponse>;

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
  /** Auto-Interact runs for another project; this one cannot start it now. */
  playtestElsewhere: z.boolean().optional(),
  /**
   * The view shows an agent's browser tab (its own Playwright Chromium or the tab it drives), not the
   * project's tab.
   */
  following: z.boolean().optional(),
  /**
   * The project's agent is using a browser, but the view stays on the project's tab because the
   * person chose it; the `follow_agent` action shows the agent's tab again.
   */
  canFollow: z.boolean().optional(),
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
    'follow_agent',
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

export const ProjectUsageDay = z.object({
  /** Local date (core's time zone), YYYY-MM-DD. */
  date: z.string(),
  runs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedTokens: z.number().int(),
  toolCalls: z.number().int(),
  durationSec: z.number().int(),
  /** Runs whose token counts are estimated because no transcript usage was available. */
  estimatedRuns: z.number().int(),
});
export type ProjectUsageDay = z.infer<typeof ProjectUsageDay>;

export const ProjectUsageResponse = z.object({
  projectId: z.string(),
  days: z.array(ProjectUsageDay),
  /** Runs created in the last 24 h, against `maxAutoRunsPerProjectPerDay`. */
  runsLast24h: z.number().int(),
  maxAutoRunsPerProjectPerDay: z.number().int(),
  maxTicketDepth: z.number().int(),
  /** Auto-dispatch is paused for this project because the daily run budget is used up. */
  budgetExhausted: z.boolean(),
});
export type ProjectUsageResponse = z.infer<typeof ProjectUsageResponse>;
