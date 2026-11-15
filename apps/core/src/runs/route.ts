import {
  type AgentId,
  BUILTIN_MODELS,
  getModelsForProvider,
  isKnownAgent,
  MODEL_ID_RE,
  PROVIDER_REGISTRY,
  resolveCliModel,
  type Route,
} from '@emberline/protocol';
import type { runs } from '../db/schema.js';

type RunRow = typeof runs.$inferSelect;

/** A model id as the catalog writes it (MODEL_ID_RE's characters), so dotted and slashed ids route too. */
const TAG_MODEL = '[A-Za-z0-9][A-Za-z0-9._:/@-]*';
/** The routing tag roadmap/delegated tickets carry in their body (and pre-0.2.0 run prompts). */
export const ROUTE_TAG = new RegExp(
  `\\[Preferred Agent:\\s*([a-z0-9_-]+)\\s*·\\s*Model:\\s*(${TAG_MODEL})\\]`,
  'i',
);

/**
 * The id a tag's model names for `agent`. Ids are case-sensitive, so an id the agent knows exactly
 * stays as written (a hand-added `Claude-Opus-4.5-Preview` keeps its case). A person typing a tag
 * may still capitalise a known id (`Opus`), so when only one of the agent's ids matches ignoring
 * case, that id is meant. Anything else is left for the run's coercion.
 */
function tagModelFor(agent: string, model: string): string {
  if (!Object.hasOwn(PROVIDER_REGISTRY, agent)) return model;
  const ids = getModelsForProvider(agent as AgentId).map((m) => m.id);
  if (ids.includes(model)) return model;
  const folded = ids.filter((id) => id.toLowerCase() === model.toLowerCase());
  return folded.length === 1 ? folded[0]! : model;
}

/** The agent and model a route tag names. Agent ids are lowercase; a model id keeps its case unless it only differs in case from one the agent knows. */
export function parseRouteTag(text: string): { agent: string; model: string } | undefined {
  const match = ROUTE_TAG.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  const agent = match[1].toLowerCase();
  return { agent, model: tagModelFor(agent, match[2]) };
}

/**
 * The route tag a new run follows: one naming an agent this core has. A tag an older roadmap or
 * ticket wrote for an agent that is gone (Gemini CLI) routes nothing, so the persona's route runs.
 */
export function routingTag(text: string): { agent: AgentId; model: string } | undefined {
  const tag = parseRouteTag(text);
  return tag && isKnownAgent(tag.agent) ? { agent: tag.agent, model: tag.model } : undefined;
}

/** The run's model; legacy rows keep it only in the prompt's route tag. */
export function runModel(row: Pick<RunRow, 'model' | 'prompt'>): string | null {
  return row.model ?? parseRouteTag(row.prompt)?.model ?? null;
}

/** The run's chain; a legacy row (`[]`) is the single route it runs on. */
export function runRoutes(
  row: Pick<RunRow, 'routes' | 'agent' | 'model' | 'prompt' | 'credential'>,
): Route[] {
  if (row.routes.length > 0) return row.routes;
  return [{ agent: row.agent, model: runModel(row) ?? 'auto', credential: row.credential } as Route];
}

/** The route this run uses; the row's own columns are authoritative, `routeIndex` only says where in `routes` it is. */
export function currentRoute(
  row: Pick<RunRow, 'routes' | 'routeIndex' | 'agent' | 'model' | 'prompt' | 'credential'>,
): Route {
  return { agent: row.agent, model: runModel(row) ?? 'auto', credential: row.credential } as Route;
}

/** What a route on `auto` has always launched with where that is not the CLI's own default. */
const AUTO_MODEL: Partial<Record<AgentId, string>> = { antigravity: 'argon' };

/**
 * The pre-discovery behaviour: what each CLI got for a built-in id before Emberline read its model
 * list. A provider whose list was never read keeps it, so a route that worked then still works.
 * Copilot had no `--model`; Claude's aliases always resolve.
 */
function preDiscoveryCliModel(agent: AgentId, id: string): string | undefined {
  if (agent === 'codex' || agent === 'aider' || agent === 'antigravity') return id;
  return undefined;
}

/**
 * The id `agent`'s CLI is launched with for a stored model id, from the catalog. `cliModel`
 * undefined leaves the CLI on its own default; `unresolved` names a stored id the CLI's list
 * (once read, `listRead`) does not offer, which the run notes. A CLI is only ever handed one
 * safe word.
 */
export function launchModel(
  agent: AgentId,
  model: string | null | undefined,
  listRead: boolean,
): { cliModel?: string; unresolved?: string } {
  const named = model && model !== 'auto' ? model : undefined;
  const wanted = named ?? AUTO_MODEL[agent];
  if (!wanted) return {};
  const resolved = resolveCliModel(agent, wanted);
  const builtin = (BUILTIN_MODELS[agent] ?? []).some((m) => m.id === wanted);
  const cliModel = resolved ?? (builtin && !listRead ? preDiscoveryCliModel(agent, wanted) : undefined);
  if (cliModel && MODEL_ID_RE.test(cliModel)) return { cliModel };
  // Nothing to note before the list was read (the CLI's default is what ran then too), nor for an
  // `auto` default the catalog lacks: nobody named a model.
  return named && (listRead || !builtin) ? { unresolved: named } : {};
}

/** The id the CLI runs `model` as, for reading its limit messages (no default, no note). */
export function cliModelOf(
  agent: string,
  model: string | null | undefined,
  listRead: boolean,
): string | undefined {
  // An old run's agent may be gone (Gemini CLI): it has no CLI to read limits for.
  if (!model || model === 'auto' || !isKnownAgent(agent)) return undefined;
  return launchModel(agent, model, listRead).cliModel;
}
