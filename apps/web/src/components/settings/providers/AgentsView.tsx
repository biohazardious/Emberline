import type { AgentId, FactorySettings, ToolchainStatusResponse } from '@emberline/protocol';
import { LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../../api';
import { ico } from '../../SectionState';
import { HelpHint } from '../../ui/HelpHint';
import { ALL_PROVIDER_IDS, type ProviderSectionForm } from '../settingsMeta';
import { ProviderRow } from './ProviderRow';
import './providers.css';

export interface AgentsViewProps {
  form: ProviderSectionForm;
  settings: FactorySettings;
  toolchain: ToolchainStatusResponse | undefined;
  toolchainError: unknown;
  busyToolProvider: AgentId | null;
  updatingAllTools: boolean;
  launchingLoginProvider: AgentId | null;
  onRefreshToolchain: () => Promise<void> | void;
  onUpdateAllTools: () => Promise<void> | void;
  onToggleProviderEnabled: (providerId: AgentId) => void;
  onToolchainAction: (
    providerId: AgentId,
    action: 'install' | 'update' | 'uninstall',
    spawnTerminal: boolean,
  ) => void;
  onStartLogin: (providerId: AgentId) => void;
}

export function AgentsView({
  form,
  settings,
  toolchain,
  toolchainError,
  busyToolProvider,
  updatingAllTools,
  launchingLoginProvider,
  onRefreshToolchain,
  onUpdateAllTools,
  onToggleProviderEnabled,
  onToolchainAction,
  onStartLogin,
}: AgentsViewProps) {
  const { enabledProviders } = form;
  const [expandedProviders, setExpandedProviders] = useState<Set<AgentId>>(() => new Set());
  const [rowMessages, setRowMessages] = useState<Partial<Record<AgentId, string | null>>>({});

  const setProviderExpanded = (providerId: AgentId, open: boolean) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (open) next.add(providerId);
      else next.delete(providerId);
      return next;
    });
  };

  const setProviderMessage = (providerId: AgentId, msg: string | null) => {
    setRowMessages((prev) => ({ ...prev, [providerId]: msg }));
  };

  const handleToggleEnabled = (providerId: AgentId) => {
    setRowMessages({});
    onToggleProviderEnabled(providerId);
  };

  return (
    <section className="providers-view" aria-labelledby="providers-agents-heading">
      <header className="providers-view-head">
        <div className="providers-view-title-group">
          <h3 id="providers-agents-heading" className="providers-view-title">
            Agents
          </h3>
          <span className="muted mono providers-view-count">
            {enabledProviders.length} of {ALL_PROVIDER_IDS.length} on
          </span>
          <HelpHint topic="the runner">
            <div className="providers-hint-body">
              {toolchain && (
                <p className="mono">
                  {toolchain.osInfo} · Node {toolchain.nodeVersion} · {toolchain.toolsDir}
                </p>
              )}
              <p>
                All agent CLIs are installed and updated inside the persistent{' '}
                <code>{toolchain?.toolsDir ?? '/opt/ai-tools'}</code> volume so container rebuilds keep your
                tools.
              </p>
            </div>
          </HelpHint>
        </div>

        <div className="providers-view-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={updatingAllTools || busyToolProvider !== null}
            onClick={() => void onUpdateAllTools()}
          >
            {updatingAllTools ? <>{ico(LoaderCircle, true)} Updating…</> : <>{ico(RotateCw)} Update all</>}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh"
            onClick={() => void onRefreshToolchain()}
          >
            {ico(RefreshCw)}
            <span className="sr-only">Refresh</span>
          </button>
        </div>
      </header>

      {toolchainError !== undefined && !toolchain && (
        <p className="form-error" role="alert">
          Could not load CLI toolchain status: {errorMessage(toolchainError)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void onRefreshToolchain()}>
            Retry
          </button>
        </p>
      )}

      <div className="provider-list" role="list" aria-label="Agent providers">
        {ALL_PROVIDER_IDS.map((providerId) => (
          <div key={providerId} role="listitem">
            <ProviderRow
              providerId={providerId}
              form={form}
              settings={settings}
              toolStatus={toolchain?.tools.find((t) => t.provider === providerId)}
              busyToolProvider={busyToolProvider}
              updatingAllTools={updatingAllTools}
              launchingLoginProvider={launchingLoginProvider}
              expanded={expandedProviders.has(providerId)}
              onExpandedChange={(open) => setProviderExpanded(providerId, open)}
              rowMessage={rowMessages[providerId] ?? null}
              onRowMessageChange={(msg) => setProviderMessage(providerId, msg)}
              onToggleEnabled={() => handleToggleEnabled(providerId)}
              onToolchainAction={(action, spawnTerminal) =>
                onToolchainAction(providerId, action, spawnTerminal)
              }
              onStartLogin={() => onStartLogin(providerId)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
