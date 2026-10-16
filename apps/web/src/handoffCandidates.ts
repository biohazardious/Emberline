import {
  type AgentId,
  type AgentPersona,
  type FactorySettings,
  getModelsForProvider,
  type Lane,
  laneCovers,
  laneOf,
  PERSONA_CAPABILITY_TARGETS,
  PROVIDER_RUNTIME,
  type Route,
  type Run,
  sameRoute,
  selectProviderModelByRank,
} from '@emberline/protocol';

/** Where a "Continue with…" route comes from, in the order they are offered. */
export type HandoffSource = 'run' | 'persona' | 'provider';

export interface HandoffCandidate {
  route: Route;
  source: HandoffSource;
  /** Its lane is out of quota right now; the server would refuse it. */
  exhausted: boolean;
}

/** Runs a person may hand to another route (the server accepts the same states). */
export const HANDOFF_STATES: ReadonlySet<Run['state']> = new Set(['rate_limited', 'failed', 'waiting_input']);

type SettingsView = Pick<
  FactorySettings,
  'personaRoutes' | 'enabledProviders' | 'anthropicKeyStored' | 'openaiKeyStored' | 'geminiKeyStored'
>;

/** Whether `agent` has an API key saved in Settings, not just in the environment (aider can use any vendor's key). */
export function keySavedFor(settings: SettingsView, agent: AgentId): boolean {
  switch (agent) {
    case 'claude':
      return settings.anthropicKeyStored;
    case 'codex':
      return settings.openaiKeyStored;
    case 'gemini':
    case 'antigravity':
      return settings.geminiKeyStored;
    case 'aider':
      return settings.anthropicKeyStored || settings.openaiKeyStored || settings.geminiKeyStored;
    default:
      return false;
  }
}

/**
 * The route a provider gets when nobody configured one for this persona: the model closest to the
 * persona's target rank (else the provider's first model), on the saved API key when there is one,
 * else the first sign-in method the provider allows. Never AI credits by default; undefined when the
 * provider can only run on a key and none is saved.
 */
export function defaultRouteFor(settings: SettingsView, agent: AgentId, persona?: AgentPersona): Route | undefined {
  const allowed = PROVIDER_RUNTIME[agent]?.credentials ?? ['login'];
  const model = persona
    ? selectProviderModelByRank(agent, PERSONA_CAPABILITY_TARGETS[persona].recommendedRank)
    : getModelsForProvider(agent)[0]?.id;
  if (!model) return undefined;
  const keyed = allowed.includes('api_key') && keySavedFor(settings, agent);
  const credential = keyed ? 'api_key' : allowed.find((c) => c !== 'api_key' && c !== 'credits');
  return credential ? { agent, model, credential } : undefined;
}

/**
 * What "Continue with…" offers for `run`: its own chain, then its persona's current chain, then one
 * default route per enabled provider. Without the current route, duplicates, and API-key routes
 * whose key is gone. Without settings (not loaded yet) only the run's own chain is offered.
 */
export function handoffCandidates(
  run: Pick<Run, 'agent' | 'model' | 'credential' | 'routes' | 'persona'>,
  settings: SettingsView | undefined,
  windows: readonly Lane[] = [],
): HandoffCandidate[] {
  const current: Route = { agent: run.agent as AgentId, model: (run.model ?? 'auto') as Route['model'], credential: run.credential };
  // Stored routes were validated as Routes when the run was created.
  const sources: [HandoffSource, readonly (Route | undefined)[]][] = [['run', run.routes as Route[]]];
  if (settings) {
    sources.push(['persona', settings.personaRoutes[run.persona] ?? []]);
    sources.push(['provider', settings.enabledProviders.map((agent) => defaultRouteFor(settings, agent, run.persona))]);
  }
  const out: HandoffCandidate[] = [];
  for (const [source, routes] of sources) {
    for (const route of routes) {
      if (!route || sameRoute(route, current) || out.some((c) => sameRoute(c.route, route))) continue;
      if (route.credential === 'api_key' && settings && !keySavedFor(settings, route.agent)) continue;
      out.push({ route, source, exhausted: windows.some((w) => laneCovers(w, laneOf(route))) });
    }
  }
  return out;
}
