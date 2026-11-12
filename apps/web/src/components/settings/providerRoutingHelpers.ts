import {
  type AgentId,
  type AgentPersona,
  coerceModelForProvider,
  type ModelCapabilityTag,
  type ModelCapabilityTier,
  PERSONA_CAPABILITY_TARGETS,
  type PersonaRouteMap,
  PROVIDER_RUNTIME,
  type Route,
  selectProviderModelByRank,
  selectProviderModelByTier,
} from '@emberline/protocol';
import { Brain, Laptop, type LucideIcon, Palette, Zap } from 'lucide-react';
import { PERSONA_LIST } from '../PersonaBadge';

export const ALL_PROVIDER_IDS: AgentId[] = ['claude', 'antigravity', 'gemini', 'codex', 'copilot', 'aider'];
export const OAUTH_LOGIN_PROVIDERS: AgentId[] = ['claude', 'antigravity', 'gemini', 'codex', 'copilot'];

export const CAPABILITY_TAG_META: Record<ModelCapabilityTag, { label: string; icon: LucideIcon }> = {
  reasoning: { label: 'Reasoning', icon: Brain },
  code: { label: 'Code', icon: Laptop },
  ui_ux: { label: 'UI/UX', icon: Palette },
  fast: { label: 'Fast', icon: Zap },
};

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

export type CapabilityPreset = 'auto-rank' | 'all-high' | 'all-medium' | 'all-low' | 'multi-provider';

/** The parallel-tickets field as a whole number between 1 and 4 (anything unreadable counts as 1). */
export function clampParallel(value: string): number {
  return Math.max(1, Math.min(4, Math.trunc(Number(value)) || 1));
}

/** A single route; keeps `prior` (the credential the user had on the first route) when the provider still supports it. */
export function defaultRoute(agent: AgentId, model: Route['model'], prior?: Route['credential']): Route {
  const allowed = PROVIDER_RUNTIME[agent].credentials;
  return { agent, model, credential: prior && allowed.includes(prior) ? prior : allowed[0]! };
}

/** Drops `removedProvider` from every persona chain; any chain left empty falls back to `fallbackAgent`. */
export function removeProviderFromRoutes(
  routes: PersonaRouteMap,
  removedProvider: AgentId,
  fallbackAgent: AgentId,
): PersonaRouteMap {
  const updated = { ...routes };
  for (const p of PERSONA_LIST) {
    const kept = routes[p.id].filter((r) => r.agent !== removedProvider);
    updated[p.id] = kept.length
      ? kept
      : [
          defaultRoute(
            fallbackAgent,
            coerceModelForProvider(fallbackAgent, routes[p.id][0]?.model ?? 'opus', p.id),
          ),
        ];
  }
  return updated;
}

export function selectQuickTierRoutes(
  routes: PersonaRouteMap,
  personaKey: AgentPersona,
  tier: ModelCapabilityTier,
): PersonaRouteMap {
  const [first, ...rest] = routes[personaKey];
  if (!first) return routes;
  return {
    ...routes,
    [personaKey]: [{ ...first, model: selectProviderModelByTier(first.agent, tier, personaKey) }, ...rest],
  };
}

export function computeCapabilityPresetRoutes({
  preset,
  personaRoutes,
  enabledProviders,
  defaultAgent,
}: {
  preset: CapabilityPreset;
  personaRoutes: PersonaRouteMap;
  enabledProviders: AgentId[];
  defaultAgent: AgentId;
}): { routes: PersonaRouteMap; notice: string } {
  if (preset === 'multi-provider') {
    const coreProvider: AgentId = enabledProviders.includes('claude')
      ? 'claude'
      : (enabledProviders[0] ?? 'claude');
    // Antigravity is never picked by a preset: the user adds it to a chain knowingly.
    const uiProvider: AgentId = enabledProviders.includes('gemini') ? 'gemini' : coreProvider;
    const qaProvider: AgentId = enabledProviders.includes('gemini')
      ? 'gemini'
      : enabledProviders.includes('codex')
        ? 'codex'
        : (enabledProviders[0] ?? 'claude');

    return {
      routes: {
        product_owner: [
          defaultRoute(
            coreProvider,
            selectProviderModelByRank(coreProvider, 5),
            personaRoutes.product_owner[0]?.credential,
          ),
        ],
        architect: [
          defaultRoute(
            coreProvider,
            selectProviderModelByRank(coreProvider, 5),
            personaRoutes.architect[0]?.credential,
          ),
        ],
        ui_ux: [
          defaultRoute(
            uiProvider,
            selectProviderModelByRank(uiProvider, 5),
            personaRoutes.ui_ux[0]?.credential,
          ),
        ],
        coder: [
          defaultRoute(
            coreProvider,
            selectProviderModelByRank(coreProvider, 4),
            personaRoutes.coder[0]?.credential,
          ),
        ],
        dba: [
          defaultRoute(
            coreProvider,
            selectProviderModelByRank(coreProvider, 4),
            personaRoutes.dba[0]?.credential,
          ),
        ],
        qa: [
          defaultRoute(qaProvider, selectProviderModelByRank(qaProvider, 3), personaRoutes.qa[0]?.credential),
        ],
        security: [
          defaultRoute(
            coreProvider,
            selectProviderModelByRank(coreProvider, 4),
            personaRoutes.security[0]?.credential,
          ),
        ],
      },
      notice:
        'Applied "Multi-Provider Specialist Split" across your active providers with automatic capability rank matching. Fallbacks were reset. Click Save to persist.',
    };
  }

  const next: PersonaRouteMap = { ...personaRoutes };
  for (const meta of PERSONA_LIST) {
    const p = meta.id;
    const agent = personaRoutes[p][0]?.agent ?? defaultAgent ?? 'claude';
    let model: Route['model'];
    if (preset === 'auto-rank') {
      model = selectProviderModelByRank(agent, PERSONA_CAPABILITY_TARGETS[p].recommendedRank);
    } else if (preset === 'all-high') {
      model = selectProviderModelByTier(agent, 'high', p);
    } else if (preset === 'all-medium') {
      model = selectProviderModelByTier(agent, 'medium', p);
    } else {
      model = selectProviderModelByTier(agent, 'low', p);
    }
    next[p] = [defaultRoute(agent, model, personaRoutes[p][0]?.credential)];
  }
  const labelMap = {
    'auto-rank': 'Recommended Persona Capability Ranks (★5 PO/Arch, ★4 Core/UI/Sec, ★3 QA)',
    'all-high': 'Maximum Capability / High Tier (★4–5)',
    'all-medium': 'Balanced Medium Tier (★3)',
    'all-low': 'Fast / Token-Saver Low Tier (★1–2)',
  };
  return {
    routes: next,
    notice: `Applied "${labelMap[preset]}" across active providers. Fallbacks were reset. Click Save to persist.`,
  };
}
