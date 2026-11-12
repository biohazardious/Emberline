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
import { ico } from '../SectionState';
import {
  OAUTH_LOGIN_PROVIDERS,
  type ProviderSectionForm,
  ST_COL_6,
  ST_DESC_73,
  ST_ROW_BETWEEN,
  ST_ROW_WRAP6,
  TIER_COLORS,
} from './settingsMeta';

const MAKE_LOGIN_CMD: Partial<Record<AgentId, string>> = {
  antigravity: 'make agy-login',
  claude: 'make claude-login',
  gemini: 'make gemini-login',
  codex: 'make codex-login',
  copilot: 'make copilot-login',
};

function ApiKeyField({
  label,
  configured,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  configured: boolean;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="field" style={{ gap: 3, marginTop: 2 }}>
      <span className="muted mono" style={{ fontSize: '0.67rem' }}>
        {label}
      </span>
      <input
        type="password"
        autoComplete="new-password"
        className="input mono"
        style={{ padding: '5px 8px', fontSize: '0.76rem' }}
        placeholder={configured ? '•••••••••••••••• (Configured)' : placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ProviderCard({
  providerId,
  form,
  settings,
  toolStatus,
  busyToolProvider,
  updatingAllTools,
  launchingLoginProvider,
  onToggleEnabled,
  onToolchainAction,
  onStartLogin,
}: {
  providerId: AgentId;
  form: ProviderSectionForm;
  settings: FactorySettings;
  toolStatus: CliToolStatus | undefined;
  busyToolProvider: AgentId | null;
  updatingAllTools: boolean;
  launchingLoginProvider: AgentId | null;
  onToggleEnabled: () => void;
  onToolchainAction: (action: 'install' | 'update' | 'uninstall', spawnTerminal: boolean) => void;
  onStartLogin: () => void;
}) {
  const { enabledProviders, antigravityAck, setAntigravityAck, apiKeys, patchApiKeys } = form;
  const isEnabled = enabledProviders.includes(providerId);
  const entry = PROVIDER_REGISTRY[providerId];
  const authStatus = settings.providerAuth?.[providerId];
  const isToolBusy = busyToolProvider === providerId || Boolean(toolStatus?.installing);
  const supportsOAuthLogin = OAUTH_LOGIN_PROVIDERS.includes(providerId);
  const isKeyConfigured =
    providerId === 'claude'
      ? Boolean(settings.anthropicKeyConfigured)
      : providerId === 'gemini' || providerId === 'antigravity'
        ? Boolean(settings.geminiKeyConfigured)
        : providerId === 'codex'
          ? Boolean(settings.openaiKeyConfigured)
          : false;
  const isAuthReady = Boolean(authStatus?.authenticated || isKeyConfigured);
  const makeLoginCmd = MAKE_LOGIN_CMD[providerId];

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
      <div style={ST_COL_6}>
        <div style={ST_ROW_BETWEEN}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <ProviderMark id={entry.id} />
            <strong style={{ fontSize: '0.9rem' }}>{entry.label}</strong>
          </div>
          <button
            type="button"
            className={`btn btn-xs ${isEnabled ? 'btn-primary' : 'btn-ghost'}`}
            onClick={onToggleEnabled}
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

        <div style={ST_ROW_WRAP6}>
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
                {ico(LoaderCircle, true)} Installing {toolStatus?.binaryName ?? providerId}…
              </>
            ) : toolStatus?.installed ? (
              <>
                {ico(Package)} {toolStatus.binaryName} ({toolStatus.version ?? 'installed'})
              </>
            ) : (
              <>{ico(TriangleAlert)} CLI Not Installed</>
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

        <div className="muted small" style={ST_DESC_73}>
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
        <div style={ST_ROW_WRAP6}>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={isToolBusy || updatingAllTools}
            onClick={() => onToolchainAction(toolStatus?.installed ? 'update' : 'install', false)}
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
              <>{ico(LoaderCircle, true)} Working…</>
            ) : toolStatus?.installed ? (
              <>{ico(RotateCw)} Update CLI</>
            ) : (
              <>{ico(Download)} Install CLI</>
            )}
          </button>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={isToolBusy || updatingAllTools}
            onClick={() => onToolchainAction(toolStatus?.installed ? 'update' : 'install', true)}
            style={{ fontSize: '0.7rem' }}
            title="Run CLI install/update inside an interactive terminal so you can watch live output"
          >
            {ico(Terminal)} Terminal
          </button>
          {toolStatus?.installed && (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              disabled={isToolBusy || updatingAllTools}
              onClick={() => onToolchainAction('uninstall', false)}
              style={{ fontSize: '0.68rem', color: 'var(--bad)' }}
              title={`Uninstall ${entry.shortLabel} CLI from /opt/ai-tools`}
              aria-label={`Uninstall ${entry.shortLabel} CLI`}
            >
              {ico(Trash2)}
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
          <div style={{ ...ST_ROW_BETWEEN, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              disabled={launchingLoginProvider !== null || (providerId === 'antigravity' && !antigravityAck)}
              onClick={onStartLogin}
              style={{
                borderColor: 'color-mix(in srgb, var(--info) 45%, transparent)',
                color: 'var(--info)',
                fontSize: '0.72rem',
              }}
              title="Opens an interactive browser terminal inside the runner container to authenticate via official CLI OAuth (auto-installs CLI if missing)"
            >
              {launchingLoginProvider === providerId ? (
                <>{ico(LoaderCircle, true)} Opening Terminal…</>
              ) : isAuthReady && authStatus?.method === 'oauth_cli' ? (
                <>{ico(RefreshCw)} Re-Login CLI Account</>
              ) : (
                <>{ico(KeyRound)} CLI OAuth Login (Terminal)</>
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
          <ApiKeyField
            label="Anthropic API Key (Optional Override · CLI OAuth used by default)"
            configured={isKeyConfigured}
            placeholder="sk-ant-..."
            value={apiKeys.anthropic}
            onChange={(anthropic) => patchApiKeys({ anthropic })}
          />
        )}

        {isEnabled && (providerId === 'gemini' || providerId === 'antigravity') && (
          <ApiKeyField
            label={
              providerId === 'gemini'
                ? 'Google Gemini API Key (recommended)'
                : 'Google Gemini API Key (optional)'
            }
            configured={isKeyConfigured}
            placeholder="AIzaSy..."
            value={apiKeys.gemini}
            onChange={(gemini) => patchApiKeys({ gemini })}
          />
        )}

        {isEnabled && providerId === 'codex' && (
          <ApiKeyField
            label="OpenAI API Key (Optional Override · ChatGPT Account OAuth supported)"
            configured={isKeyConfigured}
            placeholder="sk-proj-..."
            value={apiKeys.openai}
            onChange={(openai) => patchApiKeys({ openai })}
          />
        )}
      </div>
    </div>
  );
}
