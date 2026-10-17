import {
  type AgentId,
  type AgentPersona,
  type CliToolStatus,
  type ClaudeUsageTelemetry,
  coerceModelForProvider,
  DEFAULT_MCP_SERVERS,
  DEFAULT_SKILL_PLUGINS,
  type FactorySettings,
  formatRankStars,
  getModelInfoForProvider,
  type McpServerEntry,
  type ModelCapabilityTag,
  type ModelCapabilityTier,
  PERSONA_CAPABILITY_TARGETS,
  type PersonaRouteMap,
  PROVIDER_REGISTRY,
  PROVIDER_RUNTIME,
  type ProviderLoginResponse,
  type QuotaPolicy,
  type Route,
  type SkillPluginEntry,
  selectProviderModelByRank,
  selectProviderModelByTier,
  type ThemeMode,
  type ToolchainActionResponse,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import {
  Bell,
  Bot,
  Brain,
  CircleArrowUp,
  Cpu,
  Download,
  FlaskConical,
  Flame,
  Folder,
  Globe,
  KeyRound,
  Laptop,
  LoaderCircle,
  Lock,
  type LucideIcon,
  Moon,
  Package,
  Palette,
  Plug,
  RefreshCw,
  RotateCw,
  Save,
  Scale,
  Settings,
  Shield,
  Sun,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  Wallet,
  Zap,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useQueryParam } from '../hooks/navigation';
import { api, errorMessage } from '../api';
import { useApi } from '../hooks/useApi';
import { clampQuotaGb } from '../buildOutputs';
import { McpPluginsPanel } from '../components/McpPluginsPanel';
import { AccountPanel } from '../components/AccountPanel';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { PERSONA_LIST } from '../components/PersonaBadge';
import { QuotaPanel } from '../components/QuotaPanel';
import { RouteChainEditor } from '../components/RouteChainEditor';
import { SdkToolchainPanel } from '../components/SdkToolchainPanel';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { ProviderMark } from '../components/ProviderMark';

const ALL_PROVIDER_IDS: AgentId[] = ['claude', 'antigravity', 'gemini', 'codex', 'copilot', 'aider'];
const OAUTH_LOGIN_PROVIDERS: AgentId[] = ['claude', 'antigravity', 'gemini', 'codex', 'copilot'];

const CAPABILITY_TAG_META: Record<ModelCapabilityTag, { label: string; icon: LucideIcon }> = {
  reasoning: { label: 'Reasoning', icon: Brain },
  code: { label: 'Code', icon: Laptop },
  ui_ux: { label: 'UI/UX', icon: Palette },
  fast: { label: 'Fast', icon: Zap },
};

const TIER_COLORS: Record<ModelCapabilityTier, { bg: string; border: string; text: string; label: string }> = {
  high: {
    bg: 'color-mix(in srgb, var(--violet) 14%, transparent)',
    border: 'color-mix(in srgb, var(--violet) 45%, transparent)',
    text: 'var(--violet)',
    label: 'HIGH (★4–5)',
  },
  medium: {
    bg: 'color-mix(in srgb, var(--info) 14%, transparent)',
    border: 'color-mix(in srgb, var(--info) 45%, transparent)',
    text: 'var(--info)',
    label: 'MEDIUM (★3)',
  },
  low: {
    bg: 'color-mix(in srgb, var(--ok) 14%, transparent)',
    border: 'color-mix(in srgb, var(--ok) 45%, transparent)',
    text: 'var(--ok)',
    label: 'LOW (★1–2)',
  },
};

/** The parallel-tickets field as a whole number between 1 and 4 (anything unreadable counts as 1). */
function clampParallel(value: string): number {
  return Math.max(1, Math.min(4, Math.trunc(Number(value)) || 1));
}

/** A single route; keeps `prior` (the credential the user had on the first route) when the provider still supports it. */
function defaultRoute(agent: AgentId, model: Route['model'], prior?: Route['credential']): Route {
  const allowed = PROVIDER_RUNTIME[agent].credentials;
  return { agent, model, credential: prior && allowed.includes(prior) ? prior : allowed[0]! };
}

const SETTINGS_TABS = ['autopilot', 'providers', 'mcp_plugins', 'quota', 'notifications', 'updates', 'account'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

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
  const activeTab: SettingsTab = SETTINGS_TABS.includes(tabParam as SettingsTab) ? (tabParam as SettingsTab) : 'autopilot';
  const setActiveTab = (tab: SettingsTab) => setTabParam(tab === 'autopilot' ? null : tab);
  const [settings, setSettings] = useState<FactorySettings | null>(null);
  const [themePref, setThemePref] = useState<ThemeMode>(theme);
  const [autoPickupReady, setAutoPickupReady] = useState(true);
  const [autoPickupBacklog, setAutoPickupBacklog] = useState(false);
  const [autoSyncToMain, setAutoSyncToMain] = useState(true);
  const [selfHealingBuildGate, setSelfHealingBuildGate] = useState(true);
  const [antiSlopGate, setAntiSlopGate] = useState(true);
  const [secretGuardGate, setSecretGuardGate] = useState(true);
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

  const [toolchain, setToolchain] = useState<ToolchainStatusResponse | null>(null);
  const [busyToolProvider, setBusyToolProvider] = useState<AgentId | null>(null);
  const [updatingAllTools, setUpdatingAllTools] = useState(false);

  const [saving, setSaving] = useState(false);
  const [launchingLoginProvider, setLaunchingLoginProvider] = useState<AgentId | null>(null);
  const [antigravityAck, setAntigravityAck] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshToolchain = useCallback(async () => {
    try {
      const res = await api<ToolchainStatusResponse>('/api/toolchain/status');
      setToolchain(res);
    } catch {
      // ignore background poll errors
    }
  }, []);

  useEffect(() => {
    void api<FactorySettings>('/api/factory/settings')
      .then((res) => {
        setSettings(res);
        setThemePref(res.theme);
        setAutoPickupReady(res.autoPickupReady);
        setAutoPickupBacklog(res.autoPickupBacklog);
        setAutoSyncToMain(res.autoSyncToMain);
        setSelfHealingBuildGate(res.selfHealingBuildGate);
        setAntiSlopGate(res.antiSlopGate ?? true);
        setSecretGuardGate(res.secretGuardGate ?? true);
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
      })
      .catch((err) => setError(errorMessage(err)));
    void refreshToolchain();
  }, [refreshToolchain]);

  useEffect(() => {
    const anyInstalling =
      (toolchain?.tools.some((t) => t.installing) ?? false) || (toolchain?.sdks.some((s) => s.installing) ?? false);
    if (!anyInstalling && activeTab !== 'providers') return;
    const interval = setInterval(() => {
      void refreshToolchain();
    }, anyInstalling ? 2500 : 8000);
    return () => clearInterval(interval);
  }, [toolchain, activeTab, refreshToolchain]);

  const handleToolchainAction = async (
    providerId: AgentId,
    action: 'install' | 'update' | 'uninstall',
    spawnTerminal = false,
  ) => {
    setBusyToolProvider(providerId);
    setNotice(null);
    setError(null);
    try {
      const res = await api<ToolchainActionResponse>(`/api/toolchain/${providerId}/action`, 'POST', {
        action,
        spawnTerminal,
      });
      await refreshToolchain();
      if (res.terminal) {
        setLocation(`/terminals/${res.terminal.id}`);
        return;
      }
      setNotice(
        `${PROVIDER_REGISTRY[providerId].label} CLI ${action} completed${res.tool.version ? ` (${res.tool.version})` : ''}.`,
      );
    } catch (err) {
      setError(errorMessage(err));
      await refreshToolchain();
    } finally {
      setBusyToolProvider(null);
    }
  };

  const handleUpdateAllTools = async () => {
    setUpdatingAllTools(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api<{
        updated: AgentId[];
        errors: Record<string, string>;
        status: ToolchainStatusResponse;
      }>('/api/toolchain/update-all', 'POST', {});
      setToolchain(res.status);
      const errCount = Object.keys(res.errors).length;
      if (errCount > 0) {
        setError(`Updated ${res.updated.length} CLI(s), ${errCount} failed.`);
      } else {
        setNotice(`Updated ${res.updated.length} active/installed AI CLI(s) in ${res.status.toolsDir}.`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUpdatingAllTools(false);
    }
  };

  const handleStartProviderLogin = async (providerId: AgentId) => {
    setLaunchingLoginProvider(providerId);
    setNotice(null);
    setError(null);
    try {
      // Signing in enables the provider, which the server allows for Antigravity only once the risk is accepted.
      if (providerId === 'antigravity' && !settings?.antigravityTermsAcknowledged) {
        const updated = await api<FactorySettings>('/api/factory/settings', 'PATCH', { antigravityTermsAcknowledged: true });
        setSettings(updated);
      }
      const res = await api<ProviderLoginResponse>('/api/factory/provider-login', 'POST', {
        provider: providerId,
      });
      setEnabledProviders((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]));
      setLocation(`/terminals/${res.terminal.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLaunchingLoginProvider(null);
    }
  };

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

      // Disabling a provider drops its routes from every chain; a chain left empty falls back to the new default.
      if (exists) {
        setPersonaRoutes((prev) => {
          if (!prev) return prev;
          const updated = { ...prev };
          for (const p of PERSONA_LIST) {
            const kept = prev[p.id].filter((r) => r.agent !== providerId);
            updated[p.id] = kept.length
              ? kept
              : [defaultRoute(fallbackAgent, coerceModelForProvider(fallbackAgent, prev[p.id][0]?.model ?? 'opus', p.id))];
          }
          return updated;
        });
      }
      return next;
    });
  };

  const handlePersonaTierQuickSelect = (personaKey: AgentPersona, tier: ModelCapabilityTier) => {
    setPersonaRoutes((prev) => {
      if (!prev) return prev;
      const [first, ...rest] = prev[personaKey];
      if (!first) return prev;
      return { ...prev, [personaKey]: [{ ...first, model: selectProviderModelByTier(first.agent, tier, personaKey) }, ...rest] };
    });
  };

  const applyCapabilityPreset = (preset: 'auto-rank' | 'all-high' | 'all-medium' | 'all-low' | 'multi-provider') => {
    if (!personaRoutes) return;
    // Presets replace each chain with a single route; add fallbacks afterwards.
    if (preset === 'multi-provider') {
      const coreProvider: AgentId = enabledProviders.includes('claude')
        ? 'claude'
        : (enabledProviders[0] ?? 'claude');
      // Antigravity is never picked by a preset: the user adds it to a chain knowingly.
      const uiProvider: AgentId = enabledProviders.includes('gemini') ? 'gemini' : coreProvider;
      const qaProvider: AgentId = enabledProviders.includes('gemini')
        ? 'gemini'
        : enabledProviders.includes('codex')
          ? 'codex'
          : (enabledProviders[0] ?? 'claude');

      setPersonaRoutes({
        product_owner: [defaultRoute(coreProvider, selectProviderModelByRank(coreProvider, 5), personaRoutes.product_owner[0]?.credential)],
        architect: [defaultRoute(coreProvider, selectProviderModelByRank(coreProvider, 5), personaRoutes.architect[0]?.credential)],
        ui_ux: [defaultRoute(uiProvider, selectProviderModelByRank(uiProvider, 5), personaRoutes.ui_ux[0]?.credential)],
        coder: [defaultRoute(coreProvider, selectProviderModelByRank(coreProvider, 4), personaRoutes.coder[0]?.credential)],
        dba: [defaultRoute(coreProvider, selectProviderModelByRank(coreProvider, 4), personaRoutes.dba[0]?.credential)],
        qa: [defaultRoute(qaProvider, selectProviderModelByRank(qaProvider, 3), personaRoutes.qa[0]?.credential)],
        security: [defaultRoute(coreProvider, selectProviderModelByRank(coreProvider, 4), personaRoutes.security[0]?.credential)],
      });
      setNotice(
        'Applied "Multi-Provider Specialist Split" across your active providers with automatic capability rank matching. Fallbacks were reset. Click Save to persist.',
      );
      return;
    }

    const next: PersonaRouteMap = { ...personaRoutes };
    for (const meta of PERSONA_LIST) {
      const p = meta.id;
      const agent = personaRoutes[p][0]?.agent ?? defaultAgent ?? 'claude';
      let model: Route['model'];
      if (preset === 'auto-rank') {
        model = selectProviderModelByRank(agent, PERSONA_CAPABILITY_TARGETS[p].recommendedRank);
      } else if (preset === 'all-high') {
        model = selectProviderModelByTier(agent, 'high', p);
      } else if (preset === 'all-medium') {
        model = selectProviderModelByTier(agent, 'medium', p);
      } else {
        model = selectProviderModelByTier(agent, 'low', p);
      }
      next[p] = [defaultRoute(agent, model, personaRoutes[p][0]?.credential)];
    }
    setPersonaRoutes(next);
    const labelMap = {
      'auto-rank': 'Recommended Persona Capability Ranks (★5 PO/Arch, ★4 Core/UI/Sec, ★3 QA)',
      'all-high': 'Maximum Capability / High Tier (★4–5)',
      'all-medium': 'Balanced Medium Tier (★3)',
      'all-low': 'Fast / Token-Saver Low Tier (★1–2)',
    };
    setNotice(`Applied "${labelMap[preset]}" across active providers. Fallbacks were reset. Click Save to persist.`);
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

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'autopilot' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('autopilot')}
          >
            <Zap className="icon" aria-hidden /> Auto-Pilot &amp; Theme
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'providers' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('providers')}
          >
            <Bot className="icon" aria-hidden /> Multi-Agent &amp; Model Matrix
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'mcp_plugins' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('mcp_plugins')}
          >
            <Plug className="icon" aria-hidden /> MCP &amp; Plugins
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'quota' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('quota')}
          >
            <Timer className="icon" aria-hidden /> Quota &amp; Concurrency
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'notifications' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('notifications')}
          >
            <Bell className="icon" aria-hidden /> Forge &amp; Webhooks
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'updates' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('updates')}
          >
            <CircleArrowUp className="icon" aria-hidden /> Updates
          </button>
          <button
            type="button"
            className={`btn btn-sm ${activeTab === 'account' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab('account')}
          >
            <KeyRound className="icon" aria-hidden /> Account
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-ok">{notice}</div>}

      {activeTab === 'autopilot' && (
        <form
          onSubmit={(e) => void handleSaveFactorySettings(e)}
          className="panel"
          style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}
        >
          <div>
            <span className="eyebrow">Appearance</span>
            <h3 style={{ margin: '4px 0 8px' }}>Theme Mode</h3>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn ${theme === 'dark' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => {
                  setThemePref('dark');
                  onChangeTheme('dark');
                }}
              >
                <Moon className="icon" aria-hidden /> Dark Workbench
              </button>
              <button
                type="button"
                className={`btn ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => {
                  setThemePref('light');
                  onChangeTheme('light');
                }}
              >
                <Sun className="icon" aria-hidden /> Light Workbench
              </button>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <span className="eyebrow">Autonomous Pipeline</span>
              <h3 style={{ margin: '4px 0 4px' }}>Backlog &amp; Ready Auto-Pickup + Self-Healing</h3>
              <p className="muted small">
                Configure how the AI Coding Factory chains specialist tickets, verifies builds, and updates the live workspace.
              </p>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoPickupReady}
                onChange={(e) => setAutoPickupReady(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Pickup Ready Queue</strong>
                <div className="muted small">
                  Automatically start the highest-priority ticket in the <code>Ready</code> column as soon as the previous specialist finishes.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoPickupBacklog}
                onChange={(e) => setAutoPickupBacklog(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Pickup Backlog Queue (Continuous Factory Mode)</strong>
                <div className="muted small">
                  When the <code>Ready</code> column is empty during an active pipeline run, automatically pull the next highest-priority ticket from <code>Backlog</code>.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selfHealingBuildGate}
                onChange={(e) => setSelfHealingBuildGate(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>
                  <FlaskConical className="icon" aria-hidden /> Self-Healing Build, Lint &amp; Unit Test Gate (Auto-Verify &amp; Auto-Fix)
                </strong>
                <div className="muted small">
                  When a specialist finishes a run, automatically run the project&apos;s <code>build</code>/<code>typecheck</code>, <code>lint</code>, and <code>test</code> suites (`CI=true`). If any check fails, resume the agent with the exact compiler/linter/test failure output to self-heal before advancing.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={antiSlopGate}
                onChange={(e) => setAntiSlopGate(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>
                  <Shield className="icon" aria-hidden /> Anti-AI-Slop &amp; Anti-Vibe-Coding Gate (Deterministic Diff Audit &amp; Auto-Clean)
                </strong>
                <div className="muted small">
                  Automatically scan every completed worktree diff for type evasion (<code>: any</code>, <code>as any</code>, <code>@ts-ignore</code>), unfinished <code>TODO</code>/<code>FIXME</code> stubs, skipped tests, leftover <code>console.log</code>/<code>debugger</code>, and generic AI gradient clichés. If blocked, auto-resume the agent once to clean its own code.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={secretGuardGate}
                onChange={(e) => setSecretGuardGate(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>
                  <Lock className="icon" aria-hidden /> Pre-Commit Secret &amp; Credential Guard (Auto-Block &amp; Redact Leaked Keys)
                </strong>
                <div className="muted small">
                  Inspects diffs before commit and before <code>main</code> workspace sync for hardcoded API keys (<code>sk-...</code>, <code>AIza...</code>, <code>ghp_...</code>, <code>AKIA...</code>), private keys (<code>.pem</code>/<code>.key</code>), and tracked <code>.env</code> files. Blocks merging into <code>main</code> and instructs the agent to move secrets to <code>process.env</code> + <code>.env.example</code>.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={crossProviderCritic}
                onChange={(e) => setCrossProviderCritic(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>
                  <Scale className="icon" aria-hidden /> Cross-Provider AI Critic (Rival Provider Code Review)
                </strong>
                <div className="muted small">
                  When multiple providers are active (e.g. Claude + Google Antigravity), automatically have a rival provider audit the completed diff against the ticket specification before moving to <code>Done</code>.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoSyncToMain}
                onChange={(e) => setAutoSyncToMain(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Sync Completed Worktrees into Main Host Workspace</strong>
                <div className="muted small">
                  Merge each completed specialist's branch into <code>/workspaces/&lt;slug&gt;</code> with git so subsequent specialists and the Live Demo stay up to date. Conflicts keep the ticket in Review; untracked files such as <code>.env</code> are never touched.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoMoveToDone}
                onChange={(e) => setAutoMoveToDone(e.target.checked)}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>Auto-Move Verified Factory Tickets to Done</strong>
                <div className="muted small">
                  Move factory pipeline tickets directly to the <code>Done</code> column once their build and sync succeed.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="number"
                className="input mono"
                min={0}
                max={1000}
                value={maxAutoRunsPerDay}
                onChange={(e) => setMaxAutoRunsPerDay(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
                style={{ width: '90px' }}
              />
              <div>
                <strong>Daily run budget per project</strong>
                <div className="muted small">
                  Auto-dispatch stops starting new runs for a project once this many runs started in the last 24 hours (0 = unlimited). Manual starts are not limited.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="number"
                className="input mono"
                min={1}
                max={4}
                value={maxParallelTickets}
                onChange={(e) => setMaxParallelTickets(e.target.value)}
                onBlur={() => setMaxParallelTickets(String(clampParallel(maxParallelTickets)))}
                style={{ width: '90px' }}
              />
              <div>
                <strong>Parallel tickets per project</strong>
                <div className="muted small">
                  How many unblocked tickets of one project the factory works on at the same time (1-4). Tickets that wait for a dependency never start early.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="number"
                className="input mono"
                min={0.5}
                max={1000}
                step={0.5}
                value={buildOutputsQuotaGb}
                onChange={(e) => setBuildOutputsQuotaGb(e.target.value)}
                onBlur={() => setBuildOutputsQuotaGb(String(clampQuotaGb(buildOutputsQuotaGb)))}
                style={{ width: '90px' }}
              />
              <div>
                <strong>Build outputs archive per project (GB)</strong>
                <div className="muted small">
                  Archived APKs, installers and firmware images are kept per project up to this size (0.5-1000 GB). Beyond it the oldest unpinned outputs are deleted; pinned ones stay.
                </div>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="number"
                className="input mono"
                min={1}
                max={10}
                value={maxTicketDepth}
                onChange={(e) => setMaxTicketDepth(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                style={{ width: '90px' }}
              />
              <div>
                <strong>Agent ticket depth limit</strong>
                <div className="muted small">
                  How many generations of agent-created tickets may follow a ticket you created. Drafts beyond it are dropped and noted on the run.
                </div>
              </div>
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? (
                'Saving…'
              ) : (
                <>
                  <Save className="icon" aria-hidden /> Save Auto-Pilot &amp; Theme Settings
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'providers' && (
        <form
          onSubmit={(e) => void handleSaveFactorySettings(e)}
          className="panel"
          style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '22px' }}
        >
          {/* STEP 1: ACTIVE AI PROVIDERS, PERSISTENT CLI VOLUME & CREDENTIALS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <span className="eyebrow">Step 1 · Provider Registry, Persistent CLI Volume &amp; Credentials</span>
                <h3 style={{ margin: '4px 0 4px' }}>
                  Active AI Providers ({enabledProviders.length} Enabled)
                </h3>
                <p className="muted small" style={{ maxWidth: 760, margin: 0 }}>
                  Runner image is generic and CLI-agnostic. All AI CLIs are dynamically installed and updated inside the persistent <code>{toolchain?.toolsDir ?? '/opt/ai-tools'}</code> volume so container rebuilds never lose your tools.
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {toolchain && (
                  <span
                    className="badge mono"
                    style={{
                      fontSize: '0.68rem',
                      padding: '4px 8px',
                      borderColor: 'color-mix(in srgb, var(--ok) 40%, transparent)',
                      color: 'var(--ok)',
                    }}
                    title="Generic Runner Base OS & Node.js LTS Runtime"
                  >
                    <Cpu className="icon" aria-hidden /> {toolchain.osInfo} · Node {toolchain.nodeVersion} · <Folder className="icon" aria-hidden />{' '}
                    {toolchain.toolsDir}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={updatingAllTools || busyToolProvider !== null}
                  onClick={() => void handleUpdateAllTools()}
                  title="Install missing enabled CLIs and update all installed AI CLIs in /opt/ai-tools to their latest release"
                >
                  {updatingAllTools ? (
                    <>
                      <LoaderCircle className="icon icon-spin" aria-hidden /> Updating All CLIs…
                    </>
                  ) : (
                    <>
                      <RotateCw className="icon" aria-hidden /> Update All Active CLIs
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => void refreshToolchain()}
                  title="Refresh CLI installation & version status"
                >
                  <RefreshCw className="icon" aria-hidden /> Refresh
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(295px, 100%), 1fr))',
                gap: '10px',
              }}
            >
              {ALL_PROVIDER_IDS.map((providerId) => {
                const entry = PROVIDER_REGISTRY[providerId];
                const isEnabled = enabledProviders.includes(providerId);
                const authStatus = settings?.providerAuth?.[providerId];
                const toolStatus: CliToolStatus | undefined = toolchain?.tools.find(
                  (t) => t.provider === providerId,
                );
                const isToolBusy = busyToolProvider === providerId || Boolean(toolStatus?.installing);
                const supportsOAuthLogin = OAUTH_LOGIN_PROVIDERS.includes(providerId);
                const isKeyConfigured =
                  providerId === 'claude'
                    ? Boolean(settings?.anthropicKeyConfigured)
                    : providerId === 'gemini' || providerId === 'antigravity'
                      ? Boolean(settings?.geminiKeyConfigured)
                      : providerId === 'codex'
                        ? Boolean(settings?.openaiKeyConfigured)
                        : false;
                const isAuthReady = Boolean(authStatus?.authenticated || isKeyConfigured);
                const makeLoginCmd =
                  providerId === 'antigravity'
                    ? 'make agy-login'
                    : providerId === 'claude'
                      ? 'make claude-login'
                      : providerId === 'gemini'
                        ? 'make gemini-login'
                        : providerId === 'codex'
                          ? 'make codex-login'
                          : providerId === 'copilot'
                            ? 'make copilot-login'
                            : null;

                return (
                  <div
                    key={providerId}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      background: isEnabled ? 'var(--surface-2)' : 'color-mix(in srgb, var(--text) 1.5%, transparent)',
                      border: isEnabled
                        ? '1px solid color-mix(in srgb, var(--info) 50%, transparent)'
                        : '1px dashed var(--border)',
                      opacity: isEnabled ? 1 : 0.75,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '10px',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                          <ProviderMark id={entry.id} />
                          <strong style={{ fontSize: '0.9rem' }}>{entry.label}</strong>
                        </div>
                        <button
                          type="button"
                          className={`btn btn-xs ${isEnabled ? 'btn-primary' : 'btn-ghost'}`}
                          onClick={() => toggleProviderEnabled(providerId)}
                          title={
                            isEnabled
                              ? 'Click to disable this provider and hide its models'
                              : 'Click to enable this provider in routing selectors'
                          }
                        >
                          {isEnabled ? '✓ Active' : '+ Enable'}
                        </button>
                      </div>

                      {providerId === 'antigravity' && (
                        <label className="provider-terms-note small">
                          <input
                            type="checkbox"
                            checked={antigravityAck}
                            onChange={(e) => setAntigravityAck(e.target.checked)}
                          />
                          <span>
                            Google does not support using an Antigravity consumer login (Google AI Pro/Ultra) inside
                            third-party tools such as Emberline and has suspended accounts for it. I accept this risk for
                            my account.
                          </span>
                        </label>
                      )}

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span
                          className="badge mono"
                          style={{
                            fontSize: '0.65rem',
                            borderColor: isToolBusy
                              ? 'color-mix(in srgb, var(--info) 50%, transparent)'
                              : toolStatus?.installed
                                ? 'color-mix(in srgb, var(--ok) 50%, transparent)'
                                : 'color-mix(in srgb, var(--warn) 45%, transparent)',
                            color: isToolBusy
                              ? 'var(--info)'
                              : toolStatus?.installed
                                ? 'var(--ok)'
                                : 'var(--warn)',
                          }}
                          title={
                            toolStatus?.binaryPath
                              ? `Binary: ${toolStatus.binaryPath}\nInstall cmd: ${toolStatus.installCommand}`
                              : `Install cmd: ${toolStatus?.installCommand ?? ''}`
                          }
                        >
                          {isToolBusy ? (
                            <>
                              <LoaderCircle className="icon icon-spin" aria-hidden /> Installing {toolStatus?.binaryName ?? providerId}…
                            </>
                          ) : toolStatus?.installed ? (
                            <>
                              <Package className="icon" aria-hidden /> {toolStatus.binaryName} ({toolStatus.version ?? 'installed'})
                            </>
                          ) : (
                            <>
                              <TriangleAlert className="icon" aria-hidden /> CLI Not Installed
                            </>
                          )}
                        </span>
                        <span
                          className="badge mono"
                          style={{
                            fontSize: '0.65rem',
                            borderColor: isAuthReady
                              ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
                              : 'color-mix(in srgb, var(--warn) 45%, transparent)',
                            color: isAuthReady ? 'var(--ok)' : 'var(--warn)',
                          }}
                        >
                          {authStatus?.label ?? (isKeyConfigured ? '✓ API Key Set' : 'OAuth CLI / API Key')}
                        </span>
                      </div>

                      <div className="muted small" style={{ fontSize: '0.73rem', lineHeight: 1.35 }}>
                        {entry.description}
                      </div>

                      <div className="small" style={{ fontSize: '0.72rem', lineHeight: 1.35 }}>
                        <span className="muted">Terms: </span>
                        <span
                          className={`badge ${entry.terms.risk === 'low' ? 'badge-ok' : entry.terms.risk === 'medium' ? 'badge-warn' : 'badge-bad'}`}
                        >
                          {entry.terms.risk} risk
                        </span>{' '}
                        <span className="muted">
                          {entry.terms.summary} · checked {entry.terms.checked} ·{' '}
                        </span>
                        <a href={entry.terms.url} target="_blank" rel="noreferrer">
                          terms
                        </a>
                      </div>

                      {authStatus?.warning && (
                        <div className="small" style={{ fontSize: '0.72rem', lineHeight: 1.35, color: 'var(--warn)' }}>
                          {authStatus.warning}
                        </div>
                      )}

                      {/* Scoped Models Preview */}
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '2px' }}>
                        {entry.models.map((m) => {
                          const tierMeta = TIER_COLORS[m.tier];
                          return (
                            <span
                              key={m.id}
                              className="mono"
                              style={{
                                fontSize: '0.65rem',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: tierMeta.bg,
                                border: `1px solid ${tierMeta.border}`,
                                color: tierMeta.text,
                              }}
                              title={`${m.label} — Rank ${m.rank}/5 (${m.tier.toUpperCase()})`}
                            >
                              ★{m.rank} {m.shortLabel}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    {/* Dynamic CLI Install/Update + Interactive OAuth CLI Login & API Key Overrides */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          disabled={isToolBusy || updatingAllTools}
                          onClick={() =>
                            void handleToolchainAction(
                              providerId,
                              toolStatus?.installed ? 'update' : 'install',
                              false,
                            )
                          }
                          style={{
                            borderColor: toolStatus?.installed
                              ? 'color-mix(in srgb, var(--ok) 40%, transparent)'
                              : 'color-mix(in srgb, var(--warn) 50%, transparent)',
                            color: toolStatus?.installed ? 'var(--ok)' : 'var(--warn)',
                            fontSize: '0.71rem',
                          }}
                          title={
                            toolStatus?.installed
                              ? `Update ${entry.shortLabel} CLI in /opt/ai-tools (${toolStatus.updateCommand})`
                              : `Install ${entry.shortLabel} CLI into /opt/ai-tools (${toolStatus?.installCommand ?? ''})`
                          }
                        >
                          {isToolBusy ? (
                            <>
                              <LoaderCircle className="icon icon-spin" aria-hidden /> Working…
                            </>
                          ) : toolStatus?.installed ? (
                            <>
                              <RotateCw className="icon" aria-hidden /> Update CLI
                            </>
                          ) : (
                            <>
                              <Download className="icon" aria-hidden /> Install CLI
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          disabled={isToolBusy || updatingAllTools}
                          onClick={() =>
                            void handleToolchainAction(
                              providerId,
                              toolStatus?.installed ? 'update' : 'install',
                              true,
                            )
                          }
                          style={{ fontSize: '0.7rem' }}
                          title="Run CLI install/update inside an interactive terminal so you can watch live output"
                        >
                          <Terminal className="icon" aria-hidden /> Terminal
                        </button>
                        {toolStatus?.installed && (
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            disabled={isToolBusy || updatingAllTools}
                            onClick={() => void handleToolchainAction(providerId, 'uninstall', false)}
                            style={{ fontSize: '0.68rem', color: 'var(--bad)' }}
                            title={`Uninstall ${entry.shortLabel} CLI from /opt/ai-tools`}
                            aria-label={`Uninstall ${entry.shortLabel} CLI`}
                          >
                            <Trash2 className="icon" aria-hidden />
                          </button>
                        )}
                      </div>

                      {toolStatus?.lastError && (
                        <div
                          className="mono"
                          style={{
                            fontSize: '0.65rem',
                            color: 'var(--bad)',
                            background: 'color-mix(in srgb, var(--bad) 10%, transparent)',
                            padding: '4px 6px',
                            borderRadius: '4px',
                            maxHeight: 54,
                            overflow: 'auto',
                          }}
                        >
                          {toolStatus.lastError}
                        </div>
                      )}

                      {supportsOAuthLogin && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            disabled={launchingLoginProvider !== null || (providerId === 'antigravity' && !antigravityAck)}
                            onClick={() => void handleStartProviderLogin(providerId)}
                            style={{
                              borderColor: 'color-mix(in srgb, var(--info) 45%, transparent)',
                              color: 'var(--info)',
                              fontSize: '0.72rem',
                            }}
                            title="Opens an interactive browser terminal inside the runner container to authenticate via official CLI OAuth (auto-installs CLI if missing)"
                          >
                            {launchingLoginProvider === providerId ? (
                              <>
                                <LoaderCircle className="icon icon-spin" aria-hidden /> Opening Terminal…
                              </>
                            ) : isAuthReady && authStatus?.method === 'oauth_cli' ? (
                              <>
                                <RefreshCw className="icon" aria-hidden /> Re-Login CLI Account
                              </>
                            ) : (
                              <>
                                <KeyRound className="icon" aria-hidden /> CLI OAuth Login (Terminal)
                              </>
                            )}
                          </button>
                          {makeLoginCmd && (
                            <code
                              className="muted mono"
                              style={{ fontSize: '0.65rem' }}
                              title="Or run this command from your host terminal"
                            >
                              {makeLoginCmd}
                            </code>
                          )}
                        </div>
                      )}

                      {isEnabled && providerId === 'claude' && (
                        <label className="field" style={{ gap: 3, marginTop: 2 }}>
                          <span className="muted mono" style={{ fontSize: '0.67rem' }}>
                            Anthropic API Key (Optional Override · CLI OAuth used by default)
                          </span>
                          <input
                            type="password"
                            autoComplete="new-password"
                            className="input mono"
                            style={{ padding: '5px 8px', fontSize: '0.76rem' }}
                            placeholder={isKeyConfigured ? '•••••••••••••••• (Configured)' : 'sk-ant-...'}
                            value={anthropicApiKey}
                            onChange={(e) => setAnthropicApiKey(e.target.value)}
                          />
                        </label>
                      )}

                      {isEnabled && (providerId === 'gemini' || providerId === 'antigravity') && (
                        <label className="field" style={{ gap: 3, marginTop: 2 }}>
                          <span className="muted mono" style={{ fontSize: '0.67rem' }}>
                            {providerId === 'gemini' ? 'Google Gemini API Key (recommended)' : 'Google Gemini API Key (optional)'}
                          </span>
                          <input
                            type="password"
                            autoComplete="new-password"
                            className="input mono"
                            style={{ padding: '5px 8px', fontSize: '0.76rem' }}
                            placeholder={isKeyConfigured ? '•••••••••••••••• (Configured)' : 'AIzaSy...'}
                            value={geminiApiKey}
                            onChange={(e) => setGeminiApiKey(e.target.value)}
                          />
                        </label>
                      )}

                      {isEnabled && providerId === 'codex' && (
                        <label className="field" style={{ gap: 3, marginTop: 2 }}>
                          <span className="muted mono" style={{ fontSize: '0.67rem' }}>
                            OpenAI API Key (Optional Override · ChatGPT Account OAuth supported)
                          </span>
                          <input
                            type="password"
                            autoComplete="new-password"
                            className="input mono"
                            style={{ padding: '5px 8px', fontSize: '0.76rem' }}
                            placeholder={isKeyConfigured ? '•••••••••••••••• (Configured)' : 'sk-proj-...'}
                            value={openaiApiKey}
                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

          <SdkToolchainPanel sdks={toolchain?.sdks ?? []} onChanged={refreshToolchain} />

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

          {/* STEP 2: CAPABILITY-RANKED PERSONA ROUTING MATRIX */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <span className="eyebrow">Step 2 · Capability-Ranked Persona Matrix (★1–5 &amp; Low / Med / High)</span>
                <h3 style={{ margin: '4px 0 4px' }}>Specialist Persona Routing &amp; Model Rank Assignment</h3>
                <p className="muted small" style={{ maxWidth: 720, margin: 0 }}>
                  Each specialist role has a recommended capability rank (<code>★5 Frontier</code> for Architecture/PO, <code>★4 High</code> for Full-Stack/UI/Security, <code>★3 Medium</code> for Fast QA). Model choices are strictly scoped to the selected provider—switching a persona&apos;s provider automatically selects the matching rank model from that provider!
                </p>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => applyCapabilityPreset('auto-rank')}
                  title="Automatically match each persona to its optimal ★1-5 rank on its active provider"
                >
                  <Zap className="icon" aria-hidden /> Auto-Match by Persona Rank
                </button>
                {enabledProviders.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => applyCapabilityPreset('multi-provider')}
                    title="Distribute UI/UX, QA, and Architecture across your enabled providers"
                  >
                    <Globe className="icon" aria-hidden /> Multi-Provider Split
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => applyCapabilityPreset('all-high')}
                  title="Assign High / Frontier (★4-5) models across all personas"
                >
                  <Flame className="icon" aria-hidden /> All High (★4–5)
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => applyCapabilityPreset('all-medium')}
                  title="Assign Medium / Balanced (★3) models across all personas"
                >
                  <Scale className="icon" aria-hidden /> All Medium (★3)
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => applyCapabilityPreset('all-low')}
                  title="Assign Low / Fast (★1-2) models across all personas to save tokens"
                >
                  <Wallet className="icon" aria-hidden /> All Low / Fast (★1–2)
                </button>
              </div>
            </div>

            <div className="quota-policy">
              <label>
                New runs when their provider is out of quota
                <select
                  className="input"
                  value={quotaPolicy.newRuns}
                  onChange={(e) => setQuotaPolicy({ ...quotaPolicy, newRuns: e.target.value as QuotaPolicy['newRuns'] })}
                >
                  <option value="wait">Wait for the reset</option>
                  <option value="fallback">Start on the next route</option>
                </select>
              </label>
              <label>
                Runs in progress when their provider runs out
                <select
                  className="input"
                  value={quotaPolicy.inFlight}
                  onChange={(e) => setQuotaPolicy({ ...quotaPolicy, inFlight: e.target.value as QuotaPolicy['inFlight'] })}
                >
                  <option value="wait">Wait for the reset and continue</option>
                  <option value="fallback">Hand off to the next route</option>
                </select>
              </label>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              The factory works on one ticket per project at a time, so a ticket waiting for its provider&apos;s quota
              holds that project&apos;s queue. For factory projects, give the persona a fallback route and choose
              &ldquo;Start on the next route&rdquo; / &ldquo;Hand off to the next route&rdquo;.
            </p>

            {claudeUsage?.extraUsage && (
              <p className="muted small" style={{ margin: 0 }}>
                Claude extra usage:{' '}
                {claudeUsage.extraUsage.enabled
                  ? `on · $${claudeUsage.extraUsage.usedUsd.toFixed(2)} of $${claudeUsage.extraUsage.limitUsd.toFixed(2)} this month`
                  : `off${claudeUsage.extraUsage.disabledReason ? ` (${claudeUsage.extraUsage.disabledReason})` : ''}`}
                {' · '}
                <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
                  Change it on claude.ai → Settings → Usage
                </a>
                {claudeUsage.extraUsage.enabled &&
                  '. Claude keeps working past its subscription limit and bills extra usage; fallbacks after a Claude route only start when that runs out too.'}
              </p>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))',
                gap: '12px',
              }}
            >
              {PERSONA_LIST.map((meta) => {
                const personaKey = meta.id;
                const targetSpec = PERSONA_CAPABILITY_TARGETS[personaKey];
                const chain = personaRoutes?.[personaKey] ?? [];
                const firstRoute = chain[0];
                const selectedAgent: AgentId = firstRoute?.agent ?? enabledProviders[0] ?? 'claude';
                const providerEntry = PROVIDER_REGISTRY[selectedAgent];
                const selectedModel = firstRoute?.model ?? 'auto';
                const modelInfo = getModelInfoForProvider(selectedAgent, selectedModel);
                const activeTier: ModelCapabilityTier =
                  modelInfo?.tier ?? targetSpec.recommendedTier;
                const activeRank = modelInfo?.rank ?? targetSpec.recommendedRank;
                const tierStyle = TIER_COLORS[activeTier];

                return (
                  <div
                    key={personaKey}
                    style={{
                      padding: '14px',
                      borderRadius: '8px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '10px',
                    }}
                  >
                    {/* Header: Persona + Recommended Rank */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <strong>{meta.label}</strong>
                          <span className="badge mono" style={{ fontSize: '0.68rem' }}>
                            {meta.shortLabel}
                          </span>
                        </div>
                        <span
                          className="mono"
                          style={{
                            fontSize: '0.68rem',
                            padding: '2px 7px',
                            borderRadius: '999px',
                            background: tierStyle.bg,
                            border: `1px solid ${tierStyle.border}`,
                            color: tierStyle.text,
                            fontWeight: 600,
                          }}
                          title={`Recommended for ${meta.label}: ${targetSpec.summary}`}
                        >
                          {formatRankStars(activeRank)} · {activeTier.toUpperCase()}
                        </span>
                      </div>
                      <div className="muted small" style={{ fontSize: '0.72rem' }}>
                        {targetSpec.summary}
                      </div>
                    </div>

                    {/* Fallback chain: first route runs, the next ones take over when its quota runs out */}
                    <div className="field" style={{ gap: 4 }}>
                      <span className="muted mono" style={{ fontSize: '0.68rem' }}>
                        Provider chain (first route, then fallbacks)
                      </span>
                      {personaRoutes && (
                        <RouteChainEditor
                          persona={personaKey}
                          value={chain}
                          onChange={(next) => setPersonaRoutes({ ...personaRoutes, [personaKey]: next })}
                          enabledProviders={enabledProviders}
                          keyConfigured={{
                            claude: Boolean(settings?.anthropicKeyStored),
                            codex: Boolean(settings?.openaiKeyStored),
                            gemini: Boolean(settings?.geminiKeyStored),
                            aider: Boolean(
                              settings?.anthropicKeyStored ||
                                settings?.openaiKeyStored ||
                                settings?.geminiKeyStored,
                            ),
                          }}
                        />
                      )}
                    </div>

                    {/* Capability Tier Quick-Select Bar (Low / Medium / High) */}
                    <div className="field" style={{ gap: 4 }}>
                      <span
                        className="muted mono"
                        style={{
                          fontSize: '0.68rem',
                          display: 'flex',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>Capability Tier Quick-Match</span>
                        <span>Target: ★{targetSpec.recommendedRank}/5</span>
                      </span>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, 1fr)',
                          gap: '4px',
                        }}
                      >
                        {(['low', 'medium', 'high'] as const).map((tierKey) => {
                          const isCurrentTier = activeTier === tierKey && selectedModel !== 'auto';
                          const tMeta = TIER_COLORS[tierKey];
                          return (
                            <button
                              key={tierKey}
                              type="button"
                              onClick={() => handlePersonaTierQuickSelect(personaKey, tierKey)}
                              style={{
                                padding: '4px 6px',
                                fontSize: '0.68rem',
                                fontFamily: 'var(--font-mono)',
                                fontWeight: isCurrentTier ? 700 : 500,
                                borderRadius: '5px',
                                cursor: 'pointer',
                                background: isCurrentTier ? tMeta.bg : 'color-mix(in srgb, var(--text) 2%, transparent)',
                                border: isCurrentTier
                                  ? `1px solid ${tMeta.border}`
                                  : '1px solid var(--border)',
                                color: isCurrentTier ? tMeta.text : 'var(--text-muted)',
                                transition: 'all 0.12s ease',
                              }}
                              title={`Auto-select ${providerEntry.shortLabel}'s ${tierKey.toUpperCase()} tier model`}
                            >
                              {tierKey === 'low'
                                ? 'LOW ★1-2'
                                : tierKey === 'medium'
                                  ? 'MED ★3'
                                  : 'HIGH ★4-5'}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Selected Model Capability Tags & Description */}
                    {modelInfo && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '5px',
                          padding: '7px 9px',
                          borderRadius: '6px',
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {modelInfo.capabilities.map((cap) => {
                            const cMeta = CAPABILITY_TAG_META[cap];
                            const CapIcon = cMeta.icon;
                            return (
                              <span
                                key={cap}
                                className="mono"
                                style={{
                                  fontSize: '0.64rem',
                                  padding: '1px 5px',
                                  borderRadius: '4px',
                                  background: 'color-mix(in srgb, var(--text) 5%, transparent)',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                <CapIcon className="icon" aria-hidden /> {cMeta.label}
                              </span>
                            );
                          })}
                        </div>
                        <div className="muted small" style={{ fontSize: '0.69rem', lineHeight: 1.3 }}>
                          {modelInfo.description}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? (
                'Saving…'
              ) : (
                <>
                  <Save className="icon" aria-hidden /> Save Active Providers &amp; Capability Matrix
                </>
              )}
            </button>
          </div>
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
      {activeTab === 'notifications' && <NotificationsPanel />}
      {activeTab === 'updates' && <UpdatesPanel />}
      {activeTab === 'account' && <AccountPanel />}
    </div>
  );
}

