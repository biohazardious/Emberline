import {
  type AgentId,
  coerceModelForProvider,
  type FactorySettings,
  PROVIDER_REGISTRY,
  type ProviderLoginResponse,
  type ToolchainActionResponse,
  type ToolchainStatusResponse,
} from '@emberline/protocol';
import { Cpu, Folder, LoaderCircle, RefreshCw, RotateCw, Save } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../../api';
import { useClaudeUsage, useToolchainStatus } from '../../hooks/useSettingsQueries';
import { PERSONA_LIST } from '../PersonaBadge';
import { SdkToolchainPanel } from '../SdkToolchainPanel';
import { ico, SectionState } from '../SectionState';
import { PersonaRoutingSection } from './PersonaRoutingSection';
import { ProviderCard } from './ProviderCard';
import {
  ALL_PROVIDER_IDS,
  defaultRoute,
  type ProviderSectionForm,
  ST_HEAD_SPLIT,
  ST_HR,
  ST_PANEL_FORM,
  ST_PANEL_PAD,
  ST_SAVE_ROW,
} from './settingsMeta';

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
    saving,
    onSave,
    setNotice,
    setError,
  } = form;
  const [, setLocation] = useLocation();
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
        style={ST_PANEL_PAD}
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
    <form onSubmit={onSave} className="panel" style={ST_PANEL_FORM}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={ST_HEAD_SPLIT}>
          <div>
            <span className="eyebrow">
              Step 1 · Provider Registry, Persistent CLI Volume &amp; Credentials
            </span>
            <h3 style={{ margin: '4px 0 4px' }}>Active AI Providers ({enabledProviders.length} Enabled)</h3>
            <p className="muted small" style={{ maxWidth: 760, margin: 0 }}>
              Runner image is generic and CLI-agnostic. All AI CLIs are dynamically installed and updated
              inside the persistent <code>{toolchain?.toolsDir ?? '/opt/ai-tools'}</code> volume so container
              rebuilds never lose your tools.
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
                {ico(Cpu)} {toolchain.osInfo} · Node {toolchain.nodeVersion} · {ico(Folder)}{' '}
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
                <>{ico(LoaderCircle, true)} Updating All CLIs…</>
              ) : (
                <>{ico(RotateCw)} Update All Active CLIs</>
              )}
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => void toolchainQuery.refresh()}
              title="Refresh CLI installation & version status"
            >
              {ico(RefreshCw)} Refresh
            </button>
          </div>
        </div>

        {toolchainQuery.error !== undefined && !toolchain && (
          <p className="form-error" role="alert">
            Could not load CLI toolchain status: {errorMessage(toolchainQuery.error)}{' '}
            <button type="button" className="btn btn-xs" onClick={() => void toolchainQuery.refresh()}>
              Retry
            </button>
          </p>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(295px, 100%), 1fr))',
            gap: '10px',
          }}
        >
          {ALL_PROVIDER_IDS.map((providerId) => (
            <ProviderCard
              key={providerId}
              providerId={providerId}
              form={form}
              settings={settings}
              toolStatus={toolchain?.tools.find((t) => t.provider === providerId)}
              busyToolProvider={busyToolProvider}
              updatingAllTools={updatingAllTools}
              launchingLoginProvider={launchingLoginProvider}
              onToggleEnabled={() => toggleProviderEnabled(providerId)}
              onToolchainAction={(action, spawnTerminal) =>
                void handleToolchainAction(providerId, action, spawnTerminal)
              }
              onStartLogin={() => void handleStartProviderLogin(providerId)}
            />
          ))}
        </div>
      </div>

      <hr style={ST_HR} />

      <SdkToolchainPanel sdks={toolchain?.sdks ?? []} onChanged={toolchainQuery.refresh} />

      <hr style={ST_HR} />

      <PersonaRoutingSection form={form} claudeUsage={claudeUsage} />

      <div style={ST_SAVE_ROW}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : <>{ico(Save)} Save Active Providers &amp; Capability Matrix</>}
        </button>
      </div>
    </form>
  );
}
