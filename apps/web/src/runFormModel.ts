import { type AgentId, type AgentModelId, getModelsForProvider, resolveCliModel } from '@emberline/protocol';

/**
 * The model the start-run form shows after the agent changes: the current one when the new agent
 * has it, else the new agent's default. Antigravity cannot run `auto`, so its default is its
 * first model the CLI still offers (else its first known one); the other agents take `auto`.
 */
export function modelAfterAgentChange(agent: AgentId, model: AgentModelId): AgentModelId {
  const models = getModelsForProvider(agent);
  if (model !== 'auto' && models.some((m) => m.id === model)) return model;
  if (agent === 'antigravity') {
    return (models.find((m) => resolveCliModel(agent, m.id) !== null) ?? models[0])?.id ?? 'auto';
  }
  return 'auto';
}
