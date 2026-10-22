import {
  FORGE_DEFAULT_SERVER_URL,
  FORGE_SCOPE_HINTS,
  type ForgeAccount,
  type ForgeAccountsResponse,
  type ForgeProvider,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import {
  accountHost,
  accountUserLine,
  createAccountBody,
  isPlainHttpServer,
  PROVIDER_LABEL,
  serverAfterProviderChange,
} from '../forgeAccounts';
import { useApi } from '../hooks/useApi';

const PROVIDERS: ForgeProvider[] = ['github', 'gitlab', 'gitea'];

/** Settings → Forge & Webhooks → Forge accounts: one account per server; tokens are write-only. */
export function ForgeAccountsPanel() {
  const list = useApi<ForgeAccountsResponse>('/api/forge/accounts', 60_000);
  const [provider, setProvider] = useState<ForgeProvider>('github');
  const [serverUrl, setServerUrl] = useState(FORGE_DEFAULT_SERVER_URL.github);
  const [token, setToken] = useState('');
  const [allowHttp, setAllowHttp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // Links from errors and Project settings land here (FORGE_ACCOUNTS_HREF): wouter does not scroll to a hash.
  useEffect(() => {
    if (window.location.hash === '#forge-accounts') panelRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await list.refresh();
      setNotice(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const built = createAccountBody({ provider, serverUrl, token, allowHttp });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    void run(
      'add',
      async () => {
        await api<ForgeAccount>('/api/forge/accounts', 'POST', built.body);
        setToken('');
        setAllowHttp(false);
      },
      'Account added.',
    );
  };

  const chooseProvider = (next: ForgeProvider) => {
    setServerUrl((current) => serverAfterProviderChange(provider, next, current));
    setProvider(next);
  };

  return (
    <section className="panel" id="forge-accounts" ref={panelRef} aria-labelledby="forge-accounts-title">
      <header className="panel-head">
        <div>
          <h2 id="forge-accounts-title">Forge accounts</h2>
          <p className="muted">One account per server. Emberline sends a token only to its own server.</p>
        </div>
      </header>
      {list.data?.legacyTokenUnmatched && (
        <p className="banner banner-warn">
          Your earlier forge token could not be matched to one server. Add it again as an account.{' '}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy !== null}
            onClick={() =>
              void run(
                'legacy',
                () => api('/api/forge/legacy-token', 'DELETE'),
                'The earlier token was removed.',
              )
            }
          >
            Forget it
          </button>
        </p>
      )}
      {list.data && list.data.accounts.length === 0 && <p className="muted">No forge accounts yet.</p>}
      <ul className="forge-account-list">
        {list.data?.accounts.map((a) => (
          <li key={a.id} className="forge-account-row">
            <div>
              <span className="badge badge-soft">{PROVIDER_LABEL[a.provider]}</span>{' '}
              <span className="mono">{accountHost(a)}</span>
              <p className="muted small">{accountUserLine(a)}</p>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    `check-${a.id}`,
                    () => api(`/api/forge/accounts/${a.id}/check`, 'POST'),
                    `${accountHost(a)}: the token works.`,
                  )
                }
              >
                {busy === `check-${a.id}` ? 'Checking…' : 'Check'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy !== null || a.source === 'environment'}
                title={a.source === 'environment' ? 'Set by EMBERLINE_FORGE_TOKEN' : undefined}
                onClick={() => {
                  if (!window.confirm(`Remove the account for ${accountHost(a)}?`)) return;
                  void run(
                    `remove-${a.id}`,
                    () => api(`/api/forge/accounts/${a.id}`, 'DELETE'),
                    'Account removed.',
                  );
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={add}>
        <h3>Add account</h3>
        <div className="segmented" role="radiogroup" aria-label="Forge">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={provider === p}
              className={provider === p ? 'active' : ''}
              onClick={() => chooseProvider(p)}
            >
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="form-row">
          <input
            type="url"
            className="input"
            aria-label="Server URL"
            placeholder="https://gitea.example.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
          <input
            type="password"
            autoComplete="new-password"
            className="input"
            aria-label="Token"
            placeholder="Token (kept in core only)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <p className="muted small">{FORGE_SCOPE_HINTS[provider]}</p>
        {isPlainHttpServer(serverUrl) && (
          <label className="review-checkbox-label">
            <input type="checkbox" checked={allowHttp} onChange={(e) => setAllowHttp(e.target.checked)} />
            Send the token to this server over plain http:// (unencrypted)
          </label>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy !== null}>
            {busy === 'add' ? 'Checking…' : 'Add account'}
          </button>
        </div>
        {notice && (
          <p className="muted small" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
