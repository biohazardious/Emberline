import type {
  ForgeAccountsResponse,
  ForgeOwner,
  ForgeOwnersResponse,
  Project,
  RepositoryStatus,
} from '@emberline/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { FORGE_ACCOUNTS_HREF, PROVIDER_LABEL, accountHost } from '../forgeAccounts';
import { useApi } from '../hooks/useApi';
import {
  accountText,
  connectPrefill,
  createRepoEnabled,
  lastPushText,
  mainStateText,
  mainTipText,
  ownerAfterLoad,
  originCredentialsText,
  pushMainBlocked,
  repoErrorForm,
  replaceOriginQuestion,
} from '../repository';

/** Project settings → Repository: origin, the account used, main against origin, and the person's push. */
export function RepositoryPanel({ project }: { project: Project }) {
  const base = `/api/projects/${project.id}/repository`;
  const status = useApi<RepositoryStatus>(base, 120_000);
  const accounts = useApi<ForgeAccountsResponse>('/api/forge/accounts', 120_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ form: 'connect' | 'create' | 'actions'; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [accountId, setAccountId] = useState('');
  // The owners belong to the account they were read for; a changed account never shows another's.
  const [ownersOf, setOwnersOf] = useState<{ accountId: string; owners: ForgeOwner[] } | null>(null);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(project.slug);
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState('');
  const s = status.data;
  const owners = ownersOf?.accountId === accountId ? ownersOf.owners : [];

  useEffect(() => {
    if (!accountId && accounts.data?.accounts[0]) setAccountId(accounts.data.accounts[0].id);
  }, [accountId, accounts.data]);
  const offeredOrigin = s ? connectPrefill(s) : null;
  useEffect(() => {
    // An origin set outside Emberline (or its clean URL, when it holds a token): offer it in
    // Connect, which is what lets Emberline use it with the forge account.
    if (offeredOrigin) setUrl((current) => current || offeredOrigin);
  }, [offeredOrigin]);
  useEffect(() => {
    // Owners are read from the forge, so only once the person opens Create.
    if (!createOpen || !accountId) return;
    let live = true;
    setOwnersError(null);
    void api<ForgeOwnersResponse>(`/api/forge/accounts/${accountId}/owners`)
      .then((res) => {
        if (!live) return;
        setOwnersOf({ accountId, owners: res.owners });
        setOwner((current) => ownerAfterLoad(current, res.owners));
      })
      .catch((err: unknown) => {
        if (live) setOwnersError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [accountId, createOpen]);

  /** Runs a mutation; on origin_exists asks once and resends with replace. */
  const act = async (key: string, send: (replace: boolean) => Promise<RepositoryStatus>) => {
    setBusy(key);
    setError(null);
    try {
      try {
        await send(false);
      } catch (err) {
        const question = replaceOriginQuestion(err);
        if (!question) throw err;
        if (!window.confirm(question)) return; // cancelled: nothing changed, nothing to report
        await send(true);
      }
    } catch (err) {
      setError({ form: repoErrorForm(key), text: errorMessage(err) });
    } finally {
      // The status shows what happened (also after a failed push), so always re-read it.
      await status.refresh();
      setBusy(null);
    }
  };

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void act('connect', (replace) =>
      api<RepositoryStatus>(`${base}/connect`, 'POST', { url: url.trim(), replace }),
    );
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act('create', (replace) =>
      api<RepositoryStatus>(`${base}/create`, 'POST', {
        accountId,
        owner,
        name: name.trim(),
        private: isPrivate,
        description: description.trim() || undefined,
        replace,
      }),
    );
  };

  const account = s ? accountText(s) : null;
  const blocked = s ? pushMainBlocked(s) : 'Loading…';
  const lastPush = s ? lastPushText(s) : null;
  const credentials = s ? originCredentialsText(s) : null;
  const tip = s ? mainTipText(s) : null;

  return (
    <section className="repo-block" aria-labelledby="repository-title">
      <h3 id="repository-title">Repository</h3>
      {status.error !== undefined && !s && (
        <p className="banner banner-error" role="alert">
          {errorMessage(status.error)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void status.refresh()}>
            Retry
          </button>
        </p>
      )}
      {s && (
        <dl className="repo-status">
          <dt>Origin</dt>
          <dd className="mono">{s.originUrl ?? 'No remote yet'}</dd>
          {account && (
            <>
              <dt>Account</dt>
              <dd>
                {account.text}
                {account.addAccount && (
                  <>
                    {' · '}
                    <Link href={FORGE_ACCOUNTS_HREF}>Add one in Settings</Link>
                  </>
                )}
              </dd>
            </>
          )}
          <dt>Main</dt>
          <dd>
            {s.isGitRepo && <span className="mono">{s.defaultBranch}</span>} {mainStateText(s)}
          </dd>
          {s.isGitRepo && tip && (
            <>
              <dt>Latest commit</dt>
              <dd className="mono">{tip}</dd>
            </>
          )}
        </dl>
      )}
      {credentials && (
        <p className="banner banner-warn" role="alert">
          {credentials}
        </p>
      )}
      {lastPush && (
        <p className="banner banner-warn" role="alert">
          {lastPush}
        </p>
      )}
      {error?.form === 'actions' && (
        <p className="banner banner-error" role="alert" id="repo-actions-error">
          {error.text}
        </p>
      )}
      {s?.isGitRepo && (
        <>
          <div className="repo-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null || blocked !== null}
              aria-describedby={error?.form === 'actions' ? 'repo-actions-error' : undefined}
              title={blocked ?? undefined}
              onClick={() => void act('push', () => api<RepositoryStatus>(`${base}/push-main`, 'POST'))}
            >
              {busy === 'push' ? 'Pushing…' : 'Push main to origin'}
            </button>
            <label className="review-checkbox-label">
              <input
                type="checkbox"
                checked={s.keepMainPushed}
                disabled={busy !== null}
                onChange={(e) =>
                  void act('keep', () =>
                    api<RepositoryStatus>(base, 'PATCH', { keepMainPushed: e.target.checked }),
                  )
                }
              />
              Keep main pushed
            </label>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy !== null || !s.originUrl}
              onClick={() => void act('refresh', () => api<RepositoryStatus>(`${base}/refresh`, 'POST'))}
            >
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {blocked !== null && <p className="muted small">{blocked}</p>}
          {blocked === null && tip && <p className="muted small">Pushes {tip}.</p>}
          <p className="muted small">
            Keep main pushed pushes main after each merge into it. It never forces a push. Origin is read when
            you press Refresh, connect, create or push.
          </p>
          <details className="repo-form">
            <summary>Connect an existing repository</summary>
            <form className="form" onSubmit={connect}>
              <input
                className="input mono"
                aria-label="Repository URL"
                aria-invalid={error?.form === 'connect' || undefined}
                aria-describedby={error?.form === 'connect' ? 'repo-connect-error' : undefined}
                placeholder="https://github.com/you/app.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button type="submit" className="btn btn-sm" disabled={busy !== null || !url.trim()}>
                {busy === 'connect' ? 'Connecting…' : 'Connect'}
              </button>
              {error?.form === 'connect' && (
                <p className="form-error" role="alert" id="repo-connect-error">
                  {error.text}
                </p>
              )}
            </form>
          </details>
          <details className="repo-form" onToggle={(e) => setCreateOpen(e.currentTarget.open)}>
            <summary>Create a repository</summary>
            {accounts.data && accounts.data.accounts.length === 0 ? (
              <p className="muted">
                Add a forge account in <Link href={FORGE_ACCOUNTS_HREF}>Settings → Forge accounts</Link>{' '}
                first.
              </p>
            ) : (
              <form className="form" onSubmit={create}>
                {accounts.error !== undefined && !accounts.data && (
                  <p className="form-error" role="alert">
                    Could not load the forge accounts: {errorMessage(accounts.error)}{' '}
                    <button type="button" className="btn btn-sm" onClick={() => void accounts.refresh()}>
                      Retry
                    </button>
                  </p>
                )}
                {ownersError !== null && (
                  <p className="form-error" role="alert">
                    Could not load the owners: {ownersError}
                  </p>
                )}
                <label>
                  Account
                  <select
                    className="input"
                    value={accountId}
                    aria-invalid={error?.form === 'create' || undefined}
                    aria-describedby={error?.form === 'create' ? 'repo-create-error' : undefined}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    {accounts.data?.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {PROVIDER_LABEL[a.provider]} · {accountHost(a)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Owner
                  <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                        {o.kind === 'organization' ? ' (organisation)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Name
                  <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <div className="segmented segmented-radios" role="radiogroup" aria-label="Visibility">
                  {[
                    { value: true, label: 'Private' },
                    { value: false, label: 'Public' },
                  ].map((o) => (
                    <label key={o.label} className={isPrivate === o.value ? 'active' : ''}>
                      <input
                        type="radio"
                        name="repo-visibility"
                        checked={isPrivate === o.value}
                        onChange={() => setIsPrivate(o.value)}
                      />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
                <label>
                  Description (optional)
                  <input
                    className="input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-sm"
                  disabled={
                    !createRepoEnabled({
                      busy: busy !== null,
                      accountId,
                      owner,
                      ownersAccountId: ownersOf?.accountId ?? null,
                      name,
                    })
                  }
                >
                  {busy === 'create' ? 'Creating…' : 'Create and connect'}
                </button>
                {error?.form === 'create' && (
                  <p className="form-error" role="alert" id="repo-create-error">
                    {error.text}
                  </p>
                )}
              </form>
            )}
          </details>
        </>
      )}
    </section>
  );
}
