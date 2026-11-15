import type { Route } from '@emberline/protocol';
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
