import {
  type AgentId,
  type CliToolStatus,
  type FactorySettings,
  PROVIDER_REGISTRY,
} from '@emberline/protocol';
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Download,
  KeyRound,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ProviderMark } from '../../ProviderMark';
import { ico } from '../../SectionState';
import { Switch } from '../../ui/Switch';
import {
  OAUTH_LOGIN_PROVIDERS,
  type ProviderSectionForm,
  providerStatus,
  type ProviderStatusKind,
} from '../settingsMeta';
import { ProviderRowDetails } from './ProviderRowDetails';
import './providers.css';

function statusIcon(kind: ProviderStatusKind) {
  switch (kind) {
    case 'installing':
      return ico(LoaderCircle, true);
    case 'error':
      return ico(CircleAlert);
    case 'off':
      return ico(CircleOff);
    case 'not_installed':
      return ico(Download);
    case 'not_signed_in':
      return ico(KeyRound);
    case 'ready':
      return ico(Check);
  }
}

export interface ProviderRowProps {
  providerId: AgentId;
  form: ProviderSectionForm;
  settings: FactorySettings;
  toolStatus: CliToolStatus | undefined;
  busyToolProvider: AgentId | null;
  updatingAllTools: boolean;
  launchingLoginProvider: AgentId | null;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  rowMessage?: string | null;
  onRowMessageChange?: (msg: string | null) => void;
  onToggleEnabled: () => void;
  onToolchainAction: (action: 'install' | 'update' | 'uninstall', spawnTerminal: boolean) => void;
  onStartLogin: () => void;
}

export function ProviderRow({
  providerId,
  form,
  settings,
  toolStatus,
  busyToolProvider,
  updatingAllTools,
  launchingLoginProvider,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  rowMessage,
  onRowMessageChange,
  onToggleEnabled,
  onToolchainAction,
  onStartLogin,
}: ProviderRowProps) {
  const { enabledProviders, antigravityAck, setAntigravityAck } = form;
  const isEnabled = enabledProviders.includes(providerId);
  const entry = PROVIDER_REGISTRY[providerId];
  const authStatus = settings.providerAuth?.[providerId];
  const isToolBusy = busyToolProvider === providerId || Boolean(toolStatus?.installing);
  const supportsOAuthLogin = OAUTH_LOGIN_PROVIDERS.includes(providerId);

  const isKeyConfigured =
    providerId === 'claude'
      ? Boolean(settings.anthropicKeyConfigured)
      : providerId === 'codex'
        ? Boolean(settings.openaiKeyConfigured)
        : providerId === 'aider'
          ? Boolean(
              settings.anthropicKeyConfigured || settings.openaiKeyConfigured || settings.geminiKeyConfigured,
            )
          : false;

  const isKeyStored =
    providerId === 'claude'
      ? Boolean(settings.anthropicKeyStored)
      : providerId === 'codex'
        ? Boolean(settings.openaiKeyStored)
        : providerId === 'aider'
          ? Boolean(settings.geminiKeyStored)
          : false;

  const isInstalled = toolStatus?.installed ?? authStatus?.cliInstalled ?? false;
  const isAuthReady = Boolean(authStatus?.authenticated || isKeyConfigured);

  const status = providerStatus({
    enabled: isEnabled,
    installing: isToolBusy,
    toolStatus,
    authStatus,
    keyConfigured: isKeyConfigured,
  });

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultExpanded);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [focusAckCount, setFocusAckCount] = useState(0);
  const ackCheckboxRef = useRef<HTMLInputElement | null>(null);
  const detailsId = useId();

  const isOpen = expanded !== undefined ? expanded : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (expanded === undefined) setUncontrolledOpen(next);
    onExpandedChange?.(next);
  };

  const activeMessage = rowMessage !== undefined ? rowMessage : localMessage;
  const setMessage = (next: string | null) => {
    if (rowMessage === undefined) setLocalMessage(next);
    onRowMessageChange?.(next);
  };

  useEffect(() => {
    if (focusAckCount > 0 && isOpen) {
      ackCheckboxRef.current?.focus();
    }
  }, [focusAckCount, isOpen]);

  const requireAntigravityAck = () => {
    setOpen(true);
    setMessage('Accept the Antigravity account risk before enabling it.');
    setFocusAckCount((c) => c + 1);
  };

  const handleToggleSwitch = () => {
    if (providerId === 'antigravity' && !antigravityAck && !isEnabled) {
      requireAntigravityAck();
      return;
    }
    if (isEnabled && enabledProviders.length <= 1) {
      setMessage('At least one AI provider must remain active.');
      return;
    }
    setMessage(null);
    onToggleEnabled();
  };

  const handleChangeAntigravityAck = (checked: boolean) => {
    setAntigravityAck(checked);
    if (checked) setMessage(null);
  };

  const handleNextStepSignIn = () => {
    if (providerId === 'antigravity' && !antigravityAck) {
      requireAntigravityAck();
      return;
    }
    onStartLogin();
  };

  const warningFirstLine = authStatus?.warning ? authStatus.warning.split(/\r?\n/)[0] : null;
  const errorFirstLine = !isOpen && toolStatus?.lastError ? toolStatus.lastError.split(/\r?\n/)[0] : null;

  const showInstallNextStep = isEnabled && !isInstalled && !isToolBusy;
  const showSignInNextStep = isEnabled && isInstalled && !isAuthReady && supportsOAuthLogin && !isToolBusy;

  return (
    <div className={`provider-row${isEnabled ? '' : ' provider-row-off'}`} data-provider-row={providerId}>
      <div className="provider-row-main">
        <div className="provider-row-identity">
          <ProviderMark id={entry.id} />
          <strong className="provider-row-name">{entry.label}</strong>
          {toolStatus?.installed && toolStatus.version && (
            <span className="provider-row-version mono muted">{toolStatus.version}</span>
          )}
          <span
            className={`badge mono provider-status provider-status-${status.kind}`}
            data-provider-status={status.kind}
          >
            {statusIcon(status.kind)}
            <span>{status.label}</span>
          </span>
          {isKeyStored && <span className="badge mono provider-marker-key">{ico(KeyRound)} Key stored</span>}
          {warningFirstLine && (
            <span className="provider-row-warning">
              {ico(TriangleAlert)} {warningFirstLine}
            </span>
          )}
          {errorFirstLine && <span className="provider-row-error-inline mono">{errorFirstLine}</span>}
        </div>

        <div className="provider-row-controls">
          {showInstallNextStep && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={isToolBusy || updatingAllTools}
              onClick={() => onToolchainAction('install', false)}
            >
              {ico(Download)} Install
            </button>
          )}
          {showSignInNextStep && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={launchingLoginProvider !== null}
              onClick={handleNextStepSignIn}
            >
              {launchingLoginProvider === providerId ? (
                <>{ico(LoaderCircle, true)} Opening…</>
              ) : (
                <>{ico(KeyRound)} Sign in</>
              )}
            </button>
          )}
          <Switch
            checked={isEnabled}
            ariaLabel={`Use ${entry.label}`}
            label={<span className="sr-only">Use {entry.label}</span>}
            onChange={handleToggleSwitch}
          />
          <button
            type="button"
            className="icon-btn provider-row-toggle"
            aria-expanded={isOpen}
            aria-controls={isOpen ? detailsId : undefined}
            aria-label={`${isOpen ? 'Hide' : 'Show'} ${entry.label} details`}
            onClick={() => setOpen(!isOpen)}
          >
            <ChevronRight
              className={`icon ui-disclosure-chevron${isOpen ? ' ui-disclosure-chevron-open' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {activeMessage && (
        <div className="provider-row-message" role="alert">
          {activeMessage}
        </div>
      )}

      {isOpen && (
        <ProviderRowDetails
          id={detailsId}
          providerId={providerId}
          form={form}
          settings={settings}
          toolStatus={toolStatus}
          isEnabled={isEnabled}
          isToolBusy={isToolBusy}
          updatingAllTools={updatingAllTools}
          launchingLoginProvider={launchingLoginProvider}
          ackCheckboxRef={ackCheckboxRef}
          onChangeAntigravityAck={handleChangeAntigravityAck}
          onToolchainAction={onToolchainAction}
          onStartLogin={onStartLogin}
        />
      )}
    </div>
  );
}
