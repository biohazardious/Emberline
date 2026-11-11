import type { SshKeyResponse } from '@emberline/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { type Dispatch, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useApi } from '../../hooks/useApi';
import { OWN_KEY_BUTTON, OWN_KEY_LABEL, SHARED_KEY_HINT, SHARED_KEY_LABEL } from '../../sshKeys';
import { SshKeyLine } from '../SshKeyLine';
import { repoIsSsh, type WizardAction, type WizardState } from './wizardLogic';

const SSH_KEY_URL = '/api/ssh-key';

/**
 * The Repository step for an ssh address: the key the clone will use (the shared key, with its
 * public line to add on the forge) and "Use a key for this project only". Nothing for https.
 */
export function RepoSshKey({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  if (!repoIsSsh(state)) return null;
  return <SshKeyChoiceBox state={state} dispatch={dispatch} />;
}

function SshKeyChoiceBox({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const shared = useApi<SshKeyResponse>(SSH_KEY_URL, 60_000);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = shared.data?.key ?? null;

  const createShared = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<SshKeyResponse>(SSH_KEY_URL, 'POST');
      queryClient.setQueryData(['api', SSH_KEY_URL], res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const choose = (choice: 'shared' | 'own') => dispatch({ type: 'sshKeyChoice', choice });

  return (
    <section className="wizard-ssh-key" aria-labelledby="wizard-ssh-key-title">
      <h4 id="wizard-ssh-key-title" className="wizard-legend">
        SSH key
      </h4>
      {state.sshKeyChoice === 'own' ? (
        <>
          <p>
            <strong>{OWN_KEY_LABEL}</strong>
          </p>
          <p className="muted small">
            Emberline makes the key when you press Create the key, and shows its public key to add to the
            repository as a deploy key. The clone starts when you say so.
          </p>
          <div className="actions">
            <button type="button" className="btn btn-sm" onClick={() => choose('shared')}>
              Use Emberline&apos;s shared key
            </button>
          </div>
        </>
      ) : shared.error !== undefined && !shared.data ? (
        <p className="form-error" role="alert">
          Could not read Emberline&apos;s SSH key: {errorMessage(shared.error)}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void shared.refresh()}>
            Retry
          </button>
        </p>
      ) : !shared.data ? (
        <p className="muted small">Checking the SSH key…</p>
      ) : key ? (
        <>
          <p>
            The clone uses <strong>{SHARED_KEY_LABEL}</strong>{' '}
            <span className="muted mono">({key.fingerprint})</span>.
          </p>
          <SshKeyLine publicKey={key.publicKey} copyLabel="Copy">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => choose('own')}>
              {OWN_KEY_BUTTON}
            </button>
          </SshKeyLine>
          <p className="muted small">{SHARED_KEY_HINT}</p>
        </>
      ) : (
        <>
          <p>Emberline has no SSH key yet.</p>
          <p className="muted small">
            Create the shared key (every project that uses it reaches its ssh repository with it), or a key
            for this project only (a deploy key for this one repository).
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void createShared()}
            >
              {busy ? 'Creating…' : 'Create a shared key'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => choose('own')}>
              {OWN_KEY_BUTTON}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
