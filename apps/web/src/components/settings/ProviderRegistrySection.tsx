import type { AgentId, FactorySettings, ToolchainStatusResponse } from '@emberline/protocol';
import { Cpu, Folder, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import { SdkToolchainPanel } from '../SdkToolchainPanel';
import { ProviderRegistryCard } from './ProviderRegistryCard';
import { ALL_PROVIDER_IDS } from './providerRoutingHelpers';

export interface ProviderRegistrySectionProps {
  enabledProviders: AgentId[];
  settings: FactorySettings | null;
  toolchain: ToolchainStatusResponse | null;
  busyToolProvider: AgentId | null;
  updatingAllTools: boolean;
  launchingLoginProvider: AgentId | null;
  antigravityAck: boolean;
  setAntigravityAck: (value: boolean) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (value: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (value: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (value: string) => void;
  onToggleEnabled: (providerId: AgentId) => void;
  onToolchainAction: (
    providerId: AgentId,
    action: 'install' | 'update' | 'uninstall',
    spawnTerminal?: boolean,
  ) => void;
  onUpdateAllTools: () => void;
  onRefreshToolchain: () => Promise<void>;
  onStartLogin: (providerId: AgentId) => void;
}

export function ProviderRegistrySection({
  enabledProviders,
  settings,
  toolchain,
  busyToolProvider,
  updatingAllTools,
  launchingLoginProvider,
  antigravityAck,
  setAntigravityAck,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  openaiApiKey,
  setOpenaiApiKey,
  onToggleEnabled,
  onToolchainAction,
  onUpdateAllTools,
  onRefreshToolchain,
  onStartLogin,
}: ProviderRegistrySectionProps) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
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
                <Cpu className="icon" aria-hidden /> {toolchain.osInfo} · Node {toolchain.nodeVersion} ·{' '}
                <Folder className="icon" aria-hidden /> {toolchain.toolsDir}
              </span>
            )}
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={updatingAllTools || busyToolProvider !== null}
              onClick={onUpdateAllTools}
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
              onClick={() => void onRefreshToolchain()}
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
          {ALL_PROVIDER_IDS.map((providerId) => (
            <ProviderRegistryCard
              key={providerId}
              providerId={providerId}
              isEnabled={enabledProviders.includes(providerId)}
              settings={settings}
              toolStatus={toolchain?.tools.find((t) => t.provider === providerId)}
              busyToolProvider={busyToolProvider}
              updatingAllTools={updatingAllTools}
              launchingLoginProvider={launchingLoginProvider}
              antigravityAck={antigravityAck}
              setAntigravityAck={setAntigravityAck}
              anthropicApiKey={anthropicApiKey}
              setAnthropicApiKey={setAnthropicApiKey}
              geminiApiKey={geminiApiKey}
              setGeminiApiKey={setGeminiApiKey}
              openaiApiKey={openaiApiKey}
              setOpenaiApiKey={setOpenaiApiKey}
              onToggleEnabled={onToggleEnabled}
              onToolchainAction={onToolchainAction}
              onStartLogin={onStartLogin}
            />
          ))}
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />

      <SdkToolchainPanel sdks={toolchain?.sdks ?? []} onChanged={onRefreshToolchain} />

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
    </>
  );
}
