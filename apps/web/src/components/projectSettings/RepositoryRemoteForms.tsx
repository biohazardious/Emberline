import type {
  ForgeAccountsResponse,
  ForgeOwner,
  ForgeOwnersResponse,
  HostKeyDetails,
  Project,
  RepositoryStatus,
} from '@emberline/protocol';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../../api';
import { accountHost, FORGE_ACCOUNTS_HREF, PROVIDER_LABEL } from '../../forgeAccounts';
import { useApi } from '../../hooks/useApi';
import { connectPrefill, createRepoEnabled, ownerAfterLoad } from '../../repository';
import { SSH_KEY_HREF } from '../../sshKeys';
import { HostKeyChangedNote, HostKeyTrust } from '../HostKeyTrust';

export type RepoForm = 'connect' | 'create' | 'actions';

export interface RepoError {
  form: RepoForm;
  text: string;
  code?: string;
  hostKey?: HostKeyDetails | null;
}

/** Help for an ssh problem a remote operation hit: trust an unknown host key (then run it again), a changed one, no key. */
export function SshProblemHelp({ error, onTrusted }: { error: RepoError; onTrusted: () => void }) {
  if (error.code === 'host_key_unknown' && error.hostKey)
    return <HostKeyTrust hostKey={error.hostKey} trustLabel="Trust and try again" onTrusted={onTrusted} />;
  if (error.code === 'host_key_changed') return <HostKeyChangedNote hostKey={error.hostKey} />;
  if (error.code === 'ssh_key_missing')
    return (
      <p className="muted small">
        Choose or create this project&apos;s key under SSH key above, or create the shared key in{' '}
        <Link href={SSH_KEY_HREF}>Settings → SSH key</Link>.
      </p>
    );
  return null;
}

export function RepositoryRemoteForms({
  project,
  status,
  busy,
  error,
  help,
  onConnect,
  onCreate,
}: {
  project: Project;
  status: RepositoryStatus;
  busy: string | null;
  error: RepoError | null;
  help: (form: RepoForm) => ReactNode;
  onConnect: (url: string) => void;
  onCreate: (payload: {
    accountId: string;
    owner: string;
    name: string;
    private: boolean;
    description?: string;
  }) => void;
}) {
  const accounts = useApi<ForgeAccountsResponse>('/api/forge/accounts', 120_000);
  const offeredOrigin = connectPrefill(status);
  const [url, setUrl] = useState(offeredOrigin ?? '');
  const [accountId, setAccountId] = useState('');
  const [ownersOf, setOwnersOf] = useState<{ accountId: string; owners: ForgeOwner[] } | null>(null);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(project.slug);
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState('');
  const owners = ownersOf?.accountId === accountId ? ownersOf.owners : [];

  useEffect(() => {
    if (!accountId && accounts.data?.accounts[0]) setAccountId(accounts.data.accounts[0].id);
  }, [accountId, accounts.data]);

  useEffect(() => {
    if (offeredOrigin) setUrl((current) => current || offeredOrigin);
  }, [offeredOrigin]);

  useEffect(() => {
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

  const submitConnect = (e: FormEvent) => {
    e.preventDefault();
    onConnect(url.trim());
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    onCreate({
      accountId,
      owner,
      name: name.trim(),
      private: isPrivate,
      description: description.trim() || undefined,
    });
  };

  return (
    <div className="repo-inline-editor">
      <form className="repo-form-constrained" onSubmit={submitConnect}>
        <label className="field">
          Connect repository URL
          <input
            className="input mono"
            aria-label="Repository URL"
            aria-invalid={error?.form === 'connect' || undefined}
            aria-describedby={error?.form === 'connect' ? 'repo-connect-error' : undefined}
            placeholder="https://github.com/you/app.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="repo-actions">
          <button type="submit" className="btn btn-sm" disabled={busy !== null || !url.trim()}>
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {error?.form === 'connect' && (
          <p className="form-error" role="alert" id="repo-connect-error">
            {error.text}
          </p>
        )}
        {help('connect')}
      </form>

      <details className="repo-form" onToggle={(e) => setCreateOpen(e.currentTarget.open)}>
        <summary>Create a repository</summary>
        {accounts.data && accounts.data.accounts.length === 0 ? (
          <p className="muted small">
            Add a forge account in <Link href={FORGE_ACCOUNTS_HREF}>Settings → Forge accounts</Link> first.
          </p>
        ) : (
          <form className="repo-form-constrained" onSubmit={submitCreate}>
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
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="repo-actions">
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
            </div>
            {error?.form === 'create' && (
              <p className="form-error" role="alert" id="repo-create-error">
                {error.text}
              </p>
            )}
            {help('create')}
          </form>
        )}
      </details>
    </div>
  );
}
