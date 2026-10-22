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
  asSentence,
  createAccountBody,
  isPlainHttpServer,
  PROVIDER_LABEL,
  replaceTokenBody,
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
  // Where the last result shows: on the row it belongs to ('legacy' and 'add' for the banner and the form).
  const [feedback, setFeedback] = useState<{ scope: string; ok: boolean; text: string } | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [newToken, setNewToken] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  // Links from errors and Project settings land here (FORGE_ACCOUNTS_HREF): wouter does not scroll to a hash.
  useEffect(() => {
    if (window.location.hash === '#forge-accounts') panelRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  const run = async (
    scope: string,
    key: string,
    fn: () => Promise<unknown>,
    done: string,
  ): Promise<boolean> => {
    setBusy(key);
    setFeedback(null);
    try {
      await fn();
      await list.refresh();
      setFeedback({ scope, ok: true, text: done });
      return true;
    } catch (err) {
      setFeedback({ scope, ok: false, text: asSentence(errorMessage(err)) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const show = (scope: string) => {
    if (feedback?.scope !== scope) return null;
    return feedback.ok ? (
      <p className="muted small" role="status">
        {feedback.text}
      </p>
    ) : (
      <p className="form-error" role="alert">
        {feedback.text}
      </p>
    );
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const built = createAccountBody({ provider, serverUrl, token, allowHttp });
    if ('error' in built) {
      setFeedback({ scope: 'add', ok: false, text: built.error });
      return;
    }
    // The token never outlives the submit, whatever the outcome.
    setToken('');
    const ok = await run(
      'add',
      'add',
      () => api<ForgeAccount>('/api/forge/accounts', 'POST', built.body),
      'Account added.',
    );
    if (ok) setAllowHttp(false);
  };

  const saveToken = async (a: ForgeAccount) => {
    const built = replaceTokenBody(newToken);
    if ('error' in built) {
      setFeedback({ scope: a.id, ok: false, text: built.error });
      return;
    }
    setNewToken('');
    const ok = await run(
      a.id,
      `token-${a.id}`,
      () => api<ForgeAccount>(`/api/forge/accounts/${a.id}`, 'PATCH', built.body),
      `${accountHost(a)}: the new token works.`,
    );
    if (ok) setReplacing(null);
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
      {list.error !== undefined && !list.data && (
        <p className="form-error" role="alert">
          Could not load forge accounts: {errorMessage(list.error)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void list.refresh()}>
            Retry
          </button>
        </p>
      )}
      {list.data?.legacyTokenUnmatched && (
        <div className="banner banner-warn">
          <p>
            Your earlier forge token could not be matched to one server. Add it again as an account.{' '}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'legacy',
                  'legacy',
                  () => api('/api/forge/legacy-token', 'DELETE'),
                  'The earlier token was removed.',
                )
              }
            >
              Forget it
            </button>
          </p>
          {show('legacy')}
        </div>
      )}
      {!list.data?.legacyTokenUnmatched && show('legacy')}
      {list.data && list.data.accounts.length === 0 && <p className="muted">No forge accounts yet.</p>}
      <ul className="forge-account-list">
        {list.data?.accounts.map((a) => {
          const fromEnv = a.source === 'environment';
          return (
            <li key={a.id} className="forge-account-row">
              <div>
                <span className="badge badge-soft">{PROVIDER_LABEL[a.provider]}</span>{' '}
                <span className="mono">{accountHost(a)}</span>
                <p className="muted small">{accountUserLine(a)}</p>
                {fromEnv && (
                  <p className="muted small">From environment (EMBERLINE_FORGE_TOKEN): change it there.</p>
                )}
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      a.id,
                      `check-${a.id}`,
                      () => api(`/api/forge/accounts/${a.id}/check`, 'POST'),
                      `${accountHost(a)}: the token works.`,
                    )
                  }
                >
                  {busy === `check-${a.id}` ? 'Checking…' : 'Check'}
                </button>
                {!fromEnv && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy !== null}
                      aria-expanded={replacing === a.id}
                      onClick={() => {
                        setNewToken('');
                        setReplacing(replacing === a.id ? null : a.id);
                      }}
                    >
                      Replace token
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(`Remove the account for ${accountHost(a)}?`)) return;
                        void run(
                          a.id,
                          `remove-${a.id}`,
                          () => api(`/api/forge/accounts/${a.id}`, 'DELETE'),
                          'Account removed.',
                        );
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              {replacing === a.id && !fromEnv && (
                <form
                  className="forge-account-token"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveToken(a);
                  }}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="input"
                    aria-label={`New token for ${accountHost(a)}`}
                    placeholder="New token"
                    value={newToken}
                    onChange={(e) => setNewToken(e.target.value)}
                  />
                  <button type="submit" className="btn btn-sm btn-primary" disabled={busy !== null}>
                    {busy === `token-${a.id}` ? 'Checking…' : 'Save'}
                  </button>
                </form>
              )}
              <div className="forge-account-feedback">{show(a.id)}</div>
            </li>
          );
        })}
      </ul>
      <form className="form" onSubmit={(e) => void add(e)}>
        <h3 id="forge-add-title">Add account</h3>
        <div className="segmented segmented-radios" role="radiogroup" aria-labelledby="forge-add-title">
          {PROVIDERS.map((p) => (
            <label key={p} className={provider === p ? 'active' : ''}>
              <input
                type="radio"
                name="forge-provider"
                value={p}
                checked={provider === p}
                onChange={() => chooseProvider(p)}
              />
              <span>{PROVIDER_LABEL[p]}</span>
            </label>
          ))}
        </div>
        <div className="form-row">
          <label className="field">
            Server URL
            <input
              type="text"
              inputMode="url"
              className="input"
              placeholder="https://gitea.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </label>
          <label className="field">
            Token
            <input
              type="password"
              autoComplete="new-password"
              className="input"
              placeholder="Kept in core only"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
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
        {show('add')}
      </form>
    </section>
  );
}
