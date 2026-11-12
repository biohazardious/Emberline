import type { Project, ProjectSshKeyResponse, SshKeyChoice } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorMessage } from '../api';
import { useApi } from '../hooks/useApi';
import { deployKeyHint, isSshAddress, OWN_KEY_LABEL, SHARED_KEY_LABEL, SSH_KEY_HREF } from '../sshKeys';
import { SshKeyLine } from './SshKeyLine';

const NEW_KEY_QUESTION =
  "Make a new key for this project? The current key stops working at once: replace it in the repository's Settings → Deploy keys.";
const DELETE_QUESTION =
  "Delete this project's key? Its ssh operations fail until you create a new one or choose the shared key. Also remove it from the repository's deploy keys on the forge.";

/**
 * Project settings → Repository → SSH key: the shared key or the project's own (a deploy key for
 * this one repository). The choice is stored; switching to the shared key keeps the project's key,
 * and deleting the own key keeps the choice (Ruling 19), so nothing falls back to a wider key unasked.
 */
export function ProjectSshKey({ project, originUrl }: { project: Project; originUrl: string | null }) {
  const url = `/api/projects/${project.id}/ssh-key`;
  const query = useApi<ProjectSshKeyResponse>(url, 60_000);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = query.data;

  const run = async (key: string, fn: () => Promise<ProjectSshKeyResponse | undefined>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await fn();
      if (next) queryClient.setQueryData(['api', url], next);
      else await query.refresh();
    } catch (err) {
      setError(errorMessage(err));
      await query.refresh();
    } finally {
      setBusy(null);
    }
  };

  const choose = (choice: SshKeyChoice) =>
    void run('choice', () => api<ProjectSshKeyResponse>(`${url}-choice`, 'PUT', { choice }));
  const generate = (replacing: boolean) => {
    if (replacing && !window.confirm(NEW_KEY_QUESTION)) return;
    void run('generate', () => api<ProjectSshKeyResponse>(url, 'POST'));
  };
  const remove = () => {
    if (!window.confirm(DELETE_QUESTION)) return;
    void run('delete', async () => {
      await api(url, 'DELETE');
      return undefined;
    });
  };

  const sshOrigin = originUrl !== null && isSshAddress(originUrl);
  return (
    <fieldset className="ssh-key-choice" aria-busy={busy !== null || undefined}>
      <legend>SSH key</legend>
      {query.error !== undefined && !s && (
        <p className="form-error" role="alert">
          Could not load the SSH key: {errorMessage(query.error)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void query.refresh()}>
            Retry
          </button>
        </p>
      )}
      {s && (
        <>
          {!sshOrigin && (
            <p className="muted small">
              Used for an ssh origin (such as <span className="mono">git@github.com:you/app.git</span>). An
              https origin uses the forge account instead.
            </p>
          )}
          <label className="ssh-key-option">
            <input
              type="radio"
              name={`ssh-key-choice-${project.id}`}
              checked={s.choice === 'shared'}
              disabled={busy !== null}
              onChange={() => choose('shared')}
            />
            <span>
              {SHARED_KEY_LABEL}{' '}
              {s.shared ? (
                <span className="muted mono">({s.shared.fingerprint})</span>
              ) : (
                <span className="muted">(none yet)</span>
              )}
            </span>
          </label>
          {s.choice === 'shared' && !s.shared && (
            <p className="muted small ssh-key-detail">
              {/* One grid item: the link stays in the sentence. */}
              <span>
                Create it in <Link href={SSH_KEY_HREF}>Settings → SSH key</Link>, or use this project&apos;s
                own key.
              </span>
            </p>
          )}
          <label className="ssh-key-option">
            <input
              type="radio"
              name={`ssh-key-choice-${project.id}`}
              checked={s.choice === 'own'}
              disabled={busy !== null}
              onChange={() => choose('own')}
            />
            <span>{OWN_KEY_LABEL}</span>
          </label>
          {s.key ? (
            <div className="ssh-key-detail">
              {s.choice === 'shared' && (
                <p className="muted small">
                  This project&apos;s key is kept while the shared key is chosen: switching back needs no new
                  deploy key.
                </p>
              )}
              <p className="muted small">
                Fingerprint <span className="mono">{s.key.fingerprint}</span>
              </p>
              <SshKeyLine publicKey={s.key.publicKey} copyLabel="Copy">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy !== null}
                  onClick={() => generate(true)}
                >
                  {busy === 'generate' ? 'Working…' : 'New key'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy !== null}
                  onClick={remove}
                >
                  {busy === 'delete' ? 'Deleting…' : 'Delete'}
                </button>
              </SshKeyLine>
              <p className="muted small">{deployKeyHint(originUrl)}</p>
            </div>
          ) : (
            s.choice === 'own' && (
              <div className="ssh-key-detail">
                <p className="small">
                  This project has no key: its ssh operations fail until you create one.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null}
                    onClick={() => generate(false)}
                  >
                    {busy === 'generate' ? 'Creating…' : 'Create a key'}
                  </button>
                </div>
              </div>
            )
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
