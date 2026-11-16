import {
  type AgentId,
  type CliToolStatus,
  type FactorySettings,
  type ModelCapabilityTier,
  PERSONA_CAPABILITY_TARGETS,
  type PersonaRouteMap,
  PROVIDER_RUNTIME,
  type ProviderAuthStatus,
  type QuotaPolicy,
  type Route,
  selectProviderModelByRank,
  selectProviderModelByTier,
  type ThemeMode,
} from '@emberline/protocol';
import type { CSSProperties, FormEvent } from 'react';
import { PERSONA_BY_ID, PERSONA_LIST } from '../PersonaBadge';

export const ALL_PROVIDER_IDS: AgentId[] = ['claude', 'antigravity', 'codex', 'copilot', 'aider'];
export const OAUTH_LOGIN_PROVIDERS: AgentId[] = ['claude', 'antigravity', 'codex', 'copilot'];

export const PROVIDER_VIEWS = ['agents', 'routing', 'sdks'] as const;
export type ProviderView = (typeof PROVIDER_VIEWS)[number];

export type ProviderStatusKind = 'installing' | 'error' | 'off' | 'not_installed' | 'not_signed_in' | 'ready';

export interface ProviderStatusResult {
  kind: ProviderStatusKind;
  state: ProviderStatusKind;
  label: string;
}

export interface ProviderStatusInput {
  enabled: boolean;
  installing?: boolean;
  toolStatus?: Pick<CliToolStatus, 'installed' | 'installing' | 'lastError'> | null;
  authStatus?: Partial<Pick<ProviderAuthStatus, 'authenticated' | 'label' | 'cliInstalled'>> | null;
  keyConfigured?: boolean;
  installed?: boolean;
  signedIn?: boolean;
  lastError?: string | null;
  authLabel?: string | null;
}

/**
 * Composite status for a provider row in Settings → Providers → Agents.
 * Precedence: installing → error → off → not_installed → not_signed_in → ready.
 */
export function providerStatus(input: ProviderStatusInput): ProviderStatusResult {
  const isInstalling = Boolean(input.installing || input.toolStatus?.installing);
  if (isInstalling) {
    return { kind: 'installing', state: 'installing', label: 'Installing…' };
  }

  const lastError = input.lastError !== undefined ? input.lastError : input.toolStatus?.lastError;
  if (lastError && lastError.trim().length > 0) {
    return { kind: 'error', state: 'error', label: 'Install failed' };
  }

  if (!input.enabled) {
    return { kind: 'off', state: 'off', label: 'Off' };
  }

  const isInstalled =
    input.installed ?? input.toolStatus?.installed ?? input.authStatus?.cliInstalled ?? false;
  if (!isInstalled) {
    return { kind: 'not_installed', state: 'not_installed', label: 'CLI not installed' };
  }

  const isSignedIn =
    input.signedIn ?? (Boolean(input.authStatus?.authenticated) || Boolean(input.keyConfigured));
  if (!isSignedIn) {
    return { kind: 'not_signed_in', state: 'not_signed_in', label: 'Not signed in' };
  }

  const customLabel =
    input.authLabel ?? (input.authStatus?.authenticated !== false ? input.authStatus?.label : undefined);
  const label = customLabel?.trim() || 'Ready';
  return { kind: 'ready', state: 'ready', label };
}

export const ST_PANEL_PAD: CSSProperties = { padding: '20px' };
export const ST_PANEL_FORM: CSSProperties = {
  padding: '20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '22px',
};
export const ST_HR: CSSProperties = { border: 'none', borderTop: '1px solid var(--border)', margin: 0 };
export const ST_SAVE_ROW: CSSProperties = { display: 'flex', justifyContent: 'flex-end' };
export const ST_HEAD_SPLIT: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
};
export const ST_ROW_BETWEEN: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
};
export const ST_ROW_WRAP6: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
};
export const ST_COL_14: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '14px' };
export const ST_COL_6: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px' };
export const ST_CUSTOM_BOX: CSSProperties = {
  padding: '14px',
  borderRadius: '8px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};
export const ST_CARD_GRID_310: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(310px, 100%), 1fr))',
  gap: '10px',
};
export const ST_FIELD_4: CSSProperties = { gap: 4 };
export const ST_LABEL_68: CSSProperties = { fontSize: '0.8rem' };
export const ST_BADGE_64: CSSProperties = { fontSize: '0.8rem' };
export const ST_DESC_73: CSSProperties = { fontSize: '0.8rem', lineHeight: 1.35 };

export const TIER_COLORS: Record<
  ModelCapabilityTier,
  { bg: string; border: string; text: string; label: string }
> = {
  high: {
    bg: 'color-mix(in srgb, var(--violet) 14%, transparent)',
    border: 'color-mix(in srgb, var(--violet) 45%, transparent)',
    text: 'var(--violet)',
    label: 'HIGH (★4–5)',
  },
  medium: {
    bg: 'color-mix(in srgb, var(--info) 14%, transparent)',
    border: 'color-mix(in srgb, var(--info) 45%, transparent)',
    text: 'var(--info)',
    label: 'MEDIUM (★3)',
  },
  low: {
    bg: 'color-mix(in srgb, var(--ok) 14%, transparent)',
    border: 'color-mix(in srgb, var(--ok) 45%, transparent)',
    text: 'var(--ok)',
    label: 'LOW (★1–2)',
  },
};

export interface AutopilotDraft {
  themePref: ThemeMode;
  autoPickupReady: boolean;
  autoPickupBacklog: boolean;
  autoSyncToMain: boolean;
  autoResolveAdditiveConflicts: boolean;
  serializeOverlappingTickets: boolean;
  selfHealingBuildGate: boolean;
  antiSlopGate: boolean;
  secretGuardGate: boolean;
  requireCompletionSignal: boolean;
  crossProviderCritic: boolean;
  autoMoveToDone: boolean;
  maxTicketDepth: number;
  maxParallelTickets: string;
  buildOutputsQuotaGb: string;
  maxAutoRunsPerDay: number;
  /** Who Emberline's and the agents' commits are made as. */
  commitName: string;
  commitEmail: string;
}

export interface ApiKeyDraft {
  anthropic: string;
  openai: string;
  gemini: string;
}

export interface ProviderSectionForm {
  settings: FactorySettings | undefined;
  setSettings: (next: FactorySettings) => void;
  defaultAgent: AgentId;
  setDefaultAgent: (next: AgentId) => void;
  enabledProviders: AgentId[];
  setEnabledProviders: (updater: AgentId[] | ((prev: AgentId[]) => AgentId[])) => void;
  antigravityAck: boolean;
  setAntigravityAck: (next: boolean) => void;
  personaRoutes: PersonaRouteMap | null;
  setPersonaRoutes: (
    updater: PersonaRouteMap | ((prev: PersonaRouteMap | null) => PersonaRouteMap | null),
  ) => void;
  quotaPolicy: QuotaPolicy;
  setQuotaPolicy: (next: QuotaPolicy) => void;
  apiKeys: ApiKeyDraft;
  patchApiKeys: (patch: Partial<ApiKeyDraft>) => void;
  dirty: boolean;
  onDiscard: () => void;
  saving: boolean;
  onSave: (e: FormEvent) => void;
  setNotice: (next: string | null) => void;
  setError: (next: string | null) => void;
}

/** The parallel-tickets field as a whole number between 1 and 4 (anything unreadable counts as 1). */
export function clampParallel(value: string): number {
  return Math.max(1, Math.min(4, Math.trunc(Number(value)) || 1));
}

/** A single route; keeps `prior` (the credential the user had on the first route) when the provider still supports it. */
export function defaultRoute(agent: AgentId, model: Route['model'], prior?: Route['credential']): Route {
  const allowed = PROVIDER_RUNTIME[agent].credentials;
  return { agent, model, credential: prior && allowed.includes(prior) ? prior : allowed[0]! };
}

export type CapabilityPreset = 'auto-rank' | 'all-high' | 'all-medium' | 'all-low' | 'multi-provider';

export function buildPresetRoutes(
  preset: CapabilityPreset,
  personaRoutes: PersonaRouteMap,
  enabledProviders: AgentId[],
  defaultAgent: AgentId,
  antigravityAcknowledged = false,
): { routes: PersonaRouteMap; notice: string } {
  if (preset === 'multi-provider') {
    const core: AgentId = enabledProviders.includes('claude') ? 'claude' : (enabledProviders[0] ?? 'claude');
    // The UI/UX and QA specialist is Antigravity, but only once it is enabled and its terms are
    // acknowledged; until then UI/UX keeps its route, and QA goes to Codex when it can.
    const specialist = enabledProviders.includes('antigravity') && antigravityAcknowledged;
    const pick = (agent: AgentId, rank: number, chain: Route[]): Route[] => [
      defaultRoute(agent, selectProviderModelByRank(agent, rank), chain[0]?.credential),
    ];
    const ui = specialist ? pick('antigravity', 5, personaRoutes.ui_ux) : personaRoutes.ui_ux;
    const qa = specialist
      ? pick('antigravity', 3, personaRoutes.qa)
      : enabledProviders.includes('codex')
        ? pick('codex', 3, personaRoutes.qa)
        : personaRoutes.qa;
    // Personas left on their own route keep their fallbacks too; the notice must not say otherwise.
    const kept = (['ui_ux', 'qa'] as const)
      .filter((p) => (p === 'ui_ux' ? ui : qa) === personaRoutes[p])
      .map((p) => PERSONA_BY_ID[p].label);
    const fallbacks =
      kept.length === 0
        ? 'Fallbacks were reset.'
        : `Fallbacks were reset, except ${kept.join(' and ')}, which kept ${kept.length === 1 ? 'its route' : 'their routes'}: Antigravity is not enabled with its terms acknowledged.`;
    return {
      routes: {
        product_owner: [
          defaultRoute(core, selectProviderModelByRank(core, 5), personaRoutes.product_owner[0]?.credential),
        ],
        architect: [
          defaultRoute(core, selectProviderModelByRank(core, 5), personaRoutes.architect[0]?.credential),
        ],
        ui_ux: ui,
        coder: [defaultRoute(core, selectProviderModelByRank(core, 4), personaRoutes.coder[0]?.credential)],
        dba: [defaultRoute(core, selectProviderModelByRank(core, 4), personaRoutes.dba[0]?.credential)],
        qa,
        security: [
          defaultRoute(core, selectProviderModelByRank(core, 4), personaRoutes.security[0]?.credential),
        ],
      },
      notice: `Multi-provider split applied. ${fallbacks} Click Save to persist.`,
    };
  }

  const next: PersonaRouteMap = { ...personaRoutes };
  for (const meta of PERSONA_LIST) {
    const p = meta.id;
    const agent = personaRoutes[p][0]?.agent ?? defaultAgent ?? 'claude';
    const model =
      preset === 'auto-rank'
        ? selectProviderModelByRank(agent, PERSONA_CAPABILITY_TARGETS[p].recommendedRank)
        : selectProviderModelByTier(
            agent,
            preset === 'all-high' ? 'high' : preset === 'all-medium' ? 'medium' : 'low',
            p,
          );
    next[p] = [defaultRoute(agent, model, personaRoutes[p][0]?.credential)];
  }
  const labelMap = {
    'auto-rank': 'Auto-match by rank',
    'all-high': 'All high (★4–5)',
    'all-medium': 'All medium (★3)',
    'all-low': 'All low (★1–2)',
  };
  return {
    routes: next,
    notice: `${labelMap[preset]} applied. Fallbacks were reset. Click Save to persist.`,
  };
}
