import { AgentId, AgentModelId, type ProviderModelInfo } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { badRequest, conflict } from '../errors.js';
import {
  addManualModel,
  ModelAlreadyListedError,
  readCatalog,
  removeManualModel,
} from '../models/catalog.js';
import type { ModelDiscovery } from '../models/discovery.js';

const RefreshRequest = z.object({ agent: AgentId.optional() }).default({});
const ManualRequest = z.object({
  id: AgentModelId.refine((id) => id !== 'auto', 'Pick a model id, not "auto".'),
  label: z.string().trim().max(120).optional(),
});

/** The model catalog: what each CLI reported, a refresh on request, and ids a person typed in. */
export function registerModelRoutes(app: FastifyInstance, db: Db, discovery: ModelDiscovery): void {
  const agentParam = (raw: string): AgentId => {
    const parsed = AgentId.safeParse(raw);
    if (!parsed.success) throw badRequest(`Unknown provider: ${raw}`);
    return parsed.data;
  };

  app.get('/api/models', async () => ({ catalog: readCatalog(db) }));

  app.post('/api/models/refresh', async (request) => {
    const parsed = RefreshRequest.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Unknown provider.');
    return { reads: await discovery.refresh(parsed.data.agent) };
  });

  app.post<{ Params: { agent: string } }>('/api/models/:agent/manual', async (request) => {
    const agent = agentParam(request.params.agent);
    const parsed = ManualRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'A model id is letters, digits and . _ : / @ - only, and starts with a letter or digit.',
      );
    }
    try {
      addManualModel(db, agent, parsed.data.id, parsed.data.label || undefined);
    } catch (err) {
      if (err instanceof ModelAlreadyListedError) throw conflict(err.message);
      throw err;
    }
    return { catalog: readCatalog(db) };
  });

  app.delete<{ Params: { agent: string; id: string } }>('/api/models/:agent/manual/:id', async (request) => {
    const agent = agentParam(request.params.agent);
    const entry = readCatalog(db)[agent].models.find((m: ProviderModelInfo) => m.id === request.params.id);
    if (entry?.source !== 'manual') throw conflict('Only models you added can be removed');
    removeManualModel(db, agent, request.params.id);
    return { catalog: readCatalog(db) };
  });
}
