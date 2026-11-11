import type { SshKeyResponse, TrustedHostKey, TrustedHostKeysResponse } from '@emberline/protocol';
import { useIsFetching } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { anchorScrollDue } from '../containerPreviewSetup';
import { asSentence, type Feedback, feedbackFor } from '../forgeAccounts';
import { useApi } from '../hooks/useApi';
import { createdText, hostLabel, SHARED_KEY_HINT } from '../sshKeys';
import { SshKeyLine } from './SshKeyLine';

const NEW_KEY_QUESTION =
  'Make a new shared key? The current key stops working at once: remove its public key from GitHub, GitLab or your server and add the new one.';
const DELETE_QUESTION =
  'Delete the shared key? Projects that use it cannot reach their ssh repositories until you create a key. Also remove its public key from GitHub, GitLab or your server.';

/** Settings → SSH key: Emberline's shared key (the private half stays in core) and the host keys a person trusted. */
export function SshKeyPanel() {
  const shared = useApi<SshKeyResponse>('/api/ssh-key', 60_000);
  const hosts = useApi<TrustedHostKeysResponse>('/api/ssh-host-keys', 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const key = shared.data?.key ?? null;

  // Links from errors land on the trusted hosts (TRUSTED_HOSTS_HREF): wouter does not scroll to a hash.
  const hostsRef = useRef<HTMLElement>(null);
  const fetching = useIsFetching();
  const scrolled = useRef(false);
  useEffect(() => {
    if (
      !anchorScrollDue({
        scrolled: scrolled.current,
        shown: hosts.data !== undefined,
        fetching,
        hash: window.location.hash,
        anchor: 'trusted-host-keys',
      })
    )
      return;
    scrolled.current = true;
    hostsRef.current?.scrollIntoView({ block: 'start' });
  }, [fetching, hosts.data]);

  const run = async (scope: string, fn: () => Promise<unknown>, done: string, after: () => Promise<void>) => {
    setBusy(scope);
    setFeedback(null);
    try {
      await fn();
      setFeedback({ scope, ok: true, text: done });
    } catch (err) {
      setFeedback({ scope, ok: false, text: asSentence(errorMessage(err)) });
    } finally {
      await after();
      setBusy(null);
    }
  };

  const generate = (replacing: boolean) => {
    if (replacing && !window.confirm(NEW_KEY_QUESTION)) return;
    void run(
      'key',
      () => api<SshKeyResponse>('/api/ssh-key', 'POST'),
      replacing
        ? 'New key made. Remove the old public key from your forge or server and add this one.'
        : 'Key made. Add its public key where your repositories are.',
      shared.refresh,
    );
  };

  const remove = () => {
    if (!window.confirm(DELETE_QUESTION)) return;
    void run('key', () => api('/api/ssh-key', 'DELETE'), 'The shared key was deleted.', shared.refresh);
  };

  const removeHost = (h: TrustedHostKey) => {
    if (
      !window.confirm(
        `Remove the trusted host key of ${hostLabel(h)}? Emberline then shows its fingerprint again and asks before it connects.`,
      )
    )
      return;
    void run(
      'hosts',
      () => api('/api/ssh-host-keys', 'DELETE', { host: h.host, port: h.port, keyType: h.keyType }),
      `${hostLabel(h)}: host key removed.`,
      hosts.refresh,
    );
  };

  // Both regions are always in the page, so a screen reader announces a result put into one.
  const show = (scope: string) => {
    const mine = feedbackFor(feedback, scope);
    return (
      <>
        <p className="form-error" role="alert">
          {mine.alert}
        </p>
        <p className="muted small" role="status">
          {mine.status}
        </p>
      </>
    );
  };

  return (
    <section className="panel ssh-key-panel" id="ssh-key" aria-labelledby="ssh-key-title">
      <header className="panel-head">
        <div>
          <h2 id="ssh-key-title">SSH key</h2>
          <p className="muted">
            Emberline reaches ssh repositories (such as{' '}
            <span className="mono">git@github.com:you/app.git</span>) with its own key. The private key stays
            in Emberline&apos;s core: agents never see it.
          </p>
        </div>
      </header>
      {shared.error !== undefined && !shared.data && (
        <p className="form-error" role="alert">
          Could not load the SSH key: {errorMessage(shared.error)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void shared.refresh()}>
            Retry
          </button>
        </p>
      )}
      {shared.data && !key && (
        <div className="ssh-key-empty">
          <p>Emberline has no SSH key yet.</p>
          <p className="muted small">
            Projects that use the shared key cannot reach an ssh repository until you create one.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null}
              onClick={() => generate(false)}
            >
              {busy === 'key' ? 'Creating…' : 'Create a key'}
            </button>
          </div>
        </div>
      )}
      {key && (
        <div className="ssh-key-shown">
          <p>
            <strong>Emberline SSH key</strong>{' '}
            <span className="muted small">
              {key.algorithm} · created {createdText(key.createdAt)}
            </span>
          </p>
          <p className="muted small">
            Fingerprint <span className="mono">{key.fingerprint}</span>
          </p>
          <SshKeyLine publicKey={key.publicKey}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy !== null}
              onClick={() => generate(true)}
            >
              {busy === 'key' ? 'Working…' : 'New key'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={remove}>
              Delete
            </button>
          </SshKeyLine>
          <p className="muted small">{SHARED_KEY_HINT}</p>
        </div>
      )}
      {show('key')}

      <section
        className="ssh-host-keys"
        id="trusted-host-keys"
        ref={hostsRef}
        aria-labelledby="ssh-hosts-title"
      >
        <h3 id="ssh-hosts-title">Trusted host keys</h3>
        <p className="muted small">
          Servers whose host key you trusted after comparing its fingerprint. GitHub, GitLab and Bitbucket are
          known to Emberline already. When a server&apos;s key changes, Emberline refuses to connect until you
          remove the old key here.
        </p>
        {hosts.error !== undefined && !hosts.data && (
          <p className="form-error" role="alert">
            Could not load the trusted host keys: {errorMessage(hosts.error)}{' '}
            <button type="button" className="btn btn-sm" onClick={() => void hosts.refresh()}>
              Retry
            </button>
          </p>
        )}
        {hosts.data && hosts.data.hosts.length === 0 && <p className="muted">No trusted host keys.</p>}
        <ul className="forge-account-list">
          {hosts.data?.hosts.map((h) => (
            <li key={`${h.host}:${h.port}:${h.keyType}`} className="forge-account-row">
              <div>
                <span className="mono">{hostLabel(h)}</span>{' '}
                <span className="badge badge-soft">{h.keyType}</span>
                <p className="muted small">
                  <span className="mono">{h.fingerprint}</span> · trusted {createdText(h.trustedAt)}
                </p>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy !== null}
                  onClick={() => removeHost(h)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        {show('hosts')}
      </section>
    </section>
  );
}
