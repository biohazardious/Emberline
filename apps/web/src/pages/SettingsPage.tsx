import {
  type AgentId,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type FactorySettings,
  type McpServerEntry,
  type PersonaRouteMap,
  type QuotaPolicy,
  type SkillPluginEntry,
} from '@emberline/protocol';
import {
  Bell,
  Bot,
  CircleArrowUp,
  KeyRound,
  KeySquare,
  type LucideIcon,
  Plug,
  Settings,
  Timer,
  Zap,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { clampQuotaGb } from '../buildOutputs';
import { ico } from '../components/SectionState';
import { AccountSection } from '../components/settings/AccountSection';
import { AutopilotSection } from '../components/settings/AutopilotSection';
import { ForgeAccountsSection } from '../components/settings/ForgeAccountsSection';
import { McpPluginsSection } from '../components/settings/McpPluginsSection';
import { ProvidersSection } from '../components/settings/ProvidersSection';
import { QuotaSection } from '../components/settings/QuotaSection';
import { SshKeySection } from '../components/settings/SshKeySection';
import {
  type AutopilotDraft,
  clampParallel,
  type ProviderSectionForm,
} from '../components/settings/settingsMeta';
import { UpdatesSection } from '../components/settings/UpdatesSection';
import { useQueryParam } from '../hooks/navigation';
import { useFactorySettings } from '../hooks/useFactorySettings';

const SETTINGS_TABS = [
  'autopilot',
  'providers',
  'mcp_plugins',
  'quota',
  'notifications',
  'ssh_key',
  'updates',
  'account',
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

const SETTINGS_TAB_ITEMS: ReadonlyArray<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'autopilot', label: 'Auto-Pilot & Theme', icon: Zap },
  { id: 'providers', label: 'Multi-Agent & Model Matrix', icon: Bot },
  { id: 'mcp_plugins', label: 'MCP & Plugins', icon: Plug },
  { id: 'quota', label: 'Quota & Concurrency', icon: Timer },
  { id: 'notifications', label: 'Forge & Webhooks', icon: Bell },
  { id: 'ssh_key', label: 'SSH key', icon: KeySquare },
  { id: 'updates', label: 'Updates', icon: CircleArrowUp },
  { id: 'account', label: 'Account', icon: KeyRound },
];

export function SettingsPage({
  theme,
  onChangeTheme,
}: {
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
}) {
  // The tab lives in the address, so coming back from a login or install terminal returns to it.
  const [tabParam, setTabParam] = useQueryParam('tab');
  const activeTab: SettingsTab = SETTINGS_TABS.includes(tabParam as SettingsTab)
    ? (tabParam as SettingsTab)
    : 'autopilot';
  const setActiveTab = (tab: SettingsTab) => setTabParam(tab === 'autopilot' ? null : tab);

  const settingsQuery = useFactorySettings(false);
  const settings = settingsQuery.data;

  const [hydrated, setHydrated] = useState(false);
  const [autopilot, setAutopilot] = useState<AutopilotDraft>({
    themePref: theme,
    autoPickupReady: true,
    autoPickupBacklog: false,
    autoSyncToMain: true,
    selfHealingBuildGate: true,
    antiSlopGate: true,
    secretGuardGate: true,
    requireCompletionSignal: true,
    crossProviderCritic: false,
    autoMoveToDone: true,
    maxTicketDepth: 3,
    maxParallelTickets: '2',
    buildOutputsQuotaGb: '5',
    maxAutoRunsPerDay: 40,
  });
  const [defaultAgent, setDefaultAgent] = useState<AgentId>('claude');
  const [enabledProviders, setEnabledProviders] = useState<AgentId[]>(['claude']);
  const [personaRoutes, setPersonaRoutes] = useState<PersonaRouteMap | null>(null);
  const [quotaPolicy, setQuotaPolicy] = useState<QuotaPolicy>({ newRuns: 'wait', inFlight: 'wait' });
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>(DEFAULT_MCP_SERVERS);
  const [skillPlugins, setSkillPlugins] = useState<SkillPluginEntry[]>(DEFAULT_SKILL_PLUGINS);
  const [apiKeys, setApiKeys] = useState({ anthropic: '', openai: '', gemini: '' });
  const [antigravityAck, setAntigravityAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings || hydrated) return;
    setHydrated(true);
    setAutopilot({
      themePref: settings.theme,
      autoPickupReady: settings.autoPickupReady,
      autoPickupBacklog: settings.autoPickupBacklog,
      autoSyncToMain: settings.autoSyncToMain,
      selfHealingBuildGate: settings.selfHealingBuildGate,
      antiSlopGate: settings.antiSlopGate ?? true,
      secretGuardGate: settings.secretGuardGate ?? true,
      requireCompletionSignal: settings.requireCompletionSignal ?? true,
      crossProviderCritic: settings.crossProviderCritic ?? false,
      autoMoveToDone: settings.autoMoveToDone,
      maxTicketDepth: settings.maxTicketDepth,
      maxAutoRunsPerDay: settings.maxAutoRunsPerProjectPerDay,
      maxParallelTickets: String(settings.maxParallelTicketsPerProject ?? 2),
      buildOutputsQuotaGb: String(settings.buildOutputsQuotaGb ?? 5),
    });
    setDefaultAgent(settings.defaultAgent);
    setEnabledProviders(settings.enabledProviders?.length ? settings.enabledProviders : ['claude']);
    setAntigravityAck(settings.antigravityTermsAcknowledged ?? false);
    setPersonaRoutes(settings.personaRoutes);
    if (settings.quotaPolicy) setQuotaPolicy(settings.quotaPolicy);
    if (settings.mcpServers?.length) setMcpServers(settings.mcpServers);
    if (settings.skillPlugins?.length) setSkillPlugins(settings.skillPlugins);
  }, [settings, hydrated]);

  const handleSaveFactorySettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        theme: autopilot.themePref,
        autoPickupReady: autopilot.autoPickupReady,
        autoPickupBacklog: autopilot.autoPickupBacklog,
        autoSyncToMain: autopilot.autoSyncToMain,
        selfHealingBuildGate: autopilot.selfHealingBuildGate,
        antiSlopGate: autopilot.antiSlopGate,
        secretGuardGate: autopilot.secretGuardGate,
        requireCompletionSignal: autopilot.requireCompletionSignal,
        crossProviderCritic: autopilot.crossProviderCritic,
        autoMoveToDone: autopilot.autoMoveToDone,
        maxTicketDepth: autopilot.maxTicketDepth,
        maxAutoRunsPerProjectPerDay: autopilot.maxAutoRunsPerDay,
        maxParallelTicketsPerProject: clampParallel(autopilot.maxParallelTickets),
        buildOutputsQuotaGb: clampQuotaGb(autopilot.buildOutputsQuotaGb),
        defaultAgent,
        enabledProviders,
        antigravityTermsAcknowledged: antigravityAck,
        personaRoutes,
        quotaPolicy,
        mcpServers,
        skillPlugins,
      };
      if (apiKeys.anthropic.trim()) payload.anthropicApiKey = apiKeys.anthropic.trim();
      if (apiKeys.openai.trim()) payload.openaiApiKey = apiKeys.openai.trim();
      if (apiKeys.gemini.trim()) payload.geminiApiKey = apiKeys.gemini.trim();

      const updated = await api<FactorySettings>('/api/factory/settings', 'PATCH', payload);
      settingsQuery.setData(updated);
      setEnabledProviders(updated.enabledProviders?.length ? updated.enabledProviders : ['claude']);
      setAntigravityAck(updated.antigravityTermsAcknowledged ?? false);
      setDefaultAgent(updated.defaultAgent);
      setPersonaRoutes(updated.personaRoutes);
      setQuotaPolicy(updated.quotaPolicy);
      if (updated.mcpServers?.length) setMcpServers(updated.mcpServers);
      if (updated.skillPlugins?.length) setSkillPlugins(updated.skillPlugins);
      setApiKeys({ anthropic: '', openai: '', gemini: '' });
      if (autopilot.themePref === 'light' || autopilot.themePref === 'dark') {
        onChangeTheme(autopilot.themePref);
      }
      setNotice('Factory settings, active AI providers, MCP registry & skill plugins saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const providerForm: ProviderSectionForm = {
    settings,
    setSettings: settingsQuery.setData,
    defaultAgent,
    setDefaultAgent,
    enabledProviders,
    setEnabledProviders,
    antigravityAck,
    setAntigravityAck,
    personaRoutes,
    setPersonaRoutes,
    quotaPolicy,
    setQuotaPolicy,
    apiKeys,
    patchApiKeys: (patch) => setApiKeys((prev) => ({ ...prev, ...patch })),
    saving,
    onSave: (e) => void handleSaveFactorySettings(e),
    setNotice,
    setError,
  };

  return (
    <div className="settings-page" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <header
        className="panel"
        style={{
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <span className="eyebrow">Control Center</span>
          <h2 style={{ margin: '4px 0 0' }}>
            {ico(Settings)} Factory Settings &amp; Multi-Agent Model Routing
          </h2>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Factory settings sections">
          {SETTINGS_TAB_ITEMS.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              className={`btn btn-sm ${activeTab === id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setActiveTab(id)}
            >
              {ico(icon)} {label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-ok" role="status">
          {notice}
        </div>
      )}

      {activeTab === 'autopilot' && (
        <AutopilotSection
          settings={settings}
          loading={settingsQuery.loading}
          loadError={settingsQuery.error}
          onRetry={settingsQuery.refresh}
          theme={theme}
          onChangeTheme={onChangeTheme}
          draft={autopilot}
          onChangeDraft={(patch) => setAutopilot((prev) => ({ ...prev, ...patch }))}
          saving={saving}
          onSave={(e) => void handleSaveFactorySettings(e)}
        />
      )}

      {activeTab === 'providers' && (
        <ProvidersSection
          form={providerForm}
          loading={settingsQuery.loading}
          loadError={settingsQuery.error}
          onRetry={settingsQuery.refresh}
        />
      )}

      {activeTab === 'mcp_plugins' && (
        <McpPluginsSection
          mcpServers={mcpServers.length > 0 ? mcpServers : DEFAULT_MCP_SERVERS}
          skillPlugins={skillPlugins.length > 0 ? skillPlugins : DEFAULT_SKILL_PLUGINS}
          loading={settingsQuery.loading}
          loadError={settingsQuery.error}
          onRetry={settingsQuery.refresh}
          onChangeMcpServers={setMcpServers}
          onChangeSkillPlugins={setSkillPlugins}
          onSave={(e) => void handleSaveFactorySettings(e)}
          saving={saving}
        />
      )}

      {activeTab === 'quota' && <QuotaSection />}
      {activeTab === 'notifications' && <ForgeAccountsSection />}
      {activeTab === 'ssh_key' && <SshKeySection />}
      {activeTab === 'updates' && <UpdatesSection />}
      {activeTab === 'account' && <AccountSection />}
    </div>
  );
}
