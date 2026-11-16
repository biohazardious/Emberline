import type { SdkActionResponse, SdkId, SdkStatus } from '@emberline/protocol';
import {
  Check,
  CircuitBoard,
  CircleOff,
  Download,
  LoaderCircle,
  RotateCw,
  Smartphone,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage } from '../api';
import { ico } from './SectionState';
import './settings/providers/providers.css';
import { Disclosure } from './ui/Disclosure';
import { HelpHint } from './ui/HelpHint';

const SDK_ICONS: Record<SdkId, typeof CircuitBoard> = {
  platformio: CircuitBoard,
  android: Smartphone,
  flutter: Smartphone,
  'esp-qemu': CircuitBoard,
};

/**
 * SDKs for desktop, mobile and embedded projects. Installs run as runner terminals (they download
 * gigabytes), so every action opens its terminal; the rows follow the status while it runs.
 */
export function SdkToolchainPanel({
  sdks,
  onChanged,
}: {
  sdks: SdkStatus[];
  onChanged: () => Promise<void> | void;
}) {
  const [, setLocation] = useLocation();
  const [busy, setBusy] = useState<SdkId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anyInstalling = sdks.some((sdk) => sdk.installing);

  const run = async (id: SdkId, action: 'install' | 'update' | 'uninstall') => {
    setBusy(id);
    setError(null);
    try {
      const res = await api<SdkActionResponse>(`/api/toolchain/sdk/${id}/action`, 'POST', { action });
      await onChanged();
      setLocation(`/terminals/${res.terminal.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sdk-panel" aria-labelledby="providers-sdks-heading">
      <header className="providers-view-head">
        <div className="providers-view-title-group">
          <h3 id="providers-sdks-heading" className="providers-view-title">
            Project SDKs
          </h3>
          <HelpHint topic="project SDKs">
            <div className="providers-hint-body">
              <p>
                Installed into the persistent tools volume at pinned versions and already on the agents&apos;{' '}
                <code>PATH</code> (<code>JAVA_HOME</code> and <code>ANDROID_HOME</code> included).
              </p>
              <p>
                Agents can also install them from a run with <code>emberline-sdk install &lt;id&gt;</code>.
              </p>
            </div>
          </HelpHint>
        </div>
        <p className="muted providers-view-summary">
          Optional toolchains for desktop, mobile and embedded projects.
        </p>
      </header>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {sdks.length === 0 ? (
        <p className="muted small">No project SDKs registered.</p>
      ) : (
        <div className="sdk-list" role="list" aria-label="Project SDKs">
          {sdks.map((sdk) => {
            const Icon = SDK_ICONS[sdk.id];
            const disabled = busy !== null || anyInstalling;
            const statusClass = sdk.installing
              ? 'sdk-status-installing'
              : sdk.installed
                ? 'sdk-status-installed'
                : 'sdk-status-not_installed';
            return (
              <div key={sdk.id} className="sdk-row" role="listitem" data-sdk-row={sdk.id}>
                <div className="sdk-row-main">
                  <div className="sdk-row-identity">
                    <strong className="sdk-row-title">
                      <Icon className="icon" aria-hidden="true" /> {sdk.label}
                    </strong>
                    {sdk.installed && sdk.version && (
                      <span className="mono muted sdk-row-meta">{sdk.version}</span>
                    )}
                    <span className="mono muted sdk-row-meta">{sdk.sizeHint}</span>
                    <span className={`badge mono provider-status ${statusClass}`}>
                      {sdk.installing ? ico(LoaderCircle, true) : sdk.installed ? ico(Check) : ico(CircleOff)}
                      <span>
                        {sdk.installing ? 'Working…' : sdk.installed ? 'Installed' : 'Not installed'}
                      </span>
                    </span>
                  </div>

                  <div className="sdk-row-actions">
                    {sdk.installing && sdk.terminalId ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setLocation(`/terminals/${sdk.terminalId}`)}
                      >
                        <SquareTerminal className="icon" aria-hidden="true" /> Show progress
                      </button>
                    ) : sdk.installed ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={disabled}
                        onClick={() => void run(sdk.id, 'update')}
                      >
                        <RotateCw className="icon" aria-hidden="true" /> Reinstall
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={disabled}
                        onClick={() => void run(sdk.id, 'install')}
                      >
                        {busy === sdk.id ? (
                          <LoaderCircle className="icon icon-spin" aria-hidden="true" />
                        ) : (
                          <Download className="icon" aria-hidden="true" />
                        )}{' '}
                        Install
                      </button>
                    )}
                  </div>
                </div>

                <Disclosure label="Details">
                  <div className="sdk-details-body">
                    <p className="muted">{sdk.description}</p>
                    <p className="mono muted">
                      <code>{sdk.id}</code> · {sdk.sizeHint}
                      {sdk.version ? ` · v${sdk.version}` : ''} · <code>emberline-sdk install {sdk.id}</code>
                    </p>
                    {sdk.installed && !sdk.installing && (
                      <div>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost danger"
                          disabled={disabled}
                          onClick={() => void run(sdk.id, 'uninstall')}
                        >
                          <Trash2 className="icon" aria-hidden="true" /> Uninstall
                        </button>
                      </div>
                    )}
                  </div>
                </Disclosure>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
