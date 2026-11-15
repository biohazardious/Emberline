import { FactorySettings } from '@emberline/protocol';
import { describe, expect, it } from 'vitest';
import {
  autopilotDraftFrom,
  buildSettingsPatch,
  isAutopilotDirty,
  isMcpDraftDirty,
  isProviderDraftDirty,
  mcpDraftFrom,
  providerDraftFrom,
} from './settingsDraft';

function makeSettings(overrides: Partial<FactorySettings> = {}): FactorySettings {
  const defaultChain = [{ agent: 'claude' as const, model: 'opus' as const, credential: 'login' as const }];
  return FactorySettings.parse({
    personaAgents: {},
    personaRoutes: {
      product_owner: defaultChain,
      architect: defaultChain,
      ui_ux: defaultChain,
      coder: defaultChain,
      dba: defaultChain,
      qa: defaultChain,
      security: defaultChain,
    },
    ...overrides,
  });
}

describe('settingsDraft', () => {
  describe('autopilotDraftFrom & isAutopilotDirty', () => {
    it('returns false when settings are undefined or draft matches saved settings', () => {
      const settings = makeSettings();
      const draft = autopilotDraftFrom(settings);
      expect(isAutopilotDirty(draft, undefined)).toBe(false);
      expect(isAutopilotDirty(draft, settings)).toBe(false);
    });

    it('detects changes to toggles, numbers, and commit identity', () => {
      const settings = makeSettings();
      const base = autopilotDraftFrom(settings);

      expect(isAutopilotDirty({ ...base, autoPickupReady: !base.autoPickupReady }, settings)).toBe(true);
      expect(
        isAutopilotDirty(
          { ...base, autoResolveAdditiveConflicts: !base.autoResolveAdditiveConflicts },
          settings,
        ),
      ).toBe(true);
      expect(isAutopilotDirty({ ...base, maxParallelTickets: '4' }, settings)).toBe(true);
      expect(isAutopilotDirty({ ...base, buildOutputsQuotaGb: '25' }, settings)).toBe(true);
      expect(isAutopilotDirty({ ...base, commitName: 'Ada Lovelace' }, settings)).toBe(true);
      expect(isAutopilotDirty({ ...base, commitName: `  ${base.commitName}  ` }, settings)).toBe(false);
    });
  });

  describe('providerDraftFrom & isProviderDraftDirty', () => {
    it('returns false when settings are undefined or draft matches saved settings', () => {
      const settings = makeSettings({ enabledProviders: ['claude', 'codex'] });
      const draft = providerDraftFrom(settings);
      expect(isProviderDraftDirty(draft, undefined)).toBe(false);
      expect(isProviderDraftDirty(draft, settings)).toBe(false);
    });

    it('treats reordered enabledProviders as clean (order alone is not dirty)', () => {
      const settings = makeSettings({ enabledProviders: ['claude', 'codex', 'aider'] });
      const draft = providerDraftFrom(settings);
      draft.enabledProviders = ['aider', 'claude', 'codex'];
      expect(isProviderDraftDirty(draft, settings)).toBe(false);

      draft.enabledProviders = ['claude', 'codex'];
      expect(isProviderDraftDirty(draft, settings)).toBe(true);
    });

    it('treats any non-empty typed API key as dirty', () => {
      const settings = makeSettings();
      const base = providerDraftFrom(settings);

      expect(
        isProviderDraftDirty({ ...base, apiKeys: { anthropic: '   ', openai: '', gemini: '' } }, settings),
      ).toBe(false);
      expect(
        isProviderDraftDirty(
          { ...base, apiKeys: { anthropic: 'sk-ant-123', openai: '', gemini: '' } },
          settings,
        ),
      ).toBe(true);
      expect(
        isProviderDraftDirty(
          { ...base, apiKeys: { anthropic: '', openai: 'sk-proj-456', gemini: '' } },
          settings,
        ),
      ).toBe(true);
      expect(
        isProviderDraftDirty(
          { ...base, apiKeys: { anthropic: '', openai: '', gemini: 'AIzaSy789' } },
          settings,
        ),
      ).toBe(true);
    });

    it('detects changes to defaultAgent, antigravityAck, quotaPolicy, and personaRoutes', () => {
      const settings = makeSettings();
      const base = providerDraftFrom(settings);

      expect(isProviderDraftDirty({ ...base, defaultAgent: 'codex' }, settings)).toBe(true);
      expect(isProviderDraftDirty({ ...base, antigravityAck: true }, settings)).toBe(true);
      expect(
        isProviderDraftDirty({ ...base, quotaPolicy: { newRuns: 'fallback', inFlight: 'wait' } }, settings),
      ).toBe(true);

      const nextRoutes = structuredClone(base.personaRoutes)!;
      nextRoutes.coder = [{ agent: 'claude', model: 'sonnet', credential: 'login' }];
      expect(isProviderDraftDirty({ ...base, personaRoutes: nextRoutes }, settings)).toBe(true);
    });
  });

  describe('mcpDraftFrom & isMcpDraftDirty', () => {
    it('detects MCP server and skill plugin edits', () => {
      const settings = makeSettings();
      const draft = mcpDraftFrom(settings);
      expect(isMcpDraftDirty(draft, undefined)).toBe(false);
      expect(isMcpDraftDirty(draft, settings)).toBe(false);
      expect(isMcpDraftDirty(draft.mcpServers, draft.skillPlugins, settings)).toBe(false);

      const toggledMcp = draft.mcpServers.map((s, i) => (i === 0 ? { ...s, enabled: !s.enabled } : s));
      expect(isMcpDraftDirty({ ...draft, mcpServers: toggledMcp }, settings)).toBe(true);
      expect(isMcpDraftDirty(toggledMcp, draft.skillPlugins, settings)).toBe(true);

      const toggledSkills = draft.skillPlugins.map((s, i) => (i === 0 ? { ...s, enabled: !s.enabled } : s));
      expect(isMcpDraftDirty({ ...draft, skillPlugins: toggledSkills }, settings)).toBe(true);
    });
  });

  describe('buildSettingsPatch', () => {
    it('omits blank API keys and includes trimmed API keys when provided', () => {
      const settings = makeSettings();
      const auto = autopilotDraftFrom(settings);
      const prov = providerDraftFrom(settings);
      const mcp = mcpDraftFrom(settings);

      const cleanPatch = buildSettingsPatch(auto, prov, mcp);
      expect('anthropicApiKey' in cleanPatch).toBe(false);
      expect('openaiApiKey' in cleanPatch).toBe(false);
      expect('geminiApiKey' in cleanPatch).toBe(false);

      const withKey = buildSettingsPatch(
        auto,
        { ...prov, apiKeys: { anthropic: '  sk-ant-test  ', openai: '', gemini: '' } },
        mcp,
      );
      expect(withKey.anthropicApiKey).toBe('sk-ant-test');
    });
  });
});
