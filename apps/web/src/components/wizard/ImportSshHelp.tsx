import type {
  HostKeyDetails,
  ImportSshKey,
  ProjectSshKeyResponse,
  SshRemoteProblem,
} from '@emberline/protocol';
import { deployKeyHint, keyInUse, OWN_KEY_BUTTON, SHARED_KEY_HINT } from '../../sshKeys';
import { HostKeyChangedNote, HostKeyTrust } from '../HostKeyTrust';
import { SshKeyLine } from '../SshKeyLine';

export type ImportPhase =
  | { kind: 'cloning'; tail: string; note: string | null }
  | { kind: 'awaitingKey'; sshKey: ImportSshKey | null }
  | { kind: 'detecting' }
  | {
      kind: 'cloneFailed';
      exitCode: number | null;
      tail: string;
      reason: string | undefined;
      code?: SshRemoteProblem;
      hostKey?: HostKeyDetails;
    }
  | { kind: 'detectFailed'; message: string }
  | { kind: 'busy'; label: string };

export function ImportProgressSteps({
  source,
  phase,
  usesOwnKey,
}: {
  source: 'import_url' | 'import_folder';
  phase: ImportPhase;
  usesOwnKey: boolean;
}) {
  if (source === 'import_folder') {
    const failed = phase.kind === 'detectFailed';
    return (
      <ol className="wizard-progress-steps" aria-label="Import steps">
        <li
          className={`wizard-progress-item ${failed ? 'wizard-progress-item-failed' : 'wizard-progress-item-active'}`}
        >
          <span>Inspect files</span>
          <span className="wizard-progress-state">· {failed ? 'Failed' : 'Running'}</span>
        </li>
      </ol>
    );
  }

  const keyDone = phase.kind !== 'awaitingKey';
  const cloneDone = phase.kind === 'detecting' || phase.kind === 'detectFailed';
  const cloneActive = phase.kind === 'cloning' || phase.kind === 'busy';
  const cloneFailed = phase.kind === 'cloneFailed';
  const inspectActive = phase.kind === 'detecting';
  const inspectFailed = phase.kind === 'detectFailed';

  return (
    <ol className="wizard-progress-steps" aria-label="Import steps">
      {usesOwnKey && (
        <li
          className={`wizard-progress-item ${
            phase.kind === 'awaitingKey' ? 'wizard-progress-item-active' : 'wizard-progress-item-done'
          }`}
        >
          <span>1. Deploy key</span>
          <span className="wizard-progress-state">· {keyDone ? 'Ready' : 'Waiting'}</span>
        </li>
      )}
      <li
        className={`wizard-progress-item ${
          cloneFailed
            ? 'wizard-progress-item-failed'
            : cloneDone
              ? 'wizard-progress-item-done'
              : cloneActive
                ? 'wizard-progress-item-active'
                : ''
        }`}
      >
        <span>{usesOwnKey ? '2. Clone' : '1. Clone'}</span>
        <span className="wizard-progress-state">
          · {cloneFailed ? 'Failed' : cloneDone ? 'Done' : cloneActive ? 'Running' : 'Pending'}
        </span>
      </li>
      <li
        className={`wizard-progress-item ${
          inspectFailed ? 'wizard-progress-item-failed' : inspectActive ? 'wizard-progress-item-active' : ''
        }`}
      >
        <span>{usesOwnKey ? '3. Inspect' : '2. Inspect'}</span>
        <span className="wizard-progress-state">
          · {inspectFailed ? 'Failed' : inspectActive ? 'Running' : 'Pending'}
        </span>
      </li>
    </ol>
  );
}

export function ImportAwaitingKeyBox({
  sshKey,
  repoUrl,
  keyBusy,
  onMakeOwnKey,
}: {
  sshKey: ImportSshKey | null;
  repoUrl: string;
  keyBusy: boolean;
  onMakeOwnKey: () => void;
}) {
  return (
    <div className="wizard-ssh-key">
      {sshKey ? (
        <>
          <p className="muted small">
            Fingerprint <span className="mono">{sshKey.fingerprint}</span>
          </p>
          <SshKeyLine publicKey={sshKey.publicKey} copyLabel="Copy" />
          <p className="muted small">{deployKeyHint(repoUrl)}</p>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="btn btn-sm" disabled={keyBusy} onClick={onMakeOwnKey}>
            {keyBusy ? 'Creating…' : "Create this project's key"}
          </button>
        </div>
      )}
    </div>
  );
}

export function ImportSshFailureBox({
  problem,
  hostKey,
  trustOffered,
  keys,
  repoUrl,
  keyBusy,
  onCloneAgain,
  onMakeKey,
}: {
  problem: SshRemoteProblem | null;
  hostKey: HostKeyDetails | undefined;
  trustOffered: boolean;
  keys: ProjectSshKeyResponse | null;
  repoUrl: string;
  keyBusy: boolean;
  onCloneAgain: () => void | Promise<void>;
  onMakeKey: (how: 'shared' | 'own' | 'chooseOwn') => void;
}) {
  const inUse = keys ? keyInUse(keys) : null;
  const ownChosen = keys?.choice === 'own';

  return (
    <>
      {trustOffered && hostKey && (
        <HostKeyTrust hostKey={hostKey} trustLabel="Trust and try again" onTrusted={onCloneAgain} />
      )}
      {problem === 'host_key_changed' && <HostKeyChangedNote hostKey={hostKey} newTab />}
      {(problem === 'auth_refused' || problem === 'ssh_key_missing') && keys && (
        <div className="wizard-ssh-key">
          {inUse ? (
            <>
              <p className="small">
                The clone uses {ownChosen ? "this project's own key" : "Emberline's shared key"}{' '}
                <span className="muted mono">({inUse.fingerprint})</span>. Add its public key, then try again.
              </p>
              <SshKeyLine publicKey={inUse.publicKey} copyLabel="Copy" />
              <p className="muted small">{ownChosen ? deployKeyHint(repoUrl) : SHARED_KEY_HINT}</p>
            </>
          ) : (
            <div className="actions">
              {ownChosen ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={keyBusy}
                  onClick={() => onMakeKey('own')}
                >
                  Create this project&apos;s key
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={keyBusy}
                    onClick={() => onMakeKey('shared')}
                  >
                    Create a shared key
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={keyBusy}
                    onClick={() => onMakeKey('chooseOwn')}
                  >
                    {OWN_KEY_BUTTON}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
