import {
  type AgentId,
  type CliToolStatus,
  type FactorySettings,
  PROVIDER_REGISTRY,
} from '@emberline/protocol';
import {
  Check,
  Copy,
  Download,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { type RefObject, useState } from 'react';
import { api, errorMessage } from '../../../api';
import { ico } from '../../SectionState';
import { ProviderModels } from '../ProviderModels';
import { OAUTH_LOGIN_PROVIDERS, type ProviderSectionForm } from '../settingsMeta';

export const MAKE_LOGIN_CMD: Partial<Record<AgentId, string>> = {
  antigravity: 'make agy-login',
  claude: 'make claude-login',
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
    <label className="field provider-key-field">
      <span className="muted mono provider-key-label">{label}</span>
      <input
        type="password"
        autoComplete="new-password"
        className="input mono provider-key-input"
        placeholder={configured ? '•••••••••••••••• (Configured)' : placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export interface ProviderRowDetailsProps {
  id: string;
  providerId: AgentId;
  form: ProviderSectionForm;
  settings: FactorySettings;
  toolStatus: CliToolStatus | undefined;
  isEnabled: boolean;
  isToolBusy: boolean;
  updatingAllTools: boolean;
  launchingLoginProvider: AgentId | null;
  ackCheckboxRef?: RefObject<HTMLInputElement | null>;
  onChangeAntigravityAck: (checked: boolean) => void;
  onToolchainAction: (action: 'install' | 'update' | 'uninstall', spawnTerminal: boolean) => void;
  onStartLogin: () => void;
}

export function ProviderRowDetails({
  id,
  providerId,
  form,
  settings,
  toolStatus,
  isEnabled,
  isToolBusy,
  updatingAllTools,
  launchingLoginProvider,
  ackCheckboxRef,
  onChangeAntigravityAck,
  onToolchainAction,
  onStartLogin,
}: ProviderRowDetailsProps) {
  const { antigravityAck, apiKeys, patchApiKeys } = form;
  const entry = PROVIDER_REGISTRY[providerId];
  const authStatus = settings.providerAuth?.[providerId];
  const supportsOAuthLogin = OAUTH_LOGIN_PROVIDERS.includes(providerId);
  const isKeyConfigured =
    providerId === 'claude'
      ? Boolean(settings.anthropicKeyConfigured)
      : providerId === 'codex'
        ? Boolean(settings.openaiKeyConfigured)
        : false;
  const isAuthReady = Boolean(authStatus?.authenticated || isKeyConfigured);
  const makeLoginCmd = MAKE_LOGIN_CMD[providerId];

  const [removingKey, setRemovingKey] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const removeGeminiKey = async () => {
    setRemovingKey(true);
    try {
      form.setSettings(await api<FactorySettings>('/api/factory/settings', 'PATCH', { geminiApiKey: null }));
      patchApiKeys({ gemini: '' });
      form.setNotice('Gemini API key removed.');
    } catch (err) {
      form.setError(errorMessage(err));
    } finally {
      setRemovingKey(false);
    }
  };

  const handleCopyMakeCmd = () => {
    if (!makeLoginCmd) return;
    void navigator.clipboard?.writeText(makeLoginCmd);
    setCopiedCmd(true);
  };

  const showApiKeySection =
    providerId === 'claude' ||
    providerId === 'codex' ||
    (providerId === 'aider' && (isEnabled || Boolean(settings.geminiKeyStored)));

  return (
    <div id={id} className="provider-details">
      <section className="provider-detail-group" aria-label={`About ${entry.label}`}>
        <h4 className="provider-detail-heading">About</h4>
        <p className="muted provider-detail-desc">{entry.description}</p>
        <div className="provider-terms-line">
          <span className="muted">Terms:</span>
          <span
            className={`badge ${
              entry.terms.risk === 'low'
                ? 'badge-ok'
                : entry.terms.risk === 'medium'
                  ? 'badge-warn'
                  : 'badge-bad'
            }`}
          >
            {entry.terms.risk} risk
          </span>
          <span className="muted">
            {entry.terms.summary} · checked {entry.terms.checked} ·
          </span>
          <a href={entry.terms.url} target="_blank" rel="noreferrer">
            terms
          </a>
        </div>
      </section>

      {supportsOAuthLogin && (
        <section className="provider-detail-group" aria-label={`${entry.label} sign-in`}>
          <h4 className="provider-detail-heading">Sign-in</h4>
          {providerId === 'antigravity' && (
            <label className="provider-terms-note small">
              <input
                ref={ackCheckboxRef}
                type="checkbox"
                checked={antigravityAck}
                onChange={(e) => onChangeAntigravityAck(e.target.checked)}
              />
              <span>
                Google does not support using an Antigravity consumer login (Google AI Pro/Ultra) inside
                third-party tools such as Emberline and has suspended accounts for it. I accept this risk for
                my account.
              </span>
            </label>
          )}
          <div className="provider-signin-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={launchingLoginProvider !== null || (providerId === 'antigravity' && !antigravityAck)}
              onClick={onStartLogin}
            >
              {launchingLoginProvider === providerId ? (
                <>{ico(LoaderCircle, true)} Opening terminal…</>
              ) : isAuthReady && authStatus?.method === 'oauth_cli' ? (
                <>{ico(RefreshCw)} Sign in again</>
              ) : (
                <>{ico(KeyRound)} Sign in</>
              )}
            </button>
            {makeLoginCmd && (
              <span className="provider-cmd-pill">
                <code className="mono">{makeLoginCmd}</code>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={handleCopyMakeCmd}
                  aria-label={`Copy ${makeLoginCmd}`}
                >
                  {copiedCmd ? ico(Check) : ico(Copy)} {copiedCmd ? 'Copied' : 'Copy command'}
                </button>
              </span>
            )}
          </div>
        </section>
      )}

      {showApiKeySection && (
        <section className="provider-detail-group" aria-label={`${entry.label} API key`}>
          <h4 className="provider-detail-heading">API key</h4>
          {providerId === 'claude' && (
            <ApiKeyField
              label="Anthropic API Key (Optional Override · CLI OAuth used by default)"
              configured={isKeyConfigured}
              placeholder="sk-ant-..."
              value={apiKeys.anthropic}
              onChange={(anthropic) => patchApiKeys({ anthropic })}
            />
          )}
          {providerId === 'codex' && (
            <ApiKeyField
              label="OpenAI API Key (Optional Override · ChatGPT Account OAuth supported)"
              configured={isKeyConfigured}
              placeholder="sk-proj-..."
              value={apiKeys.openai}
              onChange={(openai) => patchApiKeys({ openai })}
            />
          )}
          {providerId === 'aider' && (isEnabled || Boolean(settings.geminiKeyStored)) && (
            <>
              <ApiKeyField
                label="Google Gemini API Key (Optional · for Aider's Gemini models)"
                configured={Boolean(settings.geminiKeyConfigured)}
                placeholder="AIzaSy..."
                value={apiKeys.gemini}
                onChange={(gemini) => patchApiKeys({ gemini })}
              />
              {settings.geminiKeyStored && (
                <div className="provider-key-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    disabled={removingKey}
                    onClick={() => void removeGeminiKey()}
                  >
                    {ico(Trash2)} Remove key
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section className="provider-detail-group" aria-label={`${entry.label} CLI`}>
        <h4 className="provider-detail-heading">CLI</h4>
        <div className="provider-cli-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={isToolBusy || updatingAllTools}
            onClick={() => onToolchainAction(toolStatus?.installed ? 'update' : 'install', false)}
          >
            {isToolBusy ? (
              <>{ico(LoaderCircle, true)} Working…</>
            ) : toolStatus?.installed ? (
              <>{ico(RotateCw)} Update</>
            ) : (
              <>{ico(Download)} Install</>
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={isToolBusy || updatingAllTools}
            onClick={() => onToolchainAction(toolStatus?.installed ? 'update' : 'install', true)}
          >
            {ico(Terminal)} Run in terminal
          </button>
          {toolStatus?.installed && (
            <button
              type="button"
              className="btn btn-sm btn-ghost danger"
              disabled={isToolBusy || updatingAllTools}
              onClick={() => onToolchainAction('uninstall', false)}
            >
              {ico(Trash2)} Uninstall
            </button>
          )}
        </div>
        {toolStatus?.lastError && (
          <pre className="provider-cli-error mono" role="alert">
            {toolStatus.lastError}
          </pre>
        )}
        {(toolStatus?.binaryPath || toolStatus?.installCommand) && (
          <div className="provider-cli-meta mono muted">
            {toolStatus?.binaryPath && (
              <div>
                Binary: <code>{toolStatus.binaryPath}</code>
              </div>
            )}
            {toolStatus?.installCommand && (
              <div>
                Install command: <code>{toolStatus.installCommand}</code>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="provider-detail-group" aria-label={`${entry.label} models`}>
        <h4 className="provider-detail-heading">Models</h4>
        <ProviderModels providerId={providerId} />
      </section>
    </div>
  );
}
