/**
 * Model ids as data. The built-ins ship with Emberline; the runtime catalog holds what the CLIs
 * reported (see model discovery) and is set once at start-up and after each refresh. The helpers
 * here read both, so a model the CLI added last week is selectable without a release.
 */
import { PERSONA_CAPABILITY_TARGETS, PROVIDER_REGISTRY } from './provider-registry.js';
import type { ModelRank, ProviderModelInfo } from './provider-registry.js';
import type { AgentId, AgentModelId, ModelCapabilityTier } from './runs.js';

/** A model id is one safe shell word: it is passed to a CLI as an argument, never interpreted. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

const AGENT_IDS = Object.keys(PROVIDER_REGISTRY) as AgentId[];

/** Today's registry models, the labels and ranks Emberline ships knowing about. */
export const BUILTIN_MODELS = Object.fromEntries(
  AGENT_IDS.map((a) => [a, PROVIDER_REGISTRY[a].models]),
) as Record<AgentId, ProviderModelInfo[]>;

/**
 * The model ids each CLI listed when this release was cut. Discovery uses them to tell a model
 * that is new since the release from one that was always there.
 */
export const KNOWN_AT_RELEASE: Record<AgentId, string[]> = {
  claude: [
    'claude-fable-5-1',
    'claude-haiku-4-5',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ],
  antigravity: [
    'gemini-4-argon-medium',
    'gemini-4-argon-high',
    'gemini-4-argon-low',
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'claude-opus-5-5-low',
    'claude-opus-5-5-medium',
    'claude-opus-5-5-high',
    'claude-sonnet-5-5-low',
    'claude-sonnet-5-5-medium',
    'claude-sonnet-5-5-high',
    'gpt-oss-120b-medium',
  ],
  copilot: [],
  gemini: [],
  codex: [],
  aider: [],
};

export type ModelCatalog = Record<AgentId, ProviderModelInfo[]>;

const emptyCatalog = (): ModelCatalog =>
  Object.fromEntries(AGENT_IDS.map((a) => [a, []])) as unknown as ModelCatalog;

let catalog: ModelCatalog = emptyCatalog();

/** Replaces the runtime catalog; null drops it, leaving the built-ins alone. */
export function setModelCatalog(c: ModelCatalog | null): void {
  catalog = { ...emptyCatalog(), ...(c ?? {}) };
}

export function getModelCatalog(): ModelCatalog {
  return catalog;
}

/** Built-ins plus catalog entries for `agent`; where both name an id, the catalog's label and cliId win. */
export function getModelsForProvider(agent: AgentId): ProviderModelInfo[] {
  const builtins = BUILTIN_MODELS[agent] ?? BUILTIN_MODELS.claude;
  const fromCatalog = catalog[agent] ?? [];
  if (fromCatalog.length === 0) return builtins;
  const byId = new Map(fromCatalog.map((m) => [m.id, m]));
  const merged = builtins.map((b) => {
    const c = byId.get(b.id);
    return c ? { ...b, label: c.label, ...(c.cliId !== undefined ? { cliId: c.cliId } : {}) } : b;
  });
  const builtinIds = new Set(builtins.map((b) => b.id));
  return [...merged, ...fromCatalog.filter((m) => !builtinIds.has(m.id))];
}

/**
 * Rank and tier for a model the CLI reported without any. The effort suffix is the only signal
 * the CLIs give, so an id without one lands in the middle.
 */
export function rankFromName(id: string, label: string): { rank: ModelRank; tier: ModelCapabilityTier } {
  const text = `${id} ${label}`.toLowerCase();
  const has = (word: string) => new RegExp(`(^|[^a-z])${word}($|[^a-z])`).test(text);
  if (has('xhigh') || has('max')) return { rank: 5, tier: 'high' };
  if (has('high')) return { rank: 4, tier: 'high' };
  if (has('medium')) return { rank: 3, tier: 'medium' };
  if (has('low')) return { rank: 2, tier: 'low' };
  return { rank: 3, tier: 'medium' };
}

/** The catalog's or built-in's label for a model, else the id itself. */
export function modelLabel(agent: AgentId, id: string): string {
  return getModelsForProvider(agent).find((m) => m.id === id)?.label ?? id;
}

/** Index of `needle` as a run of consecutive tokens in `hay`, or -1. */
function tokenRun(hay: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return i;
  }
  return -1;
}

/**
 * The id to hand the CLI for a stored model id. An entry's own cliId wins. A built-in id that
 * is a family name (`argon`) maps to the highest-ranked catalog entry of that family. Claude's
 * built-in aliases are accepted by Claude Code as they are. Null means the CLI no longer offers it.
 */
export function resolveCliModel(agent: AgentId, id: string): string | null {
  const direct = getModelsForProvider(agent).find((m) => m.id === id);
  const fromCatalog = (catalog[agent] ?? []).some((m) => m.id === id);
  if (direct && (direct.cliId || fromCatalog)) return direct.cliId ?? direct.id;
  const builtin = (BUILTIN_MODELS[agent] ?? []).some((m) => m.id === id);
  if (!builtin) return direct ? direct.id : null;
  if (agent === 'claude') return id;
  const family = id.split('-');
  const matches = (catalog[agent] ?? [])
    .map((m) => {
      const tokens = m.id.split('-');
      const at = tokenRun(tokens, family);
      return at < 0 ? null : { m, tail: tokens.length - at - family.length };
    })
    .filter((x): x is { m: ProviderModelInfo; tail: number } => x !== null);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.m.rank - a.m.rank || a.tail - b.tail || (a.m.id < b.m.id ? -1 : 1));
  const best = matches[0]!.m;
  return best.cliId ?? best.id;
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
  for (const other of AGENT_IDS) {
    const found = getModelsForProvider(other).find((m) => m.id === model);
    if (found) return found;
  }
  return null;
}

/** Selects the best model from `agent` whose rank is closest to `targetRank` (1..5). */
export function selectProviderModelByRank(agent: AgentId, targetRank: number): string {
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
  persona?: keyof typeof PERSONA_CAPABILITY_TARGETS,
): string {
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
  persona?: keyof typeof PERSONA_CAPABILITY_TARGETS,
): AgentModelId {
  if (currentModel === 'auto') return 'auto';
  if (isModelValidForProvider(agent, currentModel)) return currentModel;
  // Find the rank of currentModel in whichever provider it came from, or use the persona's recommended rank
  const priorInfo = getModelInfoForProvider(agent, currentModel);
  const targetRank = priorInfo?.rank ?? (persona ? PERSONA_CAPABILITY_TARGETS[persona].recommendedRank : 4);
  return selectProviderModelByRank(agent, targetRank);
}
