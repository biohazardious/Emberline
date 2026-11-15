import { getModelsForProvider, type ProviderModelInfo, setModelCatalog } from '@emberline/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { modelAfterAgentChange } from './runFormModel';

describe('modelAfterAgentChange', () => {
  afterEach(() => setModelCatalog(null));
  const agyDefault = getModelsForProvider('antigravity')[0]!.id;

  it('moves a Claude model to the Antigravity default, never auto', () => {
    expect(modelAfterAgentChange('antigravity', 'opus')).toBe(agyDefault);
    expect(modelAfterAgentChange('antigravity', 'auto')).toBe(agyDefault);
  });

  it('falls back to auto on an agent that accepts it', () => {
    expect(modelAfterAgentChange('claude', agyDefault)).toBe('auto');
  });

  it('keeps a model the new agent has', () => {
    expect(modelAfterAgentChange('claude', 'opus')).toBe('opus');
    expect(modelAfterAgentChange('antigravity', agyDefault)).toBe(agyDefault);
  });
});

describe('with a discovered Antigravity catalog', () => {
  afterEach(() => setModelCatalog(null));

  it('picks the first model the CLI offers', () => {
    const entry = { ...getModelsForProvider('antigravity')[0]!, id: 'gemini-4-carbon-high', source: 'cli' };
    setModelCatalog({ antigravity: [entry as ProviderModelInfo] } as never);
    expect(modelAfterAgentChange('antigravity', 'opus')).toBe('gemini-4-carbon-high');
  });
});
