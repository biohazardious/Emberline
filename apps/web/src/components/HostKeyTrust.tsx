import type { HostKeyDetails } from '@emberline/protocol';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { hostLabel, TRUSTED_HOSTS_HREF } from '../sshKeys';

/**
 * "Trust this host key?" for a server Emberline does not know (`host_key_unknown`): the fingerprint
 * to compare with what the server's admin publishes, and Trust. Never offered for a changed key.
 */
export function HostKeyTrust({
  hostKey,
  onTrusted,
  trustLabel = 'Trust this host key',
  disabled = false,
}: {
  hostKey: HostKeyDetails;
  /** The key is stored; e.g. run the clone or the operation again. */
  onTrusted: () => void | Promise<void>;
  trustLabel?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/ssh-host-keys', 'POST', {
        host: hostKey.host,
        port: hostKey.port,
        keyType: hostKey.keyType,
        key: hostKey.key,
        fingerprint: hostKey.fingerprint,
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    await onTrusted();
  };
  return (
    <div className="host-key-trust banner banner-warn">
      <p>
        <strong>
          Trust this host key (<span className="mono">{hostKey.fingerprint}</span>)?
        </strong>
      </p>
      <p className="small">
        Emberline has not connected to <span className="mono">{hostLabel(hostKey)}</span> before. It offers a{' '}
        <span className="mono">{hostKey.keyType}</span> key. Compare it with the fingerprint the server&apos;s
        admin publishes (on your own server: <span className="mono">ssh-keygen -lf</span> on its host key
        file), and trust it only if they match.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || disabled}
          onClick={() => void trust()}
        >
          {busy ? 'Trusting…' : trustLabel}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A server whose host key differs from the one Emberline knows (`host_key_changed`): what it may
 * mean and where the old key is removed. No way to trust it from here. The offered key may be absent.
 */
export function HostKeyChangedNote({
  hostKey,
  newTab = false,
}: {
  hostKey: HostKeyDetails | null | undefined;
  /** Open Settings in a new tab (from the wizard, which must stay open). */
  newTab?: boolean;
}) {
  const where = 'Settings → SSH key → Trusted host keys';
  return (
    <div className="banner banner-error host-key-changed">
      <p>
        <strong>
          The server&apos;s host key is not the one Emberline knows
          {hostKey ? (
            <>
              {' '}
              for <span className="mono">{hostLabel(hostKey)}</span>
            </>
          ) : null}
          .
        </strong>
      </p>
      {hostKey && (
        <p className="small">
          It now offers <span className="mono">{hostKey.fingerprint}</span> ({hostKey.keyType}).
        </p>
      )}
      <p className="small">
        Someone may be between Emberline and the server, or the server&apos;s key was replaced. Ask the
        server&apos;s admin. If the key really changed, remove the old one in{' '}
        {newTab ? (
          <a href={TRUSTED_HOSTS_HREF} target="_blank" rel="noreferrer">
            {where}
          </a>
        ) : (
          <Link href={TRUSTED_HOSTS_HREF}>{where}</Link>
        )}{' '}
        and try again. For GitHub, GitLab and Bitbucket Emberline uses its own list: update Emberline when
        they announce a new key.
      </p>
    </div>
  );
}
