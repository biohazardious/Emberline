import { type AgentId, MODEL_ID_RE, resolveCliModel, type Route } from '@emberline/protocol';
import type { runs } from '../db/schema.js';

type RunRow = typeof runs.$inferSelect;

/** A model id as the catalog writes it (MODEL_ID_RE's characters), so dotted and slashed ids route too. */
const TAG_MODEL = '[a-z0-9][a-z0-9._:/@-]*';
/** The routing tag roadmap/delegated tickets carry in their body (and pre-0.2.0 run prompts). */
export const ROUTE_TAG = new RegExp(
  `\\[Preferred Agent:\\s*([a-z0-9_-]+)\\s*·\\s*Model:\\s*(${TAG_MODEL})\\]`,
  'i',
);

export function parseRouteTag(text: string): { agent: string; model: string } | undefined {
  const match = ROUTE_TAG.exec(text);
  return match?.[1] && match[2]
    ? { agent: match[1].toLowerCase(), model: match[2].toLowerCase() }
    : undefined;
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
 * The id `agent`'s CLI is launched with for a stored model id, from the catalog. `cliModel`
 * undefined leaves the CLI on its own default; `unresolved` names a stored id the CLI no longer
 * offers (or never did), which the run notes. A CLI is only ever handed one safe word.
 */
export function launchModel(
  agent: AgentId,
  model: string | null | undefined,
): { cliModel?: string; unresolved?: string } {
  const named = model && model !== 'auto' ? model : undefined;
  const wanted = named ?? AUTO_MODEL[agent];
  if (!wanted) return {};
  const cliModel = resolveCliModel(agent, wanted);
  if (cliModel && MODEL_ID_RE.test(cliModel)) return { cliModel };
  // An `auto` default the catalog lacks is the CLI's own default; nobody named a model.
  return named ? { unresolved: named } : {};
}

/** The id the CLI runs `model` as, for reading its limit messages (no default, no note). */
export function cliModelOf(agent: string, model: string | null | undefined): string | undefined {
  return model && model !== 'auto' ? launchModel(agent as AgentId, model).cliModel : undefined;
}
