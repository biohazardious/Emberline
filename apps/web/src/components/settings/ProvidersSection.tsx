import {
  type AgentId,
  coerceModelForProvider,
  type FactorySettings,
  PROVIDER_REGISTRY,
  type ProviderLoginResponse,
  type ToolchainActionResponse,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../../api';
import { useQueryParam } from '../../hooks/navigation';
import { useClaudeUsage, useToolchainStatus } from '../../hooks/useSettingsQueries';
import { PERSONA_LIST } from '../PersonaBadge';
import { SdkToolchainPanel } from '../SdkToolchainPanel';
import { SectionState } from '../SectionState';
import { SaveBar } from '../ui/SaveBar';
import { AgentsView } from './providers/AgentsView';
import './providers/providers.css';
import { RoutingView } from './providers/RoutingView';
import { defaultRoute, PROVIDER_VIEWS, type ProviderSectionForm, type ProviderView } from './settingsMeta';

const PROVIDER_VIEW_ITEMS: ReadonlyArray<{ id: ProviderView; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'routing', label: 'Routing' },
  { id: 'sdks', label: 'SDKs' },
];

export function ProvidersSection({
  form,
  loading,
  loadError,
  onRetry,
}: {
  form: ProviderSectionForm;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => Promise<void>;
}) {
  const {
    settings,
    setSettings,
    defaultAgent,
    setDefaultAgent,
    enabledProviders,
    setEnabledProviders,
    antigravityAck,
    setPersonaRoutes,
    dirty,
    onDiscard,
    saving,
    onSave,
    setNotice,
    setError,
  } = form;
  const [, setLocation] = useLocation();
  const [viewParam, setViewParam] = useQueryParam('view');
  const activeView: ProviderView = PROVIDER_VIEWS.includes(viewParam as ProviderView)
    ? (viewParam as ProviderView)
    : 'agents';
  const setActiveView = (next: ProviderView) => setViewParam(next === 'agents' ? null : next);

  const toolchainQuery = useToolchainStatus(true);
  const toolchain = toolchainQuery.data;
  const claudeUsage = useClaudeUsage(30_000).data;

  const [busyToolProvider, setBusyToolProvider] = useState<AgentId | null>(null);
  const [updatingAllTools, setUpdatingAllTools] = useState(false);
  const [launchingLoginProvider, setLaunchingLoginProvider] = useState<AgentId | null>(null);

  if (!settings) {
    return (
      <SectionState
        loading={Boolean(loading || toolchainQuery.loading)}
        error={loadError}
        onRetry={onRetry}
        loadingText="Loading AI providers & model routing matrix…"
        emptyText="No AI provider settings available yet."
        errorPrefix="Could not load provider settings"
      />
    );
  }

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
      await toolchainQuery.refresh();
      if (res.terminal) {
        setLocation(`/terminals/${res.terminal.id}`);
        return;
      }
      setNotice(
        `${PROVIDER_REGISTRY[providerId].label} CLI ${action} completed${res.tool.version ? ` (${res.tool.version})` : ''}.`,
      );
    } catch (err) {
      setError(errorMessage(err));
      await toolchainQuery.refresh();
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
      toolchainQuery.setData(res.status);
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
      if (providerId === 'antigravity' && !settings.antigravityTermsAcknowledged) {
        setSettings(
          await api<FactorySettings>('/api/factory/settings', 'PATCH', {
            antigravityTermsAcknowledged: true,
          }),
        );
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
      return;
    }
    setEnabledProviders((prev) => {
      const exists = prev.includes(providerId);
      if (exists && prev.length <= 1) {
        return prev;
      }
      const next = exists ? prev.filter((p) => p !== providerId) : [...prev, providerId];
      const fallbackAgent: AgentId = next.includes(defaultAgent) ? defaultAgent : (next[0] ?? 'claude');
      if (!next.includes(defaultAgent)) setDefaultAgent(fallbackAgent);
      if (exists) {
        setPersonaRoutes((routes) => {
          if (!routes) return routes;
          const updated = { ...routes };
          for (const p of PERSONA_LIST) {
            const kept = routes[p.id].filter((r) => r.agent !== providerId);
            updated[p.id] = kept.length
              ? kept
              : [
                  defaultRoute(
                    fallbackAgent,
                    coerceModelForProvider(fallbackAgent, routes[p.id][0]?.model ?? 'opus', p.id),
                  ),
                ];
          }
          return updated;
        });
      }
      return next;
    });
  };

  return (
    <form onSubmit={onSave} className="panel providers-section">
      <div className="providers-top-bar">
        <div className="segmented providers-view-switch" role="group" aria-label="Providers view">
          {PROVIDER_VIEW_ITEMS.map(({ id, label }) => {
            const active = activeView === id;
            return (
              <button
                key={id}
                id={`providers-view-${id}`}
                type="button"
                aria-pressed={active}
                className={active ? 'active' : ''}
                onClick={() => setActiveView(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {activeView === 'agents' && (
        <AgentsView
          form={form}
          settings={settings}
          toolchain={toolchain}
          toolchainError={toolchainQuery.error}
          busyToolProvider={busyToolProvider}
          updatingAllTools={updatingAllTools}
          launchingLoginProvider={launchingLoginProvider}
          onRefreshToolchain={toolchainQuery.refresh}
          onUpdateAllTools={handleUpdateAllTools}
          onToggleProviderEnabled={toggleProviderEnabled}
          onToolchainAction={(providerId, action, spawnTerminal) =>
            void handleToolchainAction(providerId, action, spawnTerminal)
          }
          onStartLogin={(providerId) => void handleStartProviderLogin(providerId)}
        />
      )}

      {activeView === 'routing' && <RoutingView form={form} claudeUsage={claudeUsage} />}

      {activeView === 'sdks' && (
        <SdkToolchainPanel sdks={toolchain?.sdks ?? []} onChanged={toolchainQuery.refresh} />
      )}

      <SaveBar dirty={dirty} saving={saving} onDiscard={onDiscard} />
    </form>
  );
}
