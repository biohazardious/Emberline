/** API contracts: runs. */
import { z } from 'zod';
import { AgentPersona, PermissionMode } from './projects.js';

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
export const AgentId = z.enum(['claude', 'antigravity', 'copilot', 'gemini', 'codex', 'aider']);
export type AgentId = z.infer<typeof AgentId>;

/** Model IDs across all supported CLI providers. */
export const AgentModelId = z.enum([
  'auto',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'argon',
  'gemini-pro',
  'gemini-flash',
  'gemini-flash-lite',
  'o3',
  'gpt-4o',
  'o4-mini',
  'gpt-4o-mini',
]);
export type AgentModelId = z.infer<typeof AgentModelId>;

/** Capability tier and 1-5 star rank for the multi-provider model matrix. */
export const ModelCapabilityTier = z.enum(['high', 'medium', 'low']);
export type ModelCapabilityTier = z.infer<typeof ModelCapabilityTier>;
export type ModelRank = 1 | 2 | 3 | 4 | 5;
export type ModelCapabilityTag = 'reasoning' | 'code' | 'ui_ux' | 'fast';

export interface ProviderModelInfo {
  id: Exclude<AgentModelId, 'auto'>;
  label: string;
  shortLabel: string;
  rank: ModelRank;
  tier: ModelCapabilityTier;
  badge: string;
  capabilities: ModelCapabilityTag[];
  description: string;
}

export type ProviderTermsRisk = 'low' | 'medium' | 'high';

/** What the vendor's terms say about running its CLI inside a platform like Emberline. */
export interface ProviderTerms {
  url: string;
  /** YYYY-MM-DD the note was last checked against the vendor's page. */
  checked: string;
  risk: ProviderTermsRisk;
  summary: string;
}

export interface ProviderRegistryEntry {
  id: AgentId;
  label: string;
  shortLabel: string;
  badge: string;
  authKind: 'host_or_key' | 'api_key' | 'cli_auth';
  keyConfigField?: 'anthropicKeyConfigured' | 'openaiKeyConfigured' | 'geminiKeyConfigured';
  description: string;
  terms: ProviderTerms;
  models: ProviderModelInfo[];
}

export const PROVIDER_REGISTRY: Record<AgentId, ProviderRegistryEntry> = {
  claude: {
    id: 'claude',
    label: 'Claude Code (Anthropic)',
    shortLabel: 'Claude',
    badge: 'Primary Host CLI / API',
    authKind: 'host_or_key',
    keyConfigField: 'anthropicKeyConfigured',
    description:
      'Official Anthropic Claude Code CLI with deep worktree tool execution and host OAuth / API key support.',
    terms: {
      url: 'https://code.claude.com/docs/en/legal-and-compliance',
      checked: '2026-10-16',
      risk: 'low',
      summary: 'Unmodified Claude Code with your own subscription is allowed, also when a platform hosts it.',
    },
    models: [
      {
        id: 'fable',
        label: 'Claude Fable',
        shortLabel: 'fable',
        rank: 5,
        tier: 'high',
        badge: '★5 · HIGH · FRONTIER',
        capabilities: ['reasoning', 'code'],
        description: 'Frontier architectural synthesis, multi-step system planning & deep reasoning.',
      },
      {
        id: 'opus',
        label: 'Claude Opus',
        shortLabel: 'opus',
        rank: 4,
        tier: 'high',
        badge: '★4 · HIGH · FLAGSHIP',
        capabilities: ['reasoning', 'code', 'ui_ux'],
        description: 'Flagship full-stack engineering, complex backend logic, security & DB design.',
      },
      {
        id: 'sonnet',
        label: 'Claude Sonnet',
        shortLabel: 'sonnet',
        rank: 3,
        tier: 'medium',
        badge: '★3 · MEDIUM · BALANCED',
        capabilities: ['code', 'ui_ux', 'fast'],
        description: 'Balanced high-speed coding, test automation, UI components & daily feature work.',
      },
      {
        id: 'haiku',
        label: 'Claude Haiku',
        shortLabel: 'haiku',
        rank: 2,
        tier: 'low',
        badge: '★2 · LOW · FAST',
        capabilities: ['fast', 'code'],
        description: 'Ultra-fast, token-efficient model for quick fixes, linting & lightweight tasks.',
      },
    ],
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity (AGY CLI)',
    shortLabel: 'AGY',
    badge: 'Agentic UI/UX & Full-Stack',
    authKind: 'cli_auth',
    description:
      'Google DeepMind Antigravity CLI specialized in visual UI/UX craftsmanship and full-stack flows.',
    terms: {
      url: 'https://antigravity.google/docs/faq/',
      checked: '2026-10-16',
      risk: 'high',
      summary: 'Consumer logins inside third-party tools are not supported; Google has suspended accounts.',
    },
    models: [
      {
        id: 'argon',
        label: 'Antigravity Argon Pro',
        shortLabel: 'argon',
        rank: 5,
        tier: 'high',
        badge: '★5 · HIGH · FRONTIER',
        capabilities: ['ui_ux', 'reasoning', 'code'],
        description: 'Frontier creative UI/UX design systems, interactive layouts & full-stack architecture.',
      },
      {
        id: 'gemini-pro',
        label: 'Antigravity Gemini Pro',
        shortLabel: 'gemini-pro',
        rank: 4,
        tier: 'high',
        badge: '★4 · HIGH · DEEP CONTEXT',
        capabilities: ['reasoning', 'code', 'ui_ux'],
        description: 'Large-context multi-file reasoning and complex web/mobile engineering.',
      },
      {
        id: 'gemini-flash',
        label: 'Antigravity Flash',
        shortLabel: 'gemini-flash',
        rank: 3,
        tier: 'medium',
        badge: '★3 · MEDIUM · BALANCED',
        capabilities: ['fast', 'ui_ux', 'code'],
        description: 'High-speed UI iteration, styling polish & component verification.',
      },
      {
        id: 'gemini-flash-lite',
        label: 'Antigravity Flash-Lite',
        shortLabel: 'flash-lite',
        rank: 1,
        tier: 'low',
        badge: '★1 · LOW · LIGHT',
        capabilities: ['fast'],
        description: 'Lightweight rapid tasks and quick syntax checks.',
      },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini CLI',
    shortLabel: 'Gemini',
    badge: 'Google Gemini API / CLI',
    authKind: 'api_key',
    keyConfigField: 'geminiKeyConfigured',
    description:
      'Google Gemini CLI with 1M+ token context window for massive repository analysis and coding.',
    terms: {
      url: 'https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals',
      checked: '2026-10-16',
      risk: 'medium',
      summary:
        'Consumer Google login ended on 2026-06-18; use an API key or Code Assist Standard/Enterprise.',
    },
    models: [
      {
        id: 'gemini-pro',
        label: 'Gemini Pro',
        shortLabel: 'gemini-pro',
        rank: 5,
        tier: 'high',
        badge: '★5 · HIGH · FRONTIER',
        capabilities: ['reasoning', 'code', 'ui_ux'],
        description: 'Maximum reasoning depth and massive codebase context comprehension.',
      },
      {
        id: 'gemini-flash',
        label: 'Gemini Flash',
        shortLabel: 'gemini-flash',
        rank: 3,
        tier: 'medium',
        badge: '★3 · MEDIUM · BALANCED',
        capabilities: ['code', 'fast', 'ui_ux'],
        description: 'Fast agentic coding, tool execution & test verification.',
      },
      {
        id: 'gemini-flash-lite',
        label: 'Gemini Flash-Lite',
        shortLabel: 'flash-lite',
        rank: 1,
        tier: 'low',
        badge: '★1 · LOW · FAST',
        capabilities: ['fast'],
        description: 'Ultra-low latency and high-efficiency execution for simple tasks.',
      },
    ],
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    shortLabel: 'Codex',
    badge: 'OpenAI API / CLI',
    authKind: 'api_key',
    keyConfigField: 'openaiKeyConfigured',
    description: 'OpenAI Codex terminal agent powered by o-series reasoning and GPT-4.1/4o models.',
    terms: {
      url: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
      checked: '2026-10-16',
      risk: 'low',
      summary: 'Codex CLI is included in ChatGPT plans.',
    },
    models: [
      {
        id: 'o3',
        label: 'OpenAI o3',
        shortLabel: 'o3',
        rank: 5,
        tier: 'high',
        badge: '★5 · HIGH · FRONTIER',
        capabilities: ['reasoning', 'code'],
        description: 'Frontier analytical reasoning, complex algorithms & system architecture.',
      },
      {
        id: 'gpt-4o',
        label: 'GPT-4o / GPT-4.1',
        shortLabel: 'gpt-4o',
        rank: 4,
        tier: 'high',
        badge: '★4 · HIGH · FLAGSHIP',
        capabilities: ['code', 'ui_ux', 'reasoning'],
        description: 'Flagship general-purpose full-stack engineering and API design.',
      },
      {
        id: 'o4-mini',
        label: 'OpenAI o4-mini',
        shortLabel: 'o4-mini',
        rank: 3,
        tier: 'medium',
        badge: '★3 · MEDIUM · BALANCED',
        capabilities: ['code', 'fast', 'reasoning'],
        description: 'Fast reasoning model optimized for code generation and automated testing.',
      },
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o Mini',
        shortLabel: '4o-mini',
        rank: 2,
        tier: 'low',
        badge: '★2 · LOW · FAST',
        capabilities: ['fast', 'code'],
        description: 'Compact, low-cost model for quick edits and boilerplate tasks.',
      },
    ],
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    shortLabel: 'Copilot',
    badge: 'GitHub CLI Auth',
    authKind: 'cli_auth',
    description: 'GitHub Copilot agentic CLI using your GitHub subscription models.',
    terms: {
      url: 'https://docs.github.com/en/copilot',
      checked: '2026-10-16',
      risk: 'medium',
      summary: 'No explicit policy for hosted use found; check your plan.',
    },
    models: [
      {
        id: 'opus',
        label: 'Copilot · Claude Opus',
        shortLabel: 'opus',
        rank: 4,
        tier: 'high',
        badge: '★4 · HIGH · FLAGSHIP',
        capabilities: ['reasoning', 'code'],
        description: 'High-capability architectural and backend engineering via Copilot.',
      },
      {
        id: 'gpt-4o',
        label: 'Copilot · GPT-4o',
        shortLabel: 'gpt-4o',
        rank: 4,
        tier: 'high',
        badge: '★4 · HIGH · FLAGSHIP',
        capabilities: ['code', 'ui_ux'],
        description: 'Full-stack implementation and UI workflows via Copilot.',
      },
      {
        id: 'sonnet',
        label: 'Copilot · Claude Sonnet',
        shortLabel: 'sonnet',
        rank: 3,
        tier: 'medium',
        badge: '★3 · MEDIUM · BALANCED',
        capabilities: ['code', 'fast'],
        description: 'Balanced speed and accuracy for daily coding & QA.',
      },
      {
        id: 'gpt-4o-mini',
        label: 'Copilot · GPT-4o Mini',
        shortLabel: '4o-mini',
        rank: 2,
        tier: 'low',
        badge: '★2 · LOW · FAST',
        capabilities: ['fast'],
        description: 'Fast lightweight completions and shell assistance.',
      },
    ],
  },
  aider: {
    id: 'aider',
    label: 'Aider Polyglot CLI',
    shortLabel: 'Aider',
    badge: 'Git-Aware Diff Agent',
    authKind: 'host_or_key',
    description: 'Aider AI pair-programming CLI with repository map and automatic git commits.',
    terms: {
      url: 'https://aider.chat/docs/',
      checked: '2026-10-16',
      risk: 'low',
      summary: 'Uses your own API keys.',
    },
    models: [
      {
        id: 'opus',
        label: 'Aider · Claude Opus',
        shortLabel: 'opus',
        rank: 5,
        tier: 'high',
        badge: '★5 · HIGH · ARCHITECT',
        capabilities: ['reasoning', 'code'],
        description: 'Deep multi-file refactoring with Architect + Editor mode.',
      },
      {
        id: 'o3',
        label: 'Aider · OpenAI o3',
        shortLabel: 'o3',
        rank: 5,
        tier: 'high',
        badge: '★5 · HIGH · REASONING',
        capabilities: ['reasoning', 'code'],
        description: 'Analytical multi-file code synthesis with o3 reasoning.',
      },
      {
        id: 'sonnet',
        label: 'Aider · Claude Sonnet',
        shortLabel: 'sonnet',
        rank: 3,
        tier: 'medium',
        badge: '★3 · MEDIUM · BALANCED',
        capabilities: ['code', 'fast'],
        description: 'Fast diff-based editing and test fixing.',
      },
      {
        id: 'haiku',
        label: 'Aider · Claude Haiku',
        shortLabel: 'haiku',
        rank: 2,
        tier: 'low',
        badge: '★2 · LOW · FAST',
        capabilities: ['fast'],
        description: 'Lightweight patches and quick edits.',
      },
    ],
  },
};

export const PERSONA_CAPABILITY_TARGETS: Record<
  AgentPersona,
  { recommendedRank: ModelRank; recommendedTier: ModelCapabilityTier; summary: string }
> = {
  product_owner: {
    recommendedRank: 5,
    recommendedTier: 'high',
    summary: 'Rank 5 (High) · Product strategy, requirement decomposition & backlog orchestration',
  },
  architect: {
    recommendedRank: 5,
    recommendedTier: 'high',
    summary: 'Rank 5 (High) · System blueprint, module boundaries & technical trade-offs',
  },
  coder: {
    recommendedRank: 4,
    recommendedTier: 'high',
    summary: 'Rank 4 (High) · Full-stack implementation, complex logic & self-healing builds',
  },
  dba: {
    recommendedRank: 4,
    recommendedTier: 'high',
    summary: 'Rank 4 (High) · Data modeling, migrations, indexing & query optimization',
  },
  security: {
    recommendedRank: 4,
    recommendedTier: 'high',
    summary: 'Rank 4 (High) · Threat modeling, auth hardening & vulnerability auditing',
  },
  ui_ux: {
    recommendedRank: 4,
    recommendedTier: 'high',
    summary: 'Rank 4 (High) · Design systems, responsive layouts, accessibility & visual polish',
  },
  qa: {
    recommendedRank: 3,
    recommendedTier: 'medium',
    summary: 'Rank 3 (Medium) · Fast unit/integration/E2E testing & regression verification',
  },
};

/** Returns strictly the models supported by the given CLI provider. */
export function getModelsForProvider(agent: AgentId): ProviderModelInfo[] {
  return PROVIDER_REGISTRY[agent]?.models ?? PROVIDER_REGISTRY.claude.models;
}

/** Checks whether a model ID is valid for the given CLI provider (`auto` is valid for all). */
export function isModelValidForProvider(agent: AgentId, model: AgentModelId): boolean {
  if (model === 'auto') return true;
  return getModelsForProvider(agent).some((m) => m.id === model);
}

/** Looks up metadata for a model across a specific provider (or globally as fallback). */
export function getModelInfoForProvider(agent: AgentId, model: AgentModelId): ProviderModelInfo | null {
  if (model === 'auto') return null;
  const direct = getModelsForProvider(agent).find((m) => m.id === model);
  if (direct) return direct;
  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    const found = entry.models.find((m) => m.id === model);
    if (found) return found;
  }
  return null;
}

/** Selects the best model from `agent` whose rank is closest to `targetRank` (1..5). */
export function selectProviderModelByRank(agent: AgentId, targetRank: number): Exclude<AgentModelId, 'auto'> {
  const models = getModelsForProvider(agent);
  const clamped = Math.max(1, Math.min(5, Math.round(targetRank)));
  let best = models[0]!;
  let bestDiff = Math.abs(best.rank - clamped);
  for (const candidate of models) {
    const diff = Math.abs(candidate.rank - clamped);
    if (diff < bestDiff || (diff === bestDiff && candidate.rank > best.rank)) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best.id;
}

/** Selects the best model from `agent` matching a capability tier ('high' | 'medium' | 'low') and optional persona. */
export function selectProviderModelByTier(
  agent: AgentId,
  tier: ModelCapabilityTier,
  persona?: AgentPersona,
): Exclude<AgentModelId, 'auto'> {
  const models = getModelsForProvider(agent);
  const tierMatches = models.filter((m) => m.tier === tier);
  if (tierMatches.length > 0) {
    if (tier === 'high' && persona) {
      const targetRank = PERSONA_CAPABILITY_TARGETS[persona]?.recommendedRank ?? 4;
      const exact = tierMatches.find((m) => m.rank === targetRank);
      if (exact) return exact.id;
    }
    return tierMatches[0]!.id;
  }
  const fallbackRank =
    tier === 'high'
      ? persona
        ? PERSONA_CAPABILITY_TARGETS[persona].recommendedRank
        : 4
      : tier === 'medium'
        ? 3
        : 2;
  return selectProviderModelByRank(agent, fallbackRank);
}

/**
 * Ensures `currentModel` is valid for `agent`. If `currentModel` belongs to another provider,
 * automatically maps it to the equivalent rank/tier model on `agent`!
 */
export function coerceModelForProvider(
  agent: AgentId,
  currentModel: AgentModelId,
  persona?: AgentPersona,
): AgentModelId {
  if (currentModel === 'auto') return 'auto';
  if (isModelValidForProvider(agent, currentModel)) return currentModel;
  // Find the rank of currentModel in whichever provider it came from, or use the persona's recommended rank
  const priorInfo = getModelInfoForProvider(agent, currentModel);
  const targetRank = priorInfo?.rank ?? (persona ? PERSONA_CAPABILITY_TARGETS[persona].recommendedRank : 4);
  return selectProviderModelByRank(agent, targetRank);
}

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
