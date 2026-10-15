import type { SdkActionResponse, SdkId, SdkStatus } from '@emberline/protocol';
import {
  CircuitBoard,
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

const SDK_ICONS: Record<SdkId, typeof CircuitBoard> = {
  platformio: CircuitBoard,
  android: Smartphone,
  flutter: Smartphone,
  'esp-qemu': CircuitBoard,
};

/**
 * SDKs for desktop, mobile and embedded projects. Installs run as runner terminals (they download
 * gigabytes), so every action opens its terminal; the cards follow the status while it runs.
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <span className="eyebrow">Project SDKs · Desktop, Mobile &amp; Embedded</span>
        <h3 style={{ margin: '4px 0 4px' }}>SDKs for Non-Web Projects</h3>
        <p className="muted small" style={{ maxWidth: 760, margin: 0 }}>
          Installed into the persistent tools volume at pinned versions and already on the agents&apos;{' '}
          <code>PATH</code> (<code>JAVA_HOME</code> and <code>ANDROID_HOME</code> included). Agents can also
          install them with <code>emberline-sdk install &lt;id&gt;</code>.
        </p>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
          gap: '10px',
        }}
      >
        {sdks.map((sdk) => {
          const Icon = SDK_ICONS[sdk.id];
          const disabled = busy !== null || anyInstalling;
          return (
            <div
              key={sdk.id}
              className="panel"
              style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
              >
                <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Icon className="icon" aria-hidden /> {sdk.label}
                </strong>
                <span
                  className="badge mono"
                  style={{ fontSize: '0.68rem', color: sdk.installed ? 'var(--ok)' : 'var(--muted)' }}
                  title={sdk.version ?? undefined}
                >
                  {sdk.installing ? 'Working…' : sdk.installed ? 'Installed' : 'Not installed'}
                </span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                {sdk.description}
              </p>
              <p className="muted small mono" style={{ margin: 0, fontSize: '0.7rem' }}>
                <code>{sdk.id}</code> · {sdk.sizeHint}
              </p>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: 'auto' }}>
                {sdk.installing && sdk.terminalId ? (
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setLocation(`/terminals/${sdk.terminalId}`)}
                  >
                    <SquareTerminal className="icon" aria-hidden /> Show progress
                  </button>
                ) : sdk.installed ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      disabled={disabled}
                      onClick={() => void run(sdk.id, 'update')}
                    >
                      <RotateCw className="icon" aria-hidden /> Reinstall
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      disabled={disabled}
                      onClick={() => void run(sdk.id, 'uninstall')}
                    >
                      <Trash2 className="icon" aria-hidden /> Uninstall
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    disabled={disabled}
                    onClick={() => void run(sdk.id, 'install')}
                  >
                    {busy === sdk.id ? (
                      <LoaderCircle className="icon icon-spin" aria-hidden />
                    ) : (
                      <Download className="icon" aria-hidden />
                    )}{' '}
                    Install
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
