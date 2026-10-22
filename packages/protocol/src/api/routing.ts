/** API contracts: quota-aware routing (fallback chains, lanes, policy). */
import { z } from 'zod';
import { AgentId, AgentModelId } from './runs.js';

export const MAX_ROUTES = 4;
/** Automatic handoffs per ticket attempt; manual handoffs are not limited. */
export const MAX_HANDOFFS = 3;

/**
 * How a route signs in and pays: the CLI's own login (subscription quota), the API key stored in
 * Settings, or the login with paid AI credits allowed once the quota is used up (Antigravity).
 */
export const Credential = z.enum(['login', 'api_key', 'credits']);
export type Credential = z.infer<typeof Credential>;

/** One step of a persona's fallback chain. */
export const Route = z.object({
  agent: AgentId,
  model: AgentModelId,
  credential: Credential.default('login'),
});
export type Route = z.infer<typeof Route>;

export const QuotaPolicyChoice = z.enum(['wait', 'fallback']);
export type QuotaPolicyChoice = z.infer<typeof QuotaPolicyChoice>;

/** What happens when a lane's quota runs out: wait for its reset, or move to the next route. */
export const QuotaPolicy = z.object({
  newRuns: QuotaPolicyChoice.default('wait'),
  inFlight: QuotaPolicyChoice.default('wait'),
});
export type QuotaPolicy = z.infer<typeof QuotaPolicy>;

const Chain = z.array(Route).min(1).max(MAX_ROUTES);
export const PersonaRouteMap = z.object({
  product_owner: Chain,
  architect: Chain,
  ui_ux: Chain,
  coder: Chain,
  dba: Chain,
  qa: Chain,
  security: Chain,
});
export type PersonaRouteMap = z.infer<typeof PersonaRouteMap>;

export type ResumeMode = 'session' | 'continue_latest' | 'fresh';

/** Facts about each CLI that routing needs (which credentials it can use, how it continues). */
export const PROVIDER_RUNTIME: Record<AgentId, { credentials: Credential[]; resumeMode: ResumeMode }> = {
  claude: { credentials: ['login', 'api_key'], resumeMode: 'session' },
  antigravity: { credentials: ['login', 'credits'], resumeMode: 'continue_latest' },
  gemini: { credentials: ['login', 'api_key'], resumeMode: 'fresh' },
  codex: { credentials: ['login', 'api_key'], resumeMode: 'fresh' },
  copilot: { credentials: ['login'], resumeMode: 'fresh' },
  aider: { credentials: ['api_key'], resumeMode: 'fresh' },
};

/** A quota lane: limits of one agent signed in one way, for one pool of models (`*` = all). */
export interface Lane {
  agent: string;
  credential: string;
  pool: string;
}

/** The quota pool a model draws from; `*` when the model is unknown or `auto`. */
export function quotaPoolFor(agent: string, model: string | null | undefined): string {
  if (!model || model === 'auto') return '*';
  if (agent === 'antigravity') return model.startsWith('gemini') ? 'gemini' : model;
  return model;
}

export function laneOf(route: { agent: string; model: string | null | undefined; credential: string }): Lane {
  return { agent: route.agent, credential: route.credential, pool: quotaPoolFor(route.agent, route.model) };
}

/** Whether an exhausted `window` lane blocks work on `lane`. */
export function laneCovers(window: Lane, lane: Lane): boolean {
  return (
    window.agent === lane.agent &&
    window.credential === lane.credential &&
    (window.pool === '*' || lane.pool === '*' || window.pool === lane.pool)
  );
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.agent === b.agent && a.model === b.model && a.credential === b.credential;
}
