import {
  type AgentId,
  type AgentPersona,
  type ClaudeUsageTelemetry,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type FactorySettings,
  type McpServerEntry,
  type ModelCapabilityTier,
  type PersonaRouteMap,
  type QuotaPolicy,
  type SkillPluginEntry,
  type ThemeMode,
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
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { clampQuotaGb } from '../buildOutputs';
import { AccountPanel } from '../components/AccountPanel';
import { ViewErrorBanner, ViewLoadingState } from '../components/ErrorBoundary';
import { ForgeAccountsPanel } from '../components/ForgeAccountsPanel';
import { McpPluginsPanel } from '../components/McpPluginsPanel';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { QuotaPanel } from '../components/QuotaPanel';
import { AutopilotTabPanel } from '../components/settings/AutopilotTabPanel';
import { PersonaRoutingSection } from '../components/settings/PersonaRoutingSection';
import { ProviderRegistrySection } from '../components/settings/ProviderRegistrySection';
import {
  type CapabilityPreset,
  clampParallel,
  computeCapabilityPresetRoutes,
  removeProviderFromRoutes,
  selectQuickTierRoutes,
} from '../components/settings/providerRoutingHelpers';
import { useToolchainState } from '../components/settings/useToolchainState';
import { SshKeyPanel } from '../components/SshKeyPanel';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { useQueryParam } from '../hooks/navigation';
import { useApi } from '../hooks/useApi';

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
  const [, setLocation] = useLocation();
  // The tab lives in the address, so coming back from a login or install terminal returns to it.
  const [tabParam, setTabParam] = useQueryParam('tab');
  const activeTab: SettingsTab = SETTINGS_TABS.includes(tabParam as SettingsTab)
    ? (tabParam as SettingsTab)
    : 'autopilot';
  const setActiveTab = (tab: SettingsTab) => setTabParam(tab === 'autopilot' ? null : tab);
  const [settings, setSettings] = useState<FactorySettings | null>(null);
  const [themePref, setThemePref] = useState<ThemeMode>(theme);
  const [autoPickupReady, setAutoPickupReady] = useState(true);
  const [autoPickupBacklog, setAutoPickupBacklog] = useState(false);
  const [autoSyncToMain, setAutoSyncToMain] = useState(true);
  const [selfHealingBuildGate, setSelfHealingBuildGate] = useState(true);
  const [antiSlopGate, setAntiSlopGate] = useState(true);
  const [secretGuardGate, setSecretGuardGate] = useState(true);
  const [requireCompletionSignal, setRequireCompletionSignal] = useState(true);
  const [crossProviderCritic, setCrossProviderCritic] = useState(false);
  const [autoMoveToDone, setAutoMoveToDone] = useState(true);
  const [maxTicketDepth, setMaxTicketDepth] = useState(3);
  // Kept as typed while editing; clamped to 1-4 on blur and save.
  const [maxParallelTickets, setMaxParallelTickets] = useState('2');
  // Kept as typed while editing; clamped to 0.5-1000 GB on blur and save.
  const [buildOutputsQuotaGb, setBuildOutputsQuotaGb] = useState('5');
  const [maxAutoRunsPerDay, setMaxAutoRunsPerDay] = useState(40);
  const [defaultAgent, setDefaultAgent] = useState<AgentId>('claude');
  const [enabledProviders, setEnabledProviders] = useState<AgentId[]>(['claude']);
  const [personaRoutes, setPersonaRoutes] = useState<PersonaRouteMap | null>(null);
  const [quotaPolicy, setQuotaPolicy] = useState<QuotaPolicy>({ newRuns: 'wait', inFlight: 'wait' });
  // Same URL and poll interval as the Quota tab, so both share one cached request.
  const claudeUsage = useApi<ClaudeUsageTelemetry>('/api/factory/claude-usage', 30_000).data;
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>(DEFAULT_MCP_SERVERS);
  const [skillPlugins, setSkillPlugins] = useState<SkillPluginEntry[]>(DEFAULT_SKILL_PLUGINS);

  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');

  const [saving, setSaving] = useState(false);
  const [antigravityAck, setAntigravityAck] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toolchainState = useToolchainState({
    activeTab,
    settings,
    setSettings,
    setEnabledProviders,
    setNotice,
    setError,
    onNavigate: setLocation,
  });

  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(undefined);

  const loadSettings = useCallback(async () => {
    setLoadingSettings(true);
    setLoadError(undefined);
    try {
      const res = await api<FactorySettings>('/api/factory/settings');
      setSettings(res);
      setThemePref(res.theme);
      setAutoPickupReady(res.autoPickupReady);
      setAutoPickupBacklog(res.autoPickupBacklog);
      setAutoSyncToMain(res.autoSyncToMain);
      setSelfHealingBuildGate(res.selfHealingBuildGate);
      setAntiSlopGate(res.antiSlopGate ?? true);
      setSecretGuardGate(res.secretGuardGate ?? true);
      setRequireCompletionSignal(res.requireCompletionSignal ?? true);
      setCrossProviderCritic(res.crossProviderCritic ?? false);
      setAutoMoveToDone(res.autoMoveToDone);
      setMaxTicketDepth(res.maxTicketDepth);
      setMaxAutoRunsPerDay(res.maxAutoRunsPerProjectPerDay);
      setMaxParallelTickets(String(res.maxParallelTicketsPerProject ?? 2));
      setBuildOutputsQuotaGb(String(res.buildOutputsQuotaGb ?? 5));
      setDefaultAgent(res.defaultAgent);
      setEnabledProviders(res.enabledProviders?.length ? res.enabledProviders : ['claude']);
      setAntigravityAck(res.antigravityTermsAcknowledged ?? false);
      setPersonaRoutes(res.personaRoutes);
      if (res.quotaPolicy) setQuotaPolicy(res.quotaPolicy);
      if (res.mcpServers?.length) setMcpServers(res.mcpServers);
      if (res.skillPlugins?.length) setSkillPlugins(res.skillPlugins);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoadingSettings(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const toggleProviderEnabled = (providerId: AgentId) => {
    if (providerId === 'antigravity' && !antigravityAck && !enabledProviders.includes('antigravity')) {
      setNotice('Accept the Antigravity account risk on its card before enabling it.');
      return;
    }
    setEnabledProviders((prev) => {
      const exists = prev.includes(providerId);
      if (exists && prev.length <= 1) {
        setNotice('At least one AI provider must remain active.');
        return prev;
      }
      const next = exists ? prev.filter((p) => p !== providerId) : [...prev, providerId];
      const fallbackAgent: AgentId = next.includes(defaultAgent) ? defaultAgent : (next[0] ?? 'claude');
      if (!next.includes(defaultAgent)) {
        setDefaultAgent(fallbackAgent);
      }
      if (exists) {
        setPersonaRoutes((routes) =>
          routes ? removeProviderFromRoutes(routes, providerId, fallbackAgent) : routes,
        );
      }
      return next;
    });
  };

  const handlePersonaTierQuickSelect = (personaKey: AgentPersona, tier: ModelCapabilityTier) => {
    setPersonaRoutes((prev) => (prev ? selectQuickTierRoutes(prev, personaKey, tier) : prev));
  };

  const applyCapabilityPreset = (preset: CapabilityPreset) => {
    if (!personaRoutes) return;
    const result = computeCapabilityPresetRoutes({
      preset,
      personaRoutes,
      enabledProviders,
      defaultAgent,
    });
    setPersonaRoutes(result.routes);
    setNotice(result.notice);
  };

  const handleSaveFactorySettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        theme: themePref,
        autoPickupReady,
        autoPickupBacklog,
        autoSyncToMain,
        selfHealingBuildGate,
        antiSlopGate,
        secretGuardGate,
        requireCompletionSignal,
        crossProviderCritic,
        autoMoveToDone,
        maxTicketDepth,
        maxAutoRunsPerProjectPerDay: maxAutoRunsPerDay,
        maxParallelTicketsPerProject: clampParallel(maxParallelTickets),
        buildOutputsQuotaGb: clampQuotaGb(buildOutputsQuotaGb),
        defaultAgent,
        enabledProviders,
        antigravityTermsAcknowledged: antigravityAck,
        personaRoutes,
        quotaPolicy,
        mcpServers,
        skillPlugins,
      };
      if (anthropicApiKey.trim()) payload.anthropicApiKey = anthropicApiKey.trim();
      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
      if (geminiApiKey.trim()) payload.geminiApiKey = geminiApiKey.trim();

      const updated = await api<FactorySettings>('/api/factory/settings', 'PATCH', payload);
      setSettings(updated);
      setEnabledProviders(updated.enabledProviders?.length ? updated.enabledProviders : ['claude']);
      setAntigravityAck(updated.antigravityTermsAcknowledged ?? false);
      setDefaultAgent(updated.defaultAgent);
      setPersonaRoutes(updated.personaRoutes);
      setQuotaPolicy(updated.quotaPolicy);
      if (updated.mcpServers?.length) setMcpServers(updated.mcpServers);
      if (updated.skillPlugins?.length) setSkillPlugins(updated.skillPlugins);
      setAnthropicApiKey('');
      setOpenaiApiKey('');
      setGeminiApiKey('');
      if (themePref === 'light' || themePref === 'dark') {
        onChangeTheme(themePref);
      }
      setNotice('Factory settings, active AI providers, MCP registry & skill plugins saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
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
            <Settings className="icon" aria-hidden /> Factory Settings &amp; Multi-Agent Model Routing
          </h2>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Factory settings sections">
          {SETTINGS_TAB_ITEMS.map(({ id, label, icon: TabIcon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              className={`btn btn-sm ${activeTab === id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setActiveTab(id)}
            >
              <TabIcon className="icon" aria-hidden /> {label}
            </button>
          ))}
        </div>
      </header>

      {Boolean(loadError) && (
        <ViewErrorBanner label="Could not load factory settings" error={loadError} onRetry={loadSettings} />
      )}
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
      {loadingSettings && !settings && !loadError && <ViewLoadingState label="Loading factory settings…" />}

      {activeTab === 'autopilot' && (
        <AutopilotTabPanel
          theme={theme}
          onChangeTheme={onChangeTheme}
          setThemePref={setThemePref}
          autoPickupReady={autoPickupReady}
          setAutoPickupReady={setAutoPickupReady}
          autoPickupBacklog={autoPickupBacklog}
          setAutoPickupBacklog={setAutoPickupBacklog}
          selfHealingBuildGate={selfHealingBuildGate}
          setSelfHealingBuildGate={setSelfHealingBuildGate}
          antiSlopGate={antiSlopGate}
          setAntiSlopGate={setAntiSlopGate}
          requireCompletionSignal={requireCompletionSignal}
          setRequireCompletionSignal={setRequireCompletionSignal}
          secretGuardGate={secretGuardGate}
          setSecretGuardGate={setSecretGuardGate}
          crossProviderCritic={crossProviderCritic}
          setCrossProviderCritic={setCrossProviderCritic}
          autoSyncToMain={autoSyncToMain}
          setAutoSyncToMain={setAutoSyncToMain}
          autoMoveToDone={autoMoveToDone}
          setAutoMoveToDone={setAutoMoveToDone}
          maxAutoRunsPerDay={maxAutoRunsPerDay}
          setMaxAutoRunsPerDay={setMaxAutoRunsPerDay}
          maxParallelTickets={maxParallelTickets}
          setMaxParallelTickets={setMaxParallelTickets}
          buildOutputsQuotaGb={buildOutputsQuotaGb}
          setBuildOutputsQuotaGb={setBuildOutputsQuotaGb}
          maxTicketDepth={maxTicketDepth}
          setMaxTicketDepth={setMaxTicketDepth}
          saving={saving}
          onSave={(e) => void handleSaveFactorySettings(e)}
        />
      )}

      {activeTab === 'providers' && (
        <form
          onSubmit={(e) => void handleSaveFactorySettings(e)}
          className="panel"
          style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '22px' }}
        >
          <ProviderRegistrySection
            enabledProviders={enabledProviders}
            settings={settings}
            toolchain={toolchainState.toolchain}
            busyToolProvider={toolchainState.busyToolProvider}
            updatingAllTools={toolchainState.updatingAllTools}
            launchingLoginProvider={toolchainState.launchingLoginProvider}
            antigravityAck={antigravityAck}
            setAntigravityAck={setAntigravityAck}
            anthropicApiKey={anthropicApiKey}
            setAnthropicApiKey={setAnthropicApiKey}
            geminiApiKey={geminiApiKey}
            setGeminiApiKey={setGeminiApiKey}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            onToggleEnabled={toggleProviderEnabled}
            onToolchainAction={(providerId, action, spawnTerminal) =>
              void toolchainState.handleToolchainAction(providerId, action, spawnTerminal)
            }
            onUpdateAllTools={() => void toolchainState.handleUpdateAllTools()}
            onRefreshToolchain={toolchainState.refreshToolchain}
            onStartLogin={(providerId) => void toolchainState.handleStartProviderLogin(providerId)}
          />
          <PersonaRoutingSection
            enabledProviders={enabledProviders}
            settings={settings}
            personaRoutes={personaRoutes}
            setPersonaRoutes={setPersonaRoutes}
            quotaPolicy={quotaPolicy}
            setQuotaPolicy={setQuotaPolicy}
            claudeUsage={claudeUsage}
            saving={saving}
            onApplyPreset={applyCapabilityPreset}
            onQuickTierSelect={handlePersonaTierQuickSelect}
          />
        </form>
      )}

      {activeTab === 'mcp_plugins' && (
        <McpPluginsPanel
          mcpServers={mcpServers}
          skillPlugins={skillPlugins}
          onChangeMcpServers={setMcpServers}
          onChangeSkillPlugins={setSkillPlugins}
          onSave={(e) => void handleSaveFactorySettings(e)}
          saving={saving}
        />
      )}

      {activeTab === 'quota' && <QuotaPanel />}
      {activeTab === 'notifications' && (
        <>
          <ForgeAccountsPanel />
          <NotificationsPanel />
        </>
      )}
      {activeTab === 'ssh_key' && <SshKeyPanel />}
      {activeTab === 'updates' && <UpdatesPanel />}
      {activeTab === 'account' && <AccountPanel />}
    </div>
  );
}
