import {
  type AgentId,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type FactorySettings,
  type McpServerEntry,
  type PersonaRouteMap,
  type QuotaPolicy,
  type SkillPluginEntry,
  type UpdateFactorySettingsBody,
} from '@emberline/protocol';
import {
  Bell,
  Bot,
  CircleArrowUp,
  KeyRound,
  KeySquare,
  type LucideIcon,
  Plug,
  Timer,
  Zap,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { ico } from '../components/SectionState';
import { AccountSection } from '../components/settings/AccountSection';
import { AutopilotSection } from '../components/settings/AutopilotSection';
import { ForgeAccountsSection } from '../components/settings/ForgeAccountsSection';
import { McpPluginsSection } from '../components/settings/McpPluginsSection';
import { ProvidersSection } from '../components/settings/ProvidersSection';
import { QuotaSection } from '../components/settings/QuotaSection';
import { SshKeySection } from '../components/settings/SshKeySection';
import {
  autopilotDraftFrom,
  buildSettingsPatch,
  isAutopilotDirty,
  isMcpDraftDirty,
  isProviderDraftDirty,
  mcpDraftFrom,
  providerDraftFrom,
} from '../components/settings/settingsDraft';
import { type AutopilotDraft, type ProviderSectionForm } from '../components/settings/settingsMeta';
import { UpdatesSection } from '../components/settings/UpdatesSection';
import { PageHeader } from '../components/ui/PageHeader';
import { useQueryParam } from '../hooks/navigation';
import { useFactorySettings } from '../hooks/useFactorySettings';

export const SETTINGS_TABS = [
  'autopilot',
  'providers',
  'mcp_plugins',
  'quota',
  'notifications',
  'ssh_key',
  'updates',
  'account',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const SETTINGS_TAB_ITEMS: ReadonlyArray<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'autopilot', label: 'Automation', icon: Zap },
  { id: 'providers', label: 'Providers', icon: Bot },
  { id: 'mcp_plugins', label: 'MCP and skills', icon: Plug },
  { id: 'quota', label: 'Usage limits', icon: Timer },
  { id: 'notifications', label: 'Forges and webhooks', icon: Bell },
  { id: 'ssh_key', label: 'SSH key', icon: KeySquare },
  { id: 'updates', label: 'Updates', icon: CircleArrowUp },
  { id: 'account', label: 'Account', icon: KeyRound },
];

const SAVED_NOTICE = 'Settings saved.';

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
  const tabListRef = useRef<HTMLDivElement>(null);

  const settingsQuery = useFactorySettings(false);
  const settings = settingsQuery.data;

  const [hydrated, setHydrated] = useState(false);
  const [autopilot, setAutopilot] = useState<AutopilotDraft>(() => autopilotDraftFrom(undefined, theme));
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

  const syncFromSettings = (source: FactorySettings) => {
    setAutopilot(autopilotDraftFrom(source));
    const prov = providerDraftFrom(source);
    setDefaultAgent(prov.defaultAgent);
    setEnabledProviders(prov.enabledProviders);
    setAntigravityAck(prov.antigravityAck);
    setPersonaRoutes(prov.personaRoutes);
    setQuotaPolicy(prov.quotaPolicy);
    setApiKeys(prov.apiKeys);
    const mcp = mcpDraftFrom(source);
    setMcpServers(mcp.mcpServers);
    setSkillPlugins(mcp.skillPlugins);
  };

  useEffect(() => {
    if (!settings || hydrated) return;
    setHydrated(true);
    syncFromSettings(settings);
  }, [settings, hydrated]);

  const clearSavedNotice = () => {
    setNotice((prev) => (prev === SAVED_NOTICE ? null : prev));
  };

  const autopilotDirty = isAutopilotDirty(autopilot, settings);
  const providerDirty = isProviderDraftDirty(
    {
      defaultAgent,
      enabledProviders,
      antigravityAck,
      personaRoutes,
      quotaPolicy,
      apiKeys,
    },
    settings,
  );
  const mcpDirty = isMcpDraftDirty({ mcpServers, skillPlugins }, settings);
  const anyDirty = autopilotDirty || providerDirty || mcpDirty;

  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyDirty]);

  const handleDiscardAutopilot = () => {
    if (!settings) return;
    const next = autopilotDraftFrom(settings);
    setAutopilot(next);
    if (next.themePref === 'light' || next.themePref === 'dark') {
      onChangeTheme(next.themePref);
    }
    clearSavedNotice();
    setError(null);
  };

  const handleDiscardProviders = () => {
    if (!settings) return;
    const next = providerDraftFrom(settings);
    setDefaultAgent(next.defaultAgent);
    setEnabledProviders(next.enabledProviders);
    setAntigravityAck(next.antigravityAck);
    setPersonaRoutes(next.personaRoutes);
    setQuotaPolicy(next.quotaPolicy);
    setApiKeys(next.apiKeys);
    clearSavedNotice();
    setError(null);
  };

  const handleDiscardMcp = () => {
    if (!settings) return;
    const next = mcpDraftFrom(settings);
    setMcpServers(next.mcpServers);
    setSkillPlugins(next.skillPlugins);
    clearSavedNotice();
    setError(null);
  };

  const handleSaveFactorySettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload: UpdateFactorySettingsBody = buildSettingsPatch(
        autopilot,
        {
          defaultAgent,
          enabledProviders,
          antigravityAck,
          personaRoutes,
          quotaPolicy,
          apiKeys,
        },
        {
          mcpServers,
          skillPlugins,
        },
      );

      const updated = await api<FactorySettings>('/api/factory/settings', 'PATCH', payload);
      settingsQuery.setData(updated);
      syncFromSettings(updated);
      if (autopilot.themePref === 'light' || autopilot.themePref === 'dark') {
        onChangeTheme(autopilot.themePref);
      }
      setNotice(SAVED_NOTICE);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = SETTINGS_TABS.indexOf(activeTab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_TABS.length - 1;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex]!;
    setActiveTab(nextTab);
    const tabs = tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  };

  const providerForm: ProviderSectionForm = {
    settings,
    setSettings: settingsQuery.setData,
    defaultAgent,
    setDefaultAgent: (next) => {
      clearSavedNotice();
      setDefaultAgent(next);
    },
    enabledProviders,
    setEnabledProviders: (updater) => {
      clearSavedNotice();
      setEnabledProviders(updater);
    },
    antigravityAck,
    setAntigravityAck: (next) => {
      clearSavedNotice();
      setAntigravityAck(next);
    },
    personaRoutes,
    setPersonaRoutes: (updater) => {
      clearSavedNotice();
      setPersonaRoutes(updater);
    },
    quotaPolicy,
    setQuotaPolicy: (next) => {
      clearSavedNotice();
      setQuotaPolicy(next);
    },
    apiKeys,
    patchApiKeys: (patch) => {
      clearSavedNotice();
      setApiKeys((prev) => ({ ...prev, ...patch }));
    },
    dirty: providerDirty,
    onDiscard: handleDiscardProviders,
    saving,
    onSave: (e) => void handleSaveFactorySettings(e),
    setNotice,
    setError,
  };

  return (
    <div className="settings-page">
      <PageHeader title="Settings">
        <div
          ref={tabListRef}
          className="settings-tabs"
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={handleTabKeyDown}
        >
          {SETTINGS_TAB_ITEMS.map(({ id, label, icon }) => {
            const selected = activeTab === id;
            return (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`settings-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                className="settings-tab"
                onClick={() => setActiveTab(id)}
              >
                {ico(icon)} {label}
              </button>
            );
          })}
        </div>
      </PageHeader>

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

      <div
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        className="settings-tabpanel"
      >
        {activeTab === 'autopilot' && (
          <AutopilotSection
            settings={settings}
            loading={settingsQuery.loading}
            loadError={settingsQuery.error}
            onRetry={settingsQuery.refresh}
            theme={theme}
            onChangeTheme={onChangeTheme}
            draft={autopilot}
            onChangeDraft={(patch) => {
              clearSavedNotice();
              setAutopilot((prev) => ({ ...prev, ...patch }));
            }}
            dirty={autopilotDirty}
            onDiscard={handleDiscardAutopilot}
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
            onChangeMcpServers={(next) => {
              clearSavedNotice();
              setMcpServers(next);
            }}
            onChangeSkillPlugins={(next) => {
              clearSavedNotice();
              setSkillPlugins(next);
            }}
            dirty={mcpDirty}
            onDiscard={handleDiscardMcp}
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
    </div>
  );
}
