import {
  type AgentId,
  type CliToolStatus,
  type FactorySettings,
  PROVIDER_REGISTRY,
} from '@emberline/protocol';
import {
  Download,
  KeyRound,
  LoaderCircle,
  Package,
  RefreshCw,
  RotateCw,
  Terminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { ProviderMark } from '../ProviderMark';
import { OAUTH_LOGIN_PROVIDERS, TIER_COLORS } from './providerRoutingHelpers';

export interface ProviderRegistryCardProps {
  providerId: AgentId;
  isEnabled: boolean;
  settings: FactorySettings | null;
  toolStatus?: CliToolStatus;
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
  onStartLogin: (providerId: AgentId) => void;
}

export function ProviderRegistryCard({
  providerId,
  isEnabled,
  settings,
  toolStatus,
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
  onStartLogin,
}: ProviderRegistryCardProps) {
  const entry = PROVIDER_REGISTRY[providerId];
  const authStatus = settings?.providerAuth?.[providerId];
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <ProviderMark id={entry.id} />
            <strong style={{ fontSize: '0.9rem' }}>{entry.label}</strong>
          </div>
          <button
            type="button"
            className={`btn btn-xs ${isEnabled ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onToggleEnabled(providerId)}
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
              third-party tools such as Emberline and has suspended accounts for it. I accept this risk for my
              account.
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
              color: isToolBusy ? 'var(--info)' : toolStatus?.installed ? 'var(--ok)' : 'var(--warn)',
            }}
            title={
              toolStatus?.binaryPath
                ? `Binary: ${toolStatus.binaryPath}\nInstall cmd: ${toolStatus.installCommand}`
                : `Install cmd: ${toolStatus?.installCommand ?? ''}`
            }
          >
            {isToolBusy ? (
              <>
                <LoaderCircle className="icon icon-spin" aria-hidden /> Installing{' '}
                {toolStatus?.binaryName ?? providerId}…
              </>
            ) : toolStatus?.installed ? (
              <>
                <Package className="icon" aria-hidden /> {toolStatus.binaryName} (
                {toolStatus.version ?? 'installed'})
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={isToolBusy || updatingAllTools}
            onClick={() => onToolchainAction(providerId, toolStatus?.installed ? 'update' : 'install', false)}
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
            onClick={() => onToolchainAction(providerId, toolStatus?.installed ? 'update' : 'install', true)}
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
              onClick={() => onToolchainAction(providerId, 'uninstall', false)}
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              disabled={launchingLoginProvider !== null || (providerId === 'antigravity' && !antigravityAck)}
              onClick={() => onStartLogin(providerId)}
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
              {providerId === 'gemini'
                ? 'Google Gemini API Key (recommended)'
                : 'Google Gemini API Key (optional)'}
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
}
