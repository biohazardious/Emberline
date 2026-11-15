import {
  type AgentId,
  type ModelCatalog,
  type ProviderModelInfo,
  setModelCatalog,
} from '@emberline/protocol';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** What core stores per model and per provider read (the shape of `GET /api/models`). */
export type StoredModel = ProviderModelInfo & { firstSeen: string; lastSeen: string };
export type ProviderRead = { at: string; cliVersion: string | null; ok: boolean; error: string | null };
export type StoredCatalog = Record<AgentId, { models: StoredModel[]; read: ProviderRead | null }>;

export const MODEL_CATALOG_KEY = ['api', '/api/models'] as const;

/** Refetches the catalog after a change, so every picker lists the new ids. */
export const invalidateModelCatalog = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: MODEL_CATALOG_KEY });

/**
 * Hands a fetched catalog to the protocol helpers. It runs during render, not in an effect, so the
 * pickers below this component read the new list in the same pass.
 */
export function publishToProtocol(catalog: StoredCatalog | undefined): void {
  if (!catalog) return;
  setModelCatalog(
    Object.fromEntries(
      Object.entries(catalog).map(([agent, entry]) => [
        agent,
        entry.models.map(({ firstSeen: _f, lastSeen: _l, ...m }) => m),
      ]),
    ) as ModelCatalog,
  );
}

/** The model catalog; mounted once so every picker shows discovered models. */
export function useModelCatalog() {
  const query = useQuery({
    queryKey: MODEL_CATALOG_KEY,
    queryFn: async () => (await api<{ catalog: StoredCatalog }>('/api/models')).catalog,
    staleTime: Infinity,
  });
  publishToProtocol(query.data);
  return query;
}
