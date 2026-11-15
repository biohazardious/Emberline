/** Static provider registry: labels, terms and the models Emberline ships knowing about. */
import type { AgentPersona } from './projects.js';
import type { AgentId, ModelCapabilityTier } from './runs.js';

/** 1-5 star rank for the multi-provider model matrix. */
export type ModelRank = 1 | 2 | 3 | 4 | 5;
export type ModelCapabilityTag = 'reasoning' | 'code' | 'ui_ux' | 'fast';

export interface ProviderModelInfo {
  /** What Emberline stores and compares; the CLI may be handed `cliId` instead. */
  id: string;
  /** The id the CLI is started with, when it differs from `id` (a built-in family alias). */
  cliId?: string;
  label: string;
  shortLabel: string;
  rank: ModelRank;
  tier: ModelCapabilityTier;
  badge: string;
  capabilities: ModelCapabilityTag[];
  description: string;
  /** Where the entry came from: shipped with Emberline, read from the CLI, a picker, or typed in. */
  source: 'builtin' | 'cli' | 'picker' | 'manual';
  /** ISO time the entry was last absent from a discovery; null or unset while it is present. */
  missingSince?: string | null;
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

type ModelDef = Omit<ProviderModelInfo, 'source'>;

const REGISTRY_DEFS: Record<AgentId, Omit<ProviderRegistryEntry, 'models'> & { models: ModelDef[] }> = {
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

/** The registry with every shipped model marked as built in. */
export const PROVIDER_REGISTRY = Object.fromEntries(
  Object.entries(REGISTRY_DEFS).map(([id, def]) => [
    id,
    { ...def, models: def.models.map((m): ProviderModelInfo => ({ ...m, source: 'builtin' })) },
  ]),
) as Record<AgentId, ProviderRegistryEntry>;

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
