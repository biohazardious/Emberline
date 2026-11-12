import { claudeAdapter, secondaryCliAdapter } from '@emberline/adapter-claude';
import { codexAdapter } from '@emberline/adapter-codex';
import { geminiAdapter } from '@emberline/adapter-gemini';
import type { ProviderAdapter } from '@emberline/adapter-sdk';
import { AgentId } from '@emberline/protocol';

export type { ProviderAdapter, ProviderLaunchContext } from '@emberline/adapter-sdk';

/**
 * Every agent CLI's adapter, keyed by its `AgentId`: adding an id to the protocol enum fails the
 * build until it has an adapter here. Core reaches a CLI's launch, wording and limits only through these.
 */
const PROVIDERS: Readonly<Record<AgentId, ProviderAdapter>> = {
  claude: claudeAdapter,
  antigravity: secondaryCliAdapter('antigravity', 'Antigravity'),
  copilot: secondaryCliAdapter('copilot', 'Copilot'),
  gemini: geminiAdapter,
  codex: codexAdapter,
  aider: secondaryCliAdapter('aider', 'Aider'),
};

/** The adapter for a run's `agent`; unknown ids (e.g. a stale prompt route tag) run Claude. */
export function providerAdapter(agent: string): ProviderAdapter {
  const id = AgentId.safeParse(agent);
  return id.success ? PROVIDERS[id.data] : PROVIDERS.claude;
}

export function providerIds(): AgentId[] {
  return [...AgentId.options];
}
